import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { clip } from './scene.mjs';

const require = createRequire(import.meta.url);
const Detect = require('../../video-music/detect.js');
const Mood = require('../../video-music/mood.js');

function circleIoU(a, b) {
  const overlap = Detect.overlapFraction([a.cx, a.cy, a.r], [b.cx, b.cy, b.r]);
  const small = Math.min(a.r, b.r) ** 2, big = Math.max(a.r, b.r) ** 2;
  const inter = overlap * small;                                   // overlapFraction is relative to the smaller circle
  return inter / (small + big - inter);
}

test('follows a zooming, panning sphere and ignores the face, the fire and the lamp', () => {
  const frames = clip(10, 5);
  const report = Detect.detectSphere(frames);
  assert.equal(report.status, 'ok', report.reasons.join(' '));
  assert.ok(report.metrics.coverage >= .9);
  const scores = frames.map((f, i) => circleIoU({ cx: report.track[i].cx * f.width, cy: report.track[i].cy * f.height, r: report.track[i].radius * f.height }, f.truth));
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  assert.ok(mean > .7 && Math.min(...scores) > .45, `overlap with the true sphere: mean ${mean.toFixed(2)}, worst ${Math.min(...scores).toFixed(2)}`);
  for (const f of frames) {
    const e = Detect.focusAt(report, f.time);
    assert.ok(e.cy - e.ry > f.truth.cy / f.height - f.truth.r / f.height * 1.6, 'the region to read must stay off the face above the sphere');
    assert.ok(e.cx > .1 && e.cx < .9, 'and away from the fireplace and the lamp');
  }
});

test('the region that is read stays inside the sphere', () => {
  const frames = clip(10, 5);
  const report = Detect.detectSphere(frames);
  frames.forEach((f, i) => {
    const e = Detect.focusAt(report, f.time), truth = f.truth;
    const inside = Detect.overlapFraction([e.cx * f.width, e.cy * f.height, e.ry * f.height], [truth.cx, truth.cy, truth.r]);
    assert.ok(inside > .85, `frame ${i}: ${inside.toFixed(2)} of the read region lies inside the sphere`);
  });
});

test('a scene with no sphere is rejected with reasons', () => {
  const report = Detect.detectSphere(clip(10, 5, { sphere: false }));
  assert.equal(report.status, 'rejected');
  assert.ok(report.reasons.length > 0);
  assert.ok(report.metrics.uncertaintyIndex > .7);
});

test('the sphere colour is read from the tracked interior', () => {
  const read = (options) => {
    const frames = clip(6, 5, options), report = Detect.detectSphere(frames);
    const per = frames.map((f) => { const e = Detect.focusAt(report, f.time); return Mood.readPalette(f, { cx: e.cx * f.width, cy: e.cy * f.height, rx: e.rx * f.width, ry: e.ry * f.height }); });
    return Mood.decide(Mood.meanScores(per));
  };
  assert.equal(read({ hue: [235, 150, 40] }).mood, 'warm');                       // amber, with an orange fireplace in the frame
  assert.equal(read({ hue: [40, 120, 235] }).mood, 'sad');                        // blue
  assert.equal(read({ hue: [235, 50, 45] }).mood, 'anger');                       // red
  const mixed = read({ hue: [40, 120, 235], hue2: [160, 70, 235] });             // blue on one side, violet on the other
  assert.equal(mixed.mood, null, 'a blue and violet mixture must not be forced into one mood');
});

test('uncertainty is a labelled heuristic, not a probability', () => {
  const report = Detect.detectSphere(clip(4, 5));
  assert.match(report.metrics.uncertaintyNote, /Not a probability/);
  assert.ok(report.metrics.uncertaintyIndex >= 0 && report.metrics.uncertaintyIndex <= 1);
});

test('circle overlap geometry', () => {
  const f = Detect.overlapFraction;
  assert.equal(f([0, 0, 10], [0, 0, 10]), 1);
  assert.equal(f([0, 0, 10], [50, 0, 10]), 0);
  assert.equal(f([0, 0, 10], [1, 1, 30]), 1);                       // the small one lies inside the big one
  const half = f([0, 0, 10], [10, 0, 10]);
  assert.ok(half > .35 && half < .45, `two equal circles whose centres are one radius apart overlap about 39%, got ${half.toFixed(2)}`);
});

test('focus interpolates and holds at the ends', () => {
  const report = { width: 200, height: 100, track: [{ time: 0, cx: .2, cy: .5, radius: .2 }, { time: 10, cx: .8, cy: .5, radius: .4 }] };
  assert.equal(Detect.focusAt(report, -1).cx, .2);
  assert.equal(Detect.focusAt(report, 99).cx, .8);
  const mid = Detect.focusAt(report, 5);
  assert.ok(Math.abs(mid.cx - .5) < 1e-9 && Math.abs(mid.ry - .3 * Detect.INTERIOR_SHRINK) < 1e-9);
  assert.ok(Math.abs(mid.rx - mid.ry * 100 / 200) < 1e-9, 'rx is scaled by the aspect ratio');
});
