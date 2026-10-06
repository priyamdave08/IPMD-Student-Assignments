// A synthetic robot scene with the traps the real footage has: a dark face with bright eyes above the sphere, a white body,
// a fireplace and a lamp that are bright and warm, and a camera that zooms and pans. No real footage is used.
const W = 640, H = 360;

function ellipse(x, y, cx, cy, rx, ry) { return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1; }

// rgb of the scene at source coordinates (x, y), or the sphere's interior colour when `sphere` is on.
function pixel(x, y, sphere, hue, hue2, particles) {
  let c = y < 180 ? [232, 220, 200] : [232, 222, 215];
  if (y >= 300) c = [185, 175, 170];
  if (ellipse(x, y, 320, 235, 100, 125)) c = [242, 246, 246];                    // white body
  if (ellipse(x, y, 320, 95, 58, 42)) c = [24, 22, 22];                          // dark face screen
  for (const dx of [-22, 22]) if (ellipse(x, y, 320 + dx, 92, 9, 6) && y < 92) c = [255, 200, 120];    // glowing eyes
  if (ellipse(x, y, 60, 250, 28, 44) || ellipse(x, y, 52, 240, 26, 42) || ellipse(x, y, 70, 245, 26, 40)) c = [255, 120, 0];   // flames
  if (ellipse(x, y, 60, 260, 12, 22)) c = [255, 230, 120];
  if (Math.hypot(x - 585, y - 70) <= 16) c = [255, 240, 150];                    // lamp
  if (sphere) {
    const d = Math.hypot(x - 320, y - 222) / 62;
    if (d <= 1) {
      let base = hue2 && x >= 320 ? hue2 : hue;
      const shade = 1.1 - .5 * d;
      c = base.map((v) => Math.min(255, v * shade));
      if (y < 222 - 6.2) c = c.map((v, i) => v * .35 + [20, 40, 90][i]);
      for (const [px, py, pr] of particles) if (Math.hypot(x - px, y - py) <= pr) c = [255, 240, 200];
    } else if (d <= 1.04) c = [235, 235, 235];                                    // glass rim
  }
  return c;
}

// Returns the frame at time t (of `duration`) at half resolution (320x180) and the true sphere circle in that frame.
export function frame(t, duration, { sphere = true, hue = [235, 150, 40], hue2 = null, seed = 1 } = {}) {
  const zoom = 1 + .7 * t / duration, pan = 40 * t / duration;
  const m02 = 320 - 320 * zoom - pan, m12 = 250 - 250 * zoom;
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const particles = Array.from({ length: 28 }, () => { const a = rnd() * 6.28, b = rnd() * .9 * 62; return [320 + b * Math.cos(a), 222 + b * Math.sin(a), 2 + rnd() * 3]; });
  const w = W / 2, h = H / 2, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (const [ox, oy] of [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]) {                    // 2x2 supersampling
      const sx = ((x + ox) * 2 - m02) / zoom, sy = ((y + oy) * 2 - m12) / zoom;
      const c = pixel(sx, sy, sphere, hue, hue2, particles);
      r += c[0]; g += c[1]; b += c[2];
    }
    data.set([r / 4, g / 4, b / 4, 255], (y * w + x) * 4);
  }
  return { time: t, width: w, height: h, data, truth: { cx: (zoom * 320 + m02) / 2, cy: (zoom * 222 + m12) / 2, r: zoom * 62 / 2 } };
}

export function clip(duration = 10, fps = 5, options = {}) {
  return Array.from({ length: Math.round(duration * fps) }, (_, i) => frame(i / fps, duration, options));
}
