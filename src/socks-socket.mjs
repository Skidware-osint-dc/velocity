// src/socks-socket.mjs — wisp-js custom TCPSocket that dials through an
// upstream SOCKS5 proxy WHILE PRESERVING THE DESTINATION HOSTNAME.
//
// Why this exists: wispurr's Go workers (and wisp-js's NodeTCPSocket) resolve
// DNS locally and connect by IP. That's fast, but it makes .onion impossible —
// onion names don't resolve with system DNS, and Tor needs the hostname
// (socks "ATYP domain"), not an IP. This class hands the hostname straight to
// the SOCKS5 upstream, which is exactly what `curl --socks5-hostname` does.
//
// Mirrors wisp-js's NodeTCPSocket interface:
//   constructor(hostname, port), connect(), recv(), send(), close(), pause(), resume()
import { SocksClient } from "socks";

class BoundedQueue {
	constructor(max_size) {
		this.max_size = max_size;
		this.queue = [];
		this.put_callbacks = [];
		this.get_callbacks = [];
	}
	put_now(data) {
		this.queue.push(data);
		this.get_callbacks.shift()?.();
	}
	async put(data) {
		if (this.size <= this.max_size) return this.put_now(data);
		await new Promise((resolve) => this.put_callbacks.push(resolve));
		this.put_now(data);
	}
	get_now() {
		this.put_callbacks.shift()?.();
		return this.queue.shift();
	}
	async get() {
		if (this.size > 0) return this.get_now();
		await new Promise((resolve) => this.get_callbacks.push(resolve));
		return this.get_now();
	}
	close() {
		this.queue = [];
		let cb;
		while ((cb = this.get_callbacks.shift())) cb();
		while ((cb = this.put_callbacks.shift())) cb();
	}
	get size() {
		return this.queue.length;
	}
}

export function socksTCPSocketClass(socksUrl) {
	// socks5h://127.0.0.1:9050 → { host, port, type: 5 } ("h" = hostname to proxy)
	const u = new URL(socksUrl);
	const proxy = {
		host: u.hostname,
		port: Number(u.port || 9050),
		type: 5,
	};

	return class SocksTCPSocket {
		constructor(hostname, port) {
			this.hostname = hostname;
			this.port = port;
			this.recv_buffer_size = 128;
			this.socket = null;
			this.paused = false;
			this.connected = false;
			this.data_queue = new BoundedQueue(this.recv_buffer_size);
		}

		async connect() {
			let socket;
			try {
				({ socket } = await SocksClient.createConnection({
					proxy,
					command: "connect",
					destination: { host: this.hostname, port: this.port },
				}));
			} catch (e) {
				if (process.env.WISP_LOG) console.error(`[socks] connect FAILED ${this.hostname}:${this.port}: ${e.message}`);
				throw e;
			}
			if (process.env.WISP_LOG) console.log(`[socks] connect ${this.hostname}:${this.port} via ${proxy.host}:${proxy.port}`);

			this.socket = socket;
			this.socket.setNoDelay(true);
			this.connected = true;
			this.socket.on("data", (data) => this.data_queue.put(data));
			this.socket.on("close", () => {
				this.data_queue.close();
				this.socket = null;
			});
			this.socket.on("error", () => {
				if (this.socket) this.socket.destroy();
				this.data_queue.close();
				this.socket = null;
			});
			this.socket.on("end", () => {
				if (!this.socket) return;
				this.socket.destroy();
				this.socket = null;
			});
		}

		async recv() {
			return await this.data_queue.get();
		}

		async send(data) {
			await new Promise((resolve) => this.socket.write(data, resolve));
		}

		async close() {
			if (!this.socket) return;
			this.socket.end();
			this.socket = null;
		}

		pause() {
			if (this.data_queue.size >= this.data_queue.max_size && this.socket) {
				this.socket.pause();
				this.paused = true;
			}
		}

		resume() {
			if (this.socket && this.paused) {
				this.socket.resume();
				this.paused = false;
			}
		}
	};
}
