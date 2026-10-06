"""CPU sphere detector with temporal tracking, for full robot footage.

EchoSphere's sphere is a glass ball, so it is found from several cues at once
rather than from brightness alone: a circular rim (edge support), a lit and
colourful interior, contrast against the surrounding body, and not being a dark
screen (the robot's face). Candidates from every sampled frame are then linked
into one path by dynamic programming, so a single frame cannot pull the
selection onto a lamp, a fire or the face.

Nothing here is a trained model, and its numbers are heuristics: `quality`
values are relative scores in 0..1 and `uncertainty_index` is NOT a calibrated
probability. Unreliable selections are rejected rather than guessed.
"""
import json
import math
import shutil
import subprocess
from pathlib import Path
import cv2
import numpy as np
from .models import FocusPoint

SAMPLE_FPS = 5
WORK_WIDTH = 480
TOP_CANDIDATES = 6
INTERIOR_SHRINK = .9          # analyse slightly inside the glass rim
MAX_KEYPOINTS = 16
MAX_GAP_SECONDS = 1.0
MAX_SAMPLES = 100              # keeps a 60 s clip to about 100 analysed frames

# Rejection thresholds (heuristic; documented in docs/API.md).
MIN_COVERAGE = .7
MIN_QUALITY = .35
MAX_AMBIGUOUS_FRACTION = .35
MAX_JITTER = .12


def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def _read_frames(video, check):
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS)
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if not cap.isOpened() or fps <= 0 or count <= 0:
        raise RuntimeError('Cannot decode the normalized video.')
    duration = count / fps
    stride = max(1, round(fps / min(SAMPLE_FPS, MAX_SAMPLES / max(duration, 1))))
    frames, index = [], 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            check()
            if index % stride == 0:
                h, w = frame.shape[:2]
                scale = WORK_WIDTH / w
                frames.append((index / fps, cv2.resize(frame, (WORK_WIDTH, round(h * scale)), interpolation=cv2.INTER_AREA)))
            index += 1
    finally:
        cap.release()
    return frames, fps, count


