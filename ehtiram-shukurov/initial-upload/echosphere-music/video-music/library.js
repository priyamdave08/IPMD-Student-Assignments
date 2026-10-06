// Chooses a song for a mood from music-library/manifest.json and works out how to play it. The browser twin of server/library.py.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EchoLibrary = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MOODS = ['warm', 'calm', 'sad', 'anger'];
  const TARGET_LUFS = -20;                   // about where the instrument composer sits
  const MAX_BOOST_DB = 18, MAX_CUT_DB = 12;
  const END_MARGIN = .5;                     // a track must outlast the video by this much, or it would have to loop
  const EDIT_NOTE = 'Edited: shortened and faded to fit the video.';
  const CREDITS_URL = 'https://github.com/Ehtiram-Shukurov/echosphere-music/blob/main/music-library/CREDITS.md';

  // A small, stable string hash (FNV-1a with a final mix), so the same input always picks the same song.
  // Mirrored by _hash32() in server/library.py: the same seed must pick the same track on both.
  function hash32(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); h ^= h >>> 16;
    return h >>> 0;
  }

  // Only tracks the manifest marks eligible are ever played.
  function playable(manifest) {
    return ((manifest && manifest.tracks) || []).filter((t) => t.eligible && MOODS.includes(t.mood) && t.file && t.duration > 0);
  }

  function counts(manifest) {
    const out = { warm: 0, calm: 0, sad: 0, anger: 0 };
    for (const t of playable(manifest)) out[t.mood]++;
    return out;
  }

  // Start after any digital silence, keeping a quarter second so a soft attack is not clipped,
  // then snap forward to the next beat so the music starts on-beat (when the manifest has beats).
  function startOf(track) {
    const start = Math.max(0, ((track.features && track.features.lead_silence_s) || 0) - .25);
    const beats = ((track.features || {}).beats || []).filter((b) => typeof b === 'number' && Number.isFinite(b));
    let best = Infinity;
    for (const b of beats) if (b >= start && b < best) best = b;
    return best === Infinity ? start : best;
  }

  // The loudness of the stretch that will actually play, from the closest measured excerpt (10 s, 30 s or 60 s).
  function loudnessOf(track, seconds) {
    const f = track.features || {};
    const order = seconds <= 20 ? ['lufs_10', 'lufs_30', 'lufs'] : seconds <= 45 ? ['lufs_30', 'lufs_10', 'lufs'] : ['lufs', 'lufs_30', 'lufs_10'];
    for (const key of order) if (typeof f[key] === 'number' && Number.isFinite(f[key])) return f[key];
    return null;
  }

  // Volume change that brings the excerpt to the target level. `limited` is true when the limit stopped it short.
  function gainFor(track, seconds) {
    const lufs = loudnessOf(track, seconds);
    if (lufs === null) return { db: 0, measured: null, limited: false };
    const wanted = TARGET_LUFS - lufs, db = Math.max(-MAX_CUT_DB, Math.min(MAX_BOOST_DB, wanted));
    return { db, measured: lufs, limited: db !== wanted, wanted };
  }

  // Feature order mirrors tools/build_music_manifest.py FEATURES.
  const AFFECT_FEATURES = ['onset_rate', 'rms_db', 'centroid_hz', 'low_ratio', 'flux_mean',
                           'mode_margin', 'dynamic_range_db', 'tempo_bpm', 'pulse_clarity'];
  // Ideal (valence, arousal, energy) per mood, in library-relative z-space. Tuned by ear, not physics;
  // keep in sync with _MOOD_TARGETS in server/library.py.
  const MOOD_TARGETS = { warm: [1, 1, .8], calm: [1, -1, -.8], sad: [-1, -1, -.8], anger: [-1, 1, 1] };
  const SHORTLIST = 3;   // how many of the closest fits the seed may choose among
  const SEG_XFADE = 2;   // crossfade seconds at segment boundaries (clamped per boundary at playback)

  function hasAffect(t) {
    const f = t.features || {};
    return AFFECT_FEATURES.every((k) => typeof f[k] === 'number' && Number.isFinite(f[k]));
  }

  // Raw feature vector; mirrors _vector() in tools/build_music_manifest.py (log on centroid and flux).
  function featureVector(f) {
    return [f.onset_rate, f.rms_db, Math.log(f.centroid_hz), f.low_ratio, Math.log(f.flux_mean + 1),
            f.mode_margin, f.dynamic_range_db, f.tempo_bpm, f.pulse_clarity];
  }

  // Per-feature [mean, population std] over the eligible library, in id order.
  // Sequential sums, exactly like the server, so both sides agree bit-for-bit.
  function affectStats(tracks) {
    const vecs = tracks.filter(hasAffect).map((t) => featureVector(t.features));
    if (!vecs.length) return null;
    return AFFECT_FEATURES.map((_, i) => {
      let mean = 0;
      for (const v of vecs) mean += v[i];
      mean /= vecs.length;
      let variance = 0;
      for (const v of vecs) variance += (v[i] - mean) * (v[i] - mean);
      return [mean, Math.sqrt(variance / vecs.length)];
    });
  }

  // (valence, arousal, energy) in library-relative z-space. Valence and arousal mirror
  // judge() in tools/build_music_manifest.py; energy is sheer intensity.
  function affectOf(track, stats) {
    const v = featureVector(track.features);
    const z = v.map((x, i) => (stats[i][1] > 1e-9 ? (x - stats[i][0]) / stats[i][1] : 0));
    return [z[5] + .3 * z[2], (z[0] + z[1] + z[2] + z[4] + .5 * z[7]) / 4.5, (z[1] + z[6] + z[7]) / 3];
  }

  // Candidates as [distance, track] pairs, closest fit first, ties broken by id.
  // Null when any candidate lacks measured features: the choice then stays uniform.
  function rankedByFit(use, mood, stats) {
    if (!stats || use.some((t) => !hasAffect(t))) return null;
    const target = MOOD_TARGETS[mood];
    return use.map((t) => {
      const [va, ar, en] = affectOf(t, stats);
      const d = Math.sqrt((va - target[0]) ** 2 + (ar - target[1]) ** 2 + (en - target[2]) ** 2);
      return [d, t];
    }).sort((a, b) => a[0] - b[0] || (a[1].id < b[1].id ? -1 : a[1].id > b[1].id ? 1 : 0));
  }

  // The segment playlist: contiguous runs of the same timeline mood, each with its own
  // energy-matched track, so the music follows the light over time. Windows with no clear
  // mood attach to the neighboring run; runs whose mood has no tracks are absorbed the
  // same way. `avoidIds[i]` optionally skips a track for run i ("another song").
  // Returns null when nothing can be picked.
  function planSegments(manifest, timeline, duration, seed, fallbackMood, avoidIds) {
    const avail = counts(manifest);
    // 1. runs by mood
    const raw = [];
    let pending = null;
    for (const w of timeline || []) {
      if (!w.mood) {
        if (raw.length) raw[raw.length - 1].t1 = w.t1;
        else pending = pending ? { t0: pending.t0, t1: w.t1 } : { t0: w.t0, t1: w.t1 };
        continue;
      }
      if (pending) { raw.push({ t0: pending.t0, t1: w.t1, mood: w.mood }); pending = null; }
      else if (raw.length && raw[raw.length - 1].mood === w.mood) raw[raw.length - 1].t1 = w.t1;
      else raw.push({ t0: w.t0, t1: w.t1, mood: w.mood });
    }
    if (pending) {
      if (raw.length) raw[raw.length - 1].t1 = pending.t1;
      else raw.push({ t0: 0, t1: duration, mood: fallbackMood });
    }
    if (!raw.length) raw.push({ t0: 0, t1: duration, mood: fallbackMood });
    // 2. drop runs whose mood has no tracks, merging their time into neighbors
    const runs = [];
    let leadT0 = null;
    for (const r of raw) {
      if ((avail[r.mood] || 0) > 0) {
        runs.push({ t0: leadT0 !== null ? leadT0 : r.t0, t1: r.t1, mood: r.mood });
        leadT0 = null;
      } else if (runs.length) runs[runs.length - 1].t1 = r.t1;
      else leadT0 = leadT0 !== null ? leadT0 : r.t0;
    }
    if (!runs.length) return null;
    runs[0].t0 = 0; runs[runs.length - 1].t1 = duration;
    // 3. an energy-matched track per run
    const segs = [];
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i], dur = Math.max(.1, r.t1 - r.t0);
      const pick = choose(manifest, r.mood, dur, `${seed}:seg${i}`, avoidIds && avoidIds[i]);
      if (!pick) return null;
      segs.push({ t0: r.t0, t1: r.t1, mood: r.mood, track: pick.track, pick, gain: gainFor(pick.track, dur) });
    }
    return segs;
  }
  // Repeatable pick among approved tracks long enough for the video; the longest one is looped only as a last resort.
  // When every candidate has measured audio features, the seed picks among the closest
  // (valence, arousal, energy) fits for the mood instead of uniformly at random.
  // `avoid` is a track id to skip when there is any alternative (used by "Another song").
  function choose(manifest, mood, duration, seed, avoid) {
    const eligible = playable(manifest).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const pool = eligible.filter((t) => t.mood === mood);
    if (!pool.length) return null;
    const fits = pool.filter((t) => t.duration - startOf(t) >= duration + END_MARGIN);
    let use = fits.length ? fits : [pool.reduce((best, t) => (t.duration - startOf(t) > best.duration - startOf(best) ? t : best))];
    if (avoid && use.length > 1) use = use.filter((t) => t.id !== avoid);
    const ranked = rankedByFit(use, mood, affectStats(eligible));
    if (!ranked) {
      const track = use[hash32(`${seed}|${mood}`) % use.length];
      return { track, candidates: pool.length, longEnough: fits.length, looped: !fits.length, method: 'seeded random choice' };
    }
    const shortlist = ranked.slice(0, SHORTLIST);
    const [distance, track] = shortlist[hash32(`${seed}|${mood}`) % shortlist.length];
    return { track, candidates: pool.length, longEnough: fits.length, looped: !fits.length,
             method: 'energy match', fitDistance: Math.round(distance * 1000) / 1000 };
  }

  function fadeSeconds(duration) { return Math.min(.6, duration * .06); }

  // 0..1 multiplier at time t of a `duration`-long video: a short fade in and a fade out at the end.
  function envelope(t, duration) {
    const fade = fadeSeconds(duration);
    return Math.max(0, Math.min(1, t / .025)) * Math.max(0, Math.min(1, (duration - t) / fade));
  }

  function creditLine(track) {
    return track.credit || `${track.title} (${track.license || 'licence not recorded'})`;
  }

  function urlOf(base, track) {
    return base + track.file.split('/').map(encodeURIComponent).join('/');
  }

  return { MOODS, TARGET_LUFS, MAX_BOOST_DB, MAX_CUT_DB, END_MARGIN, EDIT_NOTE, CREDITS_URL, hash32, playable, counts, startOf, loudnessOf, gainFor, choose, planSegments, SEG_XFADE, fadeSeconds, envelope, creditLine, urlOf, hasAffect, affectStats, affectOf, rankedByFit, MOOD_TARGETS };
});
