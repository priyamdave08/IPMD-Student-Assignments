import numpy as np
from server import detect
from tests.synthetic import make_video


def iou(a, b, size=(640, 360)):
    import cv2
    w, h = size
    def mask(f):
        m = np.zeros((h, w), np.uint8)
        cv2.ellipse(m, (round(f['cx'] * w), round(f['cy'] * h)), (max(1, round(f['rx'] * w)), max(1, round(f['ry'] * h))), 0, 0, 360, 255, -1)
        return m > 0
    x, y = mask(a), mask(b)
    return float((x & y).sum() / max((x | y).sum(), 1))


def test_tracks_a_zooming_sphere_and_ignores_face_fire_and_lamp(tmp_path):
    truth = make_video(tmp_path / 'scene.mp4')
    report = detect.detect_sphere(tmp_path / 'scene.mp4', tmp_path / 'out')
    assert report['status'] == 'ok', report['reasons']
    scores = [iou(detect.focus_at(truth, p['time']), detect.focus_at(report['focus'], p['time'])) for p in truth]
    assert np.mean(scores) > .6 and min(scores) > .4, scores
    # The analysis region must stay off the robot's face (the dark oval above the sphere).
    for point in report['focus']:
        assert point['cy'] - point['ry'] > .3, point
    assert (tmp_path / 'out' / 'detection-overlay.mp4').stat().st_size > 1000
    assert (tmp_path / 'out' / 'detection-sheet.jpg').stat().st_size > 1000
    assert report['metrics']['uncertainty_note'].startswith('Heuristic')


def test_scene_without_a_sphere_is_rejected(tmp_path):
    make_video(tmp_path / 'none.mp4', sphere=False)
    report = detect.detect_sphere(tmp_path / 'none.mp4', tmp_path / 'out')
    assert report['status'] == 'rejected', report['metrics']
    assert report['reasons']
    assert (tmp_path / 'out' / 'detection.json').exists()
    assert (tmp_path / 'out' / 'detection-sheet.jpg').exists()   # overlays still exported for inspection


def test_focus_points_match_the_existing_analysis_contract(tmp_path):
    from server.models import AnalysisRequest
    make_video(tmp_path / 'scene.mp4')
    report = detect.detect_sphere(tmp_path / 'scene.mp4', tmp_path / 'out')
    request = AnalysisRequest(focus=report['focus'])       # validates ordering, bounds and the 16 point limit
    assert request.focus[0].time == 0 and len(request.focus) <= 16
