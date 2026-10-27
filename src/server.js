/**
 * Velocity — a stable, fast web proxy
 * Rewriting engine: Scramjet   |   Backbone architecture: Ultraviolet-style
 *
 * Transports (switchable at runtime from the UI):
 *   - libcurl  (wisp, Firefox-grade TLS fingerprint)  [default]
 *   - epoxy    (wisp, lightweight rust TLS)
 *   - bare     (classic Bare v3, maximum compatibility)
 *
 * Egress "regions" (InvisiProxy LTS pattern): the wisp server itself owns the
 * upstream proxy, so ANY transport can ride Tor — see src/wisp.js.
 */
import express from "express";
import compression from "compression";
import { createServer } from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { createBareServer } from "@tomphttp/bare-server-node";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { startWispRegionPool } from "./wisp.js";

const TOR_SOCKS = process.env.TOR_SOCKS || "127.0.0.1:9050";
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const SITE_USER = process.env.SITE_USER || "user";

logging.set_level(process.env.WISP_LOG === "info" ? logging.INFO : logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	// Legacy fallback only (when wispurr can't spawn). Loopback opened here so the
	// client-side libcurl proxy option can still reach the local Tor SOCKS port.
	allow_loopback_ips: true,
});

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

function pkgDir(name) {
  const direct = path.join(ROOT, "node_modules", name);
  if (fs.existsSync(path.join(direct, "package.json"))) return direct;
  let entry = path.dirname(require.resolve(name));
  while (!fs.existsSync(path.join(entry, "package.json"))) {
    const up = path.dirname(entry);
    if (up === entry) throw new Error(`cannot locate package ${name}`);
    entry = up;
  }
  return entry;
}

const paths = {
  scram: scramjetPath,
  baremux: baremuxPath,
  libcurl: path.join(pkgDir("@mercuryworkshop/libcurl-transport"), "dist"),
  epoxy: path.join(pkgDir("@mercuryworkshop/epoxy-transport"), "dist"),
  baremod: path.join(pkgDir("@mercuryworkshop/bare-as-module3"), "dist"),
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", p, "package.json"), "utf8")).version;

const app = express();
app.disable("x-powered-by");

// COOP/COEP are required by Scramjet-client features (and match the reference impl).
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// Optional site lock (Incognito-style deploy protection): set SITE_PASSWORD to
// gate everything behind HTTP Basic auth. SITE_USER customizes the username.
app.use((req, res, next) => {
	if (!SITE_PASSWORD || req.path === "/healthz") return next();
	const h = String(req.headers.authorization || "");
	if (h.toLowerCase().startsWith("basic ")) {
		const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
		const i = decoded.indexOf(":");
		const u = decoded.slice(0, i), p = decoded.slice(i + 1);
		if ((!process.env.SITE_USER || u === SITE_USER) && p === SITE_PASSWORD) return next();
	}
	res.setHeader("WWW-Authenticate", 'Basic realm="Velocity"');
	res.status(401).send("🔒 Velocity is locked.");
});

app.use(compression());

// ---- static engine / transport assets (immutable, fingerprinted by version) ----
const STATIC_OPTS = { immutable: true, maxAge: "7d", index: false, fallthrough: true };
app.use("/scram/", express.static(paths.scram, STATIC_OPTS));
app.use("/baremux/", express.static(paths.baremux, STATIC_OPTS));
app.use("/libcurl/", express.static(paths.libcurl, STATIC_OPTS));
app.use("/epoxy/", express.static(paths.epoxy, STATIC_OPTS));
app.use("/baremod/", express.static(paths.baremod, STATIC_OPTS));
app.use(express.static(PUBLIC, { index: "index.html", fallthrough: true, maxAge: 0 }));

// ---- search suggestions (server-side to dodge CORS) ----
const suggCache = new Map(); // q -> {at, data}
app.get("/suggest", async (req, res) => {
  const q = String(req.query.q ?? "").slice(0, 120);
  if (!q.trim()) return res.json([]);
  const hit = suggCache.get(q);
  if (hit && Date.now() - hit.at < 60_000) return res.json(hit.data);
  try {
    const r = await fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36" },
      signal: AbortSignal.timeout(4000),
    });
    const raw = await r.json();
    // DDG "type=list" shape: [query, [phrases...]]; older shape: [{phrase}...]
    let data = [];
    if (Array.isArray(raw) && Array.isArray(raw[1])) data = raw[1];
    else if (Array.isArray(raw)) data = raw.map((x) => x && x.phrase);
    data = data.filter((x) => typeof x === "string").slice(0, 8);
    if (suggCache.size > 500) suggCache.delete(suggCache.keys().next().value);
    suggCache.set(q, { at: Date.now(), data });
    res.json(data);
  } catch {
    res.json([]);
  }
});

