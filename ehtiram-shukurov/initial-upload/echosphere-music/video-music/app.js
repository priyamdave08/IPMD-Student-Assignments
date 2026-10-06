'use strict';
// EchoSphere, browser edition: add a video, find the sphere, read its feeling, play a song. Nothing leaves the device.
const $ = (id) => document.getElementById(id);
const BASE = '../music-library/';
const NAMES = { warm: 'Warm', calm: 'Calm', anger: 'Dynamic', sad: 'Sad' };
const THEME = { warm: ['#FFD166', '255,209,102'], calm: ['#B59BEA', '123,78,214'], anger: ['#F27982', '193,18,31'], sad: ['#98BEDF', '58,110,165'] };
const MAX_SIDE = 320, MAX_SAMPLES = 100, SAMPLES_PER_SECOND = 5;

const video = $('video'), audio = $('song'), overlay = $('overlay'), stage = document.querySelector('.video-stage');
const audioB = new Audio(); audioB.crossOrigin = 'anonymous'; audioB.preload = 'auto';
const state = {
  manifest: null, run: 0, busy: false, file: null, url: null, duration: 0, frames: [], report: null, manual: null, sceneFallback: false,
  drawing: false, draft: null, decision: null, mood: null, forceMood: null, seed: '', variation: 0,
  segs: null, track: null, pick: null, gain: null,   // track/pick/gain always describe the current segment
};
let audioCtx = null, nodes = null, envelopeTimer = 0;
// Two media elements take turns: while one plays a segment, the other preloads the next,
// and they crossfade at boundaries. seg = segment index, -1 = idle.
const slots = [
  { el: audio, level: null, xfade: null, seg: -1, ready: false, loading: false, loadPromise: null, loadToken: 0 },
  { el: audioB, level: null, xfade: null, seg: -1, ready: false, loading: false, loadPromise: null, loadToken: 0 },
];
let lastCur = -1;

// ---- small helpers -----------------------------------------------------------------------------------------------

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function message(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function progress(fraction) { $('progress').hidden = fraction === null; if (fraction !== null) $('progressBar').style.width = `${Math.round(fraction * 100)}%`; }
function show(id, on) {
  const el = $(id), was = el.hidden;
  el.hidden = !on;
  if (on && was) { el.classList.remove('rise'); void el.offsetWidth; el.classList.add('rise'); }   // panels rise in once
}
// Sets an element's text from plain strings and {strong: '...'} pieces, without ever parsing HTML.
function say(el, ...parts) {
  el.replaceChildren(...parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : Object.assign(document.createElement('strong'), { textContent: p.strong }))));
}
const make = (tag, props, ...children) => { const el = Object.assign(document.createElement(tag), props); el.append(...children); return el; };
const channel = new MessageChannel(), waiting = [];
channel.port1.onmessage = () => { const next = waiting.shift(); if (next) next(); };
const yieldToPage = () => new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0); });   // not throttled in background tabs
class Cancelled extends Error {}
const alive = (token) => { if (token !== state.run) throw new Cancelled(); };

function applyMood(mood) {
  if (!mood) return;
  if (activeMood !== mood && !calmMode) transitions.push({ born: performance.now() });
  activeMood = mood;
  document.documentElement.style.setProperty('--accent', THEME[mood][0]);
  document.documentElement.style.setProperty('--accent-rgb', THEME[mood][1]);
  setTitle(NAMES[mood]);
  window.dispatchEvent(new Event('sphere-change'));
}

// The big title: a feeling once one is decided, otherwise plain words. `end` is the punctuation after it.
function setTitle(text, end = '.') {
  $('moodTitle').replaceChildren(document.createTextNode(text), Object.assign(document.createElement('span'), { textContent: end }));
}
const DEFAULT_SUBTITLE = 'Add a video to hear its song';

function paintMoodButtons() {
  const hinted = state.decision && state.decision.ambiguous ? state.decision.ranked.slice(0, 2) : [];
  document.querySelectorAll('.mood-btn').forEach((b) => {
    const m = b.dataset.mood;
    b.classList.toggle('active', m === state.mood);
    b.classList.toggle('hint', !state.mood && hinted.includes(m));
    b.setAttribute('aria-pressed', String(m === state.mood));
  });
}

function setQuiet(on) {
  calmMode = on;
  $('motionLabel').textContent = on ? 'Motion off' : 'Motion on';
  $('calmToggle').setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('quiet', on);
  window.dispatchEvent(new Event('sphere-change'));
}

// ---- the song library --------------------------------------------------------------------------------------------

