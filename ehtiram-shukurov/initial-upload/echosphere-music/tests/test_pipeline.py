import importlib
import json
from pathlib import Path
import subprocess
import wave
import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def services(tmp_path,monkeypatch):
    monkeypatch.setenv('ECHOSPHERE_DATA',str(tmp_path/'data'))
    for name in ('ECHOSPHERE_API_KEY','ECHOSPHERE_ALLOWED_HOSTS','ECHOSPHERE_RETENTION_HOURS','ECHOSPHERE_MAX_STORAGE_GB','ECHOSPHERE_MAX_QUEUE'):monkeypatch.delenv(name,raising=False)
    from server import config,auth,store,retention,media,analysis,detect,auto,library,engines,worker,app
    for module in (config,auth,store,retention,media,analysis,detect,auto,library,engines,worker,app):importlib.reload(module)
    with TestClient(app.app) as client:
        yield client,store,worker


@pytest.fixture
def clip(tmp_path):
    path=tmp_path/'warm.mp4'
    subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=0xffbb44:s=320x240:r=24:d=10',
                    '-f','lavfi','-i','sine=frequency=440:duration=10','-c:v','libx264','-threads','2','-c:a','aac','-shortest',str(path)],check=True)
    return path


def import_clip(client,store,worker,clip):
    with clip.open('rb') as f:r=client.post('/v1/videos',files={'file':('warm.mp4',f,'video/mp4')})
    assert r.status_code==202,r.text
    item=r.json();worker.process(store.claim())
    video=client.get('/v1/videos/'+item['id']).json()
    assert video['state']=='ready',video
    return video


FOCUS=[{'time':0,'cx':.5,'cy':.6,'rx':.2,'ry':.25}]


def test_complete_api_pipeline(services,clip):
    c,s,w=services
    v=import_clip(c,s,w,clip)
    assert v['metadata']['original']['source_has_audio']
    assert not v['metadata']['source_has_audio']
    assert c.post('/v1/soundtracks',json={'video_id':v['id']}).status_code==409
    r=c.post(f'/v1/videos/{v["id"]}/analysis',json={'focus':FOCUS})
    assert r.status_code==202,r.text
    w.process(s.claim())
    a=c.get('/v1/jobs/'+r.json()['id']).json()
    assert a['state']=='complete',a
    assert a['result']['mood']=='warm'
    assert a['result']['analyzer']['semantic'] is False
    assert c.get(a['result']['evidence'][0]['url']).status_code==200
    body={'video_id':v['id'],'mood':'sad','seed':77,'engine':'composer'}
    r=c.post('/v1/soundtracks',json=body,headers={'Idempotency-Key':'same-take'})
    assert r.status_code==202,r.text
    assert c.post('/v1/soundtracks',json=body,headers={'Idempotency-Key':'same-take'}).json()['id']==r.json()['id']
    assert c.post('/v1/soundtracks',json={**body,'seed':78},headers={'Idempotency-Key':'same-take'}).status_code==409
    w.process(s.claim())
    result=c.get('/v1/soundtracks/'+r.json()['id']).json()
    assert result['state']=='complete',result
    assert result['result']['brief']['observed_mood']=='warm'
    assert result['result']['brief']['mood']=='sad'
    assert result['result']['audio']['samples']==441000
    assert .001<result['result']['audio']['rms']<.5
    audio=c.get(result['audio_url']).content
    assert audio==c.get(result['audio_url']).content
    assert c.get(result['video_url']).status_code==200
    assert c.delete('/v1/videos/'+v['id']).status_code==409
    assert c.delete('/v1/soundtracks/'+result['id']).status_code==200
    assert c.delete('/v1/videos/'+v['id']).status_code==200
    assert c.get('/v1/videos/'+v['id']).status_code==404


