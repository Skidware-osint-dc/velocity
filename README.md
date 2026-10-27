# ⚡ Velocity

A web proxy with **Ultraviolet's battle-tested architecture**, **Scramjet's high-performance rewriting engine**, **Holy Unblocker / InvisiProxy LTS**-grade egress architecture, and **Incognito-style** apps & games launcher — including **Tor / .onion routing for every transport**.

- **Engine:** [Scramjet](https://github.com/MercuryWorkshop/scramjet) (interception-based rewriter, WASM-powered JS rewriting)
- **Transports:** libcurl → wisp *(default, best TLS fingerprint — also the Tor transport)*, epoxy → wisp, or classic Bare v3 — switchable live in Settings
- **Stealth (HU-inspired):** tab cloaking, `about:blank` stealth window, panic key, multi-tab browser view, quick-launch chips
- **Tor:** route everything through a local Tor daemon — clearnet over Tor exits *and* `.onion` sites both work

## Architecture

```
browser ──service worker──▶ Scramjet rewriter (scramjet.all.js + wasm)
                │
                ▼  bare-mux connection (per-tab transport)
        ┌───────┴────────────────────────┐
   wisp /wisp/                       bare /bare/
   wispurr region workers (Go):        (v3 server)
     ''   → default worker ─────────▶ target websites (direct)
     tor/ → tor worker ──▶ socks5h://127.0.0.1:9050 ─▶ Tor network
                                                        ├─▶ clearnet exits
                                                        └─▶ .onion services
     <custom regions via REGION_*_SOCKS env>
```
Because the SOCKS hop lives **server-side in the wisp worker** (InvisiProxy LTS'
pattern), *every* wisp transport — libcurl **and** epoxy — can ride Tor and load
onions. A transparent fallback (client-side libcurl SOCKS) kicks in if the Go
workers can't start.

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

## Proxy engines

Velocity is **dual-engine** (the coexistence pattern used by Bolt-Unblocker): one service worker hosts both engines and routes by prefix.

| Engine          | Prefix       | Transport                                   | Best for                             |
| --------------- | ------------ | ------------------------------------------- | ------------------------------------ |
| **Scramjet**    | `/scramjet/` | wisp (epoxy / libcurl), Tor-capable         | default — fast, region/Tor routing   |
| **Ultraviolet** | `/uv/`       | bare server direct (no wisp → **no Tor**)   | compatibility fallback               |

Pick the engine in Settings → Proxy engine. The setting applies to **new tabs** — existing tabs keep the engine they were created with. Turning Tor on forces Scramjet (Ultraviolet has no SOCKS path since it talks to the bare server directly).

### Head-to-head (load-to-rendered, local server)

| Site          | Scramjet | Ultraviolet |
| ------------- | -------- | ----------- |
| example.com   | 0.74 s   | 0.75 s      |
| YouTube       | 1.9 s    | 8.2 s       |
| Discord login | 1.0 s    | 1.8 s       |
| TikTok        | 1.0 s    | 1.5 s       |
| GeForce NOW   | 2.3 s    | 1.2 s       |
| now.gg        | 1.1 s    | 1.2 s       |

Both engines rendered every tested site. Scramjet is measurably faster on JavaScript-heavy pages (its rewriting is lazy/streamed); Ultraviolet stays as a one-click fallback for anything Scramjet hits a snag on.

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

- Toggle **"Route traffic through Tor"** in Settings — indicators in the home nav
  *and* the browser toolbar report daemon reachability (`/api/tor/status`) plus
  whether egress rides the server-side region or the client-side SOCKS fallback.
- Typing a `*.onion` URL (or clicking an onion quick-link) **auto-enables Tor**.
- With the bundled `wispurr` server, Tor is a **region** (`/wisp/tor/`) and works
  on libcurl *or* epoxy — great on mobile, where Velocity auto-defaults to epoxy.
- If the Go workers can't spawn, Velocity falls back to wisp-js + the classic
  Holy Unblocker wiring (client-side `proxy: socks5h://…`, which forces libcurl).
- Extra regions: set `REGION_EU_SOCKS=socks5h://127.0.0.1:7000` (etc.) and the
  server hosts `/wisp/eu/` automatically. A custom `wss://…` wisp endpoint can
  also be set per-user in Settings ("Custom wisp server").
- `TOR_SOCKS=host:port` repoints the status probe; the `Dockerfile` bundles tor
  and starts it via `scripts/start.sh` (`ENABLE_TOR=0` disables it).

**Hardening** (also lifted from InvisiProxy's wisp config): UDP streams off,
direct/private-IP egress off, mail ports (25/465/587) blacklisted, per-IP
connection caps + flood protection, and websocket upgrades are rejected unless
they originate from this site itself (no third-party wisp hijacking).
Onion trust-model and fingerprinting caveats of Tor Browser still apply —
this is a proxy through Tor, not Tor Browser.

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

- **Multiple tabs** — `Ctrl+T` new tab, `Ctrl+W` close, purple-dot onion tabs
- **Tab disguise** — retitle the browser tab as Google, Classroom, Docs, or custom
- **Panic key** — press `` ` `` (configurable) to instantly navigate the whole tab away
- **Stealth window** — one click embeds Velocity in a full-window `about:blank` iframe
- **History** — recent sites as launcher chips, clearable
- **Apps & Games library** — 23-tile launcher (cloud gaming, social, tools);
  every tile opens *through the proxy* (Incognito-style, minus the downloads)

## Settings

Stored in `localStorage` (`vx.settings`): Tor toggle, transport, search engine,
codec (`xor` stealth / `plain` readable URLs), open mode (framed vs fullscreen
tab), tab disguise, panic key/target. History lives in `vx.history`.

## Credits & licenses
- [Bolt-Unblocker](https://github.com/Bolt-Network/Bolt-Unblocker) — dual-engine coexistence pattern + apps-grid grouping idea
- [Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet) by Titanium Network (MIT) — dual-engine fallback engine (vendored bundle)

- [Scramjet](https://github.com/MercuryWorkshop/scramjet) — Mercury Workshop (MIT / AGPL bundled components)
- [Ultraviolet](https://github.com/titaniumnetwork-dev/ultraviolet) — Titanium Network (design lineage)
- [Holy Unblocker](https://github.com/browser-vm/Holy-Unblocker) / [InvisiProxy LTS](https://github.com/InvisiProxy/InvisiProxyLTS) — the Tor wiring lineage, evolved here into server-side wisp regions with hardening config; mobile→epoxy transport rule
- [Incognito](https://github.com/amethystnetwork-dev/Incognito) — apps & games launcher concept, deploy-time site-lock pattern
- [wispurr](https://github.com/sylvieisnton/wispurr) — Go wisp server with per-region upstream proxies
- [bare-mux](https://github.com/MercuryWorkshop/bare-mux), epoxy, libcurl-transport, wisp-js — Mercury Workshop
- [@tomphttp/bare-server-node](https://github.com/tomphttp/bare-server-node) (MIT)

For legitimate, educational, and privacy uses. Don't use it to break rules you're bound by.
