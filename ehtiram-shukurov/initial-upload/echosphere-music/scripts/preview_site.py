"""Serve the repository the way GitHub Pages would, to try the browser edition on your own computer.

    python scripts/preview_site.py [port]        then open http://127.0.0.1:8000/video-music/

Unlike Python's plain `http.server`, this honours range requests, which a browser needs to jump around inside a song.
Ctrl+C stops it.
"""
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from tests.static_server import serve  # noqa: E402

if __name__ == '__main__':
    server, base = serve(ROOT, int(sys.argv[1]) if len(sys.argv) > 1 else 8000)
    print(f'Open {base}/video-music/   (Ctrl+C to stop)', flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.shutdown()