async function loadLibrary() {
  if (location.protocol === 'file:') {
    $('library').textContent = 'Open from a web address';
    message('This page needs to be opened from a web address (the GitHub Pages site, or a local web server), not by double-clicking the file.', true);
    return;
  }
  try {
    const response = await fetch(BASE + 'manifest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(String(response.status));
    state.manifest = await response.json();
    const counts = EchoLibrary.counts(state.manifest), total = Object.values(counts).reduce((a, b) => a + b, 0);
    $('library').textContent = total ? `${total} songs ready` : 'No songs found';
    if (!total) message('The music library is empty, so no song can be chosen.', true);
  } catch {
    $('library').textContent = 'Songs unavailable';
    message('The song library could not be loaded. Check your connection and reload the page.', true);
  }
}

// ---- opening a video and reading it ------------------------------------------------------------------------------

function whenFirstFrame(el) {
  return new Promise((resolve, reject) => {
    const done = () => { clean(); resolve(); }, fail = () => { clean(); reject(new Error('cannot decode')); };
    const timer = setTimeout(fail, 20000);
    function clean() { clearTimeout(timer); el.removeEventListener('loadeddata', done); el.removeEventListener('error', fail); }
    if (el.readyState >= 2) return done();
    el.addEventListener('loadeddata', done);
    el.addEventListener('error', fail);
  });
}

function seek(el, t) {
  return new Promise((resolve, reject) => {
    if (Math.abs(el.currentTime - t) < 1e-3 && el.readyState >= 2) return resolve();
    const done = () => { clean(); resolve(); };
    const timer = setTimeout(() => { clean(); reject(new Error('seek timed out')); }, 8000);
    function clean() { clearTimeout(timer); el.removeEventListener('seeked', done); }
    el.addEventListener('seeked', done);
    el.currentTime = t;
  });
}

function resetForNewVideo() {
  stop();
  state.run++;
  Object.assign(state, { frames: [], report: null, manual: null, sceneFallback: false, drawing: false, draft: null, decision: null, timeline: null, mood: null, forceMood: null, variation: 0, segs: null, track: null, pick: null, gain: null });
  stage.classList.remove('drawing');
  $('stageRoot').classList.remove('has-video');
  for (const id of ['videoPanel', 'feelingPanel', 'songPanel', 'drawHint', 'wholeButton', 'autoButton', 'timelineWrap']) show(id, false);
  progress(null);
  setTitle('Your video'); $('soundMeta').textContent = DEFAULT_SUBTITLE;
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = null;
}

async function handleFile(file) {
  if (!file) return;
  if (!(file.type || '').startsWith('video/') && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) return message('That does not look like a video. An MP4 works best.', true);
  resetForNewVideo();
  const token = state.run;
  state.file = file;
  state.busy = true;
  $('addButton').disabled = false;
  try {
    message('Opening your video…');
    progress(.02);
    state.url = URL.createObjectURL(file);
    video.src = state.url;
    await whenFirstFrame(video);
    alive(token);
    state.duration = video.duration;
    if (!Number.isFinite(state.duration) || state.duration < 1 || !video.videoWidth) throw new Error('unusable');
    state.seed = `${EchoLibrary.hash32(`${file.name}|${file.size}|${state.duration.toFixed(2)}`)}`;
    $('videoTitle').textContent = file.name.replace(/\.[^.]+$/, '') || 'Your video';
    show('videoPanel', true);
    $('stageRoot').classList.add('has-video');
    await sampleFrames(token);
    await findSphere(token);
    alive(token);
    presentAnalysis();
    progress(null);
  } catch (e) {
    if (e instanceof Cancelled) return;
    progress(null);
    message(e.message === 'cannot decode' || e.message === 'unusable'
      ? 'This browser could not open that video. Try an MP4 (H.264) in Chrome, Edge or Safari, or another file.'
      : `Something went wrong while reading the video (${e.message}). Try again, or use another video.`, true);
    console.warn('The video could not be read:', e);
  } finally {
    if (token === state.run) state.busy = false;
  }
}

// Frames are read from a second, hidden copy of the video, so the one on screen is never seeked while the analysis runs:
// a paused video that is seeked dozens of times can keep showing a stale picture, and the outline would not line up with it.
async function sampleFrames(token) {
  const sampler = document.createElement('video');
  sampler.muted = true; sampler.playsInline = true; sampler.preload = 'auto';
  sampler.setAttribute('aria-hidden', 'true');
  sampler.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(sampler);                       // some browsers only decode frames of videos that are in the page
  try {
    sampler.src = state.url;
    await whenFirstFrame(sampler);
    const n = Math.min(MAX_SAMPLES, Math.max(8, Math.round(state.duration * SAMPLES_PER_SECOND)));
    const scale = MAX_SIDE / Math.max(sampler.videoWidth, sampler.videoHeight);
    const w = Math.max(16, Math.round(sampler.videoWidth * scale)), h = Math.max(16, Math.round(sampler.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (let i = 0; i < n; i++) {
      alive(token);
      const t = Math.min(state.duration - .05, .03 + i * (state.duration - .08) / Math.max(1, n - 1));
      await seek(sampler, t);
      ctx.drawImage(sampler, 0, 0, w, h);
      state.frames.push({ time: t, width: w, height: h, data: ctx.getImageData(0, 0, w, h).data });
      progress(.05 + .3 * (i + 1) / n);
      message(`Looking through the video… ${i + 1} of ${n}`);
    }
  } finally {
    sampler.removeAttribute('src'); sampler.load(); sampler.remove();
  }
}

async function findSphere(token) {
  const perFrame = [], n = state.frames.length;
  for (let i = 0; i < n; i++) {
    alive(token);
    perFrame.push(EchoDetect.analyzeFrame(state.frames[i]));
    progress(.35 + .6 * (i + 1) / n);
    message(`Finding the sphere… ${i + 1} of ${n}`);
    await yieldToPage();
  }
  state.report = EchoDetect.summarize(state.frames.map((f) => f.time), perFrame, state.frames[0].width, state.frames[0].height);
}

// ---- what was found ----------------------------------------------------------------------------------------------

function focusFor(t) {
  if (state.manual) return state.manual;
  if (state.sceneFallback) return { cx: .5, cy: .5, rx: .5, ry: .5, full: true };   // the whole scene, corners included
  return state.report && state.report.status === 'ok' ? EchoDetect.focusAt(state.report, t) : null;
}

function readMood() {
  const perFrame = state.frames.map((f) => {
    const e = focusFor(f.time);
    return EchoMood.readPalette(f, { cx: e.cx * f.width, cy: e.cy * f.height, rx: e.rx * f.width, ry: e.ry * f.height, full: e.full });
  });
  state.decision = EchoMood.decide(EchoMood.meanScores(perFrame));
  state.timeline = buildTimeline(perFrame);
}

// The light over time: the same decide() rule, run per window instead of over the whole clip.
// A null mood in a window means mixed light, shown striped rather than forced into a feeling.
function buildTimeline(perFrame) {
  const n = perFrame.length;
  if (!n) return [];
  const windows = Math.max(1, Math.min(12, Math.round(state.duration / 2) || 1));
  const out = [];
  for (let w = 0; w < windows; w++) {
    const a = Math.floor(w * n / windows), b = Math.max(a + 1, Math.floor((w + 1) * n / windows));
    const d = EchoMood.decide(EchoMood.meanScores(perFrame.slice(a, b)));
    out.push({ t0: state.frames[a].time, t1: state.frames[Math.min(b, n - 1)].time, mood: d.mood, top: d.closest });
  }
  return out;
}

function renderTimeline() {
  const wrap = $('timelineWrap'), box = $('timeline');
  box.replaceChildren();
  if (!state.timeline || !state.timeline.length) { show('timelineWrap', false); return; }
  const total = Math.max(state.duration, 1e-6);
  for (const seg of state.timeline) {
    const label = seg.mood ? NAMES[seg.mood] : `mixed light (closest: ${NAMES[seg.top]})`;
    const el = make('button', {
      className: 'tl-seg' + (seg.mood ? '' : ' tl-mixed'),
      title: `${fmt(seg.t0)} – ${fmt(seg.t1)}: ${label}`,
      ariaLabel: `Jump to ${fmt(seg.t0)}: ${label}`,
    });
    el.style.flexBasis = `${Math.max(1.5, (seg.t1 - seg.t0) / total * 100)}%`;
    el.dataset.t0 = seg.t0; el.dataset.t1 = seg.t1;
    if (seg.mood) el.style.setProperty('--seg', THEME[seg.mood][0]);
    el.addEventListener('click', () => { video.currentTime = Math.min(seg.t0 + .01, Math.max(0, state.duration - .05)); });
    box.append(el);
  }
  show('timelineWrap', true);
}

// The timeline marks where the music is: the window under the playhead glows.
function highlightTimeline(t) {
  const box = $('timeline');
  if (!box || !box.children.length) return;
  for (const el of box.children) {
    el.classList.toggle('playing', t >= Number(el.dataset.t0) && t < Number(el.dataset.t1));
  }
}

function presentAnalysis() {
  const { report } = state;
  state.forceMood = null;   // a fresh reading replaces any manual mood choice
  show('wholeButton', false); show('autoButton', false); show('drawHint', false);
  state.drawing = false; stage.classList.remove('drawing');
  if (!state.manual && report.status !== 'ok') {
    if (trySceneFallback()) return;   // no sphere, but the scene itself reads clearly — use it, labeled as such
    $('detectionNote').textContent = `The sphere could not be found reliably. ${report.reasons.join(' ')} Mark it yourself and the reading will continue from there.`;
    message('The sphere could not be found reliably. Mark it yourself to continue.', true);
    show('feelingPanel', false); show('songPanel', false);
    startDrawing();
    drawOverlay();
    return;
  }
  if (state.manual) {
    $('detectionNote').textContent = 'Reading the region you marked (green).';
    show('autoButton', report.status === 'ok');
  } else {
    const m = report.metrics;
    $('detectionNote').textContent = `Found the sphere in ${Math.round(m.coverage * 100)}% of the frames. The light inside the green outline was read; the faint circle is the sphere's edge.`;
  }
  show('wholeButton', false);
  readMood();
  showFeeling();
  message('Ready. You can change the feeling or ask for another song at any time.');
  drawOverlay();
  $('videoPanel').scrollIntoView({ behavior: calmMode ? 'auto' : 'smooth', block: 'start' });
}

// No sphere was found. If the scene itself reads clearly, use that instead of stopping:
// the pipeline reads video mood, and the sphere is one way to read it, not the only one.
// An unclear scene keeps the old behavior (mark the sphere yourself).
function trySceneFallback() {
  const perFrame = state.frames.map((f) => EchoMood.readPalette(f, { cx: f.width / 2, cy: f.height / 2, rx: f.width / 2, ry: f.height / 2, full: true }));
  if (!EchoMood.decide(EchoMood.meanScores(perFrame)).mood) return false;
  state.sceneFallback = true;
  $('detectionNote').textContent = 'No sphere was found, so the whole scene was read instead (green outline). If there is a sphere in the video, mark it yourself.';
  readMood();
  showFeeling();
  message('Ready. You can change the feeling or ask for another song at any time.');
  drawOverlay();
  $('videoPanel').scrollIntoView({ behavior: calmMode ? 'auto' : 'smooth', block: 'start' });
  return true;
}

const WORDS = EchoMood.COLOUR_WORDS;

function showFeeling() {
  const d = state.decision;
  show('feelingPanel', true);
  renderTimeline();
  if (d.mood) {
    state.mood = d.mood;
    if (state.sceneFallback) say($('interpretation'), `No sphere was found, so the whole scene was read. It is mostly ${WORDS[d.mood]}, which reads as `, { strong: NAMES[d.mood] }, '. Not right? Choose another feeling.');
    else say($('interpretation'), `The light inside the sphere is mostly ${WORDS[d.mood]}, which reads as `, { strong: NAMES[d.mood] }, '. Not right? Choose another feeling.');
  } else {
    state.mood = null;
    const [a, b] = d.ranked;
    say($('interpretation'), d.scores[a] < .35
      ? 'There is not much coloured light inside the sphere to read, so it does not point to one feeling. '
      : `The light inside the sphere mixes ${WORDS[a]} and ${WORDS[b]}, so it does not clearly point to one feeling. `, { strong: 'Choose the one that fits.' });
  }
  paintMoodButtons();
  fillDetails();
  if (state.mood) { applyMood(state.mood); state.variation = 0; pickSong(false); }
  else { show('songPanel', false); setTitle('Which feeling', '?'); $('soundMeta').textContent = 'The light does not settle on one'; message('Choose a feeling to hear a song.'); }
}

function fillDetails() {
  const d = state.decision, m = state.report && state.report.metrics;
  const shares = make('dl', {});
  for (const k of EchoMood.MOODS) {
    shares.append(make('dt', { textContent: NAMES[k] }), make('dd', {}, Object.assign(make('span', { className: 'bar' }), { style: `width:${Math.round(Math.min(1, d.scores[k]) * 90)}px` }), `${Math.round(d.scores[k] * 100)}%`));
  }
  const where = make('dl', {});
  if (state.sceneFallback) where.append(make('dt', { textContent: 'Region' }), make('dd', { textContent: 'whole scene (no sphere found)' }));
  else if (!state.manual && m) {
    where.append(make('dt', { textContent: 'Sphere found' }), make('dd', { textContent: `in ${Math.round(m.coverage * 100)}% of ${m.framesSampled} frames` }),
      make('dt', { textContent: 'Uncertainty' }), make('dd', { textContent: `${m.uncertaintyIndex.toFixed(2)} (0 confident, 1 unreliable; a rule of thumb, not a probability)` }));
  } else where.append(make('dt', { textContent: 'Region' }), make('dd', { textContent: 'marked by you' }));
  where.append(make('dt', { textContent: 'Frames read' }), make('dd', { textContent: String(state.frames.length) }));
  $('details').replaceChildren(shares, make('p', { textContent: d.note }), where);
}

// ---- marking the sphere by hand ----------------------------------------------------------------------------------

function startDrawing() {
  state.drawing = true; state.draft = null;
  stage.classList.add('drawing');
  show('drawHint', true); show('wholeButton', true);
  video.pause();
}

function setManual(ellipse) {
  state.manual = ellipse;
  state.sceneFallback = false;
  state.draft = null;
  state.drawing = false;
  stage.classList.remove('drawing');
  show('drawHint', false); show('wholeButton', false);
  presentAnalysis();
}

function pointer(e) {
  const r = overlay.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, w: r.width, h: r.height };
}
overlay.addEventListener('pointerdown', (e) => {
  if (!state.drawing) return;
  overlay.setPointerCapture(e.pointerId);
  const p = pointer(e);
  state.draft = { cx: p.x, cy: p.y, rx: 0, ry: 0, live: true };
});
overlay.addEventListener('pointermove', (e) => {
  if (!state.draft || !state.draft.live) return;
  const p = pointer(e), d = state.draft, radius = Math.hypot((p.x - d.cx) * p.w, (p.y - d.cy) * p.h);
  d.rx = radius / p.w; d.ry = radius / p.h;
  drawOverlay();
});
overlay.addEventListener('pointerup', (e) => {
  const d = state.draft;
  if (!d || !d.live) return;
  d.live = false;
  const r = overlay.getBoundingClientRect();
  if (d.ry * r.height < 10) { state.draft = null; drawOverlay(); return; }
  setManual({ cx: d.cx, cy: d.cy, rx: d.rx * EchoDetect.INTERIOR_SHRINK, ry: d.ry * EchoDetect.INTERIOR_SHRINK });
});

// ---- the outline drawn over the video ---------------------------------------------------------------------------

function drawEllipse(ctx, e, w, h, style, width, dash) {
  ctx.beginPath();
  ctx.ellipse(e.cx * w, e.cy * h, Math.max(1, e.rx * w), Math.max(1, e.ry * h), 0, 0, Math.PI * 2);
  ctx.setLineDash(dash || []); ctx.lineWidth = width; ctx.strokeStyle = style; ctx.stroke();
}

function drawOverlay() {
  const rect = overlay.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  const ctx = overlay.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, w, h);
  if (!$('showOverlay').checked && !state.drawing) return;
  const line = Math.max(2, 2 * dpr), t = video.currentTime;
  if (state.sceneFallback) drawEllipse(ctx, { cx: .5, cy: .5, rx: .5, ry: .5 }, w, h, '#6fe08a', line);
  else if (state.manual) drawEllipse(ctx, state.manual, w, h, '#6fe08a', line);
  else if (state.report && state.report.track.length) {
    const e = EchoDetect.focusAt(state.report, t);
    if (state.report.status === 'ok') {
      drawEllipse(ctx, e, w, h, '#6fe08a', line);
      drawEllipse(ctx, { cx: e.cx, cy: e.cy, rx: e.rx / EchoDetect.INTERIOR_SHRINK, ry: e.ry / EchoDetect.INTERIOR_SHRINK }, w, h, 'rgba(255,224,110,.75)', Math.max(1, dpr));
    } else drawEllipse(ctx, e, w, h, 'rgba(240,110,120,.9)', line, [8 * dpr, 6 * dpr]);       // what it found, marked as not reliable
  }
  if (state.draft) drawEllipse(ctx, state.draft, w, h, '#ffd166', line, [6 * dpr, 5 * dpr]);
}

// ---- choosing and loading the songs ------------------------------------------------------------------------------
// The timeline becomes a playlist: one energy-matched track per run of the same mood,
// crossfaded at boundaries. A single-mood video is one segment and behaves exactly like before.

function segAt(t) {
  const segs = state.segs;
  for (let i = 0; i < segs.length; i++) if (t < segs[i].t1) return i;
  return segs.length - 1;
}

// Crossfade seconds at the boundary after segment i, clamped so short segments still work.
function xfadeAt(i) {
  const segs = state.segs;
  if (i < 0 || i >= segs.length - 1) return 0;
  return Math.max(.05, Math.min(EchoLibrary.SEG_XFADE, (segs[i].t1 - segs[i].t0) / 2, (segs[i + 1].t1 - segs[i + 1].t0) / 2));
}

// Video time at which segment i's element starts playing (its fade-in begins).
function playStartOf(i) { return i === 0 ? 0 : state.segs[i].t0 - xfadeAt(i - 1); }

// Where segment i's track should be at video time t.
function offsetFor(i, t) {
  const seg = state.segs[i];
  const start = EchoLibrary.startOf(seg.track);
  const span = Math.max(.1, seg.track.duration - start);
  const dt = Math.max(0, t - playStartOf(i));
  return start + (seg.pick.looped ? dt % span : Math.min(dt, span - .05));
}

// Crossfade gain for segment i's element at video time t: ramps across each boundary.
function segGain(i, t) {
  const segs = state.segs, n = segs.length;
  let g = 1;
  if (i > 0) { const X = xfadeAt(i - 1); g *= Math.min(1, Math.max(0, (t - (segs[i].t0 - X)) / X)); }
  if (i < n - 1) { const X = xfadeAt(i); g *= Math.min(1, Math.max(0, (segs[i].t1 - t) / X)); }
  return g;
}

// Load segment i into slot s. Safe to call repeatedly; superseded loads are ignored.
function loadSlot(s, i) {
  const sl = slots[s];
  if (sl.seg === i && sl.loadPromise) return sl.loadPromise;
  const token = (sl.loadToken = (sl.loadToken || 0) + 1);
  const seg = state.segs[i];
  sl.loading = true; sl.ready = false; sl.seg = i;
  if (sl.level) sl.level.gain.value = Math.pow(10, seg.gain.db / 20);
  if (sl.xfade) sl.xfade.gain.value = 0;
  const el = sl.el;
  el.pause(); el.loop = false;   // looping is handled by offsetFor, per segment
  el.src = EchoLibrary.urlOf(BASE, seg.track);
  el.load();
  sl.loadPromise = new Promise((resolve) => {
    const timer = setTimeout(() => done(false), 30000);
    const done = (ok) => {
      el.oncanplay = el.onerror = null; clearTimeout(timer);
      if (sl.loadToken !== token) return resolve(false);   // a newer load took over
      sl.loading = false; sl.ready = ok; resolve(ok);
    };
    el.oncanplay = () => done(true);
    el.onerror = () => done(false);
  });
  return sl.loadPromise;
}

// Make sure segment i is loading/loaded in some slot (fire-and-forget for preloads).
function ensureLoaded(i) {
  if (!state.segs || i < 0 || i >= state.segs.length) return;
  if (slots.some((sl) => sl.seg === i)) return;
  const s = slots.findIndex((sl) => sl.seg === -1);
  if (s === -1) return;   // both busy; the next frame retries
  loadSlot(s, i).then((ok) => { if (ok) scheduleAudio(); });
}

function setCurrentSeg(i) {
  const seg = state.segs[i];
  state.track = seg.track; state.pick = seg.pick; state.gain = seg.gain;
  fillSongPanel(i);
}

async function pickSong(another) {
  if (!state.manifest) return message('The song library could not be loaded.', true);
  if (another) state.variation++;
  const timeline = state.forceMood ? [{ t0: 0, t1: state.duration, mood: state.forceMood }] : state.timeline;
  const avoid = another && state.segs ? state.segs.map((s) => s.track.id) : null;
  const segs = EchoLibrary.planSegments(state.manifest, timeline, state.duration, `${state.seed}:${state.variation}`, state.mood, avoid);
  if (!segs || !segs.length) { show('songPanel', false); return message('There are no songs in the library for these moods yet.', true); }
  const wasPlaying = !video.paused && !video.ended;
  for (const sl of slots) { sl.el.pause(); sl.seg = -1; sl.ready = false; sl.loading = false; sl.loadPromise = null; }
  state.segs = segs; lastCur = -1;
  const i = segAt(video.currentTime);
  if (!await loadSlot(0, i)) return message('That song could not be loaded. Try “Another song”.', true);
  try { slots[0].el.currentTime = offsetFor(i, video.currentTime); } catch { /* not seekable yet */ }
  setCurrentSeg(i); lastCur = i;
  if (wasPlaying) play();
  else scheduleAudio();
}

function fillSongPanel(i) {
  const seg = state.segs[i], t = seg.track, pick = seg.pick;
  show('songPanel', true);
  $('songTitle').textContent = t.title;
  const part = state.segs.length > 1 ? ` · part ${i + 1} of ${state.segs.length}` : '';
  $('songMeta').textContent = `${NAMES[seg.mood]} · ${t.artist || 'Unknown artist'} · a ${fmt(t.duration)} song, playing for ${fmt(seg.t1 - seg.t0)}${part}`;
  const credit = EchoLibrary.creditLine(t);
  $('credit').replaceChildren(`Music: ${credit}. ${EchoLibrary.EDIT_NOTE} `, make('a', { href: EchoLibrary.CREDITS_URL, textContent: 'All credits', target: '_blank', rel: 'noopener' }));
  const notes = [];
  if (pick.looped) notes.push('This song is shorter than its part, so it repeats.');
  if (seg.gain.limited) notes.push('This song is very quiet, so it may sound softer than the others.');
  if (state.segs.length > 1) notes.push('The music follows the light: a new song starts where the feeling changes.');
  $('songNote').textContent = notes.join(' ');
  const link = $('downloadSong');
  link.href = EchoLibrary.urlOf(BASE, t);
  link.download = `${t.title}.mp3`;
  $('soundMeta').textContent = `${t.title} · ${t.artist || ''}`.trim();
  $('clock').textContent = `${fmt(video.currentTime)} / ${fmt(state.duration)}`;
}

// ---- playing the video with the song ----------------------------------------------------------------------------

function ensureGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const env = audioCtx.createGain(), limiter = audioCtx.createDynamicsCompressor(), master = audioCtx.createGain(), analyser = audioCtx.createAnalyser();
  limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = .003; limiter.release.value = .1;
  analyser.fftSize = 256; analyser.smoothingTimeConstant = .8;
  master.gain.value = Number($('volume').value);
  for (const sl of slots) {
    const source = audioCtx.createMediaElementSource(sl.el);
    const level = audioCtx.createGain(), xfade = audioCtx.createGain();
    xfade.gain.value = 0;
    source.connect(level); level.connect(xfade); xfade.connect(env);
    sl.level = level; sl.xfade = xfade;
    if (sl.seg !== -1 && state.segs && state.segs[sl.seg]) sl.level.gain.value = Math.pow(10, state.segs[sl.seg].gain.db / 20);
  }
  env.connect(limiter); limiter.connect(master); master.connect(analyser); analyser.connect(audioCtx.destination);
  nodes = { env, master, analyser };
  analyserNode = analyser;
}

