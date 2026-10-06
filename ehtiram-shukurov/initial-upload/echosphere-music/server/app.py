import hashlib
import json
import re
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from urllib.parse import urlparse
import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from pydantic import ValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from . import auth, auto, library, retention, store
from .analysis import musical_brief
from .config import DATA, ROOT, MAX_BYTES, OLLAMA_URL, OLLAMA_MODEL, ACE_URL, ACE_KEY, ALLOWED_HOSTS
from .models import AnalysisRequest, AutoOptions, SoundtrackRequest


@asynccontextmanager
async def lifespan(app):
    store.init()
    yield


app = FastAPI(title='EchoSphere video soundtrack API',version='0.1.0',lifespan=lifespan)


PUBLIC_PATHS = ('/', '/video.html', '/auth/login', '/auth/logout', '/auth/status', '/health')


@app.middleware('http')
async def boundary(request: Request, call_next):
    # Host allow-list stops DNS rebinding; the origin check stops cross-site
    # mutations; then the shared-secret check protects everything else. The
    # page shell and static assets carry no data and stay reachable so the
    # browser can show its sign-in prompt.
    if (request.url.hostname or '').lower() not in ALLOWED_HOSTS:
        return JSONResponse({'detail':'This host is not allowed.'},status_code=403)
    origin = request.headers.get('origin')
    if request.method not in ('GET','HEAD','OPTIONS') and origin:
        actual, expected = urlparse(origin), urlparse(str(request.base_url))
        if (actual.scheme,actual.netloc) != (expected.scheme,expected.netloc):
            return JSONResponse({'detail':'Use the EchoSphere website to submit this request.'},status_code=403)
    path = request.url.path
    if not (path in PUBLIC_PATHS or path.startswith('/web/')) and not auth.request_authenticated(request):
        return JSONResponse({'detail':'Authentication required.'},status_code=401,headers={'WWW-Authenticate':'Bearer'})
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Cache-Control'] = 'no-store' if path.startswith(('/v1/','/auth/')) else response.headers.get('Cache-Control','no-cache')
    return response


@app.get('/auth/status')
def auth_status(request: Request):
    return {'required':auth.enabled(),'authenticated':auth.request_authenticated(request)}


@app.post('/auth/login')
async def login(request: Request):
    client = request.client.host if request.client else 'unknown'
    if auth.throttled(client):
        raise HTTPException(429,'Too many failed attempts. Wait a few minutes.')
    try:
        key = (await request.json()).get('key','')
    except Exception:
        key = ''
    if not auth.enabled():
        return {'authenticated':True,'required':False}
    if not isinstance(key,str) or not auth.key_matches(key):
        auth.record_failure(client)
        raise HTTPException(401,'That key was not accepted.')
    response = JSONResponse({'authenticated':True,'required':True})
    response.set_cookie(auth.COOKIE,auth.make_session(),max_age=auth.SESSION_HOURS*3600,httponly=True,
                        samesite='strict',secure=request.url.scheme=='https',path='/')
    return response


@app.post('/auth/logout')
def logout():
    response = JSONResponse({'authenticated':False})
    response.delete_cookie(auth.COOKIE,path='/')
    return response


def require(table, id):
    if not re.fullmatch('[0-9a-f]{32}',id):
        raise HTTPException(404,'Not found.')
    row = store.get(table,id)
    if row is None:
        raise HTTPException(404,'Not found.')
    return row


def public_job(job):
    row = dict(job)
    row.pop('idempotency',None)
    if row['kind']=='soundtrack' and row['state']=='complete':
        row['audio_url'] = f'/v1/soundtracks/{row["id"]}/audio'
        row['video_url'] = f'/v1/soundtracks/{row["id"]}/video'
        row['preview_url'] = f'/v1/soundtracks/{row["id"]}/preview'
    if row['kind']=='analysis' and row.get('result'):
        for f in row['result']['evidence']:
            f['url'] = f'/v1/jobs/{row["id"]}/frames/{f["file"]}'
    if row['kind']=='soundtrack' and row['payload'].get('auto'):
        row['stages'] = auto.stage_progress(row)
        row['options'] = row['payload']['options']
        for f in ((row.get('result') or {}).get('analysis') or {}).get('evidence',[]):
            f['url'] = f'/v1/jobs/{row["id"]}/frames/{f["file"]}'
        row['detection_url'] = f'/v1/videos/{row["video_id"]}/detection' if row['options']['input_mode']=='robot' else None
        row.pop('payload')
    return row


def queue(video, kind, payload, key=None):
    if key and len(key)>128:
        raise HTTPException(400,'Idempotency-Key must be at most 128 characters.')
    try:
        return public_job(store.enqueue(video,kind,payload,key))
    except ValueError as e:
        raise HTTPException(409,str(e)) from e


