"""Shared-secret authentication for hosted use.

The API key lives only in the server's environment. Scripts send it as
`Authorization: Bearer <key>` (or `X-API-Key`). The browser page trades it once
for an HttpOnly, signed, expiring session cookie, so no credential is ever
embedded in frontend code or kept in page-readable storage. Authentication is
disabled when no key is configured (the local default).
"""
import hashlib
import hmac
import time
from .config import API_KEY, SESSION_HOURS

COOKIE = 'echosphere_session'
_SECRET = hashlib.sha256(b'echosphere-session|' + API_KEY.encode()).digest()
_FAILURES = {}
MAX_FAILURES, WINDOW = 5, 300


def enabled():
    return bool(API_KEY)


def _digest(value):
    return hashlib.sha256(value.encode()).digest()


def key_matches(candidate):
    return bool(candidate) and hmac.compare_digest(_digest(candidate), _digest(API_KEY))


def make_session():
    expires = int(time.time() + SESSION_HOURS * 3600)
    return f'{expires}.{hmac.new(_SECRET, str(expires).encode(), "sha256").hexdigest()}'


def session_valid(token):
    try:
        expires, signature = token.split('.', 1)
        good = hmac.compare_digest(signature, hmac.new(_SECRET, expires.encode(), 'sha256').hexdigest())
        return good and int(expires) > time.time()
    except (ValueError, AttributeError):
        return False


def request_authenticated(request):
    if not enabled():
        return True
    header = request.headers.get('authorization', '')
    if header[:7].lower() == 'bearer ' and key_matches(header[7:].strip()):
        return True
    if key_matches(request.headers.get('x-api-key', '')):
        return True
    return session_valid(request.cookies.get(COOKIE, ''))


def throttled(client):
    now = time.time()
    recent = [t for t in _FAILURES.get(client, []) if now - t < WINDOW]
    _FAILURES[client] = recent
    return len(recent) >= MAX_FAILURES


def record_failure(client):
    _FAILURES.setdefault(client, []).append(time.time())