// The per-frame scheduler: the single source of truth for which element plays what.
// Ensures the current (and upcoming) segments are loaded, ramps crossfade gains,
// corrects drift, and frees slots that are far from the playhead.
function scheduleAudio() {
  if (!state.segs || !state.segs.length || !slots.length) return;
  const t = video.currentTime, n = state.segs.length;
  const cur = segAt(t);
  for (const sl of slots) {
    if (sl.seg !== -1 && !sl.loading && (sl.seg < cur || sl.seg > cur + 1)) { sl.el.pause(); sl.seg = -1; sl.ready = false; }
  }
  if (cur !== lastCur) {
    lastCur = cur;
    setCurrentSeg(cur);
    if (cur + 1 < n) ensureLoaded(cur + 1);   // preload the next while this one plays
  }
  ensureLoaded(cur);
  if (cur + 1 < n && t >= state.segs[cur].t1 - Math.max(.05, xfadeAt(cur)) - .3) ensureLoaded(cur + 1);
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const sl of slots) {
    if (sl.seg === -1 || !sl.ready || sl.loading) continue;
    const j = sl.seg, g = segGain(j, t);
    sl.xfade.gain.setTargetAtTime(g, now, .03);
    if (!video.paused && !video.ended && g > .001 && sl.el.paused) {
      try { sl.el.currentTime = offsetFor(j, t); } catch { /* not seekable yet */ }
      sl.el.play().catch(() => { /* the play button starts it again */ });
    }
    if (!sl.el.paused && !sl.el.seeking) {
      const expected = offsetFor(j, t);
      if (Math.abs(sl.el.currentTime - expected) > .6) { try { sl.el.currentTime = expected; } catch { /* not seekable yet */ } }
    }
  }
}

