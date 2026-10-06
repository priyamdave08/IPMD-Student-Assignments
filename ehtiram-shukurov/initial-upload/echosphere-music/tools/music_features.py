"""Audio features for checking whether a track's mood folder is plausible.

numpy and ffmpeg only. Features are measured on the FIRST 60 SECONDS of a track,
because that is the part that gets played for a 10 to 60 second video. They are
crude descriptors (tempo, brightness, loudness, major/minor lean); they cannot
hear "sad" versus "calm", so their job is to flag tracks that look unlike their
folder, not to decide a mood.
"""
import json
import math
import re
import subprocess
from pathlib import Path
import numpy as np

SR, N_FFT, HOP = 22050, 2048, 512
FPS = SR / HOP
HEAD_SECONDS = 60
NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
# Krumhansl-Kessler key profiles.
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def decode(path, seconds=HEAD_SECONDS):
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', str(SR), '-t', str(seconds), '-f', 'f32le', '-'],
                         capture_output=True, check=True, stdin=subprocess.DEVNULL).stdout
    y = np.frombuffer(out, np.float32)
    if len(y) < N_FFT * 4:
        raise ValueError('Audio is too short to analyse.')
    return y


def probe(path):
    """Container facts and embedded tags."""
    data = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,bit_rate:format_tags', '-of', 'json', str(path)],
                                     capture_output=True, check=True, text=True, stdin=subprocess.DEVNULL).stdout)
    fmt = data['format']
    tags = {k.lower(): v for k, v in fmt.get('tags', {}).items()}
    return {'duration': round(float(fmt['duration']), 2), 'kbps': round(float(fmt.get('bit_rate', 0)) / 1000), 'tags': tags}


def head_loudness(path, seconds=HEAD_SECONDS):
    """Integrated loudness (LUFS) and true peak of the first minute, measured the same way the pipeline measures output."""
    result = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-t', str(seconds), '-i', str(path), '-af', 'loudnorm=I=-18:TP=-1:LRA=11:print_format=json',
                             '-f', 'null', '-'], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)
    match = re.search(r'\{\s*"input_i"[\s\S]*?\}', result.stderr)
    if result.returncode or not match:
        raise RuntimeError('Could not measure loudness.')
    values = json.loads(match.group())
    return {'lufs': float(values['input_i']), 'true_peak_dbtp': float(values['input_tp'])}


def _frames(y, size, hop):
    return np.lib.stride_tricks.sliding_window_view(y, size)[::hop]


def _pick_peaks(env, min_gap):
    threshold = env.mean() + .6 * env.std()
    candidates = np.flatnonzero((env[1:-1] > env[:-2]) & (env[1:-1] >= env[2:]) & (env[1:-1] > threshold)) + 1
    kept, last = [], -min_gap
    for i in candidates:
        if i - last >= min_gap:
            kept.append(i)
            last = i
    return kept


def _tempo(flux):
    x = flux - flux.mean()
    n = len(x)
    spectrum = np.fft.rfft(x, 2 * n)
    ac = np.fft.irfft(spectrum * np.conj(spectrum))[:n]
    ac = ac / (ac[0] + 1e-12)
    bpms = np.arange(55, 191)
    lags = np.round(60 * FPS / bpms).astype(int)
    strength = ac[np.clip(lags, 0, n - 1)]
    prior = np.exp(-.5 * (np.log2(bpms / 110) / .7) ** 2)        # mild preference for walking-to-running pace
    best = int(np.argmax(strength * prior))
    return int(bpms[best]), float(max(strength[best], 0))


def _beats(flux, tempo_bpm):
    """Beat times in seconds from the onset envelope: the phase of a grid at the estimated
    tempo that lands on the most onset energy. Crude but dependency-free; the grid is only
    used to start excerpts on a beat, so phase matters more than perfect tempo."""
    period = 60.0 / tempo_bpm if tempo_bpm > 0 else 0
    step = int(round(period * FPS))
    if step < 1 or len(flux) <= step:
        return []
    best_phase = int(np.argmax([flux[phase::step].sum() for phase in range(step)]))
    n = 1 + (len(flux) - 1 - best_phase) // step
    return [round((best_phase + k * step) / FPS, 3) for k in range(n)]


