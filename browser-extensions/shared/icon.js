// Toolbar icon rasterizer. Pure JS so the same code draws the PNGs at build time (Node)
// and re-colours the toolbar icon at runtime when the brand changes (action.setIcon).
//
// Glyphs are drawn on a 0..1 square as simple primitives over a rounded tile with a
// primary -> accent gradient.

const GLYPHS = {
  // Ticket Snap: camera
  camera: [
    { t: 'rrect', x: 0.2, y: 0.33, w: 0.6, h: 0.42, r: 0.07 },
    { t: 'rrect', x: 0.36, y: 0.25, w: 0.2, h: 0.12, r: 0.03 },
    { t: 'circle', x: 0.5, y: 0.54, r: 0.135, cut: true },
    { t: 'circle', x: 0.5, y: 0.54, r: 0.075 },
  ],
  // Data Leak Guard: shield
  shield: [
    { t: 'poly', pts: [[0.5, 0.18], [0.78, 0.29], [0.76, 0.52], [0.5, 0.84], [0.24, 0.52], [0.22, 0.29]] },
    { t: 'line', x1: 0.39, y1: 0.5, x2: 0.47, y2: 0.59, w: 0.07, cut: true },
    { t: 'line', x1: 0.47, y1: 0.59, x2: 0.63, y2: 0.4, w: 0.07, cut: true },
  ],
  // SaaS Usage Reporter: bar chart
  bars: [
    { t: 'rrect', x: 0.22, y: 0.5, w: 0.14, h: 0.28, r: 0.03 },
    { t: 'rrect', x: 0.43, y: 0.32, w: 0.14, h: 0.46, r: 0.03 },
    { t: 'rrect', x: 0.64, y: 0.2, w: 0.14, h: 0.58, r: 0.03 },
  ],
  // Environment Labeler: flag
  flag: [
    { t: 'line', x1: 0.3, y1: 0.2, x2: 0.3, y2: 0.82, w: 0.07 },
    { t: 'poly', pts: [[0.3, 0.2], [0.76, 0.2], [0.64, 0.36], [0.76, 0.52], [0.3, 0.52]] },
  ],
  // Go-Links: chain link
  link: [
    { t: 'rrect', x: 0.16, y: 0.36, w: 0.4, h: 0.28, r: 0.14 },
    { t: 'rrect', x: 0.24, y: 0.43, w: 0.24, h: 0.14, r: 0.07, cut: true },
    { t: 'rrect', x: 0.44, y: 0.36, w: 0.4, h: 0.28, r: 0.14 },
    { t: 'rrect', x: 0.52, y: 0.43, w: 0.24, h: 0.14, r: 0.07, cut: true },
    { t: 'rrect', x: 0.36, y: 0.47, w: 0.28, h: 0.06, r: 0.03 },
  ],
};

export const GLYPH_NAMES = Object.keys(GLYPHS);

function hex(c) {
  let h = String(c || '#4F46E5').replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function inRRect(px, py, s) {
  const { x, y, w, h } = s;
  const r = Math.min(s.r || 0, w / 2, h / 2);
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inLine(px, py, s) {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const t = Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / (dx * dx + dy * dy || 1)));
  const qx = s.x1 + t * dx - px;
  const qy = s.y1 + t * dy - py;
  return qx * qx + qy * qy <= (s.w / 2) ** 2;
}

function hit(px, py, s) {
  switch (s.t) {
    case 'rrect': return inRRect(px, py, s);
    case 'circle': return (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r * s.r;
    case 'poly': return inPoly(px, py, s.pts);
    case 'line': return inLine(px, py, s);
    default: return false;
  }
}

function glyphHit(px, py, shapes) {
  let on = false;
  for (const s of shapes) if (hit(px, py, s)) on = !s.cut;
  return on;
}

/**
 * Renders an icon to RGBA pixels.
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
export function renderIcon(glyph, size, primary, accent) {
  const shapes = GLYPHS[glyph] || GLYPHS.link;
  const p = hex(primary);
  const a = hex(accent || primary);
  const data = new Uint8ClampedArray(size * size * 4);
  const SS = 4; // supersampling per axis
  const tile = { x: 0.02, y: 0.02, w: 0.96, h: 0.96, r: 0.22 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tileCov = 0;
      let glyphCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          if (inRRect(px, py, tile)) {
            tileCov++;
            if (glyphHit(px, py, shapes)) glyphCov++;
          }
        }
      }
      const n = SS * SS;
      const t = (x + y) / (2 * size); // diagonal gradient
      const bg = [0, 1, 2].map((i) => p[i] + (a[i] - p[i]) * t);
      const g = glyphCov / Math.max(tileCov, 1);
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) data[o + i] = Math.round(bg[i] * (1 - g) + 255 * g);
      data[o + 3] = Math.round((tileCov / n) * 255);
    }
  }
  return { width: size, height: size, data };
}

/** Sets the toolbar icon in the brand colours (runtime). */
export async function setActionIcon(api, glyph, brand) {
  if (typeof ImageData === 'undefined') return;
  const imageData = {};
  for (const size of [16, 32, 48]) {
    const { data, width, height } = renderIcon(glyph, size, brand.primary, brand.accent);
    imageData[size] = new ImageData(data, width, height);
  }
  try {
    await api.action.setIcon({ imageData });
  } catch {
    // Older Firefox builds reject some sizes. The static icons still apply.
  }
}
