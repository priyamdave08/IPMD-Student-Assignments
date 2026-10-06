// Reads a mood from the light inside the sphere. A port of the palette rule in server/analysis.py.
//
// This is EchoSphere's own colour code, not a trained model: gold is Warm, pale violet is Calm, blue is Sad,
// red or orange is Dynamic (its internal id is still "anger"). The numbers it returns are relative shares of coloured light, NOT probabilities.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EchoMood = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MOODS = ['warm', 'calm', 'sad', 'anger'];
  const MASK_FRACTION = 108 / 112;    // the server read a circle 96% as wide as the selected region

  // OpenCV's 8-bit convention, which the thresholds were written for: hue 0..179, saturation and value 0..1.
  function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = 60 * (g - b) / d;
      else if (max === g) h = 120 + 60 * (b - r) / d;
      else h = 240 + 60 * (r - g) / d;
      if (h < 0) h += 360;
    }
    return [h / 2, max === 0 ? 0 : d / max, max / 255];
  }

  // frame: {data: RGBA bytes, width, height}; ellipse: {cx, cy, rx, ry} in pixels of that frame.
  function readPalette(frame, ellipse) {
    const { data, width, height } = frame;
    const shrink = ellipse.full ? 1 : MASK_FRACTION;
    const rx = Math.max(1, ellipse.rx * shrink), ry = Math.max(1, ellipse.ry * shrink);
    const x0 = Math.max(0, Math.floor(ellipse.cx - rx)), x1 = Math.min(width - 1, Math.ceil(ellipse.cx + rx));
    const y0 = Math.max(0, Math.floor(ellipse.cy - ry)), y1 = Math.min(height - 1, Math.ceil(ellipse.cy + ry));
    let total = 0, warm = 0, anger = 0, sad = 0, calm = 0, pale = 0, paleSad = 0, pixels = 0;
    for (let y = y0; y <= y1; y++) {
      const dy = (y - ellipse.cy) / ry;
      for (let x = x0; x <= x1; x++) {
        const dx = (x - ellipse.cx) / rx;
        if (!ellipse.full && dx * dx + dy * dy > 1) continue;
        pixels++;
        const i = (y * width + x) * 4;
        const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
        if (!(s > .15 && v > .08)) continue;                   // only lit, tinted light counts
        const w = s * v;
        total += w;
        const isSad = h >= 90 && h < 125;
        if (h >= 12 && h < 40) warm += w;
        else if (h < 12 || h > 170) anger += w;
        if (isSad) sad += w;
        if (h >= 125 && h <= 170) calm += w;
        if (h >= 105 && h < 135 && s < .4 && v > .65) {        // pale violet/blue-white is Calm's own palette
          pale += w;
          if (isSad) paleSad += w;
        }
      }
    }
    const t = Math.max(total, 1e-9);
    return { warm: Math.max(0, warm) / t, calm: Math.max(0, calm + pale) / t, sad: Math.max(0, sad - paleSad) / t, anger: Math.max(0, anger) / t, pixels };
  }

  function meanScores(list) {
    const out = { warm: 0, calm: 0, sad: 0, anger: 0 };
    if (!list.length) return out;
    for (const s of list) for (const m of MOODS) out[m] += s[m] / list.length;
    return out;
  }

  // Calm's own palette sits right next to Sad's, so a reading with a real share of both is treated as a mixture.
  // The server uses .22 here. That sat on the edge of what the Calm sample measured (.22 to .26 depending on video
  // compression, against about .10 for the Sad sample), so this page asks a little earlier: a wrong question costs one click,
  // a silently wrong feeling costs the whole song.
  const CALM_SAD_MIXTURE = .16;

  const COLOUR_WORDS = { warm: 'gold or amber', calm: 'violet or pale blue', sad: 'blue', anger: 'red or orange' };

  // The ambiguity policy: never guess quietly. `mood` is null when the light does not clearly point to one feeling.
  function decide(scores) {
    const ranked = MOODS.slice().sort((a, b) => scores[b] - scores[a]);
    const [first, second] = ranked;
    let ambiguous = scores[first] < .35 || scores[first] - scores[second] < .12;
    // Calm and Sad both contain blue light, so a mixture of the two is never forced into Sad.
    ambiguous = ambiguous || ((first === 'calm' && second === 'sad') || (first === 'sad' && second === 'calm')) && scores[second] > CALM_SAD_MIXTURE;
    return {
      mood: ambiguous ? null : first, closest: first, ambiguous, ranked, scores,
      description: `The sphere's light is mostly ${COLOUR_WORDS[first]}.`,
      note: 'Relative shares of coloured light from a colour rule. They are not probabilities.',
    };
  }

  return { MOODS, MASK_FRACTION, CALM_SAD_MIXTURE, rgbToHsv, readPalette, meanScores, decide, COLOUR_WORDS };
});
