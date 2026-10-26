#!/bin/sh
# Velocity start script: launches the Tor daemon (for onion/Tor routing) and the proxy server.
# Set ENABLE_TOR=0 to skip Tor, or TOR_SOCKS=host:port to point at an external Tor daemon.
set -e

if [ "${ENABLE_TOR:-1}" = "1" ]; then
	echo "[start] launching tor daemon on 127.0.0.1:9050"
	tor --SocksPort 127.0.0.1:9050 \
		--DataDirectory /app/.tor-data \
		--KeepalivePeriod 60 \
		--Log "notice stdout" &
fi

echo "[start] launching velocity proxy"
exec node src/server.js
