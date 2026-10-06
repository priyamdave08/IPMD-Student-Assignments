'use strict';
// The globals the animated sphere (../web/sphere.js) reads. Loaded before it, exactly as the original page did.
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mod = (x, n) => ((x % n) + n) % n;
function seeded(seed) { let s = seed >>> 0; return () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let activeMood = 'warm', isPlaying = false, analyserNode = null, calmMode = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sparks = [], transitions = [];
const moods = { warm: { color: '#FFD166' }, calm: { color: '#7B4ED6' }, anger: { color: '#C1121F' }, sad: { color: '#3A6EA5' } };
function ignite(kind, strength) { if (sparks.length < 8) sparks.push({ born: performance.now(), lifespan: .9, kind, strength }); }