def _prepare(frame):
    blur = cv2.GaussianBlur(frame, (5, 5), 0)
    gray = cv2.cvtColor(blur, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    b, g, r = [blur[:, :, i].astype(np.float32) / 255 for i in range(3)]
    chroma = np.max([b, g, r], axis=0) - np.min([b, g, r], axis=0)   # 0 for grey/black, high for coloured light
    value = np.max([b, g, r], axis=0)
    grad = np.hypot(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    return {'gray': gray, 'chroma': chroma, 'value': value, 'grad': grad / 4.0}


_ANGLES = np.linspace(0, 2 * np.pi, 72, endpoint=False)
_COS, _SIN = np.cos(_ANGLES), np.sin(_ANGLES)
_DR = np.arange(-2, 3)[:, None]


def _candidates(frame, cues):
    h, w = frame.shape[:2]
    found = []
    circles = cv2.HoughCircles((cues['gray'] * 255).astype(np.uint8), cv2.HOUGH_GRADIENT_ALT, dp=1.5, minDist=h * .08,
                               param1=250, param2=.82, minRadius=round(h * .06), maxRadius=round(h * .48))
    if circles is not None:
        found += [tuple(map(float, c)) for c in circles[0][:14]]
    # Coloured, lit regions give a second, independent source of candidates.
    mask = ((cues['chroma'] > .22) & (cues['value'] > .3)).astype(np.uint8) * 255
    k = max(3, round(h * .03)) | 1
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
        if cv2.contourArea(c) < math.pi * (h * .05) ** 2:
            continue
        (cx, cy), r = cv2.minEnclosingCircle(c)
        found.append((cx, cy, r))
    valid = [c for c in found if _plausible(c, w, h)]
    # Raw detections are often the outer body ring or an enclosing blob, so they
    # are only seeds: the glass ball is usually concentric with them but smaller.
    seeds = sorted(valid, key=lambda c: -_score(cues, *c))[:5]
    kept = []
    for seed in seeds:
        cx, cy, r = _refine(cues, seed)
        if _plausible((cx, cy, r), w, h) and not any(math.hypot(cx - a, cy - b) < .25 * max(r, s) and abs(r - s) < .25 * max(r, s) for a, b, s in kept):
            kept.append((cx, cy, r))
    return kept


def _plausible(c, w, h):
    cx, cy, r = c
    return h * .06 <= r <= h * .5 and -r * .1 <= cx - r and cx + r <= w + r * .1 and -r * .1 <= cy - r and cy + r <= h + r * .1


def _refine(cues, seed, rounds=3):
    """Coordinate ascent on the plausibility score, from coarse to fine steps."""
    cx, cy, r0 = seed
    # Score is not smooth in radius, so sweep the radius at the seed's centre
    # first, then slide all three parameters from the best of those.
    best, r = max((_score(cues, cx, cy, r0 * k), r0 * k) for k in np.geomspace(.4, 1.15, 14))
    step = .08
    for _ in range(rounds):
        for _ in range(10):
            improved = False
            for dx, dy, dr in ((step, 0, 0), (-step, 0, 0), (0, step, 0), (0, -step, 0), (0, 0, step), (0, 0, -step)):
                nx, ny, nr = cx + dx * r, cy + dy * r, r * (1 + dr)
                if nr < 4:
                    continue
                v = _score(cues, nx, ny, nr)
                if v > best + 1e-4:
                    best, cx, cy, r, improved = v, nx, ny, nr, True
            if not improved:
                break
        step /= 2
    return cx, cy, r


def _box(shape, cx, cy, r):
    h, w = shape
    return max(0, int(cx - r) - 1), min(w, int(cx + r) + 2), max(0, int(cy - r) - 1), min(h, int(cy + r) + 2)


def _score(cues, cx, cy, r):
    """Relative 0..1 plausibility that this circle is the glass sphere."""
    h, w = cues['gray'].shape
    if r < 4:
        return 0.0
    xs = np.rint(cx + (r + _DR) * _COS).astype(int)
    ys = np.rint(cy + (r + _DR) * _SIN).astype(int)
    inb = (xs >= 0) & (xs < w) & (ys >= 0) & (ys < h)
    grads = np.where(inb, cues['grad'][np.clip(ys, 0, h - 1), np.clip(xs, 0, w - 1)], 0)
    q_edge = float((grads.max(axis=0) > .07).mean())
    x0, x1, y0, y1 = _box((h, w), cx, cy, r * 1.5)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    d2 = (xx - cx) ** 2 + (yy - cy) ** 2
    inside = d2 <= (r * .85) ** 2
    ring = (d2 <= (r * 1.5) ** 2) & (d2 > (r * 1.15) ** 2)
    if inside.sum() < 30:
        return 0.0
    chroma, value, gray = cues['chroma'][y0:y1, x0:x1], cues['value'][y0:y1, x0:x1], cues['gray'][y0:y1, x0:x1]
    grad = cues['grad'][y0:y1, x0:x1]
    chroma_px, value_px, grad_px = chroma[inside], value[inside], grad[inside]
    chroma_in, value_in = float(chroma_px.mean()), float(value_px.mean())
    dark_fraction = float((value_px < .15).mean())
    colour_fraction = float((chroma_px > .10).mean())                       # lit, tinted interior (pale violet counts)
    # The white/cream robot body is bright, barely tinted AND smooth. A pale sphere is just as
    # bright but full of structure (stars, reflections, edges), so smoothness separates them.
    body_fraction = float(((chroma_px < .14) & (value_px > .6) & (grad_px < .04)).mean())
    chroma_out = float(chroma[ring].mean()) if ring.sum() > 30 else chroma_in
    texture = float(gray[inside].std())
    q_glow = _clamp(max(chroma_in * value_in / .12, (value_in - .3) / .45))
    q_contrast = _clamp((chroma_in - chroma_out) / .3 + .5)
    q_dark = 1 - _clamp((dark_fraction - .2) / .4)        # the robot's face is mostly a dark screen
    q_body = 1 - _clamp((body_fraction - .12) / .3)       # a circle that swallows the smooth body is not the sphere
    q_fill = _clamp((colour_fraction - .3) / .4)
    q_texture = _clamp(texture / .08)
    q_size = 1.0 if h * .08 <= r <= h * .46 else .6
    return float(q_dark * q_body * q_size * (.24 * q_edge + .18 * q_glow + .24 * q_contrast + .2 * q_fill + .14 * q_texture))


def _track(per_frame):
    """Viterbi over candidates plus a 'missing' state; returns one index per frame (or None)."""
    n = len(per_frame)
    MISS = None
    states = [[(None, 0.0)] + [((cx, cy, r), s) for (cx, cy, r, s) in cands] for cands in per_frame]
    miss_cost, gap_cost = 1.6, .35
    cost = [np.full(len(s), np.inf) for s in states]
    back = [np.full(len(s), -1, int) for s in states]
    for j, (c, s) in enumerate(states[0]):
        cost[0][j] = miss_cost if c is None else -math.log(max(s, 1e-3))
    for t in range(1, n):
        for j, (c, s) in enumerate(states[t]):
            emit = miss_cost if c is None else -math.log(max(s, 1e-3))
            for i, (p, _) in enumerate(states[t - 1]):
                if c is None or p is None:
                    trans = gap_cost
                else:
                    scale = (c[2] + p[2]) / 2
                    trans = 2.5 * math.hypot(c[0] - p[0], c[1] - p[1]) / scale + 3.0 * abs(math.log(c[2] / p[2]))
                total = cost[t - 1][i] + trans + emit
                if total < cost[t][j]:
                    cost[t][j], back[t][j] = total, i
    j = int(np.argmin(cost[-1]))
    path = [j]
    for t in range(n - 1, 0, -1):
        j = int(back[t][j])
        path.append(j)
    path.reverse()
    return [None if states[t][j][0] is None else (*states[t][j][0], states[t][j][1], per_frame[t]) for t, j in enumerate(path)]


def _smooth(times, values, sigma=1.5):
    """Median then Gaussian smoothing of a 1-D track (endpoints held)."""
    v = np.asarray(values, float)
    pad = np.pad(v, 2, mode='edge')
    med = np.array([np.median(pad[i:i + 5]) for i in range(len(v))])
    radius = 4
    kernel = np.exp(-np.arange(-radius, radius + 1) ** 2 / (2 * sigma ** 2))
    kernel /= kernel.sum()
    return np.convolve(np.pad(med, radius, mode='edge'), kernel, mode='valid')


def _simplify(times, cx, cy, r, width, height, limit=MAX_KEYPOINTS, tol=.05):
    """Fewest linear keypoints (<= limit) that follow the path within `tol` radii."""
    idx = [0, len(times) - 1]
    def err(i, a, b):
        t = (times[i] - times[a]) / max(times[b] - times[a], 1e-9)
        return max(abs(cx[i] - (cx[a] + t * (cx[b] - cx[a]))) * width, abs(cy[i] - (cy[a] + t * (cy[b] - cy[a]))) * height,
                   abs(r[i] - (r[a] + t * (r[b] - r[a]))) * height) / max(r[i] * height, 1)
    while len(idx) < limit:
        worst, where = 0.0, None
        idx.sort()
        for a, b in zip(idx, idx[1:]):
            for i in range(a + 1, b):
                e = err(i, a, b)
                if e > worst:
                    worst, where = e, i
        if where is None or worst < tol:
            break
        idx.append(where)
    return sorted(set(idx))


def detect_sphere(video, folder, check=lambda: None):
    """Find and track the sphere. Always writes overlays and a JSON report into `folder`.

    Returns the report. `report['status']` is 'ok' or 'rejected'; when ok,
    `report['focus']` is a list of FocusPoint-compatible dicts.
    """
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    frames, fps, count = _read_frames(video, check)
    h, w = frames[0][1].shape[:2]
    per_frame = []
    for _, frame in frames:
        check()
        cues = _prepare(frame)
        scored = sorted(((cx, cy, r, _score(cues, cx, cy, r)) for cx, cy, r in _candidates(frame, cues)), key=lambda c: -c[3])
        per_frame.append(scored[:TOP_CANDIDATES])
    path = _track(per_frame)
    times = np.array([t for t, _ in frames])
    found = np.array([p is not None for p in path])
    metrics = {'frames_sampled': len(frames), 'sample_fps': round(len(frames) / max(count / fps, 1), 2)}
    coverage = float(found.mean())
    quality = float(np.mean([p[3] for p in path if p is not None])) if found.any() else 0.0
    ambiguous = 0
    for p in path:
        if p is None:
            continue
        rivals = [c for c in p[4] if math.hypot(c[0] - p[0], c[1] - p[1]) > .8 * max(c[2], p[2]) and c[3] >= .85 * p[3]]
        ambiguous += bool(rivals)
    ambiguous_fraction = ambiguous / max(int(found.sum()), 1)
    report = {'schema_version': 1, 'status': 'rejected', 'reasons': [], 'input_size': [w, h]}
    if found.sum() < 2:
        report.update(reasons=['No sphere-like region was found.'], metrics={**metrics, 'coverage': coverage, 'quality': quality,
                      'ambiguous_fraction': ambiguous_fraction, 'jitter': None, 'uncertainty_index': 1.0})
        _write_report(folder, report)
        _export_safely(video, folder, report, check)
        return report
    cx = np.interp(times, times[found], [p[0] for p in path if p])
    cy = np.interp(times, times[found], [p[1] for p in path if p])
    r = np.interp(times, times[found], [p[2] for p in path if p])
    # A long run of missing frames is not interpolated across.
    gaps = _long_gaps(times, found)
    raw = np.stack([cx, cy, r])
    scx, scy, sr = _smooth(times, cx), _smooth(times, cy), _smooth(times, r)
    jitter = float(np.sqrt(np.mean(((raw - np.stack([scx, scy, sr])) / np.mean(sr)) ** 2)))
    uncertainty = _clamp(1 - coverage * quality * (1 - ambiguous_fraction) * (1 - _clamp(jitter * 4)))
    metrics.update(coverage=round(coverage, 3), quality=round(quality, 3), ambiguous_fraction=round(ambiguous_fraction, 3),
                   jitter=round(jitter, 4), longest_gap_seconds=round(gaps, 2), uncertainty_index=round(uncertainty, 3),
                   uncertainty_note='Heuristic index from 0 (confident) to 1 (unreliable). Not a probability.')
    reasons = []
    if coverage < MIN_COVERAGE:
        reasons.append(f'The sphere was found in only {coverage:.0%} of sampled frames.')
    if quality < MIN_QUALITY:
        reasons.append('The best matches were weak sphere candidates.')
    if ambiguous_fraction > MAX_AMBIGUOUS_FRACTION:
        reasons.append('Another region scored almost as well as the chosen one in many frames.')
    if jitter > MAX_JITTER:
        reasons.append('The selection jumped around too much to be a stable sphere.')
    if gaps > MAX_GAP_SECONDS * 2:
        reasons.append('The sphere was lost for a long stretch of the clip.')
    duration = count / fps
    # Keypoints in the same normalized form the analysis API already accepts.
    nx, ny, nr = scx / w, scy / h, sr / h
    keep = _simplify(times, nx, ny, nr, w, h)
    focus = []
    for i in keep:
        rx, ry = nr[i] * h * INTERIOR_SHRINK / w, nr[i] * INTERIOR_SHRINK
        rx, ry = min(rx, .5), min(ry, .5)
        px = _clamp(nx[i], rx + 1e-4, 1 - rx - 1e-4)
        py = _clamp(ny[i], ry + 1e-4, 1 - ry - 1e-4)
        t = 0.0 if not focus else round(min(float(times[i]), duration - .01), 3)
        if focus and t <= focus[-1]['time']:
            continue
        focus.append(FocusPoint(time=t, cx=round(float(px), 4), cy=round(float(py), 4), rx=round(float(rx), 4), ry=round(float(ry), 4)).model_dump())
    report.update(status='ok' if not reasons else 'rejected', reasons=reasons, metrics=metrics, focus=focus,
                  track=[{'time': round(float(t), 3), 'cx': round(float(a / w), 4), 'cy': round(float(b / h), 4), 'radius': round(float(c / h), 4),
                          'detected': bool(f)} for t, a, b, c, f in zip(times, scx, scy, sr, found)])
    _write_report(folder, report)
    _export_safely(video, folder, report, check)
    return report


def _export_safely(video, folder, report, check):
    try:
        export_overlay(video, folder, report, check)
    except Exception as e:                    # the pictures are for inspection; never let them cost the caller the result
        report['overlay_error'] = f'{type(e).__name__}: {str(e)[:300]}'
        _write_report(folder, report)


def _long_gaps(times, found):
    longest, start = 0.0, None
    for t, f in zip(times, found):
        if not f and start is None:
            start = t
        if f and start is not None:
            longest, start = max(longest, t - start), None
    if start is not None:
        longest = max(longest, times[-1] - start)
    return float(longest)


def _write_report(folder, report):
    (folder / 'detection.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


def focus_at(points, time):
    if time <= points[0]['time']:
        return points[0]
    for a, b in zip(points, points[1:]):
        if time <= b['time']:
            t = (time - a['time']) / (b['time'] - a['time'])
            return {k: a[k] + (b[k] - a[k]) * t for k in a}
    return points[-1]


def export_overlay(video, folder, report, check=lambda: None):
    """Write detection-overlay.mp4 and detection-sheet.jpg so a person can see what was selected.

    Green ellipse: the region the colour/motion analysis will read.
    Yellow circle: the tracked sphere outline. Red label: rejected.
    """
    folder = Path(folder)
    focus = report.get('focus')
    track = report.get('track')
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frames_dir = folder / '_overlay'
    shutil.rmtree(frames_dir, ignore_errors=True)
    frames_dir.mkdir()
    sheet, wanted = [], set(np.linspace(0, max(total - 1, 0), 8).astype(int))
    rejected = report['status'] != 'ok'
    index = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            check()
            h, w = frame.shape[:2]
            t = index / fps
            view = cv2.resize(frame, (640, 2 * round(640 * h / w / 2)))   # even size: H.264 rejects odd dimensions
            vh, vw = view.shape[:2]
            if focus:
                f = focus_at(focus, t)
                cv2.ellipse(view, (round(f['cx'] * vw), round(f['cy'] * vh)), (round(f['rx'] * vw), round(f['ry'] * vh)), 0, 0, 360, (80, 220, 80), 2)
            if track:
                times = [p['time'] for p in track]
                j = int(np.argmin(np.abs(np.asarray(times) - t)))
                p = track[j]
                cv2.circle(view, (round(p['cx'] * vw), round(p['cy'] * vh)), round(p['radius'] * vh), (40, 220, 250) if p['detected'] else (160, 160, 160), 1)
            label = ('REJECTED  ' if rejected else '') + f't={t:.1f}s'
            cv2.putText(view, label, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, .65, (60, 60, 230) if rejected else (255, 255, 255), 2, cv2.LINE_AA)
            cv2.imwrite(str(frames_dir / f'{index:05d}.jpg'), view, [cv2.IMWRITE_JPEG_QUALITY, 88])
            if index in wanted:
                sheet.append(cv2.resize(view, (320, round(320 * vh / vw))))
            index += 1
    finally:
        cap.release()
    if sheet:
        while len(sheet) < 8:
            sheet.append(np.zeros_like(sheet[0]))
        grid = np.vstack([np.hstack(sheet[:4]), np.hstack(sheet[4:8])])
        cv2.imwrite(str(folder / 'detection-sheet.jpg'), grid, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if index:
        temp = folder / 'detection-overlay.part.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(fps), '-i', str(frames_dir / '%05d.jpg'), '-an', '-c:v', 'libx264',
                        '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(temp)],
                       check=True, stdin=subprocess.DEVNULL, timeout=180)
        temp.replace(folder / 'detection-overlay.mp4')
    shutil.rmtree(frames_dir, ignore_errors=True)
