/**
 * Velocity Turbo transport (proxy-transports interface for bare-mux).
 *
 * Core engine: upstream libcurl.js 0.7.4 / libcurl-transport 2.0.5 build,
 * vendored unmodified (libcurl-core.mjs, LGPL-3.0, see LICENSE-libcurl.txt).
 * NOTE: the 2.0.6 dist (libcurl.js 0.7.5) silently stalls Scramjet page
 * boots — do not "upgrade" this core without re-running the UI e2e.
 *
 * What Turbo actually changes (the "handle more data" part):
 *  - connection pool raised: [250 total, 64 per host] vs libcurl's ~50 total
 *    — lots of concurrent streams survive heavy pages (video chunks, CDNs).
 *  - it is pointed at the server's "/wisp/turbo/" region, whose wispurr worker
 *    advertises 32x bigger flow-control windows (bufferRemainingLength 1MB vs
 *    32KB) plus 4x socket buffers — far fewer CONTINUE round-trips per MB.
 *
 * TLS fingerprint note: libcurl.js ships BoringSSL (not curl-impersonate), so
 * the ClientHello stays curl-flavored. Changing that needs a wasm rebuild of
 * curl with the curl-impersonate patchset — explicitly parked as future work.
 */
import LibcurlClient from "./libcurl-core.mjs";

// bare-mux passes plain header objects; upstream 2.0.6 iterates headers
// directly (entries). Normalize both call sites.
const asEntries = (headers) =>
	headers && typeof headers[Symbol.iterator] !== "function" ? Object.entries(headers) : headers;

export default class TurboTransport extends LibcurlClient {
	constructor(options = {}) {
		super({
			...options,
			// [max_total_connections, max_per_host]
			connections: options.connections ?? [250, 64],
		});
	}

	async request(remote, method, body, headers, signal) {
		return super.request(remote, method, body, asEntries(headers), signal);
	}

	connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
		return super.connect(url, protocols, asEntries(requestHeaders), onopen, onmessage, onclose, onerror);
	}
}
