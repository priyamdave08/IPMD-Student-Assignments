import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const Lib = require('../../video-music/library.js');
const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, '../fixtures/choose-parity.json'), 'utf8'));

// The hash must stay bit-identical to _hash32() in server/library.py: the same
// seed has to pick the same track on the server and in the browser.
test('hash32 matches the server hash vectors', () => {
  assert.equal(Lib.hash32('clip:7|warm'), 2760582269);
  assert.equal(Lib.hash32('a:0|sad'), 3462567549);
  assert.equal(Lib.hash32('12345|calm'), 1180301838);
  assert.equal(Lib.hash32('My Video.mp4|123456|10.00:3|anger'), 654948314);
  assert.equal(Lib.hash32('x'), 794621484);
});

// The Python test test_track_choice_matches_browser in tests/test_library.py
// asserts the same picks from the same fixture; the two must never disagree.
// t1 is the bright lively warm track, so it wins warm; t4 is the dark soft one, so it wins sad.
test('choose() energy-matches the agreed tracks for the shared fixture', () => {
  const cases = [
    // mood, duration, seed, avoid, expected id, expected fit distance, looped
    ['warm', 60, 'clip:7', null, 't2', 2.195, false],
    ['warm', 60, 'a:0', null, 't1', 0.511, false],
    ['sad', 10, 'x', null, 't4', 1.183, false],
    ['warm', 5000, 'clip:7', null, 't2', 2.195, true],   // nothing long enough: the longest is looped
    ['warm', 10, 'seed9', null, 't1', 0.511, false],
    ['warm', 10, 'clip:7', 't1', 't2', 2.195, false],    // "another song" skips the just-played track
  ];
  for (const [mood, duration, seed, avoid, id, fit, looped] of cases) {
    const r = Lib.choose(manifest, mood, duration, seed, avoid);
    assert.equal(r.track.id, id, `${mood}/${duration}/${seed}`);
    assert.equal(r.method, 'energy match');
    assert.equal(r.fitDistance, fit);
    assert.equal(r.looped, looped);
  }
});

test('the same input picks the same song, and the seed changes it', () => {
  const seen = new Set();
  for (let v = 0; v < 60; v++) seen.add(Lib.choose(manifest, 'warm', 10, `clip:${v}`).track.id);
  assert.deepEqual([...seen].sort(), ['t1', 't2', 't3']);
  assert.equal(Lib.choose(manifest, 'warm', 10, 'clip:7').track.id, Lib.choose(manifest, 'warm', 10, 'clip:7').track.id);
});

// Without measured audio features there is nothing to match on: the choice
// falls back to the old uniform seeded pick, on both sides.
test('choose() without features falls back to a uniform seeded pick', () => {
  const bare = { tracks: [
    { id: 'a', file: 'warm/a.mp3', title: 'a', mood: 'warm', duration: 60, eligible: true },
    { id: 'b', file: 'warm/b.mp3', title: 'b', mood: 'warm', duration: 60, eligible: true },
  ] };
  const r = Lib.choose(bare, 'warm', 10, 'clip:7');
  assert.equal(r.track.id, 'b');   // hash32('clip:7|warm') is odd
  assert.equal(r.method, 'seeded random choice');
  assert.equal(r.fitDistance, undefined);
});
