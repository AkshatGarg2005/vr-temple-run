// Procedural textures: everything is painted on canvases at load time, so the
// game ships with zero image assets. Each surface gets a colour map plus a
// normal map derived from a painted height field.
import * as THREE from 'three';
import { rng, clamp } from './config.js';

let ANISO = 4;
export function setAnisotropy(a) { ANISO = a; }

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Tileable value noise with a fixed integer period.
function makeNoise(seed, period) {
  const r = rng(seed);
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = r();
  const g = (i, j) => grid[(((j % period) + period) % period) * period + (((i % period) + period) % period)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function fbm(n, x, y, oct = 4) {
  let s = 0, a = 0.5, f = 1, t = 0;
  for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); t += a; a *= 0.5; f *= 2; }
  return s / t;
}

function boxBlur(src, w, h, r, wrap) {
  const tmp = new Float32Array(src.length);
  const idx = (x, y) => {
    if (wrap) { x = (x + w) % w; y = (y + h) % h; }
    else { x = x < 0 ? 0 : x >= w ? w - 1 : x; y = y < 0 ? 0 : y >= h ? h - 1 : y; }
    return y * w + x;
  };
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[idx(k, y)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      acc += src[idx(x + r + 1, y)] - src[idx(x - r, y)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[idx(x, k)];
    for (let y = 0; y < h; y++) {
      src[y * w + x] = acc / n;
      acc += tmp[idx(x, y + r + 1)] - tmp[idx(x, y - r)];
    }
  }
}

function readGray(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const out = new Float32Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
  return out;
}

function normalFromHeight(hgt, w, h, strength, wrap) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const at = (x, y) => {
    if (wrap) { x = (x + w) % w; y = (y + h) % h; }
    else { x = x < 0 ? 0 : x >= w ? w - 1 : x; y = y < 0 ? 0 : y >= h ? h - 1 : y; }
    return hgt[y * w + x];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      d[i] = (-dx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function toTexture(c, srgb, wrap = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = ANISO;
  t.needsUpdate = true;
  return t;
}

function poly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

// Rectangle with chipped, jittered corners — reads as a hand-cut stone.
function stonePoly(x, y, w, h, r, chip = 7) {
  const j = () => (r() - 0.5) * chip;
  const c = chip * (0.6 + r() * 0.8);
  return [
    [x + c + j(), y + j()], [x + w - c + j(), y + j()],
    [x + w + j(), y + c + j()], [x + w + j(), y + h - c + j()],
    [x + w - c + j(), y + h + j()], [x + c + j(), y + h + j()],
    [x + j(), y + h - c + j()], [x + j(), y + c + j()],
  ];
}
function scalePoly(pts, s) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  return pts.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s]);
}

function crack(ctxs, r, x, y, len, w) {
  let a = r() * Math.PI * 2;
  const pts = [[x, y]];
  for (let i = 0; i < 6; i++) {
    a += (r() - 0.5) * 1.2;
    x += Math.cos(a) * len / 6; y += Math.sin(a) * len / 6;
    pts.push([x, y]);
  }
  for (const [ctx, style] of ctxs) {
    ctx.strokeStyle = style; ctx.lineWidth = w; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  }
}

// Shared per-pixel finishing: grain, mottling, moss in the low spots.
function finishStone(colorCanvas, hgt, w, h, seed, opts = {}) {
  const { moss = 0.5, grain = 0.18, wrap = true, period = 8 } = opts;
  const ctx = colorCanvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n1 = makeNoise(seed, period), n2 = makeNoise(seed + 7, period * 4);
  const mossR = 0.27, mossG = 0.36, mossB = 0.14;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = x / w * period, v = y / h * period;
      const big = fbm(n1, u, v, 4);
      const fine = n2(u * 4, v * 4);
      hgt[i] = clamp(hgt[i] + (fine - 0.5) * grain * 0.6 + (big - 0.5) * 0.08, 0, 1);
      let shade = 0.78 + big * 0.38 + (fine - 0.5) * grain;
      const low = clamp((0.42 - hgt[i]) * 3.2, 0, 1);
      shade *= 1 - low * 0.45;
      let m = clamp((big - 0.52) * 4.5, 0, 1) * moss + low * moss * 0.9 * clamp(big * 1.6 - 0.3, 0, 1);
      m = clamp(m, 0, 0.85);
      const k = i * 4;
      const r0 = d[k] / 255 * shade, g0 = d[k + 1] / 255 * shade, b0 = d[k + 2] / 255 * shade;
      const ms = 0.75 + fine * 0.5;
      d[k] = clamp(r0 + (mossR * ms - r0) * m, 0, 1) * 255;
      d[k + 1] = clamp(g0 + (mossG * ms - g0) * m, 0, 1) * 255;
      d[k + 2] = clamp(b0 + (mossB * ms - b0) * m, 0, 1) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  void wrap;
}