def test_focus_excludes_face_and_background():
    from server.analysis import crop_sphere,palette,focus_at
    frame=np.zeros((300,300,3),np.uint8);frame[:]=(0,0,255)
    cv2.circle(frame,(150,200),60,(255,90,20),-1)
    focus={'time':0,'cx':.5,'cy':2/3,'rx':.18,'ry':.18}
    crop,mask=crop_sphere(frame,focus)
    scores=palette(crop,mask)
    assert scores['sad']>.9 and scores['anger']<.01
    end={**focus,'time':10,'cx':.6,'rx':.25}
    middle=focus_at([focus,end],5)
    assert middle['cx']==pytest.approx(.55)
    assert middle['rx']==pytest.approx(.215)


def test_invalid_media_focus_and_local_origin(services,clip):
    c,s,w=services
    assert c.post('/v1/videos',files={'file':('audio.wav',b'not video')}).status_code==415
    assert c.post('/v1/videos',files={'file':('bad.mp4',b'garbage')},headers={'Origin':'https://evil.example'}).status_code==403
    r=c.post('/v1/videos',files={'file':('bad.mp4',b'garbage')})
    w.process(s.claim())
    assert c.get('/v1/jobs/'+r.json()['job_id']).json()['state']=='failed'
    v=import_clip(c,s,w,clip)
    for focus in ([{**FOCUS[0],'cx':.99}], [{**FOCUS[0],'time':3}], [FOCUS[0],FOCUS[0]], [FOCUS[0],{**FOCUS[0],'time':12}]):
        assert c.post('/v1/videos/'+v['id']+'/analysis',json={'focus':focus}).status_code==422
    assert c.get('/v1/videos/not-an-id/preview').status_code==404


def test_cancellation_recovery_and_missing_model(services,clip,monkeypatch):
    c,s,w=services
    v=import_clip(c,s,w,clip)
    job=c.post('/v1/videos/'+v['id']+'/analysis',json={'focus':FOCUS}).json()
    assert c.delete('/v1/jobs/'+job['id']).status_code==202
    assert s.claim() is None
    import httpx
    def unavailable(*args,**kwargs):raise httpx.ConnectError('Fixture: service unavailable')
    monkeypatch.setattr(w.analysis,'understand',unavailable)
    next_job=c.post('/v1/videos/'+v['id']+'/analysis',json={'focus':FOCUS,'analyzer':'qwen'}).json()
    w.process(s.claim())
    assert c.get('/v1/jobs/'+next_job['id']).json()['state']=='failed'
    job=c.post('/v1/videos/'+v['id']+'/analysis',json={'focus':FOCUS}).json()
    s.claim();s.recover()
    assert c.get('/v1/jobs/'+job['id']).json()['phase']=='Interrupted'


def test_ace_adapter_parameters():
    from server.engines import ace_request
    body=ace_request({'prompt':'Instrumental piano','duration':10,'tempo':80,'mood':'warm','seed':42})
    assert body['batch_size']==1 and body['lyrics']=='[Instrumental]'
    assert body['audio_duration']==10 and body['seed']==42
    assert body['thinking'] is False and body['use_cot_caption'] is False


def test_all_mood_scores_fit_supported_durations():
    from playwright.sync_api import sync_playwright
    from server.config import ROOT
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        try:
            page=browser.new_page()
            page.add_init_script('window.requestAnimationFrame=()=>0;')
            page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(('file:','data:')) else route.abort())
            page.goto((ROOT/'music-page.html').as_uri())
            page.add_script_tag(path=str(ROOT/'web/video-score.js'))
            scores=page.evaluate('''() => ['warm','calm','sad','anger'].flatMap(mood=>[10,10.005,30,60].map(duration=>{
              const brief={mood,duration,tempo:moods[mood].tempo,energy:.3,brightness:.5,seed:42,energy_curve:[{time:0,energy:.3}]};
              const score=composeVideoBrief(brief);validateScore(score);
              return {duration:score.duration,requested:duration,events:score.events.length,
                last:Math.max(...score.events.map(e=>e.time+e.duration)),same:JSON.stringify(score)===JSON.stringify(composeVideoBrief(brief))};
            }))''')
            assert len(scores)==16
            assert all(s['events']>0 and s['last']<=s['requested'] and s['duration']==s['requested'] and s['same'] for s in scores)
        finally:browser.close()