function tickEnvelope() {
  if (!nodes) return;
  nodes.env.gain.setTargetAtTime(EchoLibrary.envelope(video.currentTime, state.duration), audioCtx.currentTime, .015);
}

async function play() {
  if (!state.segs || !state.segs.length) return;
  ensureGraph();
  await audioCtx.resume();
  if (video.ended || video.currentTime >= state.duration - .1) video.currentTime = 0;
  const i = segAt(video.currentTime);
  let s = slots.findIndex((sl) => sl.seg === i);
  if (s === -1) s = 0;
  if (!await loadSlot(s, i)) { message('That song could not be loaded. Try \u201cAnother song\u201d.', true); return; }
  const sl = slots[s];
  try { sl.el.currentTime = offsetFor(i, video.currentTime); } catch { /* not seekable yet */ }
  setCurrentSeg(i); lastCur = i;
  tickEnvelope();
  try { await Promise.all([video.play(), sl.el.play()]); } catch (e) { message('The browser blocked playback. Press Play again.', true); return; }
  isPlaying = true;
  window.dispatchEvent(new Event('sphere-change'));
  clearInterval(envelopeTimer);
  envelopeTimer = setInterval(tickEnvelope, 40);
  paintPlayButton();
  requestAnimationFrame(loop);
  if (i + 1 < state.segs.length) ensureLoaded(i + 1);
}

