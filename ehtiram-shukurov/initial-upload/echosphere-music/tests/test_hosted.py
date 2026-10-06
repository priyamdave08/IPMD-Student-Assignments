"""Authentication, quotas and cleanup for hosted use."""
import importlib
import os
import time
import pytest
from fastapi.testclient import TestClient

KEY = 'k' * 32


def load(monkeypatch, tmp_path, **env):
    monkeypatch.setenv('ECHOSPHERE_DATA', str(tmp_path / 'data'))
    for name in ('ECHOSPHERE_API_KEY', 'ECHOSPHERE_ALLOWED_HOSTS', 'ECHOSPHERE_RETENTION_HOURS',
                 'ECHOSPHERE_MAX_STORAGE_GB', 'ECHOSPHERE_MAX_QUEUE'):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    from server import config, auth, store, retention, media, analysis, detect, auto, library, engines, worker, app
    for module in (config, auth, store, retention, media, analysis, detect, auto, library, engines, worker, app):
        importlib.reload(module)
    return config, auth, store, retention, app


def add_video(store, id, created, job_state=None, job_updated=None):
    with store.connect() as db:
        db.execute('INSERT INTO videos (id,name,hash,state,created) VALUES (?,?,?,?,?)', (id, 'v.mp4', 'h', 'ready', created))
        if job_state:
            db.execute('INSERT INTO jobs (id,video_id,kind,state,phase,payload,created,updated) VALUES (?,?,?,?,?,?,?,?)',
                       ('j' * 31 + id[-1], id, 'soundtrack', job_state, 'x', '{}', created, job_updated or created))


def test_local_default_needs_no_key(monkeypatch, tmp_path):
    *_, app = load(monkeypatch, tmp_path)
    with TestClient(app.app) as c:
        assert c.get('/v1/videos').status_code == 200
        assert c.get('/auth/status').json() == {'required': False, 'authenticated': True}


def test_key_protects_every_data_route(monkeypatch, tmp_path):
    *_, app = load(monkeypatch, tmp_path, ECHOSPHERE_API_KEY=KEY)
    with TestClient(app.app) as c:
        vid = 'a' * 32
        routes = [('get', '/v1/videos'), ('get', f'/v1/videos/{vid}'), ('get', f'/v1/videos/{vid}/preview'),
                  ('get', f'/v1/jobs/{vid}'), ('get', f'/v1/soundtracks/{vid}/audio'),
                  ('get', f'/v1/jobs/{vid}/frames/frame-00.jpg'), ('post', '/v1/videos'), ('post', '/v1/soundtracks'),
                  ('delete', f'/v1/videos/{vid}'), ('delete', f'/v1/jobs/{vid}'), ('get', '/playground')]
        for method, path in routes:
            assert getattr(c, method)(path).status_code == 401, (method, path)
        assert c.get('/v1/videos', headers={'Authorization': 'Bearer wrong'}).status_code == 401
        assert c.get('/v1/videos', headers={'Authorization': f'Bearer {KEY}'}).status_code == 200
        assert c.get('/v1/videos', headers={'X-API-Key': KEY}).status_code == 200
        # The page shell and health reveal nothing without the key, and never contain it.
        assert c.get('/').status_code == 200 and c.get('/web/video.js').status_code == 200
        assert c.get('/health').json() == {'status': 'ok'}
        assert 'worker_online' in c.get('/health', headers={'Authorization': f'Bearer {KEY}'}).json()
        assert KEY not in c.get('/').text + c.get('/web/video.js').text


def test_browser_session_cookie_and_throttle(monkeypatch, tmp_path):
    _, auth, _, _, app = load(monkeypatch, tmp_path, ECHOSPHERE_API_KEY=KEY)
    with TestClient(app.app) as c:
        assert c.get('/v1/videos').status_code == 401
        for _ in range(5):
            assert c.post('/auth/login', json={'key': 'nope'}).status_code == 401
        assert c.post('/auth/login', json={'key': KEY}).status_code == 429  # locked out even with the right key
        auth._FAILURES.clear()
        r = c.post('/auth/login', json={'key': KEY})
        assert r.status_code == 200
        cookie = r.headers['set-cookie']
        assert 'httponly' in cookie.lower() and 'samesite=strict' in cookie.lower() and KEY not in cookie
        assert c.get('/v1/videos').status_code == 200
        assert c.get('/auth/status').json()['authenticated'] is True
        c.post('/auth/logout')
        c.cookies.clear()
        assert c.get('/v1/videos').status_code == 401


