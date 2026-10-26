/**
 * Velocity service worker.
 * Scramjet 1.1 bundles controller+worker+client into scramjet.all.js.
 */
importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

async function handleRequest(event) {
	await scramjet.loadConfig();
	if (scramjet.route(event)) {
		return scramjet.fetch(event);
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