def _chroma(y):
    size, hop = 8192, 4096
    window = np.hanning(size).astype(np.float32)
    mag = np.abs(np.fft.rfft(_frames(y, size, hop) * window, axis=1))
    freqs = np.fft.rfftfreq(size, 1 / SR)
    keep = (freqs >= 100) & (freqs <= 3000)
    pitch_class = np.round(69 + 12 * np.log2(freqs[keep] / 440)).astype(int) % 12
    squashed = np.log1p(30 * mag[:, keep])                       # so a few loud partials do not decide the key
    return np.array([squashed[:, pitch_class == k].sum() for k in range(12)])


def _key(chroma):
    best = {}
    for mode, profile in (('major', MAJOR), ('minor', MINOR)):
        scores = [np.corrcoef(np.roll(profile, tonic), chroma)[0, 1] for tonic in range(12)]
        tonic = int(np.argmax(scores))
        best[mode] = (float(scores[tonic]), tonic)
    mode = 'major' if best['major'][0] >= best['minor'][0] else 'minor'
    return {'key': f'{NOTES[best[mode][1]]} {mode}', 'mode': mode, 'major_corr': round(best['major'][0], 3), 'minor_corr': round(best['minor'][0], 3),
            'mode_margin': round(best['major'][0] - best['minor'][0], 3)}


def analyze(path):
    """Everything measured from the first minute of one file. Returns plain numbers."""
    y = decode(path)
    seconds = len(y) / SR
    frames = _frames(y, N_FFT, HOP)
    window = np.hanning(N_FFT).astype(np.float32)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    rms_db = 20 * np.log10(rms)
    live = rms_db > rms_db.max() - 45                              # ignore near-silent frames in averages
    mag = np.abs(np.fft.rfft(frames * window, axis=1)).astype(np.float32)
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
    total = mag.sum(axis=1) + 1e-9
    centroid = (mag * freqs).sum(axis=1) / total
    power = mag ** 2
    energy = power.sum(axis=1) + 1e-12
    low_ratio = power[:, freqs < 200].sum(axis=1) / energy
    log_mag = np.log1p(10 * mag)
    flux = np.maximum(0, np.diff(log_mag, axis=0)).sum(axis=1)
    flux = np.concatenate([[0], flux])
    peaks = _pick_peaks(flux, 4)
    tempo, pulse = _tempo(flux[live] if live.sum() > 100 else flux)
    lead = np.flatnonzero(rms_db > -50)
    key = _key(_chroma(y))
    features = {
        'analysed_seconds': round(seconds, 1),
        'tempo_bpm': tempo,
        'pulse_clarity': round(pulse, 3),
        'beats': _beats(flux, tempo),
        'onset_rate': round(len(peaks) / seconds, 3),
        'rms_db': round(float(np.mean(rms_db[live])), 2),
        'dynamic_range_db': round(float(np.percentile(rms_db, 95) - np.percentile(rms_db, 10)), 2),
        'centroid_hz': round(float(np.average(centroid[live], weights=rms[live])), 1),
        'low_ratio': round(float(np.mean(low_ratio[live])), 3),
        'flux_mean': round(float(flux[live].mean()), 3),
        'lead_silence_s': round(float(lead[0] * HOP / SR) if len(lead) else seconds, 2),
        'clip_fraction': round(float(np.mean(np.abs(y) >= .999)), 6),
        **key,
    }
    features.update(head_loudness(path))
    # Loudness of just the first 10 and 30 seconds too: the intro is often quieter than the first minute, and a video
    # only hears as much of the track as it is long. None when that stretch is silent.
    for seconds in (10, 30):
        try:
            value = head_loudness(path, seconds)['lufs']
        except Exception:
            value = None
        features[f'lufs_{seconds}'] = value if value is not None and math.isfinite(value) else None
    return features
