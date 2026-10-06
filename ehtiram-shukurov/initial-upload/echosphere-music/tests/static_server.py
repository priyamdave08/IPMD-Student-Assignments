"""A small static file server that honours HTTP Range requests, the way GitHub Pages does.

Python's own http.server ignores Range, and without it a browser cannot seek inside a song, so it would hide real problems.
"""
import os
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class _Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    _remaining = None

    def send_head(self):
        path = self.translate_path(self.path)
        rng = self.headers.get('Range')
        match = re.match(r'bytes=(\d*)-(\d*)$', (rng or '').strip())
        if not rng or not match or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start = int(match.group(1)) if match.group(1) else max(0, size - int(match.group(2) or 0))
        end = min(int(match.group(2)) if match.group(1) and match.group(2) else size - 1, size - 1)
        if start > end:
            self.send_error(416)
            return None
        handle = open(path, 'rb')
        handle.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return handle

    def copyfile(self, source, outputfile):
        if self._remaining is None:
            return super().copyfile(source, outputfile)
        remaining, self._remaining = self._remaining, None
        while remaining > 0:
            chunk = source.read(min(65536, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def log_message(self, *args):
        pass


def serve(root, port=0):
    """Serve `root` on localhost in a background thread. Returns (server, base_url)."""
    handler = lambda *a, **k: _Handler(*a, directory=str(root), **k)      # noqa: E731
    class Quiet(ThreadingHTTPServer):
        def handle_error(self, request, client_address):      # browsers abort range downloads when they seek; not worth printing
            pass

    server = Quiet(('127.0.0.1', port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'
