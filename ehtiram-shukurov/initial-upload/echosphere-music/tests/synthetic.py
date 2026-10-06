"""Synthetic robot scenes for detector tests: no real footage is stored in the repository.

The scene has the traps the real demo has: a dark face with bright eyes above the
sphere, a white body around it, a fireplace and a lamp that are bright and warm,
and a camera that zooms and pans.
"""
import subprocess
from pathlib import Path
import cv2
import numpy as np

W, H, FPS = 640, 360, 24


def _scene(t, duration, sphere, hue, rng, hue2=None):
    img = np.zeros((H, W, 3), np.uint8)
    img[:] = (215, 222, 232)
    img[: H // 2] = (200, 208, 220)
    cv2.rectangle(img, (0, 300), (W, H), (170, 175, 185), -1)             # table
    cv2.ellipse(img, (320, 235), (100, 125), 0, 0, 360, (246, 246, 242), -1)  # white body
    cv2.ellipse(img, (320, 95), (58, 42), 0, 0, 360, (22, 22, 24), -1)         # dark face screen
    for dx in (-22, 22):
        cv2.ellipse(img, (320 + dx, 92), (9, 6), 0, 200, 340, (120, 200, 255), 3)   # glowing eyes
    for _ in range(3):                                                        # fireplace flames
        cv2.ellipse(img, (60 + int(rng.integers(-12, 12)), 250 + int(rng.integers(-20, 10))), (26, 42), 0, 0, 360, (0, 120, 255), -1)
    cv2.ellipse(img, (60, 260), (12, 22), 0, 0, 360, (120, 230, 255), -1)
    cv2.circle(img, (585, 70), 16, (150, 240, 255), -1)                       # lamp
    truth = None
    if sphere:
        cx, cy, r = 320, 222, 62
        yy, xx = np.mgrid[:H, :W]
        d = np.hypot(xx - cx, yy - cy) / r
        inside = d <= 1
        colour = np.zeros((H, W, 3), np.float32)
        base = np.array(hue, np.float32)
        colour[:] = base * (1.1 - .5 * d[..., None])
        if hue2 is not None:                                                  # right half a different colour
            colour[:, cx:] = np.array(hue2, np.float32) * (1.1 - .5 * d[:, cx:, None])
        sky = (yy < cy - r * .1)[..., None]
        colour = np.where(sky, colour * .35 + np.array([90, 40, 20], np.float32), colour)
        img[inside] = np.clip(colour[inside], 0, 255).astype(np.uint8)
        for _ in range(28):                                                   # particles
            a, b = rng.uniform(0, 6.28), rng.uniform(0, .9) * r
            cv2.circle(img, (int(cx + b * np.cos(a)), int(cy + b * np.sin(a))), int(rng.integers(2, 5)), (200, 240, 255), -1)
        cv2.circle(img, (cx, cy), int(r), (235, 235, 235), 2, cv2.LINE_AA)
        truth = (cx, cy, r)
    zoom = 1 + .7 * t / duration
    pan = 40 * t / duration
    m = np.array([[zoom, 0, 320 - 320 * zoom - pan], [0, zoom, 250 - 250 * zoom]], np.float32)
    img = cv2.warpAffine(img, m, (W, H), borderMode=cv2.BORDER_REPLICATE)
    if truth:
        cx, cy, r = truth
        truth = (zoom * cx + m[0, 2], zoom * cy + m[1, 2], zoom * r)
    return img, truth


def make_video(path, sphere=True, hue=(40, 150, 235), duration=10, seed=1, hue2=None):
    """Write an MP4 (BGR `hue` for the sphere interior). Returns per-second truth circles in normalized units."""
    path = Path(path)
    rng = np.random.default_rng(seed)
    raw = path.with_suffix('.raw.avi')
    out = cv2.VideoWriter(str(raw), cv2.VideoWriter_fourcc(*'MJPG'), FPS, (W, H))
    truths = []
    for i in range(int(duration * FPS)):
        t = i / FPS
        frame, truth = _scene(t, duration, sphere, hue, rng, hue2)
        out.write(frame)
        if truth and i % FPS == 0:
            truths.append({'time': round(t, 2), 'cx': float(truth[0] / W), 'cy': float(truth[1] / H), 'rx': float(truth[2] / W), 'ry': float(truth[2] / H)})
    out.release()
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(raw), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)], check=True)
    raw.unlink()
    return truths


def make_flat_video(path, bgr=(40, 150, 235), duration=10):
    """A sphere-only clip: the whole frame is coloured light with gentle variation."""
    path = Path(path)
    raw = path.with_suffix('.raw.avi')
    out = cv2.VideoWriter(str(raw), cv2.VideoWriter_fourcc(*'MJPG'), FPS, (W, H))
    yy, xx = np.mgrid[:H, :W]
    for i in range(int(duration * FPS)):
        shade = 1.0 - .35 * np.hypot(xx - W / 2 - 30 * np.sin(i / 20), yy - H / 2) / (W / 2)
        out.write(np.clip(np.array(bgr, np.float32) * shade[..., None], 0, 255).astype(np.uint8))
    out.release()
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(raw), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)], check=True)
    raw.unlink()
