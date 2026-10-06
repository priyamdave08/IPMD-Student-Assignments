// Finds and follows the glass sphere in a video, in the browser. A port of server/detect.py.
//
// The sphere is recognised from several cues at once, not from brightness alone: a circular rim,
// a lit and coloured interior with texture, contrast against the body around it, and not being
// a dark screen (the robot's face). Candidates from every sampled frame are then linked into one
// path by dynamic programming, so a single frame cannot pull the selection onto a lamp, a fire
// or the face. Nothing here is a trained model. Its scores are heuristics, and `uncertaintyIndex`
// is NOT a probability. Unreliable selections are rejected instead of guessed.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EchoDetect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TOP_CANDIDATES = 6;
  const INTERIOR_SHRINK = .9;             // read slightly inside the glass rim
  const MAX_GAP_SECONDS = 1.0;
  const MIN_COVERAGE = .7, MIN_QUALITY = .35, MAX_AMBIGUOUS_FRACTION = .35, MAX_JITTER = .12;
  const EDGE_THRESHOLD = .10;             // step height (0..1) that counts as a rim edge for the circle search

  const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
  const mirror = (i, n) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);       // OpenCV's default border

  // ---- per-frame cues ------------------------------------------------------------------------------------------

  function blur5(channel, w, h) {
    const k = [1, 4, 6, 4, 1], tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -2; d <= 2; d++) s += k[d + 2] * channel[y * w + mirror(x + d, w)];
      tmp[y * w + x] = s / 16;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -2; d <= 2; d++) s += k[d + 2] * tmp[mirror(y + d, h) * w + x];
      out[y * w + x] = s / 16;
    }
    return out;
  }

  // frame: {data: RGBA bytes, width, height}
  function prepare(frame) {
    const { data, width: w, height: h } = frame, n = w * h;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { R[i] = data[i * 4]; G[i] = data[i * 4 + 1]; B[i] = data[i * 4 + 2]; }
    const r = blur5(R, w, h), g = blur5(G, w, h), b = blur5(B, w, h);
    const gray = new Float32Array(n), chroma = new Float32Array(n), value = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      gray[i] = (.299 * r[i] + .587 * g[i] + .114 * b[i]) / 255;
      const mx = Math.max(r[i], g[i], b[i]), mn = Math.min(r[i], g[i], b[i]);
      chroma[i] = (mx - mn) / 255;
      value[i] = mx / 255;
    }
    const grad = new Float32Array(n), gx = new Float32Array(n), gy = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const xm = mirror(x - 1, w), xp = mirror(x + 1, w), ym = mirror(y - 1, h), yp = mirror(y + 1, h);
      const at = (yy, xx) => gray[yy * w + xx];
      const sx = (at(ym, xp) + 2 * at(y, xp) + at(yp, xp)) - (at(ym, xm) + 2 * at(y, xm) + at(yp, xm));
      const sy = (at(yp, xm) + 2 * at(yp, x) + at(yp, xp)) - (at(ym, xm) + 2 * at(ym, x) + at(ym, xp));
      gx[y * w + x] = sx / 4; gy[y * w + x] = sy / 4;
      grad[y * w + x] = Math.hypot(sx, sy) / 4;
    }
    // Row-wise running sums make "add up a disk" cost one subtraction per row instead of one addition per pixel.
    const stride = w + 1;
    const sums = { chroma: 0, value: 0, gray: 0, gray2: 0, dark: 0, colour: 0, body: 0 };
    const prefix = {};
    for (const key of Object.keys(sums)) prefix[key] = new Float64Array(stride * h);
    for (let y = 0; y < h; y++) {
      let c = 0, v = 0, g2 = 0, gg = 0, d = 0, co = 0, bo = 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, o = y * stride + x + 1;
        c += chroma[i]; v += value[i]; g2 += gray[i]; gg += gray[i] * gray[i];
        if (value[i] < .15) d++;
        if (chroma[i] > .10) co++;
        if (chroma[i] < .14 && value[i] > .6 && grad[i] < .04) bo++;
        prefix.chroma[o] = c; prefix.value[o] = v; prefix.gray[o] = g2; prefix.gray2[o] = gg;
        prefix.dark[o] = d; prefix.colour[o] = co; prefix.body[o] = bo;
      }
    }
    return { w, h, gray, chroma, value, grad, gx, gy, prefix, stride };
  }

  // Totals over every pixel whose centre lies within radius R of (cx, cy), clipped to the image.
  const KEYS = ['chroma', 'value', 'gray', 'gray2', 'dark', 'colour', 'body'];
  function disk(cues, cx, cy, R, out) {
    for (const k of KEYS) out[k] = 0;
    out.n = 0;
    const { w, h, prefix, stride } = cues;
    const yA = Math.max(0, Math.ceil(cy - R)), yB = Math.min(h - 1, Math.floor(cy + R));
    for (let y = yA; y <= yB; y++) {
      const dy = y - cy, rest = R * R - dy * dy;
      if (rest < 0) continue;
      const half = Math.sqrt(rest);
      const x0 = Math.max(0, Math.ceil(cx - half)), x1 = Math.min(w - 1, Math.floor(cx + half));
      if (x1 < x0) continue;
      const row = y * stride;
      for (const k of KEYS) out[k] += prefix[k][row + x1 + 1] - prefix[k][row + x0];
      out.n += x1 - x0 + 1;
    }
    return out;
  }

  // ---- how sphere-like is this circle? (relative, 0..1) ----------------------------------------------------------

  const ANGLES = 72, COS = [], SIN = [];
  for (let i = 0; i < ANGLES; i++) { COS.push(Math.cos(i / ANGLES * 2 * Math.PI)); SIN.push(Math.sin(i / ANGLES * 2 * Math.PI)); }
  const scratchIn = {}, scratchOut = {}, scratchRing = {};

  function score(cues, cx, cy, r) {
    const { w, h, grad } = cues;
    if (r < 4) return 0;
    let edge = 0;
    for (let a = 0; a < ANGLES; a++) {
      let best = 0;
      for (let dr = -2; dr <= 2; dr++) {
        const x = Math.round(cx + (r + dr) * COS[a]), y = Math.round(cy + (r + dr) * SIN[a]);
        if (x >= 0 && x < w && y >= 0 && y < h) best = Math.max(best, grad[y * w + x]);
      }
      if (best > .07) edge++;
    }
    const qEdge = edge / ANGLES;
    const inside = disk(cues, cx, cy, r * .85, scratchIn);
    if (inside.n < 30) return 0;
    const outer = disk(cues, cx, cy, r * 1.5, scratchOut), inner = disk(cues, cx, cy, r * 1.15, scratchRing);
    const n = inside.n;
    const chromaIn = inside.chroma / n, valueIn = inside.value / n;
    const darkFraction = inside.dark / n, colourFraction = inside.colour / n, bodyFraction = inside.body / n;
    const ringN = outer.n - inner.n;
    const chromaOut = ringN > 30 ? (outer.chroma - inner.chroma) / ringN : chromaIn;
    const mean = inside.gray / n, texture = Math.sqrt(Math.max(0, inside.gray2 / n - mean * mean));
    const qGlow = clamp(Math.max(chromaIn * valueIn / .12, (valueIn - .3) / .45));
    const qContrast = clamp((chromaIn - chromaOut) / .3 + .5);
    const qDark = 1 - clamp((darkFraction - .2) / .4);          // the robot's face is mostly a dark screen
    const qBody = 1 - clamp((bodyFraction - .12) / .3);         // a circle that swallows the smooth body is not the sphere
    const qFill = clamp((colourFraction - .3) / .4);
    const qTexture = clamp(texture / .08);
    const qSize = (h * .08 <= r && r <= h * .46) ? 1 : .6;
    return qDark * qBody * qSize * (.24 * qEdge + .18 * qGlow + .24 * qContrast + .2 * qFill + .14 * qTexture);
  }

  function plausible(c, w, h) {
    const [cx, cy, r] = c;
    return h * .06 <= r && r <= h * .5 && -r * .1 <= cx - r && cx + r <= w + r * .1 && -r * .1 <= cy - r && cy + r <= h + r * .1;
  }

  // Coordinate ascent on the score, from coarse to fine steps, after sweeping the radius at the seed's centre.
  function refine(cues, seed, rounds = 3) {
    let [cx, cy, r0] = seed;
    let best = -1, r = r0;
    for (let i = 0; i < 14; i++) {
      const k = .4 * Math.pow(1.15 / .4, i / 13), v = score(cues, cx, cy, r0 * k);
      if (v > best) { best = v; r = r0 * k; }
    }
    let step = .08;
    for (let round = 0; round < rounds; round++) {
      for (let it = 0; it < 10; it++) {
        let improved = false;
        for (const [dx, dy, dr] of [[step, 0, 0], [-step, 0, 0], [0, step, 0], [0, -step, 0], [0, 0, step], [0, 0, -step]]) {
          const nx = cx + dx * r, ny = cy + dy * r, nr = r * (1 + dr);
          if (nr < 4) continue;
          const v = score(cues, nx, ny, nr);
          if (v > best + 1e-4) { best = v; cx = nx; cy = ny; r = nr; improved = true; }
        }
        if (!improved) break;
      }
      step /= 2;
    }
    return [cx, cy, r];
  }

  // ---- where might a circle be? ------------------------------------------------------------------------------------

  // Circle search along edge normals: every strong edge votes for centres on either side of it.
  function circleSeeds(cues, maxSeeds = 8) {
    const { w, h, grad, gx, gy } = cues;
    const rMin = Math.max(4, Math.round(h * .06)), rMax = Math.round(h * .48);
    const acc = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const g = grad[y * w + x];
      if (g < EDGE_THRESHOLD) continue;
      const dx = gx[y * w + x] / (g || 1) / 1, dy = gy[y * w + x] / (g || 1) / 1;
      const norm = Math.hypot(dx, dy) || 1, ux = dx / norm, uy = dy / norm;
      for (let r = rMin; r <= rMax; r += 2) for (const sign of [-1, 1]) {
        const cx = Math.round(x + sign * ux * r), cy = Math.round(y + sign * uy * r);
        if (cx >= 0 && cx < w && cy >= 0 && cy < h) acc[cy * w + cx] += g;
      }
    }
    const smooth = blur5(acc, w, h);
    const order = Array.from(smooth.keys()).sort((a, b) => smooth[b] - smooth[a]);
    const peaks = [];
    for (const i of order) {
      if (peaks.length >= maxSeeds || smooth[i] <= 0) break;
      const cx = i % w, cy = (i / w) | 0;
      if (peaks.some(([px, py]) => Math.hypot(px - cx, py - cy) < rMin)) continue;
      peaks.push([cx, cy]);
    }
    // For each candidate centre, the radius at which most edge points sit.
    return peaks.map(([cx, cy]) => {
      const hist = new Float32Array(rMax + 2);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const g = grad[y * w + x];
        if (g < EDGE_THRESHOLD) continue;
        const d = Math.round(Math.hypot(x - cx, y - cy));
        if (d >= rMin && d <= rMax) hist[d] += g;
      }
      let bestR = rMin;
      for (let r = rMin; r <= rMax; r++) if (hist[r] > hist[bestR]) bestR = r;
      return [cx, cy, bestR];
    });
  }

  // Large coloured, lit regions are a second, independent source of candidates.
  function regionSeeds(cues, maxSeeds = 6) {
    const { w, h, chroma, value } = cues;
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = chroma[i] > .22 && value[i] > .3 ? 1 : 0;
    const k = Math.max(3, Math.round(h * .03)) | 1, half = (k - 1) / 2;
    const morph = (src, keepMax) => {
      const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = keepMax ? 0 : 1;
        for (let d = -half; d <= half; d++) { const xx = x + d; if (xx < 0 || xx >= w) continue; const s = src[y * w + xx]; v = keepMax ? Math.max(v, s) : Math.min(v, s); }
        tmp[y * w + x] = v;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = keepMax ? 0 : 1;
        for (let d = -half; d <= half; d++) { const yy = y + d; if (yy < 0 || yy >= h) continue; const s = tmp[yy * w + x]; v = keepMax ? Math.max(v, s) : Math.min(v, s); }
        out[y * w + x] = v;
      }
      return out;
    };
    mask = morph(morph(mask, true), false);                    // close: dilate then erode
    const seen = new Uint8Array(w * h), blobs = [], stack = [];
    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || seen[start]) continue;
      let area = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      stack.push(start); seen[start] = 1;
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i / w) | 0;
        area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
          if (j >= 0 && mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      if (area >= Math.PI * (h * .05) ** 2) blobs.push({ area, x0, x1, y0, y1 });
    }
    blobs.sort((a, b) => b.area - a.area);
    return blobs.slice(0, maxSeeds).map((b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2]);
  }

  // How much of the smaller circle lies inside the other (0..1).
  function overlapFraction(a, b) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]), r1 = a[2], r2 = b[2], small = Math.min(r1, r2), big = Math.max(r1, r2);
    if (d >= r1 + r2) return 0;
    if (d <= big - small) return 1;
    const alpha = Math.acos(clamp((d * d + r1 * r1 - r2 * r2) / (2 * d * r1), -1, 1)), beta = Math.acos(clamp((d * d + r2 * r2 - r1 * r1) / (2 * d * r2), -1, 1));
    const area = r1 * r1 * alpha + r2 * r2 * beta - .5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
    return area / (Math.PI * small * small);
  }

  function candidates(cues) {
    const { w, h } = cues;
    const valid = [...circleSeeds(cues), ...regionSeeds(cues)].filter((c) => plausible(c, w, h));
    // Raw detections are often the outer body ring or an enclosing blob, so they are only seeds:
    // the glass ball is usually concentric with them but smaller.
    const seeds = valid.map((c) => [c, score(cues, ...c)]).sort((a, b) => b[1] - a[1]).slice(0, 5).map((p) => p[0]);
    const kept = [];
    for (const seed of seeds) {
      const [cx, cy, r] = refine(cues, seed);
      if (!plausible([cx, cy, r], w, h)) continue;
      if (kept.some(([a, b, s]) => Math.hypot(cx - a, cy - b) < .25 * Math.max(r, s) && Math.abs(r - s) < .25 * Math.max(r, s))) continue;
      kept.push([cx, cy, r]);
    }
    return kept;
  }

  // ---- linking frames ------------------------------------------------------------------------------------------------

  // Viterbi over candidates plus a "missing" state. Returns, per frame, the chosen candidate or null.
  function track(perFrame) {
    const n = perFrame.length, MISS_COST = 1.6, GAP_COST = .35;
    const states = perFrame.map((cands) => [{ c: null, s: 0 }, ...cands.map(([cx, cy, r, s]) => ({ c: [cx, cy, r], s }))]);
    const emit = (st) => (st.c === null ? MISS_COST : -Math.log(Math.max(st.s, 1e-3)));
    const cost = states.map((s) => new Float64Array(s.length).fill(Infinity)), back = states.map((s) => new Int32Array(s.length).fill(-1));
    states[0].forEach((st, j) => { cost[0][j] = emit(st); });
    for (let t = 1; t < n; t++) {
      states[t].forEach((st, j) => {
        const e = emit(st);
        states[t - 1].forEach((prev, i) => {
          let trans;
          if (st.c === null || prev.c === null) trans = GAP_COST;
          else {
            const scale = (st.c[2] + prev.c[2]) / 2;
            trans = 2.5 * Math.hypot(st.c[0] - prev.c[0], st.c[1] - prev.c[1]) / scale + 3.0 * Math.abs(Math.log(st.c[2] / prev.c[2]));
          }
          const total = cost[t - 1][i] + trans + e;
          if (total < cost[t][j]) { cost[t][j] = total; back[t][j] = i; }
        });
      });
    }
    let j = 0;
    for (let i = 1; i < cost[n - 1].length; i++) if (cost[n - 1][i] < cost[n - 1][j]) j = i;
    const path = [j];
    for (let t = n - 1; t > 0; t--) { j = back[t][j]; path.push(j); }
    path.reverse();
    return path.map((jj, t) => (states[t][jj].c === null ? null : { cx: states[t][jj].c[0], cy: states[t][jj].c[1], r: states[t][jj].c[2], score: states[t][jj].s, all: perFrame[t] }));
  }

  function smooth(values, sigma = 1.5) {
    const n = values.length, at = (a, i) => a[Math.max(0, Math.min(a.length - 1, i))];
    const med = values.map((_, i) => { const w = [-2, -1, 0, 1, 2].map((d) => at(values, i + d)).sort((a, b) => a - b); return w[2]; });
    const radius = 4, kernel = [];
    let sum = 0;
    for (let d = -radius; d <= radius; d++) { const k = Math.exp(-d * d / (2 * sigma * sigma)); kernel.push(k); sum += k; }
    return med.map((_, i) => kernel.reduce((s, k, j) => s + k * at(med, i + j - radius), 0) / sum);
  }

  function interpolate(times, found, values) {
    const known = times.map((t, i) => [t, values[i], found[i]]).filter((p) => p[2]);
    return times.map((t) => {
      if (t <= known[0][0]) return known[0][1];
      for (let i = 1; i < known.length; i++) if (t <= known[i][0]) {
        const [t0, v0] = known[i - 1], [t1, v1] = known[i];
        return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
      }
      return known[known.length - 1][1];
    });
  }

  function longestGap(times, found) {
    let longest = 0, start = null;
    times.forEach((t, i) => {
      if (!found[i] && start === null) start = t;
      if (found[i] && start !== null) { longest = Math.max(longest, t - start); start = null; }
    });
    if (start !== null) longest = Math.max(longest, times[times.length - 1] - start);
    return longest;
  }

  // The scored candidate circles [cx, cy, r, score] in one frame. Exposed so a page can do the frames one at a time.
  function analyzeFrame(frame) {
    const cues = prepare(frame);
    const scored = candidates(cues).map(([cx, cy, r]) => [cx, cy, r, score(cues, cx, cy, r)]).sort((a, b) => b[3] - a[3]);
    return scored.slice(0, TOP_CANDIDATES);
  }

  // frames: [{time, data, width, height}] in time order, all the same size. onFrame(i, n) is called as work proceeds.
  function detectSphere(frames, onFrame) {
    const perFrame = [];
    frames.forEach((frame, i) => {
      perFrame.push(analyzeFrame(frame));
      if (onFrame) onFrame(i + 1, frames.length);
    });
    return summarize(frames.map((f) => f.time), perFrame, frames[0].width, frames[0].height);
  }

  // A glass ball full of texture yields several overlapping circles. Circles that overlap the chosen one, directly or through
  // each other, are all "the same object". A rival is a separate object elsewhere that scores almost as well.
  function hasRival(p) {
    const pool = p.all, inCluster = new Set(), queue = [[p.cx, p.cy, p.r]];
    while (queue.length) {
      const a = queue.pop();
      pool.forEach((c, i) => { if (!inCluster.has(i) && overlapFraction(c, a) >= .3) { inCluster.add(i); queue.push(c); } });
    }
    return pool.some((c, i) => !inCluster.has(i) && c[3] >= .85 * p.score);
  }

  function summarize(times, perFrame, w, h) {
    const path = track(perFrame), found = path.map((p) => p !== null), nFound = found.filter(Boolean).length;
    const coverage = nFound / times.length;
    const quality = nFound ? path.filter(Boolean).reduce((s, p) => s + p.score, 0) / nFound : 0;
    let ambiguous = 0;
    for (const p of path) {
      if (!p) continue;
      if (hasRival(p)) ambiguous++;
    }
    const ambiguousFraction = ambiguous / Math.max(nFound, 1);
    const report = { status: 'rejected', reasons: [], width: w, height: h, times };
    if (nFound < 2) {
      report.reasons = ['No sphere-like region was found.'];
      report.metrics = { coverage, quality, ambiguousFraction, jitter: null, uncertaintyIndex: 1 };
      report.track = [];
      return report;
    }
    const cx = interpolate(times, found, path.map((p) => p && p.cx)), cy = interpolate(times, found, path.map((p) => p && p.cy)), r = interpolate(times, found, path.map((p) => p && p.r));
    const gap = longestGap(times, found);
    const scx = smooth(cx), scy = smooth(cy), sr = smooth(r);
    const meanR = sr.reduce((s, v) => s + v, 0) / sr.length;
    let sq = 0;
    for (let i = 0; i < times.length; i++) sq += ((cx[i] - scx[i]) / meanR) ** 2 + ((cy[i] - scy[i]) / meanR) ** 2 + ((r[i] - sr[i]) / meanR) ** 2;
    const jitter = Math.sqrt(sq / (3 * times.length));
    const uncertaintyIndex = clamp(1 - coverage * quality * (1 - ambiguousFraction) * (1 - clamp(jitter * 4)));
    const reasons = [];
    if (coverage < MIN_COVERAGE) reasons.push(`The sphere was found in only ${Math.round(coverage * 100)}% of the sampled frames.`);
    if (quality < MIN_QUALITY) reasons.push('The best matches were weak sphere candidates.');
    if (ambiguousFraction > MAX_AMBIGUOUS_FRACTION) reasons.push('Another region scored almost as well as the chosen one in many frames.');
    if (jitter > MAX_JITTER) reasons.push('The selection jumped around too much to be a stable sphere.');
    if (gap > MAX_GAP_SECONDS * 2) reasons.push('The sphere was lost for a long stretch of the clip.');
    report.status = reasons.length ? 'rejected' : 'ok';
    report.reasons = reasons;
    report.metrics = {
      framesSampled: times.length, coverage, quality, ambiguousFraction, jitter, longestGapSeconds: gap, uncertaintyIndex,
      uncertaintyNote: 'Heuristic index from 0 (confident) to 1 (unreliable). Not a probability.',
    };
    report.track = times.map((t, i) => ({ time: t, cx: scx[i] / w, cy: scy[i] / h, radius: sr[i] / h, detected: found[i] }));
    return report;
  }

  // The region to read colour from at time t: the tracked sphere, shrunk to its interior, in normalised units.
  function focusAt(report, t) {
    const tr = report.track;
    if (!tr.length) return null;
    let a = tr[0], b = tr[0], u = 0;
    if (t >= tr[tr.length - 1].time) { a = b = tr[tr.length - 1]; }
    else if (t > tr[0].time) {
      let i = 1;
      while (tr[i].time < t) i++;
      a = tr[i - 1]; b = tr[i]; u = (t - a.time) / (b.time - a.time);
    }
    const mix = (k) => a[k] + (b[k] - a[k]) * u;
    const radius = mix('radius') * INTERIOR_SHRINK;
    return { cx: mix('cx'), cy: mix('cy'), ry: radius, rx: radius * report.height / report.width };
  }

  return { prepare, score, candidates, refine, track, analyzeFrame, detectSphere, summarize, focusAt, smooth, overlapFraction, INTERIOR_SHRINK };
});