@app.get('/health')
async def health(request: Request):
    if not auth.request_authenticated(request):
        return {'status':'ok'}
    async def ping(base,path,headers=None):
        try:
            async with httpx.AsyncClient(timeout=1,trust_env=False) as client:
                r=await client.get(base+path,headers=headers)
                r.raise_for_status()
                return r.json()
        except Exception:
            return None
    import asyncio
    vision, music = await asyncio.gather(ping(OLLAMA_URL,'/api/tags'),ping(ACE_URL,'/health',{'Authorization':f'Bearer {ACE_KEY}'} if ACE_KEY else {}))
    # Health reports the browser installation, not a successful render benchmark.
    from pathlib import Path
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        chromium = Path(p.chromium.executable_path).is_file()
    return {'status':'ok','worker_online':store.worker_online(),
            'ffmpeg':bool(shutil.which('ffmpeg') and shutil.which('ffprobe')),
            'engines':{'composer':chromium,'ace':music is not None,'library':library.available()},'library_tracks':library.counts(),
            'vision':{'model':OLLAMA_MODEL,'ready':bool(vision and any(m.get('name')==OLLAMA_MODEL for m in vision.get('models',[])))}}


def validate_upload(file: UploadFile):
    if not (file.filename or '').lower().endswith('.mp4'):
        raise HTTPException(415,'Choose an MP4 video.')
    if file.size is not None and file.size > MAX_BYTES:
        raise HTTPException(413,'Video must be 100 MB or smaller.')


async def upload_digest(file: UploadFile):
    """Check retry contents without allocating another persistent video folder."""
    validate_upload(file)
    digest, size = hashlib.sha256(), 0
    try:
        while chunk := await file.read(1024*1024):
            size += len(chunk)
            if size > MAX_BYTES:
                raise HTTPException(413,'Video must be 100 MB or smaller.')
            digest.update(chunk)
        if size == 0:
            raise HTTPException(400,'The uploaded file is empty.')
        return digest.hexdigest()
    finally:
        await file.seek(0)


def require_library(mood):
    """Refuse before anything is stored if the recorded-track library cannot serve the request."""
    have = library.counts()
    if not any(have.values()):
        raise HTTPException(409,'The music library is empty or missing. Add tracks and build its manifest (docs/MUSIC_LIBRARY.md), or choose engine=composer.')
    if mood and not have[mood]:
        raise HTTPException(409,f'The music library has no approved {mood} tracks. Approved tracks per mood: {have}.')


def auto_fingerprint(digest, options):
    return hashlib.sha256(json.dumps({'video':digest,'options':options},sort_keys=True).encode()).hexdigest()


