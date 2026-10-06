"""The automatic stages that run inside one queued soundtrack job.

Import, sphere finding, colour/motion reading and the mood decision happen here;
composing, finishing and muxing stay in the worker so both routes share them.
"""
from . import analysis, detect, media, store
from .config import DATA

# Stable machine-readable stage codes, in order. `phase` remains the human sentence.
STAGES = [
    ('queued', 'Queued'),
    ('importing', 'Preparing silent video'),
    ('detecting', 'Finding the sphere'),
    ('analyzing', 'Reading the selected sphere'),
    ('deciding', 'Choosing the mood'),
    ('composing', 'Composing with instrument samples'),
    ('finishing', 'Finishing audio'),
    ('muxing', 'Combining video and music'),
]
NOTE = 'Scores are relative colour shares from a product palette rule, not calibrated probabilities.'


class AutoFailure(Exception):
    """A stage refused to continue. `code` is machine readable; `details` is saved on the job."""

    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code, self.details = code, details or {}


PHASE_ALIASES = {'Choosing a track from the library': 'Composing with instrument samples'}     # the same stage, for the library engine


def stage_progress(job):
    """Which stage an auto job is in, for the API."""
    phase = PHASE_ALIASES.get(job['phase'], job['phase'])
    order = [label for _, label in STAGES]
    if job['state'] == 'complete':
        current = len(STAGES)
    elif phase in order:
        current = order.index(phase)
    else:
        current = None
    return [{'code': code, 'label': label,
             'state': ('done' if current is not None and i < current else 'active' if i == current and job['state'] in ('running', 'queued') else 'pending')}
            for i, (code, label) in enumerate(STAGES)]


def summarize_detection(report):
    return {'status': report['status'], 'reasons': report['reasons'], 'metrics': report.get('metrics'),
            'keypoints': len(report.get('focus') or []),
            'overlay': 'detection/overlay', 'sheet': 'detection/sheet', 'report': 'detection'}


def summarize_analysis(a):
    return {'mood': a['mood'], 'ambiguous': a['ambiguous'], 'observations': a['observations'],
            'palette_scores': a['palette_scores'], 'palette_scores_note': a.get('palette_scores_note', NOTE),
            'mean_energy': a['mean_energy'], 'mean_brightness': a['mean_brightness'],
            'evidence': a['evidence'], 'analyzer': a['analyzer'], 'warnings': a['warnings']}


def prepare(job, stage, check):
    """Run import, focus selection, analysis and the mood decision. Returns (brief, extra) for the worker."""
    options, video_id, id = job['payload']['options'], job['video_id'], job['id']
    source = DATA / 'videos' / video_id
    video = store.get('videos', video_id)
    if video['state'] != 'ready':
        stage('Preparing silent video')
        store.update('videos', video_id, state='importing')
        metadata = media.prepare_video(source / 'source.mp4', source, check)
        store.update('videos', video_id, state='ready', metadata=metadata, error=None)
        video = store.get('videos', video_id)
    detection = None
    mode = options['input_mode']
    if mode == 'robot':
        stage('Finding the sphere')
        report = detect.detect_sphere(source / 'preview.mp4', source / 'detection', check)
        detection = summarize_detection(report)
        if report['status'] != 'ok':
            raise AutoFailure('sphere_not_reliable',
                              'The sphere could not be found reliably: ' + ' '.join(report['reasons']) +
                              ' Inspect the detection overlay, or send input_mode=focus with coordinates.',
                              {'input_mode': mode, 'detection': detection})
        focus = report['focus']
    elif mode == 'sphere':
        focus = [{'time': 0, 'cx': .5, 'cy': .5, 'rx': .49, 'ry': .49}]        # the whole frame is the sphere interior
    else:
        focus = options['focus']
        if focus[-1]['time'] > video['metadata']['duration']:
            raise AutoFailure('invalid_focus', 'A focus point is outside the video duration.',
                              {'input_mode': mode, 'duration': video['metadata']['duration']})
    check()
    stage('Reading the selected sphere')
    result = analysis.analyze(source / 'preview.mp4', DATA / 'jobs' / id, {'focus': focus, 'analyzer': 'measurements'}, check)
    result['job_id'] = id
    store.update('videos', video_id, analysis=result)
    summary = summarize_analysis(result)
    check()
    stage('Choosing the mood')
    requested = options['mood']
    if requested != 'auto':
        used, source_of_mood = requested, 'override'
    elif result['mood']:
        used, source_of_mood = result['mood'], 'observed'
    elif options['on_ambiguous'] == 'best_guess':
        scores = result['palette_scores']
        used, source_of_mood = max(scores, key=scores.get), 'best_guess'
    else:
        raise AutoFailure('ambiguous_mood',
                          'The colours in the sphere do not clearly indicate one feeling. Send a mood, or set on_ambiguous=best_guess to accept the closest match.',
                          {'input_mode': mode, 'detection': detection, 'analysis': summary})
    brief = analysis.musical_brief(video, result, {'mood': used, 'seed': options['seed']})
    if source_of_mood == 'best_guess':
        brief['warnings'].append('The mood was a best guess after an ambiguous reading. ' + NOTE)
    extra = {'input_mode': mode, 'mood': {'used': used, 'observed': result['mood'], 'source': source_of_mood},
             'detection': detection, 'analysis': summary, 'focus': focus}
    return brief, extra
