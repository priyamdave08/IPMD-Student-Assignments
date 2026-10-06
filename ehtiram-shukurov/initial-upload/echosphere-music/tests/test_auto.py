"""The one-call upload-to-soundtrack endpoint: modes, rejection, ambiguity policy, retries."""
import importlib
import json
import wave
import pytest
from fastapi.testclient import TestClient
from tests.library_fixture import make_library
from tests.synthetic import make_flat_video, make_video

KEY = 'k' * 32


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv('ECHOSPHERE_DATA', str(tmp_path / 'data'))
    monkeypatch.setenv('ECHOSPHERE_LIBRARY', str(make_library(tmp_path / 'library')))      # the endpoint plays recorded tracks by default
    for name in ('ECHOSPHERE_API_KEY', 'ECHOSPHERE_ALLOWED_HOSTS', 'ECHOSPHERE_RETENTION_HOURS', 'ECHOSPHERE_MAX_STORAGE_GB', 'ECHOSPHERE_MAX_QUEUE'):
        monkeypatch.delenv(name, raising=False)
    from server import config, auth, store, retention, media, analysis, detect, auto, library, engines, worker, app
    for module in (config, auth, store, retention, media, analysis, detect, auto, library, engines, worker, app):
        importlib.reload(module)
    with TestClient(app.app) as client:
        yield client, store, worker, config, retention


def submit(client, path, **fields):
    with open(path, 'rb') as f:
        return client.post('/v1/soundtracks/auto', files={'file': ('clip.mp4', f, 'video/mp4')}, data=fields)


def run(store, worker):
    job = store.claim()
    assert job, 'nothing queued'
    worker.process(job)
    return job['id']


def status(client, id):
    return client.get('/v1/soundtracks/' + id).json()


def gold(tmp_path):
    make_video(tmp_path / 'gold.mp4')
    return tmp_path / 'gold.mp4'


def test_robot_mode_end_to_end_with_stages_and_inspectable_detection(api, tmp_path):
    client, store, worker, config, retention = api
    r = submit(client, gold(tmp_path), input_mode='robot')
    assert r.status_code == 202, r.text
    body = r.json()
    id = body['id']
    queued = status(client, id)                      # the job ID comes back immediately, before any processing
    assert queued['state'] == 'queued' and queued['stages'][0]['state'] == 'active'
    assert [s['code'] for s in queued['stages']] == ['queued', 'importing', 'detecting', 'analyzing', 'deciding', 'composing', 'finishing', 'muxing']
    run(store, worker)
    done = status(client, id)
    assert done['state'] == 'complete', done.get('error')
    assert all(s['state'] == 'done' for s in done['stages'])
    result = done['result']
    assert result['input_mode'] == 'robot' and result['detection']['status'] == 'ok'
    assert result['mood']['source'] == 'observed' and result['mood']['used'] == result['analysis']['mood']
    assert 'not calibrated probabilities' in result['analysis']['palette_scores_note']
    assert 'payload' not in done
    with wave.open(str(config.DATA / 'jobs' / id / 'soundtrack.wav')) as w:
        assert w.getnframes() == 441000
    assert client.get(f'/v1/soundtracks/{id}/audio').status_code == 200
    assert client.get(f'/v1/soundtracks/{id}/video').status_code == 200
    vid = body['video_id']
    assert client.get(f'/v1/videos/{vid}/detection/overlay').headers['content-type'] == 'video/mp4'
    assert client.get(f'/v1/videos/{vid}/detection/sheet').headers['content-type'] == 'image/jpeg'
    assert client.get(f'/v1/videos/{vid}/detection').json()['status'] == 'ok'
    assert client.get(result['analysis']['evidence'][0]['url'] if 'url' in result['analysis']['evidence'][0] else done['result']['analysis']['evidence'][0]['url']).status_code == 200
    # Cleanup understands auto jobs: the video, detection files and soundtrack go together.
    assert retention.purge_video(vid) is True
    assert not (config.DATA / 'videos' / vid).exists() and not (config.DATA / 'jobs' / id).exists()


def test_focus_mode_uses_supplied_coordinates_and_skips_detection(api, tmp_path):
    client, store, worker, *_ = api
    truth = make_video(tmp_path / 'gold.mp4')
    first = {k: round(truth[0][k], 4) for k in ('time', 'cx', 'cy', 'rx', 'ry')}
    first['rx'] = first['ry'] = .12
    r = submit(client, tmp_path / 'gold.mp4', input_mode='focus', focus=json.dumps([first]))
    assert r.status_code == 202, r.text
    id = run(store, worker)
    done = status(client, id)
    assert done['state'] == 'complete', done.get('error')
    assert done['result']['detection'] is None and done['result']['focus'] == [first]
    assert client.get(f'/v1/videos/{r.json()["video_id"]}/detection').status_code == 404


