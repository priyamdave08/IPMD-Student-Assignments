import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const Lib = require('../../video-music/library.js');

const track = (id, mood, duration, extra = {}) => ({ id, file: `${mood}/${id}.mp3`, title: id, mood, duration, eligible: true, credit: `${id} credit`, features: { lead_silence_s: 0, lufs_10: -20, lufs_30: -20, lufs: -20 }, ...extra });
const manifest = { tracks: [
  track('w1', 'warm', 200), track('w2', 'warm', 200), track('w3', 'warm', 20), track('w-held', 'warm', 200, { eligible: false }),
  track('c1', 'calm', 30), track('s1', 'sad', 100), track('a1', 'anger', 100), { ...track('bad', 'joy', 100) },
] };

test('only eligible tracks of a known mood are played', () => {
  assert.deepEqual(Lib.counts(manifest), { warm: 3, calm: 1, sad: 1, anger: 1 });
  for (let seed = 0; seed < 300; seed++) assert.notEqual(Lib.choose(manifest, 'warm', 10, seed).track.id, 'w-held');
  assert.equal(Lib.choose(manifest, 'joy', 10, 1), null);
  assert.equal(Lib.choose({ tracks: [] }, 'warm', 10, 1), null);
});

test('the same input picks the same song, and the seed changes it', () => {
  assert.equal(Lib.choose(manifest, 'warm', 10, 'a:0').track.id, Lib.choose(manifest, 'warm', 10, 'a:0').track.id);
  const seen = new Set();
  for (let v = 0; v < 60; v++) seen.add(Lib.choose(manifest, 'warm', 10, `clip:${v}`).track.id);
  assert.deepEqual([...seen].sort(), ['w1', 'w2', 'w3']);
});

test('"another song" avoids the one just played when there is a choice', () => {
  for (let v = 0; v < 60; v++) {
    const first = Lib.choose(manifest, 'warm', 10, `clip:${v}`).track.id;
    assert.notEqual(Lib.choose(manifest, 'warm', 10, `clip:${v}`, first).track.id, first);
  }
  const only = Lib.choose(manifest, 'sad', 10, 1, 's1');           // a single candidate cannot be avoided
  assert.equal(only.track.id, 's1');
});

test('tracks too short for the video are skipped, and looping is a last resort', () => {
  for (let seed = 0; seed < 100; seed++) assert.notEqual(Lib.choose(manifest, 'warm', 60, seed).track.id, 'w3');
  const all = Lib.choose(manifest, 'warm', 250, 1);                 // nothing lasts 250 s
  assert.equal(all.looped, true);
  assert.equal(all.longEnough, 0);
  assert.equal(Lib.choose(manifest, 'calm', 30, 1).looped, true);   // 30 s track, 30 s video: no margin, so it would loop
  assert.equal(Lib.choose(manifest, 'calm', 20, 1).looped, false);
});

test('leading silence is skipped but a soft attack is kept', () => {
  assert.ok(Math.abs(Lib.startOf(track('x', 'warm', 100, { features: { lead_silence_s: 2.2 } })) - 1.95) < 1e-9);
  assert.equal(Lib.startOf(track('x', 'warm', 100, { features: { lead_silence_s: .1 } })), 0);
  assert.equal(Lib.startOf({ features: {} }), 0);
});

test('the start snaps forward to the next beat when the manifest has beats', () => {
  const withBeats = (silence, beats) => track('x', 'warm', 100, { features: { lead_silence_s: silence, beats } });
  assert.equal(Lib.startOf(withBeats(1.0, [0.2, 0.7, 1.2, 1.7, 2.2])), 1.2);   // 0.75 -> next beat
  assert.equal(Lib.startOf(withBeats(0.1, [0.2, 0.7])), 0.2);
  assert.equal(Lib.startOf(withBeats(1.0, [])), 0.75);                          // no beats: plain silence skip
  assert.equal(Lib.startOf(withBeats(2.0, [0.1, 0.3])), 1.75);                 // no beat at or after the start
});

test('the level change uses the loudness of the stretch that plays', () => {
  const t = track('x', 'warm', 300, { features: { lufs_10: -34, lufs_30: -26, lufs: -22 } });
  assert.equal(Lib.loudnessOf(t, 10), -34);
  assert.equal(Lib.loudnessOf(t, 30), -26);
  assert.equal(Lib.loudnessOf(t, 55), -22);
  assert.equal(Lib.gainFor(t, 10).db, 14);
  assert.equal(Lib.gainFor(t, 10).limited, false);
  const quiet = track('q', 'warm', 300, { features: { lufs_10: -52, lufs_30: -50, lufs: -48 } });
  const g = Lib.gainFor(quiet, 10);
  assert.equal(g.db, Lib.MAX_BOOST_DB);                            // capped, and it says so
  assert.equal(g.limited, true);
  assert.equal(Lib.gainFor(track('l', 'warm', 300, { features: { lufs_10: -5 } }), 10).db, -Lib.MAX_CUT_DB);      // a very loud excerpt is cut, but only so far
  assert.equal(Lib.gainFor(track('n', 'warm', 300, { features: { lufs_10: null, lufs_30: null, lufs: null } }), 10).db, 0);
  const fallback = track('f', 'warm', 300, { features: { lufs_10: null, lufs_30: -24, lufs: -22 } });
  assert.equal(Lib.loudnessOf(fallback, 10), -24);                 // falls back to the next closest measurement
});