function stopAudioOnly() { for (const sl of slots) sl.el.pause(); }

function stop() {
  video.pause(); stopAudioOnly();
  isPlaying = false;
  clearInterval(envelopeTimer);
  paintPlayButton();
}

// ---- exporting the video with its song --------------------------------------------------------------------------
// Records the video frames to a canvas and taps the master bus, so the file
// hears exactly what the speakers play: crossfades, leveling and envelope
// included. The export is clean video — no detection overlay.

let exporting = null;

function pickExportMime() {
  const cands = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const c of cands) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c; } catch { /* try next */ }
  }
  return '';
}

// The credit for the song playing at time t, as one sentence. CC BY 4.0 asks for the title, the author, the licence and a link to it.
function creditText(t) {
  const seg = state.segs[segAt(t)];
  return `Music: ${EchoLibrary.creditLine(seg.track)} (${seg.track.license_url || 'https://creativecommons.org/licenses/by/4.0/'}). ${EchoLibrary.EDIT_NOTE}`;
}

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// Draws the credit of the current song along the bottom of the exported picture, so it travels with the video.
function drawCredit(ctx, canvas, t) {
  if (!state.segs || !state.segs.length) return;
  const size = Math.max(13, Math.round(canvas.height * .021)), pad = Math.round(size * .9), lineHeight = Math.round(size * 1.3);
  ctx.save();
  ctx.font = `${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = 'top';
  const lines = wrapLines(ctx, creditText(t), canvas.width - 2 * pad);
  const height = lines.length * lineHeight + pad;
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(0, canvas.height - height, canvas.width, height);
  ctx.fillStyle = '#fff';
  lines.forEach((text, i) => ctx.fillText(text, pad, canvas.height - height + pad / 2 + i * lineHeight));
  ctx.restore();
}

function drawExportFrame() {
  if (!exporting || !exporting.ctx) return;
  const { canvas, ctx } = exporting;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (exporting.credit) drawCredit(ctx, canvas, video.currentTime);
  if (state.duration) $('exportBar').style.width = `${Math.min(100, video.currentTime / state.duration * 100)}%`;
}

function setExportUI(on) {
  show('exportRow', on);
  $('exportButton').disabled = on;
  $('playButton').disabled = on;
  $('anotherButton').disabled = on;
}

function teardownExportTracks(ex) {
  try { if (ex.dest) nodes.master.disconnect(ex.dest); } catch { /* already gone */ }
  try { ex.vtrack.stop(); } catch { /* already stopped */ }
  try { if (ex.audioTrack) ex.audioTrack.stop(); } catch { /* already stopped */ }
}

async function exportVideo() {
  if (exporting) return;
  if (!state.segs || !state.segs.length) { message('Analyze a video first.', true); return; }
  if (!window.MediaRecorder) { message('This browser cannot record video.', true); return; }
  exporting = { cancelled: false, starting: true };   // claim the slot; blocks re-entry
  $('exportButton').disabled = true;
  ensureGraph();
  try { await audioCtx.resume(); } catch { /* may still work */ }

  // Preload the first segment so the recording starts with music, not silence.
  const i0 = segAt(0);
  let s0 = slots.findIndex((sl) => sl.seg === i0);
  if (s0 === -1) s0 = 0;
  if (!await loadSlot(s0, i0)) { exporting = null; setExportUI(false); message('That song could not be loaded. Try “Another song”.', true); return; }

  let audioTrack = null, dest = null;
  try {
    dest = audioCtx.createMediaStreamDestination();
    nodes.master.connect(dest);
    [audioTrack] = dest.stream.getAudioTracks();
  } catch { dest = null; }

  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const scale = Math.min(1, 1920 / vw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(vw * scale));
  canvas.height = Math.max(2, Math.round(vh * scale));
  const ctx = canvas.getContext('2d');
  const [vtrack] = canvas.captureStream(30).getVideoTracks();
  if (!vtrack) {
    if (dest) { try { nodes.master.disconnect(dest); } catch {} }
    exporting = null; setExportUI(false);
    message('This browser cannot capture video.', true);
    return;
  }

  const mime = pickExportMime();
  const rec = new MediaRecorder(new MediaStream([vtrack, ...(audioTrack ? [audioTrack] : [])]),
    mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 192_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  Object.assign(exporting, { rec, dest, canvas, ctx, vtrack, audioTrack, chunks, stopped, mime, starting: false, credit: $('exportCredit').checked });
  setExportUI(true);
  $('exportBar').style.width = '0%';
  $('exportLabel').textContent = 'Exporting — the video plays once while its song is recorded…';
  message('Exporting: the video plays once while its song is recorded.');

  try { video.currentTime = 0; } catch { /* play() seeks anyway */ }
  try {
    rec.start();   // no timeslice: one clean blob means valid MP4 structure
  } catch {
    exporting = null;
    teardownExportTracks({ dest, vtrack, audioTrack });
    setExportUI(false);
    message('The recording could not start in this browser.', true);
    return;
  }
  await play();
  if (!exporting || exporting.cancelled) return;
  if (video.paused) {
    // play() was blocked; it already explained why.
    const ex = exporting; exporting = null;
    try { ex.rec.stop(); } catch { /* already stopped */ }
    teardownExportTracks(ex);
    setExportUI(false);
  }
}

// MediaRecorder omits Duration from WebM output; without it most players
// disable seeking entirely. This patches the correct duration into the
// EBML header. Never throws: falls back to the original blob when the
// structure isn't understood.
async function fixWebMDuration(blob, durationMs) {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());

    const readVint = (pos, asId) => {
      if (pos >= buf.length) return null;
      let len = 1;
      while (len <= 8 && !(buf[pos] & (0x80 >> (len - 1)))) len++;
      if (len > 8 || pos + len > buf.length) return null;
      let val = 0;
      if (asId) {
        for (let i = 0; i < len; i++) val = val * 256 + buf[pos + i];
      } else {
        val = buf[pos] & (0xFF >> len);
        for (let i = 1; i < len; i++) val = val * 256 + buf[pos + i];
        if (val === Math.pow(2, 7 * len) - 1) val = -1;   // unknown size
      }
      return { len, val };
    };

    // Find the Segment element (0x18538067).
    let pos = 0, segDataStart = -1, segDataEnd = -1;
    while (pos < buf.length) {
      const id = readVint(pos, true);
      if (!id) break;
      const size = readVint(pos + id.len, false);
      if (!size) break;
      if (id.val === 0x18538067) {
        segDataStart = pos + id.len + size.len;
        segDataEnd = size.val === -1 ? buf.length : segDataStart + size.val;
        break;
      }
      if (size.val === -1) break;
      pos += id.len + size.len + size.val;
    }
    if (segDataStart < 0) return blob;

    // Find Info (0x1549A966) within the Segment.
    pos = segDataStart;
    let infoPos = -1, infoLen = -1, infoSizeLen = -1, infoSizeVal = -1;
    while (pos + 4 <= segDataEnd) {
      const id = readVint(pos, true);
      if (!id) break;
      const size = readVint(pos + id.len, false);
      if (!size) break;
      if (id.val === 0x1549A966) {
        infoPos = pos; infoLen = id.len; infoSizeLen = size.len; infoSizeVal = size.val;
        break;
      }
      if (size.val === -1 || id.val === 0x1F43B675) break;   // Cluster: past Info
      pos += id.len + size.len + size.val;
    }
    if (infoPos < 0 || infoSizeVal < 0) return blob;

    // Walk Info children for TimecodeScale (0x2AD7B1) and Duration (0x4489).
    const infoDataStart = infoPos + infoLen + infoSizeLen;
    const infoDataEnd = infoDataStart + infoSizeVal;
    let timecodeScale = 1000000, durPos = -1, durSizeLen = -1, durDataLen = -1;
    pos = infoDataStart;
    while (pos + 2 <= infoDataEnd && pos < buf.length) {
      const id = readVint(pos, true);
      if (!id) break;
      const size = readVint(pos + id.len, false);
      if (!size || size.val < 0) break;
      if (id.val === 0x2AD7B1) {
        timecodeScale = 0;
        for (let i = 0; i < size.val; i++) timecodeScale = timecodeScale * 256 + buf[pos + id.len + size.len + i];
      } else if (id.val === 0x4489) {
        durPos = pos; durSizeLen = size.len; durDataLen = size.val;
      }
      pos += id.len + size.len + size.val;
    }
    if (!timecodeScale) return blob;

    const f64 = new Uint8Array(8);
    new DataView(f64.buffer).setFloat64(0, durationMs * 1e6 / timecodeScale, false);

    if (durPos >= 0) {
      if (durDataLen !== 8) return blob;
      const out = new Uint8Array(buf);
      out.set(f64, durPos + 2 + durSizeLen);
      return new Blob([out], { type: blob.type });
    }

    // Insert a new Duration element at the start of Info, then grow Info's size.
    const durEl = new Uint8Array([0x44, 0x89, 0x88, ...f64]);
    const newBuf = new Uint8Array(buf.length + durEl.length);
    newBuf.set(buf.subarray(0, infoDataStart), 0);
    newBuf.set(durEl, infoDataStart);
    newBuf.set(buf.subarray(infoDataStart), infoDataStart + durEl.length);
    const newInfoSize = infoSizeVal + durEl.length;
    if (newInfoSize >= Math.pow(2, 7 * infoSizeLen)) return blob;
    let v = newInfoSize;
    const sizeBytes = new Uint8Array(infoSizeLen);
    for (let i = infoSizeLen - 1; i >= 0; i--) { sizeBytes[i] = v & 0xFF; v = Math.floor(v / 256); }
    sizeBytes[0] |= (0x80 >> (infoSizeLen - 1));
    newBuf.set(sizeBytes, infoPos + infoLen);
    return new Blob([newBuf], { type: blob.type });
  } catch {
    return blob;
  }
}

async function finishExport() {
  const ex = exporting;
  exporting = null;
  setExportUI(false);
  if (!ex || !ex.rec) return;
  try { ex.rec.stop(); } catch { /* already stopped */ }
  try { await ex.stopped; } catch { /* ignore */ }
  teardownExportTracks(ex);
  if (ex.cancelled || !ex.chunks.length) {
    message(ex.cancelled ? 'Export cancelled.' : 'Nothing was recorded.', !ex.cancelled);
    return;
  }
  const ext = ex.mime.includes('mp4') ? 'mp4' : 'webm';
  let blob = new Blob(ex.chunks, { type: ex.mime || 'video/webm' });
  if (ext === 'webm' && state.duration) blob = await fixWebMDuration(blob, state.duration * 1000);
  const a = document.createElement('a');
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = `echosphere-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  message(`Exported ${(blob.size / 1048576).toFixed(1)} MB of video with its song.`);
}

