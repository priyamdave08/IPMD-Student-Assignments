"""Read-only check of this computer. Does not install or download models."""
import importlib.metadata
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path

report={'python':platform.python_version(),'platform':platform.platform(),
        'free_disk_gb':round(shutil.disk_usage(Path.cwd()).free/1024**3,1),'packages':{}}
for package in ('fastapi','numpy','opencv-python-headless','playwright'):
    try:report['packages'][package]=importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:report['packages'][package]='missing'
for tool in ('ffmpeg','ffprobe','ollama','nvidia-smi'):
    report[tool]=bool(shutil.which(tool))
if report['nvidia-smi']:
    r=subprocess.run(['nvidia-smi','--query-gpu=name,memory.total,driver_version','--format=csv'],capture_output=True,text=True,timeout=15)
    report['gpu']=r.stdout.strip() if r.returncode==0 else r.stderr.strip()
if report['ffmpeg']:
    r=subprocess.run(['ffmpeg','-hide_banner','-encoders'],capture_output=True,text=True,timeout=15)
    report['encoders']={n:n in r.stdout for n in ('libx264','libvpx-vp9','libopus','aac')}
print(json.dumps(report,indent=2))