test('fades: a short fade in, a fade out at the end, full level between', () => {
  assert.equal(Lib.envelope(0, 10), 0);
  assert.equal(Lib.envelope(5, 10), 1);
  assert.equal(Lib.envelope(10, 10), 0);
  assert.ok(Lib.envelope(9.8, 10) > 0 && Lib.envelope(9.8, 10) < 1);
  assert.equal(Lib.fadeSeconds(10), .6);
  assert.ok(Math.abs(Lib.fadeSeconds(5) - .3) < 1e-9);
});

test('file addresses survive spaces and punctuation', () => {
  const url = Lib.urlOf('../music-library/', { file: 'calm/Somewhere Sunny (ver 2).mp3' });
  assert.equal(url, '../music-library/calm/Somewhere%20Sunny%20(ver%202).mp3');
  assert.match(Lib.urlOf('', { file: 'a/b #1?.mp3' }), /b%20%231%3F\.mp3$/);
});

test('the real manifest: every playable track exists, is credited and is licensed for this use', () => {
  const path = new URL('../../music-library/manifest.json', import.meta.url);
  const real = JSON.parse(readFileSync(path));
  const counts = Lib.counts(real);
  assert.ok(Object.values(counts).every((n) => n >= 10), `each mood needs a real choice: ${JSON.stringify(counts)}`);
  for (const t of Lib.playable(real)) {
    assert.ok(existsSync(new URL('../../music-library/' + t.file, import.meta.url)), `${t.file} is missing`);
    assert.ok(t.credit && t.credit.includes('Kevin MacLeod') && t.license === 'CC BY 4.0', `${t.id} has no usable credit or licence`);
    assert.ok(Number.isFinite(t.features.lufs) && t.features.lufs_10 !== undefined && t.features.lufs_30 !== undefined, `${t.id} lacks loudness measurements`);
  }
  // Every mood can serve a 10 s video and a 60 s video without looping.
  for (const mood of Lib.MOODS) for (const seconds of [10, 60]) assert.equal(Lib.choose(real, mood, seconds, 'x').looped, false, `${mood} ${seconds}s`);
});

test('planSegments turns the timeline into one track per mood run', () => {
  const segManifest = { tracks: [
    track('w1', 'warm', 200), track('w2', 'warm', 200), track('c1', 'calm', 200), track('s1', 'sad', 200),
  ] };
  const tl = [
    { t0: 0, t1: 5, mood: 'warm' }, { t0: 5, t1: 10, mood: 'warm' },
    { t0: 10, t1: 15, mood: null },   // mixed light joins the warm run
    { t0: 15, t1: 20, mood: 'sad' },
  ];
  const segs = Lib.planSegments(segManifest, tl, 20, 's:0', 'warm');
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].t0, segs[0].t1, segs[0].mood], [0, 15, 'warm']);
  assert.deepEqual([segs[1].t0, segs[1].t1, segs[1].mood], [15, 20, 'sad']);
  assert.equal(segs[0].track.mood, 'warm');
  assert.equal(segs[1].track.mood, 'sad');
  assert.ok(segs[0].gain && typeof segs[0].gain.db === 'number');
  // repeatable
  assert.deepEqual(Lib.planSegments(segManifest, tl, 20, 's:0', 'warm').map((s) => s.track.id), segs.map((s) => s.track.id));
});

test('planSegments handles empty timelines, missing moods and leading mixed light', () => {
  const segManifest = { tracks: [track('w1', 'warm', 200), track('c1', 'calm', 200)] };
  // all mixed: one segment with the fallback mood
  let segs = Lib.planSegments(segManifest, [{ t0: 0, t1: 10, mood: null }], 10, 's:0', 'calm');
  assert.equal(segs.length, 1);
  assert.deepEqual([segs[0].t0, segs[0].t1, segs[0].mood], [0, 10, 'calm']);
  // leading mixed light attaches forward
  segs = Lib.planSegments(segManifest, [{ t0: 0, t1: 5, mood: null }, { t0: 5, t1: 10, mood: 'warm' }], 10, 's:0', 'warm');
  assert.equal(segs.length, 1);
  assert.deepEqual([segs[0].t0, segs[0].t1], [0, 10]);
  // a mood with no tracks is absorbed by its neighbor
  segs = Lib.planSegments(segManifest, [{ t0: 0, t1: 5, mood: 'warm' }, { t0: 5, t1: 10, mood: 'sad' }], 10, 's:0', 'warm');
  assert.equal(segs.length, 1);
  assert.deepEqual([segs[0].t0, segs[0].t1, segs[0].mood], [0, 10, 'warm']);
  // nothing to pick from
  assert.equal(Lib.planSegments({ tracks: [] }, [{ t0: 0, t1: 10, mood: 'warm' }], 10, 's:0', 'warm'), null);
});
