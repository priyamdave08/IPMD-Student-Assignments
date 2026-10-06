"""Compare automatic sphere detection with hand-marked focus points on the supplied demo.

This is DEMO VALIDATION for one clip whose manual points came from the same
person and footage that informed the detector. It is not evidence of general
reliability. Outputs (overlay video, contact sheet, JSON) go to test-results/.

    python scripts/validate_demo_detection.py "C:\\path\\demo.mp4" [--focus docs/demo-focus.example.json]
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import detect, media  # noqa: E402


def iou_ellipses(a, b, size=(640, 360)):
    w, h = size
    def mask(f):
        m = np.zeros((h, w), np.uint8)
        cv2.ellipse(m, (round(f['cx'] * w), round(f['cy'] * h)), (max(1, round(f['rx'] * w)), max(1, round(f['ry'] * h))), 0, 0, 360, 255, -1)
        return m > 0
    ma, mb = mask(a), mask(b)
    return float((ma & mb).sum() / max((ma | mb).sum(), 1))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('video', type=Path)
    p.add_argument('--focus', type=Path, default=ROOT / 'docs' / 'demo-focus.example.json')
    p.add_argument('--out', type=Path, default=ROOT / 'test-results' / 'demo-detection')
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    manual = json.loads(a.focus.read_text())
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        meta = media.prepare_video(a.video, tmp, lambda: None)
        report = detect.detect_sphere(tmp / 'preview.mp4', a.out, lambda: None)
    result = {'clip_seconds': meta['duration'], 'status': report['status'], 'reasons': report['reasons'], 'metrics': report['metrics']}
    if report.get('focus'):
        times = np.arange(0, meta['duration'] - .05, .2)
        ious, centre, radius = [], [], []
        w, h = meta['width'], meta['height']
        for t in times:
            m, d = detect.focus_at(manual, t), detect.focus_at(report['focus'], t)
            ious.append(iou_ellipses(m, d))
            centre.append(float(np.hypot((m['cx'] - d['cx']) * w, (m['cy'] - d['cy']) * h)))
            radius.append(float(d['ry'] / m['ry']))
        result['vs_manual'] = {'samples': len(times), 'mean_iou': round(float(np.mean(ious)), 3), 'min_iou': round(float(np.min(ious)), 3),
                               'mean_centre_error_px_at_1280w': round(float(np.mean(centre)), 1), 'max_centre_error_px': round(float(np.max(centre)), 1),
                               'radius_ratio_auto_over_manual_mean': round(float(np.mean(radius)), 3),
                               'note': 'Demo validation on one clip. Not a general accuracy figure.'}
        result['auto_focus_points'] = len(report['focus'])
    (a.out / 'validation.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    print('Overlay:', a.out / 'detection-overlay.mp4', '\nSheet:  ', a.out / 'detection-sheet.jpg')


if __name__ == '__main__':
    main()
