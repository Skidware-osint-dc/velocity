// src/wisp.js — wisp hosting with per-region upstream SOCKS proxies.
//
// Architecture follows InvisiProxy LTS (née Holy Unblocker LTS): one wispurr
// (Go) worker per "region". The default region tunnels directly; named regions
// (e.g. tor, eu, jp) attach an upstream proxy to that worker, so the browser
// client picks an egress by simply pointing its transport at /wisp/<region>/.
// Region X client-side proxy settings are unnecessary — which means Tor works
// with ANY transport (epoxy included), not just libcurl.
//
// Security posture (borrowed from InvisiProxy's wisp.ts):
//   - UDP streams off (DNS-amplification / abuse surface)
//   - direct-IP, private-IP egress off (blocks LAN pivot / metadata services)
//   - mail ports blacklisted (25/465/587 — no spam relay through our exit)
//   - per-IP connection caps + flood protection on
//   - loopback stays ALLOWED only because the tor worker's upstream is
//     socks5h://127.0.0.1:9050 (stream destinations still get validated)
import { wispurr } from "wispurr";

const BASE_PORT = 14431; // internal workers; never exposed directly

export const TOR_SOCKS_URL = "socks5h://127.0.0.1:9050";

// extra regions can be enabled by pointing WISP_REGIONS_json-style env vars at
// local SOCKS daemons, e.g. REGION_EU_SOCKS=socks5h://127.0.0.1:7000
export function regionProxies() {
	const map = { tor: process.env.TOR_SOCKS_URL || TOR_SOCKS_URL };
	for (const [key, val] of Object.entries(process.env)) {
		if (key.startsWith("REGION_") && key.endsWith("_SOCKS") && val)
			map[key.slice(7, -6).toLowerCase()] = val;
	}
	return map;
}

const baseOptions = () => ({
	port: BASE_PORT,
	host: "127.0.0.1",
	allowTCP: true,
	allowUDP: false,
	allowDirectIP: false,
	allowPrivateIPs: false,
	allowLoopbackIPs: true, // the tor worker must reach 127.0.0.1:9050
	tcpBufferSize: 1048576,
	socketBufferSize: 33554432,
	pendingQueueSize: 268435456,
	bufferRemainingLength: 32768,
	tcpNoDelay: true,
	blacklist: { hostnames: [], ports: [25, 465, 587] },
	whitelist: { hostnames: [], ports: [] },
	enableV2: true,
	enableTwisp: false,
	handshakeTimeoutSeconds: 10,
	parseRealIP: true,
	trustedProxies: ["127.0.0.1", "::1"],
	logLevel: "error",
	proxy: "",
	bandwidthLimitKbps: 0,
	connectionsLimitPerIP: 200,
	connectionWindowSeconds: 10,
	floodProtection: { enabled: true, logBlockedDials: true },
	reputation: { enabled: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RegionWisp {
	constructor(name, proxy = "") {
		this.name = name;
		this.proxy = proxy;
		this.opts = { ...baseOptions(), proxy };
		this.wisp = null;
		this.live = false;
		this.stopped = false;
		this.attempt = 0;
	}

	async start() {
		while (!this.stopped) {
			try {
				const w = new wispurr(this.opts);
				await w.start(1);
				this.wisp = w;
				this.live = true;
				console.log(`[wisp:${this.name}] listening on 127.0.0.1:${w.ports[0]}${this.proxy ? ` → ${this.proxy}` : ""}`);
				for (const { process: proc } of w.processes ?? []) {
					proc.once("close", () => this.restart());
					proc.once("exit", () => {
						this.live = false;
					});
				}
				return true;
			} catch (e) {
				console.error(`[wisp:${this.name}] failed to start:`, e.message);
				await sleep(Math.min(500 * 2 ** this.attempt++, 10_000));
			}
		}
		return false;
	}

	restart() {
		if (this.stopped) return;
		this.live = false;
		console.error(`[wisp:${this.name}] worker died — respawning`);
		setTimeout(() => void this.start(), Math.min(500 * 2 ** this.attempt++, 10_000)).unref?.();
	}

	get ready() {
		return this.live && this.wisp?.isRunning;
	}

	route(req, socket, head) {
		this.wisp.route(req, socket, head);
	}

	async stop() {
		this.stopped = true;
		try {
			this.wisp?.kill();
		} catch {}
	}
}

// Spawn the default worker + one worker per configured region.
// Returns { default: RegionWisp, regions: Map<name, RegionWisp> } or null on
// total failure (caller then falls back to wisp-js).
export async function startWispRegionPool() {
	const proxies = regionProxies();
	const defaultWisp = new RegionWisp("default");
	const regions = new Map();
	try {
		await defaultWisp.start();
	} catch {
		return null;
	}
	for (const [region, proxy] of Object.entries(proxies)) {
		// the tor worker spawns even if the Tor daemon is momentarily down —
		// SOCKS connections are established lazily per stream
		const rw = new RegionWisp(region, proxy);
		regions.set(region, rw);
		rw.start().catch(() => {});
	}
	return { default: defaultWisp, regions };
}