// ---------------------------------------------------------------------------
// Bridge path: flagstones laid in courses, 4.6 m x 6 m per slab.
export function pathTextures(seed = 11) {
  const W = 512, H = 668;
  const r = rng(seed);
  const col = canvas(W, H), hc = canvas(W, H);
  const cx = col.getContext('2d'), hx = hc.getContext('2d');
  cx.fillStyle = '#3a3128'; cx.fillRect(0, 0, W, H);
  hx.fillStyle = '#1e1e1e'; hx.fillRect(0, 0, W, H);

  let y = 0;
  while (y < H - 4) {
    let rh = 92 + r() * 52;
    if (H - (y + rh) < 70) rh = H - y;
    let x = 0;
    while (x < W - 4) {
      let sw = 100 + r() * 120;
      if (W - (x + sw) < 70) sw = W - x;
      const p = stonePoly(x + 4, y + 4, sw - 8, rh - 8, r, 9);
      const hue = 28 + r() * 12, sat = 10 + r() * 14, lit = 40 + r() * 16;
      cx.fillStyle = `hsl(${hue},${sat}%,${lit}%)`; poly(cx, p); cx.fill();
      // Light worn top, darker edges
      cx.fillStyle = `hsla(${hue},${sat}%,${lit + 8}%,0.5)`; poly(cx, scalePoly(p, 0.7)); cx.fill();
      const base = 150 + r() * 45;
      hx.fillStyle = `rgb(${base},${base},${base})`; poly(hx, p); hx.fill();
      hx.fillStyle = `rgb(${base + 25},${base + 25},${base + 25})`; poly(hx, scalePoly(p, 0.9)); hx.fill();
      hx.fillStyle = `rgb(${base + 40},${base + 40},${base + 40})`; poly(hx, scalePoly(p, 0.78)); hx.fill();
      if (r() < 0.35) crack([[cx, 'rgba(25,18,12,0.85)'], [hx, '#2a2a2a']], r, x + sw * (0.3 + r() * 0.4), y + rh * (0.3 + r() * 0.4), 40 + r() * 70, 2);
      x += sw;
    }
    y += rh;
  }
  const hgt = readGray(hc);
  boxBlur(hgt, W, H, 2, false);
  finishStone(col, hgt, W, H, seed + 3, { moss: 0.55, period: 6 });
  return {
    map: toTexture(col, true),
    normalMap: toTexture(normalFromHeight(hgt, W, H, 5.5, false), false),
  };
}

// Ashlar masonry for walls, curbs, pillars — tiles in both directions.
export function wallTextures(seed = 23) {
  const W = 512, H = 512;
  const r = rng(seed);
  const col = canvas(W, H), hc = canvas(W, H);
  const cx = col.getContext('2d'), hx = hc.getContext('2d');
  cx.fillStyle = '#2e2620'; cx.fillRect(0, 0, W, H);
  hx.fillStyle = '#1a1a1a'; hx.fillRect(0, 0, W, H);
  const rows = 8, rh = H / rows;
  for (let row = 0; row < rows; row++) {
    let x = -r() * 80;
    const startX = x;
    while (x < W + startX) {
      let sw = 90 + r() * 110;
      if (W + startX - (x + sw) < 60) sw = W + startX - x;
      const hue = 26 + r() * 10, sat = 8 + r() * 10, lit = 34 + r() * 16;
      const base = 145 + r() * 50;
      for (const off of [0, W, -W]) {
        const p = stonePoly(x + 3 + off, row * rh + 3, sw - 6, rh - 6, r, 6);
        cx.fillStyle = `hsl(${hue},${sat}%,${lit}%)`; poly(cx, p); cx.fill();
        hx.fillStyle = `rgb(${base},${base},${base})`; poly(hx, p); hx.fill();
        hx.fillStyle = `rgb(${base + 30},${base + 30},${base + 30})`; poly(hx, scalePoly(p, 0.86)); hx.fill();
      }
      x += sw;
    }
  }
  const hgt = readGray(hc);
  boxBlur(hgt, W, H, 2, true);
  finishStone(col, hgt, W, H, seed + 5, { moss: 0.7, period: 8 });
  return {
    map: toTexture(col, true),
    normalMap: toTexture(normalFromHeight(hgt, W, H, 5, true), false),
  };
}