function cancelExport() {
  if (!exporting || !exporting.rec) return;
  exporting.cancelled = true;
  stop();
  finishExport();
}

function paintPlayButton() {
  const on = !video.paused && !video.ended;
  $('playButton').textContent = on ? 'Pause' : 'Play with the video';
  $('playButton').classList.toggle('playing', on);
  $('playButton').setAttribute('aria-pressed', String(on));
}

function loop() {
  drawOverlay();
  scheduleAudio();
  highlightTimeline(video.currentTime);
  if (exporting) drawExportFrame();
  if (!video.paused && !video.ended) requestAnimationFrame(loop);
}

video.addEventListener('pause', () => { stopAudioOnly(); isPlaying = false; clearInterval(envelopeTimer); paintPlayButton(); });
video.addEventListener('ended', () => { stopAudioOnly(); isPlaying = false; clearInterval(envelopeTimer); if (nodes) nodes.env.gain.value = 0; paintPlayButton(); if (exporting && exporting.rec) finishExport(); });
video.addEventListener('seeked', () => { if (state.segs && !state.busy) scheduleAudio(); drawOverlay(); highlightTimeline(video.currentTime); });
video.addEventListener('timeupdate', () => {
  if (state.busy) return;
  $('clock').textContent = `${fmt(video.currentTime)} / ${fmt(state.duration)}`;
  if (state.duration) $('scrub').value = String(Math.round(video.currentTime / state.duration * 1000));
  if (!video.paused && state.segs) scheduleAudio();
  if (video.paused) drawOverlay();
});
$('scrub').addEventListener('input', () => { if (state.duration) video.currentTime = Number($('scrub').value) / 1000 * state.duration; });
$('volume').addEventListener('input', () => { if (nodes) nodes.master.gain.value = Number($('volume').value); });
$('playButton').addEventListener('click', () => { if (!video.paused && !video.ended) stop(); else play(); });
$('anotherButton').addEventListener('click', () => pickSong(true));
$('exportButton').addEventListener('click', exportVideo);
$('cancelExport').addEventListener('click', cancelExport);