def test_sphere_only_mode(api, tmp_path):
    client, store, worker, *_ = api
    make_flat_video(tmp_path / 'flat.mp4')
    r = submit(client, tmp_path / 'flat.mp4', input_mode='sphere')
    id = run(store, worker)
    done = status(client, id)
    assert done['state'] == 'complete', done.get('error')
    assert done['result']['mood']['used'] == 'warm' and done['result']['detection'] is None


def test_unreliable_sphere_is_rejected_with_evidence(api, tmp_path):
    client, store, worker, *_ = api
    make_video(tmp_path / 'none.mp4', sphere=False)
    r = submit(client, tmp_path / 'none.mp4', input_mode='robot')
    id = run(store, worker)
    done = status(client, id)
    assert done['state'] == 'failed' and done['result']['error_code'] == 'sphere_not_reliable'
    assert 'Inspect the detection overlay' in done['error']
    assert done['result']['detection']['status'] == 'rejected'
    assert client.get(f'/v1/videos/{r.json()["video_id"]}/detection/sheet').status_code == 200   # overlay kept for review
    assert not (client.get(f'/v1/soundtracks/{id}/audio').status_code == 200)


def ambiguous(tmp_path):
    # Blue (sad) on one side and violet (calm) on the other: the palette rule cannot pick one.
    make_video(tmp_path / 'mixed.mp4', hue=(215, 120, 40), hue2=(215, 60, 150))
    return tmp_path / 'mixed.mp4'


def test_ambiguity_fails_by_default(api, tmp_path):
    client, store, worker, *_ = api
    submit(client, ambiguous(tmp_path), input_mode='robot')
    done = status(client, run(store, worker))
    assert done['state'] == 'failed', done['result']['mood']
    assert done['result']['error_code'] == 'ambiguous_mood'
    assert 'palette_scores_note' in done['result']['analysis'] and done['result']['analysis']['mood'] is None
    assert store.get('videos', done['video_id'])['state'] == 'ready'  # a later refusal must not invalidate the import


def test_best_guess_is_opt_in_and_reported(api, tmp_path):
    client, store, worker, *_ = api
    submit(client, ambiguous(tmp_path), input_mode='robot', on_ambiguous='best_guess')
    done = status(client, run(store, worker))
    assert done['state'] == 'complete', done.get('error')
    mood = done['result']['mood']
    assert mood['source'] == 'best_guess' and mood['observed'] is None and mood['used'] in ('calm', 'sad')
    assert any('best guess' in w for w in done['result']['brief']['warnings'])


def test_explicit_mood_overrides_and_keeps_the_observation(api, tmp_path):
    client, store, worker, *_ = api
    submit(client, ambiguous(tmp_path), input_mode='robot', mood='anger')
    done = status(client, run(store, worker))
    assert done['state'] == 'complete', done.get('error')
    assert done['result']['mood'] == {'used': 'anger', 'observed': None, 'source': 'override'}


def test_invalid_options_are_refused_before_anything_is_stored(api, tmp_path):
    client, store, worker, config, _ = api
    clip = gold(tmp_path)
    assert submit(client, clip, input_mode='focus').status_code == 422                                   # focus required
    assert submit(client, clip, input_mode='robot', focus='[]').status_code == 422                        # focus not allowed
    assert submit(client, clip, input_mode='robot', focus='not json').status_code == 422
    assert submit(client, clip, input_mode='telepathy').status_code == 422
    assert submit(client, clip, input_mode='robot', mood='joy').status_code == 422
    assert submit(client, clip, input_mode='robot', on_ambiguous='guess').status_code == 422
    assert submit(client, clip, input_mode='robot', engine='ace').status_code == 422                       # not offered here; never silently ignored
    (tmp_path / 'notes.txt').write_text('x')
    with open(tmp_path / 'notes.txt', 'rb') as f:
        assert client.post('/v1/soundtracks/auto', files={'file': ('notes.txt', f)}, data={'input_mode': 'robot'}).status_code == 415
    assert client.get('/v1/videos').json() == [] and store.claim() is None


def test_retry_with_the_same_key_returns_the_same_job(api, tmp_path):
    client, store, worker, *_ = api
    clip = gold(tmp_path)
    with open(clip, 'rb') as f:
        a = client.post('/v1/soundtracks/auto', files={'file': ('c.mp4', f, 'video/mp4')}, data={'input_mode': 'robot'}, headers={'Idempotency-Key': 'abc'})
    with open(clip, 'rb') as f:
        b = client.post('/v1/soundtracks/auto', files={'file': ('c.mp4', f, 'video/mp4')}, data={'input_mode': 'robot'}, headers={'Idempotency-Key': 'abc'})
    assert a.status_code == b.status_code == 202 and a.json()['id'] == b.json()['id']
    assert len(client.get('/v1/videos').json()) == 1                       # the duplicate upload was discarded
    with open(clip, 'rb') as f:
        c = client.post('/v1/soundtracks/auto', files={'file': ('c.mp4', f, 'video/mp4')}, data={'input_mode': 'sphere'}, headers={'Idempotency-Key': 'abc'})
    assert c.status_code == 409


