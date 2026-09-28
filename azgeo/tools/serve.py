#!/usr/bin/env python3
"""
Preview the site on your own computer.

    python tools/serve.py          then open http://localhost:8000

Python's built-in "python -m http.server" can't be used because it doesn't support
HTTP range requests, which PMTiles needs. This adds that support. Standard library only.
"""
import http.server, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".pmtiles": "application/octet-stream", ".json": "application/json", ".js": "text/javascript"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", ""))
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().do_GET()
        size = os.path.getsize(path)
        start = int(m[1]) if m[1] else max(0, size - int(m[2]))
        end = min(int(m[2]), size - 1) if m[1] and m[2] else size - 1
        if start >= size:
            self.send_response(416); self.send_header("Content-Range", f"bytes */{size}"); self.end_headers(); return
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            self.wfile.write(f.read(end - start + 1))

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"Serving {ROOT}\nOpen http://localhost:{PORT} in your browser. Press Ctrl+C to stop.")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), RangeHandler).serve_forever()
