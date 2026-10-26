# ⚡ Velocity

A web proxy with **Ultraviolet's battle-tested architecture**, **Scramjet's high-performance rewriting engine**, and **Holy Unblocker–style stealth features** — including **Tor / .onion routing**.

- **Engine:** [Scramjet](https://github.com/MercuryWorkshop/scramjet) (interception-based rewriter, WASM-powered JS rewriting)
- **Transports:** libcurl → wisp *(default, best TLS fingerprint — also the Tor transport)*, epoxy → wisp, or classic Bare v3 — switchable live in Settings
- **Stealth (HU-inspired):** tab cloaking, `about:blank` stealth window, panic key, multi-tab browser view, quick-launch chips
- **Tor:** route everything through a local Tor daemon — clearnet over Tor exits *and* `.onion` sites both work

## Architecture

```
browser ──service worker──▶ Scramjet rewriter (scramjet.all.js + wasm)
                │
                ▼  bare-mux connection (per-tab transport)
        ┌───────┴──────────────────┐
   wisp /wisp/                 bare /bare/
   (libcurl / epoxy transports)    (v3 server)
        │
        ▼  libcurl may attach a SOCKS5 proxy:
   tor daemon (127.0.0.1:9050) ──▶ Tor network ──▶ clearnet exits & .onion services
        └───────────────────────────────────────▶ target websites (direct)
```

| Path | Purpose |
| ---- | ------- |
| `/scramjet/` | proxy prefix (encoded URLs live here) |
| `/scram/` | Scramjet engine assets |
| `/baremux/`, `/libcurl/`, `/epoxy/`, `/baremod/` | bare-mux + transports |
| `/wisp/` | wisp websocket endpoint (libcurl/epoxy) |
| `/bare/` | Bare v3 endpoint (compat transport) |
| `/suggest?q=` | DuckDuckGo autocomplete proxy |
| `/api/tor/status` | `{running, socks}` — probes the Tor SOCKS port |
| `/healthz` | health + version info (+ `wisp`, `tor` fields) |

## Tor / onion support 🧅

Velocity implements the same approach as Holy Unblocker LTS: browser traffic
tunnels through the wisp connection, and libcurl attaches to a local Tor
daemon via `socks5h://127.0.0.1:9050` (the `h` is important — `.onion`
hostnames resolve **inside** the Tor network, never locally).

**Run it:**

```sh
sudo apt install tor                  # or: brew install tor / apk add tor
tor --SocksPort 127.0.0.1:9050       # any SOCKS5 tor daemon works
npm install && npm start
```

- Toggle **"Route traffic through Tor"** in Settings — a purple 🧅 indicator in the
  header reports the daemon's reachability (checked via `/api/tor/status`).
- Typing a `*.onion` URL (or clicking one of the onion quick-links) **auto-enables
  Tor** and switches transports for you.
- Tor forces the **libcurl** transport (it's the only transport with SOCKS proxy
  support); epoxy/bare don't proxy. Toggling Tor on/off reconfigures the transport
  live, without a reload.
- `TOR_SOCKS=host:port` env var points the status probe at an external Tor daemon
  (e.g. a sidecar container or `tor:9050` in a compose network).
- The included `Dockerfile` bundles tor and starts it via `scripts/start.sh`
  (`ENABLE_TOR=0` disables it).

**Heads up:** the server enables `allow_loopback_ips` on the wisp endpoint so the
libcurl ↔ Tor SOCKS hop on `127.0.0.1:9050` can connect. This does **not** expose
user traffic to loopback — wisp traffic is initiated by your own transport
sessions, not arbitrary user requests — but be aware if you customize wisp rules.
Onion service trust-model/fingerprint caveats of Tor Browser still apply; this is
a proxy through Tor, not Tor Browser.

## Run it

```sh
npm install
npm start          # listens on 0.0.0.0:8080 (PORT to override)
```

Open `http://localhost:8080`. Service workers require HTTPS (or localhost), so put it
behind TLS for real deployments.

## Deploy notes

- Needs a host that supports **WebSocket upgrades** (wisp + bare both use them):
  a VPS, Railway, Render (web service), Fly.io, Koyeb…
- **Vercel/Netlify/CF Pages won't work** — no raw websockets / long-lived sockets.
- A `Dockerfile` is included for container deploys (Tor daemon bundled inside).
- Proxying heavy traffic from one datacenter IP gets rate-limited/CAPTCHAd by big
  sites (YouTube, Google). Residential-ish egress or IP rotation helps.
- Onion rendezvous can be slow on first contact (16–60s for a cold descriptor);
  subsequent loads are much faster.
- This is an *open* proxy to anywhere — don't expose it publicly without access
  control. Add auth/IP allowlists before you share a URL.

## Stealth features

- **Multiple tabs** — `Ctrl+T` new tab, `Ctrl+W` close, click purple-dot onion tabs
- **Tab disguise** — retitle the browser tab as Google, Classroom, Docs, or custom
- **Panic key** — press `` ` `` (configurable) to instantly navigate the whole tab away
- **Stealth window** — one click embeds Velocity in a full-window `about:blank` iframe
- **History** — recent sites as launcher chips, clearable

## Settings

Stored in `localStorage` (`vx.settings`): Tor toggle, transport, search engine,
codec (`xor` stealth / `plain` readable URLs), open mode (framed vs fullscreen
tab), tab disguise, panic key/target. History lives in `vx.history`.

## Credits & licenses

- [Scramjet](https://github.com/MercuryWorkshop/scramjet) — Mercury Workshop (MIT / AGPL bundled components)
- [Ultraviolet](https://github.com/titaniumnetwork-dev/ultraviolet) — Titanium Network (design lineage)
- [Holy Unblocker](https://github.com/browser-vm/Holy-Unblocker) — the Tor wiring approach (`proxy: 'socks5h://localhost:9050'`) and stealth UX lineage
- [bare-mux](https://github.com/MercuryWorkshop/bare-mux), epoxy, libcurl-transport, wisp-js — Mercury Workshop
- [@tomphttp/bare-server-node](https://github.com/tomphttp/bare-server-node) (MIT)

For legitimate, educational, and privacy uses. Don't use it to break rules you're bound by.
