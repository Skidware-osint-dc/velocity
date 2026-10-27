/**
 * Velocity service worker — DUAL ENGINE (Bolt-Unblocker pattern).
 * Scramjet 1.1 handles /scramjet/ (default engine, Tor-capable via wisp),
 * Ultraviolet handles /uv/ (compatibility fallback engine, direct via bare).
 */
importScripts("/scram/scramjet.all.js");
importScripts("/uvfiles/uv.bundle.js");
importScripts("/uvfiles/uv.config.js");
importScripts("/uvfiles/uv.sw.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const uv = new UVServiceWorker(self.__uv$config);

async function handleRequest(event) {
	try {
		if (uv.route(event)) return await uv.fetch(event);
		await scramjet.loadConfig().catch((err) => console.error("Scramjet config load failed", err));
		if (scramjet.route(event)) return await scramjet.fetch(event);
	} catch (error) {
		console.error("Proxy error:", error);
	}
	return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});

// Force a config reload (recompiles codecs from IndexedDB) when the page asks.
// Needed because Scramjet's built-in loadConfig message only swaps this.config
// without recompiling the codec functions.
self.addEventListener("message", (event) => {
	if (event.data && event.data.scramjet$type === "vx:reloadConfig") {
		event.waitUntil(
			(async () => {
				scramjet.config = null;
				await scramjet.loadConfig();
			})()
		);
	}
});