async def save_upload(file: UploadFile):
    """Validate and store an uploaded MP4 under the storage and size limits. Returns (video id, sha256)."""
    validate_upload(file)
    if shutil.disk_usage(DATA).free < 512*1024*1024:
        raise HTTPException(507,'Free at least 512 MB of local disk space before importing.')
    if not retention.has_room(MAX_BYTES):
        raise HTTPException(507,'Storage is full. Delete saved videos or wait for old ones to expire.')
    id = uuid.uuid4().hex
    folder = DATA/'videos'/id
    folder.mkdir(parents=True)
    digest = hashlib.sha256()
    size = 0
    try:
        with (folder/'source.mp4').open('wb') as output:
            while chunk := await file.read(1024*1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HTTPException(413,'Video must be 100 MB or smaller.')
                digest.update(chunk)
                output.write(chunk)
        if size == 0:
            raise HTTPException(400,'The uploaded file is empty.')
        with store.connect() as db:
            db.execute('INSERT INTO videos (id,name,hash,state,created) VALUES (?,?,?,?,?)',
                       (id,(file.filename or 'video.mp4')[:200],digest.hexdigest(),'queued',time.time()))
    except BaseException:
        shutil.rmtree(folder,ignore_errors=True)
        raise
    return id, digest.hexdigest()


def discard_video(id):
    with store.connect() as db:
        db.execute('DELETE FROM videos WHERE id=?',(id,))
    shutil.rmtree(DATA/'videos'/id,ignore_errors=True)


@app.post('/v1/videos',status_code=202)
async def upload_video(file: UploadFile = File(...)):
    id = None
    try:
        id, _ = await save_upload(file)
        job = queue(id,'import',{})
        return {'id':id,'job_id':job['id'],'state':'queued'}
    except BaseException:
        if id:
            discard_video(id)
        raise
    finally:
        await file.close()


@app.post('/v1/soundtracks/auto',status_code=202)
async def create_auto_soundtrack(file: UploadFile = File(...), input_mode: str = Form(...), mood: str = Form('auto'),
                                 on_ambiguous: str = Form('fail'), engine: str = Form('library'), seed: int = Form(42), focus: str|None = Form(None),
                                 idempotency_key: str|None = Header(default=None)):
    """Upload a video and get a soundtrack in one queued job. Returns immediately with a job ID to poll."""
    try:
        options = AutoOptions(input_mode=input_mode,mood=mood,on_ambiguous=on_ambiguous,engine=engine,seed=seed,
                              focus=json.loads(focus) if focus else None).model_dump()
    except json.JSONDecodeError as e:
        raise HTTPException(422,'focus must be a JSON array of focus points.') from e
    except ValidationError as e:
        raise HTTPException(422,'; '.join((f"{'.'.join(map(str,x['loc']))}: " if x['loc'] else '')+x['msg'] for x in e.errors())) from e
    id = None
    try:
        # Resolve a retry before capacity checks: it needs no new queue slot or
        # persistent upload, even when the first request filled the storage quota.
        if idempotency_key:
            if len(idempotency_key) > 128:
                raise HTTPException(400,'Idempotency-Key must be at most 128 characters.')
            with store.connect() as db:
                old = store.decode(db.execute('SELECT * FROM jobs WHERE idempotency=?',(idempotency_key,)).fetchone())
            if old:
                fingerprint = auto_fingerprint(await upload_digest(file), options)
                if old['payload'].get('fingerprint') != fingerprint:
                    raise HTTPException(409,'This idempotency key was already used for different input.')
                return {'id':old['id'],'video_id':old['video_id'],'state':old['state'],'status_url':f'/v1/soundtracks/{old["id"]}'}
        if options['engine']=='library':
            require_library(None if options['mood']=='auto' else options['mood'])
        id, digest = await save_upload(file)
        fingerprint = auto_fingerprint(digest, options)
        job = queue(id,'soundtrack',{'auto':True,'options':options,'fingerprint':fingerprint},idempotency_key)
        return {'id':job['id'],'video_id':id,'state':'queued','status_url':f'/v1/soundtracks/{job["id"]}'}
    except BaseException:
        if id:
            discard_video(id)
        raise
    finally:
        await file.close()


@app.get('/v1/videos')
def videos():
    with store.connect() as db:
        return [dict(r) for r in db.execute('SELECT id,name,state,created FROM videos ORDER BY created DESC LIMIT 30')]


@app.get('/v1/videos/{id}')
def video(id: str):
    row = require('videos',id)
    row['preview_url'] = f'/v1/videos/{id}/preview' if row['state']=='ready' else None
    row['webm_url'] = f'/v1/videos/{id}/preview-webm' if row['state']=='ready' else None
    with store.connect() as db:
        row['jobs'] = [public_job(store.decode(r)) for r in db.execute('SELECT * FROM jobs WHERE video_id=? ORDER BY created DESC',(id,))]
    if row['analysis']:
        a = row['analysis']
        for f in a['evidence']:
            f['url'] = f'/v1/jobs/{a["job_id"]}/frames/{f["file"]}'
    return row


@app.get('/v1/videos/{id}/preview')
def preview(id: str):
    row = require('videos',id)
    if row['state']!='ready':
        raise HTTPException(409,'Video is not ready.')
    return FileResponse(DATA/'videos'/id/'preview.mp4',media_type='video/mp4')


@app.get('/v1/videos/{id}/preview-webm')
def preview_webm(id: str):
    row=require('videos',id)
    if row['state']!='ready':
        raise HTTPException(409,'Video is not ready.')
    return FileResponse(DATA/'videos'/id/'preview.webm',media_type='video/webm')


def detection_file(id, name):
    require('videos',id)
    path = DATA/'videos'/id/'detection'/name
    if not path.is_file():
        raise HTTPException(404,'No sphere detection was run for this video.')
    return path


@app.get('/v1/videos/{id}/detection')
def detection_report(id: str):
    return FileResponse(detection_file(id,'detection.json'),media_type='application/json')


@app.get('/v1/videos/{id}/detection/overlay')
def detection_overlay(id: str):
    return FileResponse(detection_file(id,'detection-overlay.mp4'),media_type='video/mp4')


@app.get('/v1/videos/{id}/detection/sheet')
def detection_sheet(id: str):
    return FileResponse(detection_file(id,'detection-sheet.jpg'),media_type='image/jpeg')


@app.post('/v1/videos/{id}/analysis',status_code=202)
def analyze_video(id: str, request: AnalysisRequest, idempotency_key: str|None = Header(default=None)):
    row = require('videos',id)
    if row['state']!='ready':
        raise HTTPException(409,'Wait for the video to finish importing.')
    if request.focus[-1].time > row['metadata']['duration']:
        raise HTTPException(422,'A focus point is outside the video duration.')
    with store.connect() as db:
        if db.execute("SELECT 1 FROM jobs WHERE video_id=? AND kind='analysis' AND state IN ('queued','running')",(id,)).fetchone():
            # Same key is safe to retry, but concurrent analyses are ambiguous.
            existing = db.execute('SELECT * FROM jobs WHERE idempotency=?',(idempotency_key,)).fetchone() if idempotency_key else None
            if not existing:
                raise HTTPException(409,'An analysis is already queued for this video.')
    return queue(id,'analysis',request.model_dump(),idempotency_key)


@app.post('/v1/soundtracks',status_code=202)
def create_soundtrack(request: SoundtrackRequest, idempotency_key: str|None = Header(default=None)):
    row = require('videos',request.video_id)
    if row['state']!='ready' or not row['analysis']:
        raise HTTPException(409,'Analyze the sphere before generating a soundtrack.')
    try:
        brief = musical_brief(row,row['analysis'],request.model_dump())
    except ValueError as e:
        raise HTTPException(409,str(e)) from e
    if request.engine=='library':
        require_library(brief['mood'])
    return queue(row['id'],'soundtrack',{**request.model_dump(),'brief':brief,'analysis_id':row['analysis']['job_id']},idempotency_key)


@app.get('/v1/jobs/{id}')
def job(id: str):
    return public_job(require('jobs',id))


@app.get('/v1/soundtracks/{id}')
def soundtrack(id: str):
    row = require('jobs',id)
    if row['kind']!='soundtrack':
        raise HTTPException(404,'Not a soundtrack.')
    return public_job(row)


@app.get('/v1/jobs/{id}/frames/{name}')
def frame(id: str, name: str):
    row = require('jobs',id)
    if row['state'] not in ('complete','failed') or row['kind'] not in ('analysis','soundtrack') or not re.fullmatch(r'frame-\d{2}\.jpg',name):
        raise HTTPException(404,'Frame unavailable.')
    path = DATA/'jobs'/id/name
    if not path.is_file():
        raise HTTPException(404,'Frame unavailable.')
    return FileResponse(path,media_type='image/jpeg')


@app.get('/v1/soundtracks/{id}/{kind}')
def download(id: str, kind: str):
    row = require('jobs',id)
    if row['kind']!='soundtrack' or row['state']!='complete':
        raise HTTPException(409,'The soundtrack is not ready.')
    if kind not in ('audio','video','metadata','preview'):
        raise HTTPException(404,'Unknown output.')
    filename, mime = {'audio':('soundtrack.wav','audio/wav'),'video':('soundtrack.mp4','video/mp4'),
                      'metadata':('result.json','application/json'),'preview':('preview.webm','video/webm')}[kind]
    return FileResponse(DATA/'jobs'/id/filename,media_type=mime,filename=f'echosphere-{id[:8]}-{filename}')


@app.delete('/v1/jobs/{id}')
@app.delete('/v1/soundtracks/{id}')
def remove_job(id: str):
    row = require('jobs',id)
    if row['state'] in store.ACTIVE:
        if row['state']=='queued':
            # Serialize with claim() so a claimed job is never deleted mid-work.
            with store.connect() as db:
                db.execute("UPDATE jobs SET cancelled=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END WHERE id=?",(id,))
        else:
            store.update('jobs',id,cancelled=1)
        if row['kind']=='import' and store.get('jobs',id)['state']=='cancelled':
            store.update('videos',row['video_id'],state='failed',error='Import cancelled.')
        return JSONResponse({'state':'cancellation_requested'},status_code=202)
    if row['kind']=='analysis':
        raise HTTPException(409,'Delete the source video to remove its analysis and evidence.')
    with store.connect() as db:
        db.execute('DELETE FROM jobs WHERE id=?',(id,))
    shutil.rmtree(DATA/'jobs'/id,ignore_errors=True)
    return {'state':'deleted'}


@app.delete('/v1/videos/{id}')
def remove_video(id: str):
    require('videos',id)
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        rows = db.execute('SELECT id,kind,state FROM jobs WHERE video_id=?',(id,)).fetchall()
        if any(r['state'] in store.ACTIVE or r['kind']=='soundtrack' for r in rows):
            raise HTTPException(409,'Cancel active jobs and delete soundtracks before deleting this video.')
        db.execute('DELETE FROM jobs WHERE video_id=?',(id,))
        db.execute('DELETE FROM videos WHERE id=?',(id,))
    for row in rows:
        shutil.rmtree(DATA/'jobs'/row['id'],ignore_errors=True)
    shutil.rmtree(DATA/'videos'/id,ignore_errors=True)
    return {'state':'deleted'}


@app.get('/')
@app.get('/video.html')
def home():
    return FileResponse(ROOT/'video.html')


@app.get('/playground')
def playground():
    return FileResponse(ROOT/'music-page.html')


app.mount('/web',StaticFiles(directory=ROOT/'web'),name='web')
