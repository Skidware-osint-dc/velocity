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
	const wispURL = () =>
		(location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/";
	const TRANSPORTS = {
		libcurl: () => ["/libcurl/index.mjs", [{ websocket: wispURL() }]],
		epoxy: () => ["/vendor/epoxy/index.mjs", [{ wisp: wispURL() }]],
		bare: () => ["/baremod/index.mjs", [location.origin + "/bare/"]],
		// Tor: libcurl speaks SOCKS5 through the wisp tunnel into the local
		// Tor daemon. socks5h => hostname resolution happens at the proxy
		// (required for .onion).
		tor: () => ["/libcurl/index.mjs", [{ websocket: wispURL(), proxy: TOR_PROXY }]],
	};
	const effectiveTransport = () => (settings.tor ? "tor" : settings.transport);

	async function selectTransport() {
		const [mod, opts] = (TRANSPORTS[effectiveTransport()] || TRANSPORTS.libcurl)();
		if ((await connection.getTransport()) !== mod || mod === "/libcurl/index.mjs") {
			// always re-set for libcurl so a proxy option flip takes effect
			await connection.setTransport(mod, opts);
		}
	}

	function setStatus(state, text) {
		const el = $("#status");
		el.className = "status status-" + state;
		el.textContent = text;
	}

	async function refreshTorIndicator() {
		const el = $("#tor-indicator");
		if (!settings.tor) {
			el.hidden = true;
			return;
		}
		el.hidden = false;
		try {
			const r = await fetch("/api/tor/status").then((r) => r.json());
			if (r.running) {
				el.className = "status status-ok";
				el.innerHTML = TOR_ICON + " tor online";
			} else {
				el.className = "status status-bad";
				el.innerHTML = TOR_ICON + " tor offline";
			}
		} catch {
			el.className = "status status-warn";
			el.textContent = "🧅 tor ?";
		}
	}

	async function boot() {
		if (ready) return;
		if (booting) return booting;
		booting = (async () => {
			setStatus("warn", "starting…");
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
		// Tor forces the libcurl transport (it's the only one with SOCKS5 support)
		$("#set-transport").disabled = settings.tor;
		if (settings.tor) $("#set-transport").value = "libcurl";
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
		saveSettings();
		applyCloak();
		modal.hidden = true;
		try {
			await boot();
			await selectTransport(); // transport AND tor both live here
			refreshTorIndicator();
			if (settings.tor) toast("🧅 Tor routing on — traffic exits via Tor");
			// re-navigate the active tab so the new transport takes effect immediately
			const tab = currentTab();
			if (tab && tab.url) tab.frame.go(tab.url);
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