// Turn plaza: a carved sun disc with gold inlay.
export function junctionTextures(seed = 37) {
  const S = 512, c0 = S / 2;
  const r = rng(seed);
  const col = canvas(S, S), hc = canvas(S, S), orm = canvas(S, S), em = canvas(S, S);
  const cx = col.getContext('2d'), hx = hc.getContext('2d'), ox = orm.getContext('2d'), ex = em.getContext('2d');
  cx.fillStyle = '#3a3128'; cx.fillRect(0, 0, S, S);
  hx.fillStyle = '#202020'; hx.fillRect(0, 0, S, S);
  ox.fillStyle = 'rgb(255,225,0)'; ox.fillRect(0, 0, S, S); // G = roughness, B = metalness
  ex.fillStyle = '#000'; ex.fillRect(0, 0, S, S);

  // border stones
  const bw = 46;
  for (let side = 0; side < 4; side++) {
    let t = 0;
    while (t < S - 2) {
      let len = 90 + r() * 70;
      if (S - (t + len) < 50) len = S - t;
      const lit = 38 + r() * 14, base = 160 + r() * 40;
      let p;
      if (side === 0) p = stonePoly(t + 3, 3, len - 6, bw - 6, r);
      else if (side === 1) p = stonePoly(t + 3, S - bw + 3, len - 6, bw - 6, r);
      else if (side === 2) p = stonePoly(3, t + 3, bw - 6, len - 6, r);
      else p = stonePoly(S - bw + 3, t + 3, bw - 6, len - 6, r);
      cx.fillStyle = `hsl(32,14%,${lit}%)`; poly(cx, p); cx.fill();
      hx.fillStyle = `rgb(${base},${base},${base})`; poly(hx, p); hx.fill();
      t += len;
    }
  }
  // inner field
  const R1 = 205, R2 = 150, R3 = 62;
  cx.fillStyle = 'hsl(30,12%,36%)'; cx.fillRect(bw, bw, S - 2 * bw, S - 2 * bw);
  hx.fillStyle = '#9a9a9a'; hx.fillRect(bw + 3, bw + 3, S - 2 * bw - 6, S - 2 * bw - 6);
  // ring of wedge stones
  const wedges = 20;
  for (let i = 0; i < wedges; i++) {
    const a0 = (i / wedges) * Math.PI * 2 + 0.012, a1 = ((i + 1) / wedges) * Math.PI * 2 - 0.012;
    const pts = [];
    for (let k = 0; k <= 6; k++) { const a = a0 + (a1 - a0) * k / 6; pts.push([c0 + Math.cos(a) * (R1 - 3), c0 + Math.sin(a) * (R1 - 3)]); }
    for (let k = 6; k >= 0; k--) { const a = a0 + (a1 - a0) * k / 6; pts.push([c0 + Math.cos(a) * (R2 + 3), c0 + Math.sin(a) * (R2 + 3)]); }
    const lit = 40 + r() * 14, base = 175 + r() * 35;
    cx.fillStyle = `hsl(30,15%,${lit}%)`; poly(cx, pts); cx.fill();
    hx.fillStyle = `rgb(${base},${base},${base})`; poly(hx, pts); hx.fill();
    // engraved glyph dots
    const am = (a0 + a1) / 2, rm = (R1 + R2) / 2;
    hx.fillStyle = '#5a5a5a';
    hx.beginPath(); hx.arc(c0 + Math.cos(am) * rm, c0 + Math.sin(am) * rm, 7, 0, Math.PI * 2); hx.fill();
    cx.fillStyle = 'rgba(30,20,12,0.6)';
    cx.beginPath(); cx.arc(c0 + Math.cos(am) * rm, c0 + Math.sin(am) * rm, 7, 0, Math.PI * 2); cx.fill();
  }
  // inner disc
  cx.fillStyle = 'hsl(33,16%,44%)';
  cx.beginPath(); cx.arc(c0, c0, R2 - 4, 0, Math.PI * 2); cx.fill();
  hx.fillStyle = '#c8c8c8';
  hx.beginPath(); hx.arc(c0, c0, R2 - 4, 0, Math.PI * 2); hx.fill();
  // sun rays: engraved grooves inlaid with gold
  const rays = 12;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const tip = R2 - 16, baseR = R3 + 10, half = 0.13;
    const pts = [
      [c0 + Math.cos(a) * tip, c0 + Math.sin(a) * tip],
      [c0 + Math.cos(a + half) * baseR, c0 + Math.sin(a + half) * baseR],
      [c0 + Math.cos(a - half) * baseR, c0 + Math.sin(a - half) * baseR],
    ];
    for (const [ctx, style] of [[cx, '#c9952e'], [hx, '#6e6e6e'], [ox, 'rgb(255,70,255)'], [ex, '#3a2006']]) {
      ctx.fillStyle = style; poly(ctx, pts); ctx.fill();
    }
  }
  for (const [ctx, style] of [[cx, '#d8a53a'], [hx, '#e6e6e6'], [ox, 'rgb(255,60,255)'], [ex, '#4a2a08']]) {
    ctx.fillStyle = style; ctx.beginPath(); ctx.arc(c0, c0, R3, 0, Math.PI * 2); ctx.fill();
  }
  for (const [ctx, style, lw] of [[cx, '#7a5414', 5], [hx, '#808080', 5], [ox, 'rgb(255,90,255)', 5]]) {
    ctx.strokeStyle = style; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(c0, c0, R3 - 14, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(c0, c0, R2 - 4, 0, Math.PI * 2); ctx.stroke();
  }
  const hgt = readGray(hc);
  boxBlur(hgt, S, S, 2, false);
  finishStone(col, hgt, S, S, seed + 9, { moss: 0.35, period: 6 });
  return {
    map: toTexture(col, true, false),
    normalMap: toTexture(normalFromHeight(hgt, S, S, 5, false), false, false),
    ormMap: toTexture(orm, false, false),
    emissiveMap: toTexture(em, true, false),
  };
}

