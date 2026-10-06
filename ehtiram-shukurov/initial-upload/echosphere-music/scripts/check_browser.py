"""End-to-end browser check with a user-provided MP4; starts/stops local services."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import httpx
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('video',type=Path)
    parser.add_argument('--focus',type=Path,default=ROOT/'docs/demo-focus.example.json')
    args=parser.parse_args()
    out=ROOT/'test-results';out.mkdir(exist_ok=True)
    env={**os.environ,'ECHOSPHERE_DATA':str(out/'data')}
    log=(out/'services.log').open('w')
    server=subprocess.Popen([sys.executable,'run_local.py'],cwd=ROOT,env=env,stdout=log,stderr=log,start_new_session=os.name!='nt')
    base='http://127.0.0.1:8765'
    try:
        with httpx.Client(base_url=base,trust_env=False,timeout=10) as client:
            for _ in range(80):
                try:
                    health=client.get('/health').json()
                    if health['worker_online']:break
                except Exception:pass
                time.sleep(.25)
            else:raise RuntimeError('Local server did not start. See test-results/services.log.')
            with sync_playwright() as p:
                browser=p.chromium.launch(headless=True)
                page=browser.new_page(viewport={'width':1440,'height':1100})
                errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(base);page.get_by_text('Local server connected',exact=True).wait_for()
                page.screenshot(path=str(out/'empty-desktop.png'),full_page=True)
                page.locator('#fileInput').set_input_files(args.video.resolve())
                page.locator('#focusPanel').wait_for(state='visible',timeout=180000)
                page.wait_for_function('document.querySelector("#sourceVideo").videoWidth>0')
                for point in json.loads(args.focus.read_text()):
                    page.locator('#focusTime').fill(str(point['time']))
                    page.locator('#focusTime').dispatch_event('input')
                    for id,value in [('focusCx',point['cx']*100),('focusCy',point['cy']*100),('focusWidth',point['rx']*200),('focusHeight',point['ry']*200)]:
                        page.locator('#'+id).fill(str(value));page.locator('#'+id).dispatch_event('change')
                    page.locator('#saveFocus').click()
                page.screenshot(path=str(out/'focus-desktop.png'),full_page=True)
                page.locator('#analyzeButton').click()
                page.locator('#reviewPanel').wait_for(state='visible',timeout=180000)
                page.locator('#generateButton').click()
                page.locator('#resultPanel').wait_for(state='visible',timeout=180000)
                page.locator('#resultVideo').scroll_into_view_if_needed()
                page.locator('#resultVideo').evaluate('(v) => v.play()')
                page.wait_for_function('document.querySelector("#resultVideo").currentTime > 0.2')
                page.locator('#resultVideo').evaluate('(v) => {v.pause();v.currentTime=5;}')
                page.wait_for_function('Math.abs(document.querySelector("#resultVideo").currentTime-5)<0.1')
                page.locator('#resultVideo').evaluate('(v) => v.play()')
                page.wait_for_function('document.querySelector("#resultVideo").currentTime>5.2')
                page.locator('#resultVideo').evaluate('(v) => v.pause()')
                audio_url=page.locator('#audioDownload').get_attribute('href')
                video_url=page.locator('#videoDownload').get_attribute('href')
                for url,name in [(audio_url,'demo-soundtrack.wav'),(video_url,'demo-with-music.mp4')]:
                    response=client.get(url);response.raise_for_status();(out/name).write_bytes(response.content)
                job=client.get(audio_url.rsplit('/',1)[0]).json()
                (out/'demo-result.json').write_text(json.dumps(job,indent=2))
                page.screenshot(path=str(out/'result-desktop.png'),full_page=True)
                saved=page.locator('#savedVideos').input_value()
                page.reload();page.get_by_text('Local server connected',exact=True).wait_for()
                page.locator('.settings summary').click()
                page.locator('#savedVideos').select_option(saved)
                page.locator('#resultPanel').wait_for(state='visible')
                page.wait_for_function('document.querySelector("#resultVideo").readyState>=2')
                assert page.locator('#audioDownload').get_attribute('href')==audio_url
                page.set_viewport_size({'width':390,'height':844})
                page.screenshot(path=str(out/'result-mobile.png'),full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                assert not errors,errors
                print(json.dumps({'status':'passed','video_id':saved,'job_id':job['id'],'mood':job['result']['brief']['mood'],
                                  'audio':job['result']['audio'],'browser_errors':errors,'output':str(out)},indent=2))
                browser.close()
    finally:
        if os.name!='nt':
            import signal
            os.killpg(server.pid,signal.SIGTERM)
        else:server.terminate()
        server.wait(timeout=10);log.close()


if __name__=='__main__':main()
