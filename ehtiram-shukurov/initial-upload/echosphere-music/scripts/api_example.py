"""Use the full workflow without a browser. Requires an explicit focus JSON."""
import argparse
import os
import json
import time
from pathlib import Path
import httpx


def main():
    p=argparse.ArgumentParser()
    p.add_argument('video',type=Path)
    p.add_argument('--focus',required=True,type=Path,help='JSON array of normalized sphere focus points')
    p.add_argument('--url',default='http://127.0.0.1:8765')
    p.add_argument('--key-env',default='ECHOSPHERE_API_KEY',help='Environment variable holding the access key (hosted servers)')
    p.add_argument('--engine',choices=['composer','ace'],default='composer')
    p.add_argument('--analyzer',choices=['measurements','qwen'],default='measurements')
    p.add_argument('--mood',choices=['auto','warm','calm','sad','anger'],default='auto')
    p.add_argument('--seed',type=int,default=42)
    p.add_argument('--output',type=Path,default=Path('data/api-output'))
    a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
    key=os.environ.get(a.key_env,'')
    headers={'Authorization':f'Bearer {key}'} if key else {}
    with httpx.Client(base_url=a.url,timeout=120,trust_env=False,headers=headers) as c:
        def read(r):
            r.raise_for_status();return r.json()
        def wait(id):
            previous=None
            while True:
                j=read(c.get('/v1/jobs/'+id))
                if j['phase']!=previous: print(j['phase'],flush=True);previous=j['phase']
                if j['state']=='complete':return j
                if j['state'] in ('failed','cancelled'):raise RuntimeError(j.get('error') or j['state'])
                time.sleep(1)
        with a.video.open('rb') as f:
            uploaded=read(c.post('/v1/videos',files={'file':(a.video.name,f,'video/mp4')}))
        wait(uploaded['job_id'])
        analysis=read(c.post(f'/v1/videos/{uploaded["id"]}/analysis',json={'focus':json.loads(a.focus.read_text()),'analyzer':a.analyzer}))
        wait(analysis['id'])
        job=read(c.post('/v1/soundtracks',json={'video_id':uploaded['id'],'engine':a.engine,'mood':a.mood,'seed':a.seed}))
        result=wait(job['id'])
        for key,name in [('audio_url','soundtrack.wav'),('video_url','soundtrack.mp4')]:
            r=c.get(result[key]);r.raise_for_status();(a.output/name).write_bytes(r.content)
        (a.output/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        print('Saved',a.output.resolve())


if __name__=='__main__':main()
