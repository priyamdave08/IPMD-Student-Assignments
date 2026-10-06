"""Start the HTTP service and its separate serial worker on this computer."""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


def main():
    root=Path(__file__).resolve().parent
    os.chdir(root)
    for tool in ('ffmpeg','ffprobe'):
        if not shutil.which(tool):
            sys.exit(f'{tool} is missing. Install FFmpeg and add its bin folder to PATH. See docs/LOCAL_SETUP.md.')
    host,port=os.environ.get('ECHOSPHERE_HOST','127.0.0.1'),os.environ.get('ECHOSPHERE_PORT','8765')
    if host not in ('127.0.0.1','localhost','::1') and len(os.environ.get('ECHOSPHERE_API_KEY',''))<24:
        sys.exit('Listening beyond this computer requires ECHOSPHERE_API_KEY (at least 24 characters) and ECHOSPHERE_ALLOWED_HOSTS.')
    extra=['--proxy-headers','--forwarded-allow-ips','*'] if os.environ.get('ECHOSPHERE_BEHIND_PROXY')=='1' else []
    children=[]
    try:
        children.append(subprocess.Popen([sys.executable,'-m','server.worker']))
        children.append(subprocess.Popen([sys.executable,'-m','uvicorn','server.app:app','--host',host,'--port',port]+extra))
        print('\nEchoSphere: http://127.0.0.1:8765\nPress Ctrl+C to stop both processes.\n',flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(.5)
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:child.kill();child.wait()


if __name__=='__main__':main()
