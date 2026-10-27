import http.server, socketserver, os
from urllib.parse import urlparse, parse_qs

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # Connection: close semantics — no pooling artifacts
    def log_message(self, *a): pass
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        size = min(int(q.get("bytes", ["33554432"])[0]), 1 << 26)
        chunk = os.urandom(262144)  # incompressible — defeats link compression
        self.send_response(200)
        self.send_header("content-type", "application/octet-stream")
        self.send_header("content-length", str(size))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        sent = 0
        while sent < size:
            n = min(len(chunk), size - sent)
            try:
                self.wfile.write(chunk[:n])
            except BrokenPipeError:
                return
            sent += n

socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", 8998), H) as s:
    print("perf-src up :8998", flush=True)
    s.serve_forever()
