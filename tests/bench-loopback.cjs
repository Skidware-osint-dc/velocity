const CHROME = process.env.CHROME_PATH || "/home/user/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const BASE = process.env.VELOCITY_URL || "http://localhost:8080";
const { chromium } = require("/tmp/node_modules/playwright-core");
(async () => {
	const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
	const page = await browser.newPage();
	await page.goto("http://localhost:8080/", { waitUntil: "load", timeout: 15000 });
	await page.waitForSelector("#status.status-ok", { timeout: 30000 });

	async function run(name, mod, opts) {
		return page.evaluate(async ({ mod, opts }) => {
			try {
				const c = new self.BareMux.BareMuxConnection("/baremux/worker.js");
				try { await c.setTransport(mod, opts); } catch (e) { return { error: "setTransport: " + String(e).slice(0, 90) }; }
				const bare = new self.BareMux.BareClient();
				await bare.fetch("http://127.0.0.1:8998/?bytes=1024").catch(() => {}); // warm
				// stream full 100MiB file, count bytes via ReadableStream (no memory copy)
				const t0 = performance.now();
				const SIZE = 32 << 20;
				let f = await bare.fetch(`http://127.0.0.1:8998/?bytes=${SIZE}&nc=${Math.random()}`, { cache: "no-store" });
				const reader = f.body.getReader();
				let bytes = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
				}
				const ms = performance.now() - t0;
				return { bytes, ms: Math.round(ms), mbps: +((bytes / 1048576) / (ms / 1000)).toFixed(1), status: f.status };
			} catch (e) {
				return { error: String(e).split("\n")[0].slice(0, 110) };
			}
		}, { mod, opts }).catch((e) => ({ error: String(e.message || e).split("\n")[0].slice(0, 110) }));
	}

	const TRANSPORTS = [
		["libcurl stock", "/libcurl/index.mjs", [{ websocket: "ws://localhost:8080/wisp/bench/" }]],
		["epoxy stock", "/vendor/epoxy/index.mjs", [{ wisp: "ws://localhost:8080/wisp/bench/" }]],
		["⚡ turbo", "/vendor/turbo/index.mjs", [{ wisp: "ws://localhost:8080/wisp/bench/", connections: [250, 64] }]],
	];

	const agg = {};
	for (let t = 0; t < 3; t++) {
		for (const [name, mod, opts] of TRANSPORTS) {
			const r = await run(name, mod, opts);
			if (r.error) console.log(`${name} t${t} ❌ ${r.error}`);
			else {
				(agg[name] ??= []).push(r.mbps);
				console.log(`${name.padEnd(15)} t${t}: ${r.mbps} MB/s (${(r.bytes / 1048576).toFixed(0)}MB streamed in ${(r.ms / 1000).toFixed(1)}s, http${r.status})`);
			}
		}
	}
	console.log("\n──── medians ────");
	for (const [n, arr] of Object.entries(agg)) console.log(`${n.padEnd(15)} median ${arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)]} MB/s`);
	await browser.close();
})();