def test_auto_endpoint_requires_the_key_and_shares_the_queue_limit(tmp_path, monkeypatch):
    monkeypatch.setenv('ECHOSPHERE_DATA', str(tmp_path / 'data'))
    monkeypatch.setenv('ECHOSPHERE_LIBRARY', str(make_library(tmp_path / 'library')))
    monkeypatch.setenv('ECHOSPHERE_API_KEY', KEY)
    monkeypatch.setenv('ECHOSPHERE_MAX_QUEUE', '1')
    for name in ('ECHOSPHERE_ALLOWED_HOSTS', 'ECHOSPHERE_RETENTION_HOURS', 'ECHOSPHERE_MAX_STORAGE_GB'):
        monkeypatch.delenv(name, raising=False)
    from server import config, auth, store, retention, media, analysis, detect, auto, library, engines, worker, app
    for module in (config, auth, store, retention, media, analysis, detect, auto, library, engines, worker, app):
        importlib.reload(module)
    clip = gold(tmp_path)
    with TestClient(app.app) as client:
        assert submit(client, clip, input_mode='robot').status_code == 401
        headers = {'Authorization': f'Bearer {KEY}'}
        with open(clip, 'rb') as f:
            ok = client.post('/v1/soundtracks/auto', files={'file': ('c.mp4', f, 'video/mp4')}, data={'input_mode': 'robot'}, headers=headers)
        assert ok.status_code == 202
        with open(clip, 'rb') as f:
            full = client.post('/v1/soundtracks/auto', files={'file': ('c.mp4', f, 'video/mp4')}, data={'input_mode': 'robot'}, headers=headers)
        assert full.status_code == 409 and 'queue is full' in full.json()['detail']
        assert len(client.get('/v1/videos', headers=headers).json()) == 1      # the refused upload left nothing behind


def test_auto_invalid_media_marks_video_and_job_failed(api):
    client, store, worker, *_ = api
    response = client.post('/v1/soundtracks/auto', files={'file': ('bad.mp4', b'not a video')},
                           data={'input_mode': 'sphere'})
    assert response.status_code == 202
    done = status(client, run(store, worker))
    video = store.get('videos', response.json()['video_id'])
    assert done['state'] == video['state'] == 'failed'
    assert video['error'] == done['error'] and video['error']


def test_auto_cancel_during_import_marks_video_failed(api, monkeypatch):
    client, store, worker, *_ = api
    response = client.post('/v1/soundtracks/auto', files={'file': ('clip.mp4', b'input')},
                           data={'input_mode': 'sphere'})
    body = response.json()

    def cancel_import(source, folder, check):
        assert store.get('videos', body['video_id'])['state'] == 'importing'
        store.update('jobs', body['id'], cancelled=1)
        check()
        pytest.fail('Cancellation was not observed')

    monkeypatch.setattr(worker.media, 'prepare_video', cancel_import)
    done = status(client, run(store, worker))
    video = store.get('videos', body['video_id'])
    assert done['state'] == 'cancelled'
    assert video['state'] == 'failed' and video['error'] == 'Import cancelled.'


@pytest.mark.parametrize('last_time', [10, 11])
def test_auto_focus_checks_imported_video_duration(api, tmp_path, last_time):
    client, store, worker, *_ = api
    clip = tmp_path / 'flat.mp4'
    make_flat_video(clip)
    point = {'time': 0, 'cx': .5, 'cy': .5, 'rx': .4, 'ry': .4}
    focus = [point, {**point, 'time': last_time}]
    response = submit(client, clip, input_mode='focus', focus=json.dumps(focus))
    assert response.status_code == 202
    done = status(client, run(store, worker))
    if last_time > 10:
        assert done['state'] == 'failed'
        assert done['result']['error_code'] == 'invalid_focus'
        assert done['result']['duration'] == 10
        assert store.get('videos', done['video_id'])['analysis'] is None
    else:
        assert done['state'] == 'complete', done.get('error')
    assert store.get('videos', done['video_id'])['state'] == 'ready'


