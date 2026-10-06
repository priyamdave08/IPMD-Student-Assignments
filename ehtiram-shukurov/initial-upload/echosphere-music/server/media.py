import json
import math
import re
import subprocess
import time
import wave
from pathlib import Path
import numpy as np
from .config import MIN_SECONDS, MAX_SECONDS


def run(args, timeout=180, check=lambda: None):
    # File-backed logs keep malformed media from filling RAM or blocking pipes.
    import tempfile
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p = subprocess.Popen(args, stdout=out, stderr=err, stdin=subprocess.DEVNULL)
        deadline = time.monotonic()+timeout
        try:
            while p.poll() is None:
                check()
                if time.monotonic() > deadline:
                    raise RuntimeError('Media processing timed out.')
                time.sleep(.1)
            if p.returncode:
                err.seek(0)
                detail = err.read(4000).decode(errors='replace')
                raise RuntimeError('Could not process media: '+detail[-1200:])
            out.seek(0)
            return out.read(2_000_000)
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()


def probe(path):
    data = json.loads(run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', str(path)], 30))
    if not set(data.get('format', {}).get('format_name', '').split(',')) & {'mov','mp4'}:
        raise ValueError('The uploaded file is not an MP4 container.')
    streams = data.get('streams', [])
    video = next((s for s in streams if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic')), None)
    if not video:
        raise ValueError('The file has no video stream.')
    duration = float(video.get('duration') or data.get('format', {}).get('duration', 0))
    if not math.isfinite(duration) or not MIN_SECONDS-.05 <= duration <= MAX_SECONDS+.05:
        raise ValueError(f'Choose a video between {MIN_SECONDS} and {MAX_SECONDS} seconds.')
    w, h = int(video['width']), int(video['height'])
    if min(w, h) < 64 or max(w, h) > 4096 or w*h > 4096*2160:
        raise ValueError('Supported video dimensions are 64 pixels through 4K.')
    return {'duration': duration, 'width': w, 'height': h,
            'source_has_audio': any(s['codec_type'] == 'audio' for s in streams)}


def prepare_video(source, folder, check):
    original = probe(source)
    target = folder / 'preview.mp4'
    temp = folder / 'preview.part.mp4'
    # Decode all frames; normalize rotation, VFR and pixel format. No source audio
    # enters either the analysis or the final preview/export path.
    run(['ffmpeg', '-v', 'error', '-xerror', '-y', '-threads', '2', '-protocol_whitelist', 'file,pipe', '-i', str(source), '-map', '0:v:0', '-an',
         '-vf', "scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=24",
         '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
         '-map_metadata', '-1', '-movflags', '+faststart', str(temp)], 180, check)
    metadata = probe(temp)
    # The normalized presentation timeline is authoritative for both analysis and audio.
    metadata['original'] = original
    temp.replace(target)
    webm(target, None, folder/'preview.webm', check)
    return metadata


def finish_audio(raw, folder, duration, check):
    count = round(duration*44100)
    # Reject short, empty or silent model output rather than padding a failed piece.
    normalized = folder / 'decoded.wav'
    run(['ffmpeg', '-v', 'error', '-y', '-i', str(raw), '-vn', '-ac', '2', '-ar', '44100',
         '-c:a', 'pcm_s16le', str(normalized)], 120, check)
    with wave.open(str(normalized), 'rb') as f:
        if f.getnframes() < count:
            raise RuntimeError('The generator returned less audio than the video duration. Try another variation.')
        audio = np.frombuffer(f.readframes(count), dtype='<i2').astype(np.float32)/32768
    if not np.isfinite(audio).all() or np.sqrt(np.mean(audio**2)) < .0001:
        raise RuntimeError('The generator returned silent or invalid audio.')
    temp, target = folder/'soundtrack.part.wav', folder/'soundtrack.wav'
    fade = min(.6, duration*.06)
    run(['ffmpeg', '-v', 'error', '-y', '-i', str(normalized), '-map_metadata', '0', '-af',
         f'atrim=end_sample={count},asetpts=PTS-STARTPTS,afade=t=in:d=0.025,afade=t=out:st={duration-fade}:d={fade},alimiter=limit=0.88:level=false:latency=true',
         '-c:a', 'pcm_s16le', str(temp)], 120, check)
    with wave.open(str(temp), 'rb') as f:
        if f.getnframes() != count:
            raise RuntimeError('Finished audio duration does not match the video.')
        values = np.frombuffer(f.readframes(count), dtype='<i2').astype(np.float32)/32768
    loudness = measure_loudness(temp)
    # Preserve the chosen dynamics; only attenuate if an inter-sample peak
    # exceeds the -1 dBTP ceiling. Do not equate sample peak with true peak.
    if loudness['true_peak_dbtp'] > -1:
        gain=10**((-1.05-loudness['true_peak_dbtp'])/20)
        attenuated=folder/'attenuated.wav'
        run(['ffmpeg','-v','error','-y','-i',str(temp),'-af',f'volume={gain}',
             '-c:a','pcm_s16le',str(attenuated)],60,check)
        attenuated.replace(temp)
        with wave.open(str(temp),'rb') as f:
            values=np.frombuffer(f.readframes(count),dtype='<i2').astype(np.float32)/32768
        loudness=measure_loudness(temp)
    if loudness['true_peak_dbtp'] > -.99:
        raise RuntimeError('The finished audio exceeds the export true-peak ceiling.')
    temp.replace(target)
    normalized.unlink(missing_ok=True)
    return {'samples': count, 'sample_rate': 44100, 'duration': count/44100,
            'sample_peak': float(np.max(np.abs(values))), 'rms': float(np.sqrt(np.mean(values**2))), **loudness}


def measure_loudness(path):
    result=subprocess.run(['ffmpeg','-hide_banner','-nostats','-i',str(path),'-af',
                           'loudnorm=I=-18:TP=-1:LRA=11:print_format=json','-f','null','-'],
                          capture_output=True,text=True,timeout=30,stdin=subprocess.DEVNULL)
    match=re.search(r'\{\s*"input_i"[\s\S]*?\}',result.stderr)
    if result.returncode or not match:
        raise RuntimeError('Could not measure the finished audio loudness.')
    values=json.loads(match.group())
    stats={'integrated_lufs':float(values['input_i']),'true_peak_dbtp':float(values['input_tp']),
           'loudness_range_lu':float(values['input_lra'])}
    if not all(math.isfinite(v) for v in stats.values()):
        raise RuntimeError('Finished audio has invalid loudness measurements.')
    return stats


def mux(video, audio, folder, check):
    temp = folder / 'soundtrack.part.mp4'
    run(['ffmpeg', '-v', 'error', '-y', '-i', str(video), '-i', str(audio), '-map', '0:v:0', '-map', '1:a:0',
         '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-map_metadata', '1', '-movflags', '+faststart',
         '-shortest', str(temp)], 120, check)
    probe(temp)
    temp.replace(folder / 'soundtrack.mp4')
    webm(video, audio, folder/'preview.webm', check)


def webm(video, audio, target, check):
    """Same presentation timeline, for browsers without H.264/AAC codecs."""
    temp=target.with_suffix('.part.webm')
    args=['ffmpeg','-v','error','-y','-i',str(video)]
    if audio:
        args+=['-i',str(audio),'-map','0:v:0','-map','1:a:0','-c:a','libopus','-b:a','160k']
    else:
        args+=['-map','0:v:0','-an']
    args+=['-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-row-mt','1','-threads','2',
           '-crf','35','-b:v','0','-map_metadata','1' if audio else '-1',str(temp)]
    run(args,180,check)
    temp.replace(target)
