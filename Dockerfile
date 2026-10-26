FROM node:20-alpine
# tor provides the SOCKS5 daemon used for onion / Tor routing
RUN apk add --no-cache tor && mkdir -p /var/lib/tor && chmod 700 /var/lib/tor
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN chmod +x scripts/start.sh
ENV PORT=8080 TOR_SOCKS=127.0.0.1:9050
EXPOSE 8080
CMD ["sh", "scripts/start.sh"]