// Junction wall relief: a guardian mask with glowing eyes.
export function reliefTextures(seed = 51) {
  const W = 512, H = 512;
  const r = rng(seed);
  const col = canvas(W, H), hc = canvas(W, H), em = canvas(W, H);
  const cx = col.getContext('2d'), hx = hc.getContext('2d'), ex = em.getContext('2d');
  cx.fillStyle = 'hsl(30,12%,36%)'; cx.fillRect(0, 0, W, H);
  hx.fillStyle = '#707070'; hx.fillRect(0, 0, W, H);
  ex.fillStyle = '#000'; ex.fillRect(0, 0, W, H);

  const both = (fn, colStyle, hStyle) => {
    cx.fillStyle = colStyle; hx.fillStyle = hStyle;
    fn(cx); cx.fill(); fn(hx); hx.fill();
  };
  // frame
  both((c) => { c.beginPath(); c.rect(18, 18, W - 36, H - 36); }, 'hsl(30,14%,40%)', '#a8a8a8');
  both((c) => { c.beginPath(); c.rect(44, 44, W - 88, H - 88); }, 'hsl(28,12%,30%)', '#5a5a5a');
  // step-fret border
  for (let i = 0; i < 14; i++) {
    const x = 50 + i * 30;
    both((c) => { c.beginPath(); c.rect(x, 22, 16, 16); c.rect(x + 8, 30, 16, 8); }, 'hsl(30,10%,26%)', '#606060');
    both((c) => { c.beginPath(); c.rect(x, H - 38, 16, 16); }, 'hsl(30,10%,26%)', '#606060');
  }
  // headdress rays
  for (let i = 0; i < 9; i++) {
    const a = Math.PI + (i + 0.5) / 9 * Math.PI;
    const x0 = W / 2 + Math.cos(a) * 120, y0 = 205 + Math.sin(a) * 120;
    const x1 = W / 2 + Math.cos(a) * 205, y1 = 205 + Math.sin(a) * 205;
    both((c) => {
      c.beginPath(); c.moveTo(x0 + Math.sin(a) * 18, y0 - Math.cos(a) * 18);
      c.lineTo(x1, y1); c.lineTo(x0 - Math.sin(a) * 18, y0 + Math.cos(a) * 18); c.closePath();
    }, 'hsl(32,16%,46%)', '#d0d0d0');
  }
  // face block
  both((c) => { c.beginPath(); c.roundRect(W / 2 - 125, 140, 250, 300, 40); }, 'hsl(31,15%,44%)', '#c4c4c4');
  // brow
  both((c) => { c.beginPath(); c.rect(W / 2 - 115, 200, 230, 30); }, 'hsl(31,15%,50%)', '#efefef');
  // eye sockets
  for (const s of [-1, 1]) {
    both((c) => { c.beginPath(); c.ellipse(W / 2 + s * 58, 262, 42, 24, 0, 0, Math.PI * 2); }, 'hsl(25,20%,14%)', '#404040');
    cx.fillStyle = '#ffb347'; ex.fillStyle = '#ff9a2e';
    for (const c of [cx, ex]) { c.beginPath(); c.ellipse(W / 2 + s * 58, 262, 22, 10, 0, 0, Math.PI * 2); c.fill(); }
    hx.fillStyle = '#9a9a9a'; hx.beginPath(); hx.ellipse(W / 2 + s * 58, 262, 22, 10, 0, 0, Math.PI * 2); hx.fill();
    // ear spools
    both((c) => { c.beginPath(); c.arc(W / 2 + s * 150, 300, 30, 0, Math.PI * 2); }, 'hsl(32,16%,46%)', '#d8d8d8');
    both((c) => { c.beginPath(); c.arc(W / 2 + s * 150, 300, 13, 0, Math.PI * 2); }, 'hsl(25,18%,20%)', '#505050');
  }
  // nose
  both((c) => { c.beginPath(); c.moveTo(W / 2, 250); c.lineTo(W / 2 + 30, 340); c.lineTo(W / 2 - 30, 340); c.closePath(); }, 'hsl(31,15%,52%)', '#f4f4f4');
  // mouth with teeth
  both((c) => { c.beginPath(); c.roundRect(W / 2 - 80, 362, 160, 52, 14); }, 'hsl(20,25%,12%)', '#3a3a3a');
  for (let i = 0; i < 6; i++) {
    both((c) => { c.beginPath(); c.rect(W / 2 - 72 + i * 25, 366, 18, 20); }, 'hsl(35,20%,60%)', '#cfcfcf');
  }
  ex.fillStyle = '#5a1e04'; ex.beginPath(); ex.roundRect(W / 2 - 74, 390, 148, 20, 8); ex.fill();
  // weathering cracks
  for (let i = 0; i < 6; i++) crack([[cx, 'rgba(20,14,10,0.8)'], [hx, '#303030']], r, 60 + r() * 390, 60 + r() * 390, 60 + r() * 90, 2.5);

  const hgt = readGray(hc);
  boxBlur(hgt, W, H, 3, false);
  finishStone(col, hgt, W, H, seed + 2, { moss: 0.5, period: 6 });
  return {
    map: toTexture(col, true, false),
    normalMap: toTexture(normalFromHeight(hgt, W, H, 4, false), false, false),
    emissiveMap: toTexture(em, true, false),
  };
}