// what the client is allowed to do, decided server-side
app.get("/api/capabilities", (req, res) => {
	res.json({
		wispEngine: wispPool ? "wispurr" : "wisp-js",
		regions: wispPool ? ["", ...wispPool.regions.keys()] : [""],
		torMode: wispPool?.regions.has("tor") ? "server" : "client",
		customWispAllowed: true,
		siteLocked: !!SITE_PASSWORD,
	});
});

app.get("/healthz", (req, res) => {
	res.json({
		ok: true,
		name: "velocity",
		version: pkg.version,
		uptime: Math.round(process.uptime()),
		wisp: wispPool ? "wispurr" : "wisp-js",
		regions: wispPool ? ["", ...wispPool.regions.keys()] : [""],
		tor: Date.now() - torState.at < 30_000 ? torState.running : null, // refreshes via /api/tor/status
		engines: {
			scramjet: read("@mercuryworkshop/scramjet"),
			baremux: read("@mercuryworkshop/bare-mux"),
		},
	});
});

// Tor status — can we reach the local SOCKS5 port?
const torState = { at: 0, running: false };
app.get("/api/tor/status", async (req, res) => {
	if (Date.now() - torState.at < 3_000) return res.json({ running: torState.running, socks: TOR_SOCKS });
	const [host, port] = TOR_SOCKS.split(":");
	const alive = await new Promise((resolve) => {
		const sock = net.connect(Number(port), host);
	sock.setTimeout(1500);
		const done = (ok) => {
			sock.destroy();
			resolve(ok);
		};
		sock.on("connect", () => done(true));
		sock.on("timeout", () => done(false));
		sock.on("error", () => done(false));
	});
	torState.at = Date.now();
	torState.running = !!alive;
	res.json({ running: torState.running, socks: TOR_SOCKS });
});

// pretty 404 for everything else
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, "404.html")));

// ---- bare (compatibility transport) + wiring ----
// default limiter is 10 conns/IP/min — unrealistic for modern pages that fan
// out dozens of subrequests through the bare transport
const bare = createBareServer("/bare/", {
	logErrors: false,
	connectionLimiter: { maxConnectionsPerIP: 500, windowDuration: 60, blockDuration: 10 },
});

// ---- wisp: spawn region workers (InvisiProxy LTS pattern) ----
let wispPool = null;
try {
	wispPool = await startWispRegionPool();
} catch (e) {
	console.error("[wisp] wispurr unavailable — falling back to wisp-js:", e.message);
}

const WISP_BASE = "/wisp/";
const wispRegionOf = (url) => {
	const p = String(url || "").split(/[?#]/)[0];
	if (p === WISP_BASE) return "";
	if (p.startsWith(WISP_BASE) && p.endsWith("/")) {
		const r = p.slice(WISP_BASE.length, -1);
		if (wispPool?.regions.has(r)) return r;
	}
	return null;
};

// reject upgrades that don't originate from our own site — closes the classic
// "steal someone's wisp endpoint for a different proxy" abuse vector
function fromOwnSite(req) {
	const { origin, host } = req.headers;
	if (!origin) return true; // non-browser clients (curl/scripts) have no origin
	try {
		return new URL(origin).hostname === new URL(`http://${host}`).hostname;
	} catch {
		return false;
	}
}

const server = createServer();
server.on("request", (req, res) => {
  if (bare.shouldRoute(req)) bare.routeRequest(req, res);
  else app(req, res);
});
server.on("upgrade", (req, socket, head) => {
	try {
		if (bare.shouldRoute(req)) return bare.routeUpgrade(req, socket, head);
		if (!fromOwnSite(req)) return socket.destroy();
		const region = wispRegionOf(req.url);
		if (region !== null && wispPool) {
			req.url = WISP_BASE; // strip region suffix; worker owns the proxy choice
			const target = region ? wispPool.regions.get(region) : wispPool.default;
			if (target?.ready) return target.route(req, socket, head);
			return socket.destroy();
		}
		// legacy fallback: wisp-js, no region support (Tor via client-side proxy)
		if (!wispPool && req.url?.endsWith("/wisp/")) return wisp.routeRequest(req, socket, head);
		socket.end();
	} catch {
		socket.destroy();
	}
});

const port = Number(process.env.PORT) || 8080;
server.listen(port, "0.0.0.0", () => {
  console.log(`⚡ Velocity proxy listening on http://0.0.0.0:${port}`);
  console.log(`   engine:   Scramjet ${read("@mercuryworkshop/scramjet")}`);
  console.log(`   wisp:     /wisp/ (${wispPool ? "wispurr; regions: " + (wispPool.regions.size ? [...wispPool.regions.keys()].join(",") : "none") : "wisp-js fallback"})   bare: /bare/`);
  console.log(`   features: ${SITE_PASSWORD ? "site-locked" : "open"} · tor upstream: ${TOR_SOCKS}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    if (wispPool) {
      wispPool.default.stop();
      for (const r of wispPool.regions.values()) r.stop();
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 300);
  });
}
