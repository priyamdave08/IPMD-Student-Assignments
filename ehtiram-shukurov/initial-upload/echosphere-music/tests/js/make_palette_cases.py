"""Regenerates tests/js/fixtures/palette-cases.json: pixel sets and the answer the Python palette rule (server/analysis.py) gives for each.

The browser port in video-music/mood.js is tested against these, so it is checked against the original rather than against itself.
    python tests/js/make_palette_cases.py
"""
import base64
import json
import sys
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
from server import analysis  # noqa: E402

SIZE = 96
rng = np.random.default_rng(11)
cases = []
yy, xx = np.mgrid[:SIZE, :SIZE]


def hsv_img(h, s, v):
    hsv = np.dstack([np.full((SIZE, SIZE), h), np.full((SIZE, SIZE), s), np.full((SIZE, SIZE), v)]).astype(np.uint8)
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)


def case(name, bgr):
    crop = bgr.astype(np.uint8).copy()
    mask = np.zeros((SIZE, SIZE), np.uint8)
    cv2.ellipse(mask, (SIZE // 2, SIZE // 2), (int(SIZE / 2 * 108 / 112), int(SIZE / 2 * 108 / 112)), 0, 0, 360, 255, -1)
    crop[mask == 0] = 0
    scores = analysis.palette(crop, mask.astype(bool))
    rgba = np.dstack([crop[:, :, 2], crop[:, :, 1], crop[:, :, 0], np.full((SIZE, SIZE), 255, np.uint8)])
    cases.append({'name': name, 'size': SIZE, 'rgba': base64.b64encode(rgba.tobytes()).decode(), 'expected': scores})


case('random noise', rng.integers(0, 256, (SIZE, SIZE, 3)))
gold = hsv_img(22, 200, 230); gold[(xx + yy) % 9 == 0] = (200, 240, 255); case('gold with sparkles', gold)
case('deep blue', hsv_img(105, 210, 200))
mix = hsv_img(105, 210, 200); mix[:, SIZE // 2:] = hsv_img(150, 150, 220)[:, SIZE // 2:]; case('blue and violet halves', mix)
pale = hsv_img(128, 70, 240); pale[(xx * 3 + yy) % 17 == 0] = (255, 255, 255); case('pale violet with stars', pale)
case('red', hsv_img(4, 230, 220))
case('green (belongs to no mood)', hsv_img(60, 200, 200))
case('almost black', hsv_img(22, 200, 10))
out = Path(__file__).resolve().parent / 'fixtures' / 'palette-cases.json'
out.write_text(json.dumps(cases), encoding='utf-8')
print(f'{len(cases)} cases, {out.stat().st_size // 1024} KB')