def test_session_cookie_expires_and_cannot_be_forged(monkeypatch, tmp_path):
    _, auth, _, _, _ = load(monkeypatch, tmp_path, ECHOSPHERE_API_KEY=KEY)
    assert auth.session_valid(auth.make_session())
    assert not auth.session_valid(f'{int(time.time()) - 5}.' + 'f' * 64)
    expires, signature = auth.make_session().split('.')
    assert not auth.session_valid(f'{int(expires) + 999999}.{signature}')
    assert not auth.session_valid('garbage')


def test_public_hosting_requires_a_strong_key(monkeypatch, tmp_path):
    with pytest.raises(RuntimeError):
        load(monkeypatch, tmp_path, ECHOSPHERE_ALLOWED_HOSTS='echo.example.com')
    with pytest.raises(RuntimeError):
        load(monkeypatch, tmp_path, ECHOSPHERE_ALLOWED_HOSTS='echo.example.com', ECHOSPHERE_API_KEY='short')
    *_, app = load(monkeypatch, tmp_path, ECHOSPHERE_ALLOWED_HOSTS='echo.example.com', ECHOSPHERE_API_KEY=KEY)
    with TestClient(app.app, base_url='http://echo.example.com') as c:
        assert c.get('/v1/videos', headers={'Authorization': f'Bearer {KEY}'}).status_code == 200
    with TestClient(app.app, base_url='http://evil.test') as c:
        assert c.get('/health').status_code == 403


def test_cleanup_removes_expired_but_never_active_work(monkeypatch, tmp_path):
    config, _, store, retention, _ = load(monkeypatch, tmp_path, ECHOSPHERE_RETENTION_HOURS='24')
    store.init()
    now, old = time.time(), time.time() - 30 * 3600
    add_video(store, 'a' * 32, old)                     # expired and idle
    add_video(store, 'b' * 32, old, 'running', old)     # old, but a job is running
    add_video(store, 'c' * 32, old, 'complete', now)    # old video with a recent result
    add_video(store, 'd' * 32, now)                     # fresh
    for letter in 'abcd':
        folder = config.DATA / 'videos' / (letter * 32)
        folder.mkdir(parents=True)
        (folder / 'source.mp4').write_bytes(b'x' * 10)
    orphan = config.DATA / 'videos' / ('e' * 32)
    orphan.mkdir()
    os.utime(orphan, (old, old))
    assert retention.sweep(now) == 1
    with store.connect() as db:
        remaining = {r['id'][0] for r in db.execute('SELECT id FROM videos')}
    assert remaining == set('bcd')
    assert not (config.DATA / 'videos' / ('a' * 32)).exists() and not orphan.exists()
    assert (config.DATA / 'videos' / ('b' * 32)).exists()
    assert retention.purge_video('b' * 32) is False  # refuses while a job is running


def test_storage_quota_rejects_uploads(monkeypatch, tmp_path):
    config, _, _, _, app = load(monkeypatch, tmp_path, ECHOSPHERE_MAX_STORAGE_GB='0.0001')  # about 107 KB
    with TestClient(app.app) as c:
        folder = config.DATA / 'videos' / ('f' * 32)
        folder.mkdir(parents=True)
        (folder / 'source.mp4').write_bytes(b'x' * 200_000)
        r = c.post('/v1/videos', files={'file': ('a.mp4', b'not really', 'video/mp4')})
        assert r.status_code == 507 and 'Storage is full' in r.json()['detail']


def test_queue_limit_is_configurable(monkeypatch, tmp_path):
    _, _, store, _, _ = load(monkeypatch, tmp_path, ECHOSPHERE_MAX_QUEUE='1')
    store.init()
    add_video(store, 'a' * 32, time.time())
    store.enqueue('a' * 32, 'import', {})
    with pytest.raises(ValueError):
        store.enqueue('a' * 32, 'import', {'again': True})
