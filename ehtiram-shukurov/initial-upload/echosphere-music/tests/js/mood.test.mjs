import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const Mood = require('../../video-music/mood.js');
const cases = JSON.parse(readFileSync(new URL('./fixtures/palette-cases.json', import.meta.url)));

const solid = (r, g, b, w = 64, h = 64) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4);
  return { data, width: w, height: h };
};
const whole = (f) => ({ cx: f.width / 2, cy: f.height / 2, rx: f.width / 2 / Mood.MASK_FRACTION, ry: f.height / 2 / Mood.MASK_FRACTION });

test('hue matches OpenCV\'s 0..179 convention', () => {
  const hue = (r, g, b) => Mood.rgbToHsv(r, g, b)[0];
  assert.equal(hue(255, 0, 0), 0);
  assert.equal(hue(255, 255, 0), 30);
  assert.equal(hue(0, 255, 0), 60);
  assert.equal(hue(0, 255, 255), 90);
  assert.equal(hue(0, 0, 255), 120);
  assert.equal(hue(255, 0, 255), 150);
  assert.ok(hue(255, 0, 60) > 170);                       // a red that leans magenta wraps to the top of the range
});

test('the port agrees with the Python palette rule on the same pixels', () => {
  for (const c of cases) {
    const frame = { data: new Uint8ClampedArray(Buffer.from(c.rgba, 'base64')), width: c.size, height: c.size };
    // An ellipse of radius size/2 gives a mask radius of size/2 * 108/112, like the server's crop mask.
    const got = Mood.readPalette(frame, { cx: c.size / 2, cy: c.size / 2, rx: c.size / 2, ry: c.size / 2 });
    for (const m of Mood.MOODS) {
      assert.ok(Math.abs(got[m] - c.expected[m]) < .03, `${c.name}: ${m} ${got[m].toFixed(3)} vs ${c.expected[m].toFixed(3)}`);
    }
  }
});

test('each sphere colour gives its own mood', () => {
  const read = (rgb) => Mood.decide(Mood.readPalette(solid(...rgb), whole(solid(...rgb))));
  assert.equal(read([255, 190, 70]).mood, 'warm');           // gold
  assert.equal(read([70, 110, 230]).mood, 'sad');            // blue
  assert.equal(read([235, 60, 45]).mood, 'anger');           // red
  assert.equal(read([180, 130, 240]).mood, 'calm');          // violet
});

test('only the light inside the ellipse is read', () => {
  const f = solid(255, 190, 70, 100, 100);                    // gold everywhere...
  for (let y = 0; y < 100; y++) for (let x = 60; x < 100; x++) f.data.set([60, 60, 240, 255], (y * 100 + x) * 4);   // ...blue on the right
  const inside = Mood.readPalette(f, { cx: 30, cy: 50, rx: 25, ry: 25 });
  assert.ok(inside.warm > .99 && inside.sad === 0);
  const outside = Mood.readPalette(f, { cx: 80, cy: 50, rx: 15, ry: 25 });
  assert.ok(outside.sad > .99 && outside.warm === 0);
});

test('a blue and violet mixture is never forced into Sad', () => {
  const mix = cases.find((c) => c.name === 'blue and violet halves');
  const decision = Mood.decide(mix.expected);
  assert.equal(decision.mood, null);
  assert.equal(decision.ambiguous, true);
  assert.equal(decision.closest, 'sad');
});

test('the ambiguity rule matches the server rule, except that Calm/Sad asks a little earlier', () => {
  const d = (warm, calm, sad, anger) => Mood.decide({ warm, calm, sad, anger });
  assert.equal(d(.5, .1, .1, .1).mood, 'warm');
  assert.equal(d(.3, .1, .1, .1).mood, null);                 // top share below .35
  assert.equal(d(.5, .42, 0, 0).mood, null);                  // top two too close (gap .08 < .12)
  assert.equal(d(0, .6, .3, 0).mood, null);                   // calm/sad mixture with a real second share
  assert.equal(d(0, .6, .2, 0).mood, null);                  // the server would accept this (.2 < .22); this page asks from .16
  assert.equal(d(0, .6, .12, 0).mood, 'calm');                // a small second share is not a mixture
  assert.equal(d(0, .12, .6, 0).mood, 'sad');
  assert.equal(d(.6, 0, .3, 0).mood, 'warm');                 // other pairs are not blocked
  assert.match(d(1, 0, 0, 0).note, /not probabilities/);
});

test('averaging frames', () => {
  const m = Mood.meanScores([{ warm: 1, calm: 0, sad: 0, anger: 0 }, { warm: 0, calm: 0, sad: 1, anger: 0 }]);
  assert.deepEqual(m, { warm: .5, calm: 0, sad: .5, anger: 0 });
  assert.deepEqual(Mood.meanScores([]), { warm: 0, calm: 0, sad: 0, anger: 0 });
});
