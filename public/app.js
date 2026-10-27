"use strict";
/**
 * Velocity launcher — boots Scramjet, picks a bare-mux transport,
 * routes through Tor when wanted (à la Holy Unblocker), and drives
 * the UI (home + tabbed browser view + settings + stealth tools).
 */
(() => {
	const PREFIX = "/scramjet/";
	const TOR_PROXY = "socks5h://127.0.0.1:9050"; // resolved by the wisp server
	const $ = (sel) => document.querySelector(sel);

	/* ---------------------------------------------------------------
	 * Settings
	 * ------------------------------------------------------------- */
	const DEFAULTS = {
		transport: "libcurl",
		engine: "https://duckduckgo.com/?q=%s",
		codec: "xor",
		cloak: "none",
		cloakTitle: "",
		openMode: "frame",
		tor: false,
		panicKey: "`",
		panicUrl: "https://classroom.google.com",
	};
	const TOR_ICON = '<svg class="oni-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><ellipse cx="8" cy="9.4" rx="5.2" ry="4.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.2c2 1.8 2 3.8 0 5.6C6 5 6 3 8 1.2z" fill="currentColor"/></svg>';
	let settings = { ...DEFAULTS };
	try {
		Object.assign(settings, JSON.parse(localStorage.getItem("vx.settings") || "{}"));
	} catch {}
	const saveSettings = () => localStorage.setItem("vx.settings", JSON.stringify(settings));

	/* ---------------------------------------------------------------
	 * Codecs — MUST be self-contained: Scramjet stringifies these
	 * functions into IndexedDB and the service worker re-evaluates them.
	 * ------------------------------------------------------------- */
	const CODECS = {
		plain: {
			encode: (url) => {
				if (!url) return url;
				return encodeURIComponent(url.toString());
			},
			decode: (url) => {
				if (!url) return url;
				return decodeURIComponent(url);
			},
		},
		xor: {
			encode: (url) => {
				if (!url) return url;
				return encodeURIComponent(
					url
						.toString()
						.split("")
						.map((char, ind) => (ind % 2 ? String.fromCharCode(char.charCodeAt(0) ^ 2) : char))
						.join("")
				);
			},
			decode: (url) => {
				if (!url) return url;
				let [input, ...search] = url.split("?");
				return (
					decodeURIComponent(input)
						.split("")
						.map((char, ind) => (ind % 2 ? String.fromCharCode(char.charCodeAt(0) ^ 2) : char))
						.join("") + (search.length ? "?" + search.join("?") : "")
				);
			},
		},
	};
	const activeCodec = () => CODECS[settings.codec] || CODECS.xor;

	/* ---------------------------------------------------------------
	 * Scramjet + bare-mux boot
	 * ------------------------------------------------------------- */
	const { ScramjetController } = $scramjetLoadController();
	let scramjet = null;
	let ready = false;
	let booting = null;

	const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

	// server capabilities: tells us whether Tor egress is a wisp *region*
	// (server-side SOCKS, InvisiProxy style) or needs the client-side proxy
	let caps = { wispEngine: "wisp-js", regions: [""], torMode: "client", customWispAllowed: true };
	const capsReady = fetch("/api/capabilities")
		.then((r) => (r.ok ? r.json() : null))
		.then((c) => { if (c) caps = c; })
		.catch(() => {});

	// a user-supplied wisp endpoint (InvisiProxy "CustomWisp") — used verbatim
	const validCustomWisp = () => {
		if (!settings.customWisp) return false;
		try {
			const u = new URL(settings.customWisp);
			return (u.protocol === "wss:" || u.protocol === "ws:") && u.pathname.endsWith("/");
		} catch {
			return false;
		}
	};
	const wispURL = (region = "") => {
		if (validCustomWisp()) return settings.customWisp;
		const proto = location.protocol === "https:" ? "wss://" : "ws://";
		return proto + location.host + "/wisp/" + (region ? region + "/" : "");
	};
	// Tor-through-region: any transport works because the server owns the SOCKS hop
	const regionActive = () =>
		settings.tor && caps.torMode === "server" && caps.regions.includes("tor") && !validCustomWisp();

	const TRANSPORTS = {
		libcurl: () => ["/libcurl/index.mjs", [{ websocket: wispURL(regionActive() ? "tor" : "") }]],
		epoxy: () => ["/vendor/epoxy/index.mjs", [{ wisp: wispURL(regionActive() ? "tor" : "") }]],
		bare: () => ["/baremod/index.mjs", [location.origin + "/bare/"]],
		// Legacy client-side Tor: libcurl attaches SOCKS5 through the wisp
		// tunnel into the daemon. socks5h => hostname resolution at the proxy.
		tor: () => ["/libcurl/index.mjs", [{ websocket: wispURL(), proxy: TOR_PROXY }]],
	};
	const effectiveTransport = () => {
		if (!settings.tor) return settings.transport;
		if (regionActive()) return settings.transport === "bare" ? "libcurl" : settings.transport; // bare is HTTP, can't take regions
		return "tor"; // fallback mode: forced libcurl + SOCKS option
	};

	let lastTransportKey = "";
	async function selectTransport() {
		const [mod, opts] = (TRANSPORTS[effectiveTransport()] || TRANSPORTS.libcurl)();
		const key = mod + "|" + JSON.stringify(opts);
		if (key !== lastTransportKey) {
			await connection.setTransport(mod, opts);
			lastTransportKey = key;
		}
	}

	function setStatus(state, text) {
		const el = $("#status");
		el.className = "status status-" + state;
		el.textContent = text;
	}

	const torIndicators = ["#tor-indicator", "#tor-indicator-2"]; // home nav + browser toolbar
	async function refreshTorIndicator() {
		const els = torIndicators.map((s) => $(s));
		const paint = (cls, html, title) => {
			for (const el of els) {
				if (!el) continue;
				el.className = "status " + cls;
				el.innerHTML = html;
				el.title = title || "";
				el.hidden = false;
			}
		};
		if (!settings.tor) {
			for (const el of els) if (el) el.hidden = true;
			return;
		}
		paint("status-warn", TOR_ICON + " tor…", "");
		try {
			const r = await fetch("/api/tor/status").then((r) => r.json());
			const mode = regionActive() ? "region" : caps.torMode === "server" ? "region" : "socks";
			if (r.running) {
				paint("status-ok", TOR_ICON + " tor online",
					`Tor egress via ${mode === "region" ? "wisp region worker" : "client SOCKS"} (${r.socks})`);
			} else {
				paint("status-bad", TOR_ICON + " tor offline", "Tor daemon not reachable at " + r.socks);
			}
		} catch {
			paint("status-warn", TOR_ICON + " tor ?", "");
		}
	}

	async function boot() {
		if (ready) return;
		if (booting) return booting;
		booting = (async () => {
			setStatus("warn", "starting…");
			await capsReady; // region / torMode known before first transport choice
			scramjet = new ScramjetController({
				prefix: PREFIX,
				files: {
					wasm: "/scram/scramjet.wasm.wasm",
					all: "/scram/scramjet.all.js",
					sync: "/scram/scramjet.sync.js",
				},
				flags: { captureErrors: true, sourcemaps: false },
				codec: activeCodec(),
			});
			await scramjet.init();
			await navigator.serviceWorker.register("/sw.js", { scope: "/" });
			await navigator.serviceWorker.ready;
			await selectTransport();
			ready = true;
			setStatus("ok", "ready");
			refreshTorIndicator();
		})();
		try {
			await booting;
		} finally {
			booting = null;
		}
	}

	/* ---------------------------------------------------------------
	 * URL handling (Ultraviolet-style search fallback) + onion detect
	 * ------------------------------------------------------------- */
	function normalizeTarget(input) {
		input = String(input || "").trim();
		if (!input) throw new Error("Enter a URL or search term first.");
		try {
			return new URL(input).toString();
		} catch {}
		try {
			const url = new URL("http://" + input);
			if (url.hostname.includes(".")) return url.toString();
		} catch {}
		return settings.engine.replace("%s", encodeURIComponent(input));
	}
	const isOnion = (target) => {
		try {
			return new URL(target).hostname.endsWith(".onion");
		} catch {
			return false;
		}
	};

	const proxied = (realUrl) => scramjet.encodeUrl(realUrl);

	/* ---------------------------------------------------------------
	 * Tabs (Holy-style multi-tab browsing)
	 * ------------------------------------------------------------- */
	const browserView = $("#browser");
	const homeView = $("#home");
	const frameContainer = $("#frame-container");
	const tabsBar = $("#tabs");
	const omnibox = $("#omnibox");
	const tabs = new Map(); // id -> {id, frame, el, url, onion}
	let activeTab = null;
	let tabSeq = 0;

	function currentTab() {
		return activeTab && tabs.get(activeTab);
	}

	function renderTabs() {
		tabsBar.innerHTML = "";
		for (const tab of tabs.values()) {
			const el = document.createElement("div");
			el.className = "tab" + (tab.id === activeTab ? " active" : "");
			el.title = tab.url || "New tab";
			let label = "New tab";
			try {
				if (tab.url) label = new URL(tab.url).hostname;
			} catch {}
			el.innerHTML =
				`<span class="t-dot${tab.onion ? " onion" : ""}"></span>` +
				`<span class="t-label">${escapeHtml(label)}</span>` +
				`<button class="t-close" title="Close tab (Ctrl+W)">✕</button>`;
			el.addEventListener("click", (e) => {
				if (e.target.closest(".t-close")) return closeTab(tab.id);
				activateTab(tab.id);
			});
			tab.el = el;
			tabsBar.appendChild(el);
		}
	}

	function createTab(target) {
		const id = ++tabSeq;
		const frame = scramjet.createFrame();
		frame.frame.className = "vx-frame";
		frame.frame.setAttribute(
			"allow",
			"autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write; geolocation"
		);
		frame.frame.style.display = "none";
		frameContainer.appendChild(frame.frame);
		const tab = { id, frame, el: null, url: "", onion: false };
		tabs.set(id, tab);
		frame.addEventListener("urlchange", (e) => {
			try {
				const real = new URL(e.url).href;
				tab.url = real;
				tab.onion = isOnion(real);
				if (tab.id === activeTab) {
					omnibox.value = real;
					tab.title = new URL(real).hostname;
					applyCloak(); // respects the disguise setting while browsing
				}
				recordHistory(real);
				renderTabs();
				attachPanic(tab);
			} catch {}
		});
		if (target) frame.go(target);
		return tab;
	}

	function activateTab(id) {
		activeTab = id;
		for (const t of tabs.values()) t.frame.frame.style.display = "none";
		const tab = tabs.get(id);
		if (tab) {
			tab.frame.frame.style.display = "block";
			omnibox.value = tab.url || "";
		}
		renderTabs();
	}

	function closeTab(id) {
		const tab = tabs.get(id);
		if (!tab) return;
		tab.frame.frame.remove();
		tabs.delete(id);
		if (activeTab === id) {
			const last = [...tabs.keys()].pop();
			if (last) activateTab(last);
			else {
				activeTab = null;
				browserView.hidden = true;
				homeView.hidden = false;
				applyCloak();
				return;
			}
		}
		renderTabs();
	}

	function attachPanic(tab) {
		try {
			const win = tab.frame.frame.contentWindow;
			if (win && !win.__vxPanic) {
				win.__vxPanic = true;
				win.addEventListener("keydown", (e) => {
					if (e.key === settings.panicKey) panic();
				});
			}
		} catch {}
	}

	function openBrowserView() {
		homeView.hidden = true;
		browserView.hidden = false;
		if (!currentTab()) {
			activateTab(createTab().id);
		}
	}

	/* ---------------------------------------------------------------
	 * Navigation
	 * ------------------------------------------------------------- */
	async function go(input) {
		err("");
		let target;
		try {
			target = normalizeTarget(input);
		} catch (e) {
			err(e.message);
			return;
		}
		try {
			await boot();
			if (isOnion(target) && !settings.tor) {
				settings.tor = true;
				saveSettings();
				await selectTransport();
				refreshTorIndicator();
				toast("🧅 Onion detected — Tor routing enabled");
			}
			if (settings.openMode === "tab") {
				location.href = proxied(target);
				return;
			}
			openBrowserView();
			const tab = currentTab();
			tab.url = target;
			tab.onion = isOnion(target);
			renderTabs();
			omnibox.value = target;
			tab.frame.go(target);
		} catch (e) {
			err("Couldn't start the proxy: " + e.message);
			setStatus("bad", "error");
		}
	}

	/* ---------------------------------------------------------------
	 * History (local only, never leaves the browser)
	 * ------------------------------------------------------------- */
	const getHistory = () => {
		try {
			return JSON.parse(localStorage.getItem("vx.history") || "[]");
		} catch {
			return [];
		}
	};
	function recordHistory(url) {
		let host = "";
		try {
			host = new URL(url).hostname;
		} catch {
			return;
		}
		const list = getHistory().filter((h) => h.u !== url);
		list.unshift({ u: url, h: host });
		localStorage.setItem("vx.history", JSON.stringify(list.slice(0, 12)));
		renderHistory();
	}
	function renderHistory() {
		const section = $("#history-section");
		const wrap = $("#history");
		const list = getHistory();
		wrap.innerHTML = "";
		section.hidden = list.length === 0;
		for (const item of list) {
			const b = document.createElement("button");
			const letter = (item.h || "?").replace(/^www\./, "").charAt(0).toUpperCase();
			b.innerHTML = `<span class="h-avatar">${letter}</span>${escapeHtml(item.h)}`;
			b.title = item.u;
			b.addEventListener("click", () => go(item.u));
			wrap.appendChild(b);
		}
	}
	const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

	/* ---------------------------------------------------------------
	 * Suggestions
	 * ------------------------------------------------------------- */
	const address = $("#address");
	const suggBox = $("#suggestions");
	let suggItems = [];
	let suggIndex = -1;
	let suggAbort = null;
	let suggTimer = null;

	const looksLikeUrl = (q) => !/\s/.test(q) && /^[^\s]+\.[^\s]+$/.test(q);

	function hideSuggestions() {
		suggBox.hidden = true;
		suggItems = [];
		suggIndex = -1;
	}
	function renderSuggestions(list) {
		suggItems = list;
		suggIndex = -1;
		suggBox.innerHTML = "";
		if (!list.length) return hideSuggestions();
		list.forEach((text) => {
			const li = document.createElement("li");
			li.textContent = text;
			li.addEventListener("mousedown", (e) => {
				e.preventDefault();
				address.value = text;
				hideSuggestions();
				go(text);
			});
			suggBox.appendChild(li);
		});
		suggBox.hidden = false;
	}
	address.addEventListener("input", () => {
		clearTimeout(suggTimer);
		const q = address.value.trim();
		if (!q || looksLikeUrl(q)) return hideSuggestions();
		suggTimer = setTimeout(async () => {
			try {
				suggAbort?.abort();
				suggAbort = new AbortController();
				const r = await fetch("/suggest?q=" + encodeURIComponent(q), { signal: suggAbort.signal });
				renderSuggestions(await r.json());
			} catch {}
		}, 160);
	});
	address.addEventListener("keydown", (e) => {
		if (suggBox.hidden) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			suggIndex =
				(suggIndex + (e.key === "ArrowDown" ? 1 : -1) + suggItems.length) % suggItems.length;
			[...suggBox.children].forEach((li, i) => li.classList.toggle("active", i === suggIndex));
			address.value = suggItems[suggIndex];
		} else if (e.key === "Escape") {
			hideSuggestions();
		}
	});
	address.addEventListener("blur", () => setTimeout(hideSuggestions, 120));

	/* ---------------------------------------------------------------
	 * Cloak + panic + stealth window (Holy-style)
	 * ------------------------------------------------------------- */
	const CLOAKS = {
		none: null,
		google: { title: "Google" },
		classroom: { title: "Google Classroom" },
		docs: { title: "Google Docs" },
	};
	function applyCloak() {
		// cloak ("tab disguise") always wins; otherwise show the active tab while browsing
		let title = CLOAKS[settings.cloak]?.title;
		if (!title && settings.cloak === "custom" && settings.cloakTitle) title = settings.cloakTitle;
		if (!title) {
			const tab = currentTab();
			title = tab && tab.title ? `${tab.title} — Velocity` : "Velocity";
		}
		document.title = title;
		if (document.getElementById("favicon") && CLOAKS[settings.cloak]?.favicon) {
			document.getElementById("favicon").href = CLOAKS[settings.cloak].favicon;
		}
	}

	function panic() {
		// replace() so the proxy page isn't in history-forward either
		location.replace(settings.panicUrl || DEFAULTS.panicUrl);
	}
	document.addEventListener("keydown", (e) => {
		if (e.key === settings.panicKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.target.tagName !== "INPUT")
			panic();
	});

	/* ---------------------------------------------------------------
	 * Settings modal
	 * ------------------------------------------------------------- */
	const modal = $("#settings");
	function syncTransportEnabled() {
		// In server-region mode Tor works over libcurl OR epoxy; in the legacy
		// fallback Tor must force libcurl (only transport with SOCKS support).
		const serverTor = caps.torMode === "server" && caps.regions.includes("tor");
		$("#set-transport").disabled = settings.tor && !serverTor;
		if (settings.tor && !serverTor) $("#set-transport").value = "libcurl";
		const note = $("#tor-note");
		if (note)
			note.textContent = settings.tor
				? serverTor
					? ".onion sites work; everything exits via Tor. Works with libcurl & epoxy (server-side region)."
					: ".onion sites work; everything exits via Tor. Forces the libcurl transport."
				: ".onion sites work; everything exits via Tor.";
	}
	function openSettings() {
		$("#set-tor").checked = settings.tor;
		$("#set-transport").value = settings.transport;
		$("#set-engine").value = settings.engine;
		$("#set-codec").value = settings.codec;
		$("#set-openmode").value = settings.openMode;
		$("#set-cloak").value = settings.cloak;
		$("#set-cloak-title").value = settings.cloakTitle;
		$("#set-panic-key").value = settings.panicKey;
		$("#set-panic-url").value = settings.panicUrl;
		$("#set-customwisp").value = settings.customWisp || "";
		$("#cloak-title-wrap").hidden = settings.cloak !== "custom";
		syncTransportEnabled();
		modal.hidden = false;
	}
	$("#set-cloak").addEventListener("change", (e) => {
		$("#cloak-title-wrap").hidden = e.target.value !== "custom";
	});
	$("#set-tor").addEventListener("change", (e) => {
		settings.tor = e.target.checked;
		syncTransportEnabled();
	});
	$("#save-settings").addEventListener("click", async () => {
		const prevCodec = settings.codec;
		settings.tor = $("#set-tor").checked;
		settings.transport = $("#set-transport").value || "libcurl";
		settings.engine = $("#set-engine").value;
		settings.codec = $("#set-codec").value;
		settings.openMode = $("#set-openmode").value;
		settings.cloak = $("#set-cloak").value;
		settings.cloakTitle = $("#set-cloak-title").value;
		settings.panicKey = $("#set-panic-key").value;
		settings.panicUrl = $("#set-panic-url").value.trim() || DEFAULTS.panicUrl;
		const cw = $("#set-customwisp").value.trim();
		settings.customWisp = cw || "";
		if (cw && !validCustomWisp()) {
			toast("Custom wisp must be a ws:// or wss:// URL ending in /");
			settings.customWisp = "";
		}
		saveSettings();
		applyCloak();
		modal.hidden = true;
		try {
			const tabAtSave = currentTab();
			const urlAtSave = tabAtSave?.url;
			await boot();
			await selectTransport(); // transport AND tor both live here
			refreshTorIndicator();
			if (settings.tor) toast("🧅 Tor routing on — traffic exits via Tor");
			else if (validCustomWisp()) toast("Custom wisp server active");
			// re-navigate so the new transport takes effect — but never stomp a
			// navigation the user started while we were swapping transports
			const tab = currentTab();
			if (tab && tab === tabAtSave && tab.url && tab.url === urlAtSave) tab.frame.go(tab.url);
			if (settings.codec !== prevCodec && scramjet) {
				// ScramjetConfig.codec stores SOURCE STRINGS (functions can't be
				// structured-cloned into IndexedDB), so stringify before passing.
				const c = activeCodec();
				await scramjet.modifyConfig({ codec: { encode: String(c.encode), decode: String(c.decode) } });
				const reg = await navigator.serviceWorker.getRegistration();
				reg?.active?.postMessage({ scramjet$type: "vx:reloadConfig" });
				toast("Codec changed — restarting engine…");
				if (reg) await reg.unregister();
				await new Promise((r) => setTimeout(r, 400));
				location.reload();
				return;
			}
			toast("Settings saved");
		} catch (e) {
			toast("Saved, but transport change failed: " + e.message);
		}
	});
	$("#open-settings").addEventListener("click", openSettings);
	$("#open-settings-2").addEventListener("click", openSettings);
	$("#close-settings").addEventListener("click", () => (modal.hidden = true));
	modal.addEventListener("click", (e) => {
		if (e.target === modal) modal.hidden = true;
	});

	/* ---------------------------------------------------------------
	 * Apps & Games launcher (Incognito-style) — everything opens
	 * through the proxy, so nothing here touches your real IP.
	 * ------------------------------------------------------------- */
	const APPS = [
		// cloud & web gaming
		{ n: "GeForce NOW", u: "https://play.geforcenow.com", i: "⚡", c: "#76b900" },
		{ n: "Xbox Cloud", u: "https://www.xbox.com/play", i: "🎮", c: "#107c10" },
		{ n: "now.gg", u: "https://now.gg", i: "📱", c: "#8e5cf7" },
		{ n: "Poki", u: "https://poki.com", i: "🕹️", c: "#ff4d6d" },
		{ n: "CrazyGames", u: "https://www.crazygames.com", i: "🃏", c: "#7c4dff" },
		{ n: "itch.io", u: "https://itch.io/games/html5", i: "🎲", c: "#fa5c5c" },
		{ n: "Neal.fun", u: "https://neal.fun", i: "🌀", c: "#00b8d4" },
		{ n: "Hacker Typer", u: "https://hackertyper.net", i: "⌨️", c: "#00c853" },
		// social & apps
		{ n: "Discord", u: "https://discord.com/app", i: "💬", c: "#5865f2" },
		{ n: "Spotify", u: "https://open.spotify.com", i: "🎧", c: "#1db954" },
		{ n: "TikTok", u: "https://www.tiktok.com", i: "🎵", c: "#ff2d55" },
		{ n: "YouTube", u: "https://www.youtube.com", i: "▶️", c: "#ff0033" },
		{ n: "Twitch", u: "https://www.twitch.tv", i: "📺", c: "#9146ff" },
		{ n: "Reddit", u: "https://www.reddit.com", i: "🗞️", c: "#ff4500" },
		{ n: "Instagram", u: "https://www.instagram.com", i: "📸", c: "#e1306c" },
		{ n: "X / Twitter", u: "https://x.com", i: "🐦", c: "#1d9bf0" },
		{ n: "Pinterest", u: "https://www.pinterest.com", i: "📌", c: "#e60023" },
		// tools
		{ n: "Google Docs", u: "https://docs.google.com", i: "📄", c: "#4285f4" },
		{ n: "Maps", u: "https://www.google.com/maps", i: "🗺️", c: "#34a853" },
		{ n: "Wayback", u: "https://web.archive.org", i: "🕰️", c: "#8a8a8a" },
		{ n: "Translate", u: "https://translate.google.com", i: "🌐", c: "#4285f4" },
		{ n: "Duolingo", u: "https://www.duolingo.com", i: "🦉", c: "#58cc02" },
		{ n: "Wikipedia", u: "https://www.wikipedia.org", i: "📚", c: "#b8b8b8" },
	];
	const appsModal = $("#apps");
	{
		const grid = $("#apps-grid");
		for (const a of APPS) {
			const b = document.createElement("button");
			b.className = "app-tile";
			b.innerHTML = `<span class="app-ic" style="background:${a.c}22;color:${a.c}">${a.i}</span><span>${a.n}</span>`;
			b.title = a.u;
			b.addEventListener("click", () => {
				appsModal.hidden = true;
				go(a.u);
			});
			grid.appendChild(b);
		}
	}
	$("#btn-apps").addEventListener("click", () => (appsModal.hidden = false));
	$("#close-apps").addEventListener("click", () => (appsModal.hidden = true));
	appsModal.addEventListener("click", (e) => {
		if (e.target === appsModal) appsModal.hidden = true;
	});

	$("#btn-stealth").addEventListener("click", () => {
		const win = window.open("about:blank", "_blank");
		if (!win) return toast("Popup blocked — allow popups for stealth mode");
		win.document.title = "Untitled";
		const iframe = win.document.createElement("iframe");
		iframe.src = location.origin + "/";
		iframe.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
		win.document.body.style.margin = "0";
		win.document.body.appendChild(iframe);
		toast("🕶 Stealth window opened");
	});

	/* ---------------------------------------------------------------
	 * Events + misc UI
	 * ------------------------------------------------------------- */
	function err(msg) {
		$("#err").textContent = msg || "";
	}
	let toastTimer = null;
	function toast(msg) {
		const t = $("#toast");
		t.textContent = msg;
		t.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (t.hidden = true), 2600);
	}

	$("#go-form").addEventListener("submit", (e) => {
		e.preventDefault();
		hideSuggestions();
		go(address.value);
	});
	$("#shortcuts").addEventListener("click", (e) => {
		const b = e.target.closest("button[data-url]");
		if (b) go(b.dataset.url);
	});
	$("#onion-links").addEventListener("click", (e) => {
		const b = e.target.closest("button[data-url]");
		if (b) go(b.dataset.url);
	});
	$("#clear-history").addEventListener("click", () => {
		localStorage.removeItem("vx.history");
		renderHistory();
	});

	$("#btn-newtab").addEventListener("click", () => {
		const tab = createTab();
		activateTab(tab.id);
		omnibox.focus();
	});
	$("#btn-home").addEventListener("click", () => {
		browserView.hidden = true;
		homeView.hidden = false;
		applyCloak();
	});
	$("#btn-back").addEventListener("click", () => currentTab()?.frame.back());
	$("#btn-forward").addEventListener("click", () => currentTab()?.frame.forward());
	$("#btn-reload").addEventListener("click", () => currentTab()?.frame.reload());
	$("#btn-popout").addEventListener("click", () => {
		const tab = currentTab();
		if (tab?.url) window.open(proxied(tab.url), "_blank", "noopener");
	});
	$("#omnibox-form").addEventListener("submit", async (e) => {
		e.preventDefault();
		const tab = currentTab();
		if (!tab) return;
		try {
			let target = normalizeTarget(omnibox.value);
			if (isOnion(target) && !settings.tor) {
				settings.tor = true;
				saveSettings();
				await selectTransport();
				refreshTorIndicator();
				toast("🧅 Onion detected — Tor routing enabled");
			}
			tab.url = target;
			tab.onion = isOnion(target);
			renderTabs();
			omnibox.value = target;
			tab.frame.go(target);
		} catch {}
	});

	document.addEventListener("keydown", (e) => {
		if (e.ctrlKey && (e.key === "t" || e.key === "T")) {
			e.preventDefault();
			if (browserView.hidden) openBrowserView();
			else $("#btn-newtab").click();
		} else if (e.ctrlKey && (e.key === "w" || e.key === "W")) {
			if (activeTab) {
				e.preventDefault();
				closeTab(activeTab);
			}
		}
	});

	/* ---------------------------------------------------------------
	 * Init
	 * ------------------------------------------------------------- */
	// InvisiProxy rule: libcurl's WASM stack is heavy on mobile — default epoxy
	if (!localStorage.getItem("vx.settings")) {
		const ua = navigator;
		const mobile =
			ua.userAgentData?.mobile === true ||
			/Android|iPhone|iPad|iPod|Mobile/i.test(ua.userAgent) ||
			(ua.platform === "MacIntel" && ua.maxTouchPoints > 1);
		if (mobile) settings.transport = "epoxy";
	}
	applyCloak();
	renderHistory();
	if ("serviceWorker" in navigator) {
		boot().catch((e) => {
			err(
				"Engine failed to start: " +
					e.message +
					(location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname)
						? " (service workers require HTTPS)"
						: "")
			);
			setStatus("bad", "error");
		});
	} else {
		setStatus("bad", "unsupported");
		err("This browser doesn't support service workers.");
	}
})();
