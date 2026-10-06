"""Configuration stays outside the pipeline so storage/services can move later."""
import os
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get('ECHOSPHERE_DATA', ROOT / 'data')).resolve()
MAX_BYTES = 100 * 1024 * 1024
MIN_SECONDS, MAX_SECONDS = 10, 60
OLLAMA_MODEL = os.environ.get('ECHOSPHERE_VISION_MODEL', 'qwen3-vl:4b')

# --- Hosted-deployment settings. Every default keeps the local app unchanged. ---
LOCAL_HOSTS = ('127.0.0.1', 'localhost', '::1', 'testserver')
API_KEY = os.environ.get('ECHOSPHERE_API_KEY', '').strip()
ALLOWED_HOSTS = tuple(h.strip().lower() for h in os.environ.get('ECHOSPHERE_ALLOWED_HOSTS', '').split(',') if h.strip()) or LOCAL_HOSTS
# Session cookies for the browser page; the key itself is never sent to a page.
SESSION_HOURS = int(os.environ.get('ECHOSPHERE_SESSION_HOURS', '12'))
# Total bytes for stored videos plus results. 0 means unlimited.
MAX_STORAGE_BYTES = int(float(os.environ.get('ECHOSPHERE_MAX_STORAGE_GB', '10')) * 1024**3)
# Stored videos older than this are removed automatically. 0 keeps them until deleted.
RETENTION_HOURS = float(os.environ.get('ECHOSPHERE_RETENTION_HOURS', '0'))
MAX_QUEUE = int(os.environ.get('ECHOSPHERE_MAX_QUEUE', '20'))
# Folder of licensed recordings (warm/calm/sad/anger subfolders and a manifest.json). Not part of Git.
LIBRARY_DIR = Path(os.environ.get('ECHOSPHERE_LIBRARY', ROOT / 'music-library')).resolve()

if any(h not in LOCAL_HOSTS for h in ALLOWED_HOSTS) and len(API_KEY) < 24:
    raise RuntimeError('Serving beyond localhost requires ECHOSPHERE_API_KEY of at least 24 characters.')


def local_url(name, default):
    value = os.environ.get(name, default).rstrip('/')
    parsed = urlparse(value)
    if parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise ValueError(f'{name} must use a local HTTP service in this release.')
    return value


OLLAMA_URL = local_url('ECHOSPHERE_OLLAMA_URL', 'http://127.0.0.1:11434')
ACE_URL = local_url('ECHOSPHERE_ACE_URL', 'http://127.0.0.1:8001')
ACE_KEY = os.environ.get('ECHOSPHERE_ACE_KEY', '')
ACE_MODEL = os.environ.get('ECHOSPHERE_ACE_MODEL', '')