// ---- controls ---------------------------------------------------------------------------------------------------

document.querySelectorAll('.mood-btn').forEach((b) => b.addEventListener('click', () => {
  state.mood = b.dataset.mood; state.forceMood = b.dataset.mood; state.variation = 0;
  applyMood(state.mood); paintMoodButtons(); pickSong(false);
  message(`${NAMES[state.mood]} chosen.`);
}));
$('addButton').addEventListener('click', () => $('fileInput').click());
$('changeButton').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; handleFile(f); });
$('drawButton').addEventListener('click', () => { startDrawing(); drawOverlay(); message('Drag from the middle of the sphere out to its edge.'); });
$('wholeButton').addEventListener('click', () => setManual({ cx: .5, cy: .5, rx: .48, ry: .48 }));
$('autoButton').addEventListener('click', () => { state.manual = null; state.sceneFallback = false; presentAnalysis(); });
$('showOverlay').addEventListener('change', drawOverlay);
window.addEventListener('resize', drawOverlay, { passive: true });
$('calmToggle').addEventListener('click', () => setQuiet(!calmMode));
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => setQuiet(e.matches));
$('creditsButton').onclick = () => $('creditsDialog').showModal();
$('closeCredits').onclick = () => $('creditsDialog').close();

for (const type of ['dragenter', 'dragover']) document.addEventListener(type, (e) => { e.preventDefault(); $('addButton').classList.add('over'); });
for (const type of ['dragleave', 'drop']) document.addEventListener(type, (e) => { e.preventDefault(); $('addButton').classList.remove('over'); });
document.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) handleFile(f); });

setQuiet(calmMode);
loadLibrary();
window.EchoApp = { state, handleFile, pickSong, play, stop, setManual, video, audio };      // for the automated browser tests