export function barkTextures(seed = 61) {
  const W = 256, H = 512;
  const col = canvas(W, H);
  const ctx = col.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const hgt = new Float32Array(W * H);
  const n = makeNoise(seed, 16);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W * 16, v = y / H * 4;
      const warp = fbm(n, u * 0.5, v * 2, 3) * 3;
      const ridges = Math.abs(Math.sin((u + warp) * Math.PI * 0.9));
      const fine = n(u * 4, v * 16);
      const h = clamp(ridges * 0.75 + fine * 0.25, 0, 1);
      hgt[y * W + x] = h;
      const k = (y * W + x) * 4;
      const s = 0.45 + h * 0.6;
      d[k] = 92 * s; d[k + 1] = 66 * s; d[k + 2] = 46 * s; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    map: toTexture(col, true),
    normalMap: toTexture(normalFromHeight(hgt, W, H, 3, true), false),
  };
}

export function flameTexture() {
  const W = 64, H = 128;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const t = 1 - y / H; // 0 bottom, 1 top
    const radius = 0.42 * Math.pow(1 - t, 0.75) * Math.min(1, t * 6 + 0.25);
    for (let x = 0; x < W; x++) {
      const dx = Math.abs(x / W - 0.5);
      let a = clamp(1 - dx / Math.max(radius, 1e-3), 0, 1);
      a = Math.pow(a, 1.4) * Math.pow(1 - t, 0.35);
      const hot = Math.pow(a, 2.2);
      const k = (y * W + x) * 4;
      d[k] = 255;
      d[k + 1] = clamp(110 + hot * 160, 0, 255);
      d[k + 2] = clamp(30 + hot * 170, 0, 255);
      d[k + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function glowTexture() {
  const S = 64;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Tileable fbm, used to animate the cloud sea below the bridges.
export function cloudNoiseTexture(seed = 77) {
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const n = makeNoise(seed, 8);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S * 8, v = y / S * 8;
      const f = fbm(n, u, v, 5);
      const k = (y * S + x) * 4;
      const val = clamp((f - 0.3) * 1.9, 0, 1) * 255;
      d[k] = d[k + 1] = d[k + 2] = val; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
