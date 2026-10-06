"""The browser-only page (video-music/), driven in a real Chromium with synthetic robot videos.

No product footage is used. The videos come from tests/synthetic.py, converted to WebM because the Chromium that ships with
Playwright cannot decode H.264. Songs are the real library in music-library/.
"""
import json
import subprocess
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright
from tests.static_server import serve
import cv2
from tests.synthetic import make_flat_video, make_video

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(not (ROOT / 'music-library' / 'manifest.json').exists(), reason='the music library is not present')


def webm(source, target):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-an', str(target)], check=True)
    return target


@pytest.fixture(scope='module')
def clips(tmp_path_factory):
    d = tmp_path_factory.mktemp('clips')
    made = {}
    for name, kwargs in {'warm': {}, 'mixed': {'hue': (215, 120, 40), 'hue2': (215, 60, 150)}, 'nosphere': {'sphere': False}}.items():
        make_video(d / f'{name}.mp4', **kwargs)
        made[name] = webm(d / f'{name}.mp4', d / f'{name}.webm')
    make_flat_video(d / 'grey.mp4', bgr=(128, 128, 128))        # no sphere and no coloured light at all
    made['grey'] = webm(d / 'grey.mp4', d / 'grey.webm')
    (d / 'notavideo.mp4').write_text('this is not a video')
    made['bad'] = d / 'notavideo.mp4'
    return made


@pytest.fixture(scope='module')
def site():
    server, base = serve(ROOT)
    yield base + '/video-music/'
    server.shutdown()


@pytest.fixture(scope='module')
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=['--autoplay-policy=no-user-gesture-required'])
        yield b
        b.close()


@pytest.fixture
def page(browser, site):
    context = browser.new_context(viewport={'width': 1280, 'height': 900})
    pg = context.new_page()
    pg.problems = []
    pg.on('pageerror', lambda e: pg.problems.append(f'pageerror: {e}'))
    pg.on('console', lambda m: pg.problems.append(f'console.error: {m.text}') if m.type == 'error' else None)
    pg.goto(site)
    pg.wait_for_function("document.getElementById('library').textContent.includes('songs')", timeout=15000)
    yield pg
    assert not pg.problems, pg.problems
    context.close()


def feed(page, path, song=True):
    page.set_input_files('#fileInput', str(path))
    page.wait_for_function("EchoApp.state.decision !== null || document.getElementById('status').classList.contains('error') || (EchoApp.state.report && EchoApp.state.report.status === 'rejected')", timeout=120000)
    if song:
        page.wait_for_function("EchoApp.state.track && EchoApp.audio.readyState >= 3", timeout=60000)


def test_the_library_loads_and_only_approved_songs_are_counted(page):
    manifest = json.loads((ROOT / 'music-library' / 'manifest.json').read_text())
    expected = sum(1 for t in manifest['tracks'] if t['eligible'])
    assert page.inner_text('#library') == f'{expected} songs ready'


def test_a_warm_video_finds_the_sphere_reads_warm_and_plays_a_warm_song(page, clips):
    feed(page, clips['warm'])
    state = page.evaluate("({det: EchoApp.state.report.status, cov: EchoApp.state.report.metrics.coverage, mood: EchoApp.state.mood, amb: EchoApp.state.decision.ambiguous, file: EchoApp.state.track.file, credit: document.getElementById('credit').textContent, panels: ['videoPanel','feelingPanel','songPanel'].map(i => !document.getElementById(i).hidden)})")
    assert state['det'] == 'ok' and state['cov'] >= .9
    assert state['mood'] == 'warm' and not state['amb']
    assert state['file'].startswith('warm/')
    assert all(state['panels'])
    assert 'Kevin MacLeod (incompetech.com)' in state['credit'] and 'Edited: shortened and faded' in state['credit']


def test_the_song_follows_the_video_when_playing_and_seeking(page, clips):
    feed(page, clips['warm'])
    page.click('#playButton')
    page.wait_for_timeout(2500)
    a = page.evaluate("({v: EchoApp.video.currentTime, a: EchoApp.audio.currentTime, paused: EchoApp.audio.paused || EchoApp.video.paused, start: EchoLibrary.startOf(EchoApp.state.track), label: document.getElementById('playButton').textContent})")
    assert not a['paused'] and a['label'] == 'Pause'
    assert abs(a['a'] - (a['start'] + a['v'])) < .5, a
    page.evaluate("EchoApp.video.currentTime = 6")
    page.wait_for_timeout(1200)
    b = page.evaluate("({v: EchoApp.video.currentTime, a: EchoApp.audio.currentTime, start: EchoLibrary.startOf(EchoApp.state.track)})")
    assert abs(b['a'] - (b['start'] + b['v'])) < .8, b
    page.click('#playButton')
    page.wait_for_timeout(300)
    assert page.evaluate("EchoApp.audio.paused && EchoApp.video.paused")


def test_another_song_and_a_different_feeling(page, clips):
    feed(page, clips['warm'])
    first = page.evaluate("EchoApp.state.track.id")
    page.click('#anotherButton')
    page.wait_for_function(f"EchoApp.state.track.id !== {json.dumps(first)} && EchoApp.audio.readyState >= 3", timeout=30000)
    page.click('.mood-btn[data-mood="sad"]')
    page.wait_for_function("EchoApp.state.track.mood === 'sad' && EchoApp.audio.readyState >= 3", timeout=30000)
    assert page.evaluate("document.getElementById('moodTitle').textContent.startsWith('Sad') && document.getElementById('downloadSong').href.includes('/music-library/sad/')")


