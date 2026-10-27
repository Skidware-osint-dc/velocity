const CHROME = process.env.CHROME_PATH || "/home/user/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const BASE = process.env.VELOCITY_URL || "http://localhost:8080";
const { chromium } = require("/tmp/node_modules/playwright-core");
(async () => {
	const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
	const page = await browser.newPage();
	await page.goto("http://localhost:8080/", { waitUntil: "load" });
	await page.waitForSelector("#status.status-ok", { timeout: 30000 });
	const runs = [];
	for (let t = 0; t < 3; t++) {
		for (const [name, mod, opts] of [
			["libcurl stock", "/libcurl/index.mjs", [{ websocket: "ws://localhost:8080/wisp/" }]],
			["epoxy stock", "/vendor/epoxy/index.mjs", [{ wisp: "ws://localhost:8080/wisp/" }]],
			["⚡ turbo@turbo-region", "/vendor/turbo/index.mjs", [{ wisp: "ws://localhost:8080/wisp/turbo/", connections: [250, 64] }]],
		]) {
			const r = await page.evaluate(async ({ mod, opts }) => {
				try {
					const c = new self.BareMux.BareMuxConnection("/baremux/worker.js");
					await c.setTransport(mod, opts);
					const bare = new self.BareMux.BareClient();
					const t0 = performance.now();
					const f = await bare.fetch("https://speed.cloudflare.com/__down?bytes=8388608&nc=" + Math.random(), { cache: "no-store" });
					const reader = f.body.getReader();
					let bytes = 0;
					for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; }
					const ms = performance.now() - t0;
					return { bytes, ms: Math.round(ms), mbps: +((bytes / 1048576) / (ms / 1000)).toFixed(1), status: f.status };
				} catch (e) { return { error: String(e).split("\n")[0].slice(0, 100) }; }
			}, { mod, opts }).catch((e) => ({ error: String(e.message || e).split("\n")[0].slice(0, 100) }));
			if (r.error) console.log(`${name.padEnd(22)} t${t} ❌ ${r.error}`);
			else console.log(`${name.padEnd(22)} t${t}: ${r.mbps} MB/s (${r.bytes}B in ${r.ms}ms, http${r.status})`);
			runs.push([name, r.mbps || 0]);
		}
	}
	const by = {};
	runs.forEach(([n, v]) => (by[n] ??= []).push(v));
	console.log("\nmedian MB/s (8MB streamed, cloudflare)");
	for (const [n, a] of Object.entries(by)) console.log(`${n.padEnd(22)} ${a.sort((x, y) => x - y)[Math.floor(a.length / 2)]}  (runs: ${a.join(", ")})`);
	await browser.close();
})();
