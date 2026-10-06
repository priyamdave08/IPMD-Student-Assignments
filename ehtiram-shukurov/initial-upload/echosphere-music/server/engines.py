import base64
import json
import os
import time
from urllib.parse import urljoin, urlparse
import httpx
from playwright.sync_api import sync_playwright
from .config import ACE_URL, ACE_KEY, ACE_MODEL, ROOT, DATA


def ensure_ace_idle():
    """A disconnected/timed-out provider may still hold the GPU. Reconcile it
    before scheduling another model request, including after a worker restart."""
    for path in (DATA/'provider-tasks').glob('*.json'):
        pending=json.loads(path.read_text())
        headers={'Authorization':f'Bearer {ACE_KEY}'} if ACE_KEY else {}
        try:
            response=httpx.post(ACE_URL+'/query_result',json={'task_id_list':[pending['id']]},
                                headers=headers,timeout=5,trust_env=False)
            response.raise_for_status()
            data=response.json()
            if data.get('code')==200 and data.get('data') and data['data'][0].get('status') in (1,2):
                path.unlink()
                continue
        except Exception:
            pass
        raise RuntimeError('An earlier ACE-Step task may still be running. Wait for it to finish and retry. If its server was restarted, see docs/LOCAL_SETUP.md for recovery.')


def composer(brief, folder, check):
    """Use the actual existing Web Audio renderer; no Python instrument rewrite."""
    check()
    with sync_playwright() as p:
        # Containers often lack the kernel features Chromium's sandbox needs. The page
        # is our own file, and every non-file/data request is aborted below.
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'] if os.environ.get('ECHOSPHERE_NO_SANDBOX') == '1' else [])
        try:
            page = browser.new_page()
            page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(('file:', 'data:')) else route.abort())
            page.add_init_script('window.requestAnimationFrame = () => 0;')
            page.goto((ROOT/'music-page.html').as_uri(), wait_until='load')
            page.add_script_tag(path=str(ROOT/'web/video-score.js'))
            page.evaluate('(brief) => { window.renderTask = {done:false}; renderVideoBrief(brief).then(result => { window.renderTask={done:true,result}; }).catch(e => { window.renderTask={done:true,error:e.message}; }); }', brief)
            end = time.monotonic()+180
            while not page.evaluate('window.renderTask.done'):
                check()
                if time.monotonic()>end:
                    raise RuntimeError('The composer took too long to render.')
                time.sleep(.2)
            result = page.evaluate('window.renderTask')
            check()
            if result.get('error'):
                raise RuntimeError(result['error'])
            data = result['result']
            (folder/'raw.wav').write_bytes(base64.b64decode(data.pop('audio')))
            (folder/'score.json').write_text(json.dumps(data['score']), encoding='utf-8')
            return {'engine':'composer','version':'v6-renderer/video-score-v1','score':data['score'],'render_stats':data['stats']}
        finally:
            browser.close()


def ace_request(brief):
    body = {'prompt':brief['prompt'],'lyrics':'[Instrumental]', 'thinking':False,
            'use_cot_caption':False,'use_cot_language':False,'use_format':False,
            'audio_duration':brief['duration'],'audio_format':'wav','batch_size':1,
            'bpm':brief['tempo'],'key_scale':'A Minor' if brief['mood'] in ('sad','anger') else 'C Major',
            'time_signature':'4','vocal_language':'unknown','inference_steps':8,
            'use_random_seed':False,'seed':brief['seed'],'task_type':'text2music'}
    if ACE_MODEL:
        body['model'] = ACE_MODEL
    return body


def ace(brief, folder, check, stage):
    headers = {'Authorization':f'Bearer {ACE_KEY}'} if ACE_KEY else {}
    payload = ace_request(brief)
    with httpx.Client(base_url=ACE_URL, headers=headers, timeout=30, trust_env=False) as client:
        check()
        response = client.post('/release_task', json=payload)
        response.raise_for_status()
        submitted = response.json()
        if submitted.get('code') != 200 or submitted.get('error'):
            raise RuntimeError('ACE-Step rejected the request: '+str(submitted.get('error')))
        task_id = submitted['data']['task_id']
        pending_dir=DATA/'provider-tasks';pending_dir.mkdir(parents=True,exist_ok=True)
        pending=pending_dir/(folder.name+'.json')
        pending.write_text(json.dumps({'id':task_id}),encoding='utf-8')
        (folder/'provider-task.json').write_text(json.dumps({'id':task_id,'request':payload}), encoding='utf-8')
        deadline = time.monotonic()+1800
        # No upstream cancellation endpoint: finish polling before releasing our
        # serial worker, then honor cancellation before downloading/publishing.
        while time.monotonic()<deadline:
            status = client.post('/query_result', json={'task_id_list':[task_id]})
            status.raise_for_status()
            body = status.json()
            if body.get('code') != 200 or not body.get('data'):
                raise RuntimeError('ACE-Step returned an invalid task status.')
            row = body['data'][0]
            if row['status'] == 2:
                pending.unlink(missing_ok=True)
                raise RuntimeError('ACE-Step could not generate this piece: '+str(row.get('result',''))[:500])
            if row['status'] == 1:
                pending.unlink(missing_ok=True)
                check()
                result = json.loads(row['result']) if isinstance(row['result'],str) else row['result']
                item = result[0]
                url = urljoin(ACE_URL+'/', item['file'])
                if urlparse(url).netloc != urlparse(ACE_URL).netloc or urlparse(url).scheme != 'http':
                    raise RuntimeError('ACE-Step returned an unexpected download location.')
                size = 0
                with client.stream('GET',url) as audio, (folder/'raw.wav').open('wb') as output:
                    audio.raise_for_status()
                    for block in audio.iter_bytes(1024*1024):
                        check()
                        size += len(block)
                        if size > 100*1024*1024:
                            raise RuntimeError('Generated audio exceeds the local limit.')
                        output.write(block)
                return {'engine':'ace','request':payload,'provider_task':task_id,
                        'dit_model':item.get('dit_model'),'lm_model':item.get('lm_model'),
                        'generation_info':item.get('generation_info'),
                        'warnings':['Neural generation quality and absence of vocals require listening.']}
            stage('Generating with ACE-Step (cancellation waits for its current task)')
            time.sleep(2)
        raise RuntimeError('ACE-Step timed out. Check its service before retrying; its task may still be running.')