def test_a_mixture_of_blue_and_violet_asks_instead_of_guessing(page, clips):
    feed(page, clips['mixed'], song=False)
    state = page.evaluate("({mood: EchoApp.state.mood, track: EchoApp.state.track, songHidden: document.getElementById('songPanel').hidden, hints: [...document.querySelectorAll('.mood-btn.hint')].map(b => b.dataset.mood), text: document.getElementById('interpretation').textContent})")
    assert state['mood'] is None and state['track'] is None and state['songHidden']
    assert sorted(state['hints']) == ['calm', 'sad']
    assert 'Choose the one that fits' in state['text']
    page.click('.mood-btn[data-mood="calm"]')
    page.wait_for_function("EchoApp.state.track && EchoApp.state.track.mood === 'calm'", timeout=30000)


def test_no_sphere_but_a_clear_scene_reads_the_whole_scene(page, clips):
    feed(page, clips['nosphere'])
    state = page.evaluate("({fallback: EchoApp.state.sceneFallback, mood: EchoApp.state.mood, drawing: EchoApp.state.drawing, note: document.getElementById('detectionNote').textContent})")
    assert state['fallback'] and state['mood'] is not None and not state['drawing']
    assert 'whole scene was read' in state['note']


def test_no_sphere_and_no_coloured_light_asks_you_to_mark_it(page, clips):
    feed(page, clips['grey'], song=False)
    state = page.evaluate("({status: EchoApp.state.report.status, drawing: EchoApp.state.drawing, feeling: !document.getElementById('feelingPanel').hidden, note: document.getElementById('detectionNote').textContent})")
    assert state['status'] == 'rejected' and state['drawing'] and not state['feeling']
    assert 'could not be found reliably' in state['note']
    box = page.evaluate("(() => { const r = document.getElementById('overlay').getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; })()")
    page.mouse.move(box['x'] + box['w'] * .5, box['y'] + box['h'] * .5)
    page.mouse.down()
    page.mouse.move(box['x'] + box['w'] * .5 + 70, box['y'] + box['h'] * .5 + 10, steps=5)
    page.mouse.up()
    page.wait_for_function("EchoApp.state.decision !== null", timeout=10000)
    assert page.evaluate("EchoApp.state.manual !== null")


def test_the_fourth_feeling_is_called_dynamic(page, clips):
    feed(page, clips['warm'])
    assert page.inner_text('.mood-btn[data-mood="anger"]').strip().endswith('Dynamic')
    page.click('.mood-btn[data-mood="anger"]')
    page.wait_for_function("EchoApp.state.track && EchoApp.state.track.mood === 'anger' && EchoApp.audio.readyState >= 3", timeout=30000)
    assert page.inner_text('#moodTitle').startswith('Dynamic')
    assert 'Dynamic' in page.inner_text('#songMeta')
    assert 'Anger' not in page.inner_text('body')


def export_and_frame(pg, tmp_path, name, credit):
    """Exports the video with or without the credit switch and returns the bottom strip of a frame, as brightness values."""
    pg.set_checked('#exportCredit', credit)
    with pg.expect_download(timeout=120000) as download:
        pg.click('#exportButton')
    file = tmp_path / f'{name}{Path(download.value.suggested_filename).suffix}'
    download.value.save_as(str(file))
    png = tmp_path / f'{name}.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '3', '-i', str(file), '-frames:v', '1', str(png)], check=True)
    frame = cv2.imread(str(png), cv2.IMREAD_GRAYSCALE)
    h = frame.shape[0]
    return frame[int(h * .90):], frame[: int(h * .5)], png


def test_the_exported_video_carries_the_song_credit(page, clips, tmp_path):
    feed(page, clips['warm'])
    credit = page.evaluate("creditText(1)")
    assert 'Kevin MacLeod (incompetech.com)' in credit and 'creativecommons.org/licenses/by/4.0' in credit and 'Edited' in credit
    with_credit, top_with, png = export_and_frame(page, tmp_path, 'with', True)
    page.wait_for_function("!document.getElementById('exportButton').disabled", timeout=30000)
    without, top_without, _ = export_and_frame(page, tmp_path, 'without', False)
    # The credit is a dark band with white text along the bottom; the rest of the picture is the same either way.
    assert with_credit.mean() < without.mean() * .75, (with_credit.mean(), without.mean())
    assert (with_credit < 100).mean() > .6 and (with_credit > 235).mean() > .01     # a dark band with white text on it
    assert (without < 100).mean() < .2
    assert abs(float(top_with.mean()) - float(top_without.mean())) < 12


def test_a_file_that_is_not_a_video_gets_a_clear_message(page, clips):
    page.set_input_files('#fileInput', str(clips['bad']))
    page.wait_for_function("document.getElementById('status').classList.contains('error')", timeout=30000)
    assert 'could not open that video' in page.inner_text('#status')
    assert page.evaluate("document.getElementById('songPanel').hidden && document.getElementById('feelingPanel').hidden")


def test_a_phone_sized_screen_does_not_scroll_sideways(browser, site, clips):
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg = context.new_page()
    pg.goto(site)
    pg.wait_for_function("document.getElementById('library').textContent.includes('songs')", timeout=15000)
    feed(pg, clips['warm'])
    assert pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") <= 1
    context.close()