def test_auto_retry_at_full_storage_and_queue_reuses_existing_job(api, monkeypatch):
    client, store, _, config, retention = api
    monkeypatch.setattr(store, 'MAX_QUEUE', 1)
    headers = {'Idempotency-Key': 'full-capacity-retry'}
    fields = {'input_mode': 'sphere'}
    content = b'queued upload; media validation happens in the worker'

    def post(data=content, options=fields, key=headers):
        return client.post('/v1/soundtracks/auto', files={'file': ('clip.mp4', data)}, data=options, headers=key)

    first = post()
    assert first.status_code == 202
    used = retention.usage_bytes()
    monkeypatch.setattr(retention, 'MAX_STORAGE_BYTES', used)
    assert not retention.has_room(1)
    retry = post()
    assert retry.status_code == 202 and retry.json() == first.json()
    assert post(options={'input_mode': 'robot'}).status_code == 409  # changed options still conflict at capacity
    assert post(data=content + b'different').status_code == 409     # so do changed video bytes
    assert post(key={'Idempotency-Key': 'new-work'}).status_code == 507
    assert retention.usage_bytes() == used
    assert len(list((config.DATA / 'videos').iterdir())) == 1
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 1


def test_auto_retry_still_validates_upload_size_and_type(api, monkeypatch):
    client, _, _, _, _ = api
    from server import app
    headers = {'Idempotency-Key': 'bounded-retry'}

    def post(name, content):
        return client.post('/v1/soundtracks/auto', files={'file': (name, content)},
                           data={'input_mode': 'sphere'}, headers=headers)

    assert post('clip.mp4', b'input').status_code == 202
    monkeypatch.setattr(app, 'MAX_BYTES', 10)
    assert post('clip.mp4', b'x' * 11).status_code == 413
    assert post('clip.mp4', b'').status_code == 400
    assert post('clip.txt', b'input').status_code == 415


def test_default_engine_plays_a_library_track_and_keeps_its_credit(api, tmp_path):
    import subprocess
    client, store, worker, config, _ = api
    r = submit(client, gold(tmp_path), input_mode='robot')
    id = run(store, worker)
    done = status(client, id)
    assert done['state'] == 'complete', done.get('error')
    prov = done['result']['provenance']
    assert prov['engine'] == 'library' and done['options']['engine'] == 'library'
    assert prov['track']['credit'] in prov['track']['credit'] and prov['track']['id'].startswith(done['result']['mood']['used'] + '/')
    assert prov['selection']['seed'] == done['result']['brief']['seed']
    # the credit must be inside the finished files, not only in the JSON
    for name in ('soundtrack.wav', 'soundtrack.mp4'):
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format_tags', '-of', 'json', str(config.DATA / 'jobs' / id / name)], capture_output=True, text=True).stdout
        assert 'Kevin MacLeod (incompetech.com)' in out, name
    assert done['stages'][5]['code'] == 'composing' and done['stages'][5]['state'] == 'done'      # library selection counts as that stage


def test_library_engine_is_refused_up_front_when_it_cannot_serve(api, tmp_path):
    client, store, worker, config, _ = api
    manifest = json.loads((config.LIBRARY_DIR / 'manifest.json').read_text())
    for t in manifest['tracks']:
        t['eligible'] = t['eligible'] and t['mood'] != 'calm'
    (config.LIBRARY_DIR / 'manifest.json').write_text(json.dumps(manifest))
    clip = gold(tmp_path)
    refused = submit(client, clip, input_mode='robot', mood='calm')
    assert refused.status_code == 409 and 'no approved calm tracks' in refused.json()['detail']
    assert client.get('/v1/videos').json() == []                                  # nothing was stored
    assert submit(client, clip, input_mode='robot', mood='warm').status_code == 202
    (config.LIBRARY_DIR / 'manifest.json').unlink()
    empty = submit(client, clip, input_mode='robot', mood='warm')
    assert empty.status_code == 409 and 'library is empty or missing' in empty.json()['detail']


def test_composer_is_still_available_on_request(api, tmp_path):
    client, store, worker, *_ = api
    submit(client, gold(tmp_path), input_mode='robot', engine='composer')
    done = status(client, run(store, worker))
    assert done['state'] == 'complete', done.get('error')
    assert done['result']['provenance']['engine'] == 'composer'


def test_a_mood_that_becomes_empty_after_acceptance_fails_with_a_code(api, tmp_path):
    client, store, worker, config, _ = api
    submit(client, gold(tmp_path), input_mode='robot')                             # accepted while the library can serve it
    manifest = json.loads((config.LIBRARY_DIR / 'manifest.json').read_text())
    for t in manifest['tracks']:
        t['eligible'] = False
    (config.LIBRARY_DIR / 'manifest.json').write_text(json.dumps(manifest))
    done = status(client, run(store, worker))
    assert done['state'] == 'failed' and done['result']['error_code'] == 'library_empty'
