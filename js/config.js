import * as THREE from 'three';

// ---- Track geometry ----
export const PATH_W = 4.6;            // walkable width of the bridge
export const HALF_W = PATH_W / 2;
export const LANES = [-1.5, 0, 1.5];
export const X_LIMIT = 1.8;           // furthest the runner can drift from the centre line
export const TILE = 6;                // length of one bridge slab
export const SLAB_DEPTH = 1.4;
export const CURB_H = 0.45;
export const CURB_W = 0.5;

// Cardinal directions on the XZ plane: N, E, S, W (x, z). Right turn = +1.
export const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const dirYaw = (d) => -d * Math.PI / 2;

// ---- Runner physics ----
export const GRAVITY = 40;
export const JUMP_V = 12.6;
export const SLIDE_TIME = 0.75;
export const START_SPEED = 13;
export const MAX_SPEED = 29;
// VR (headset, first person) runs slower: fast forward motion feels much
// faster with your head in the scene. Jumps there reach the same height but
// hang longer, so they still carry you over gaps at the lower speed.
export const VR_START_SPEED = 3;
export const VR_MAX_SPEED = 5;
export const VR_GRAVITY = 28;
export const VR_JUMP_V = 10.5;
export const RUNNER_H = 1.8;
export const SLIDE_H = 0.85;

// ---- Look ----
export const SUN_DIR = new THREE.Vector3(-0.52, 0.17, -0.84).normalize();

const lin = (hex) => new THREE.Color(hex); // THREE.Color converts sRGB hex to linear working space
export const PALETTE = {
  zenith: lin('#21456f'),
  upper: lin('#5d86b1'),
  horizon: lin('#f3b582'),
  sunGlow: lin('#ffb15c'),
  belowHorizon: lin('#c99a80'),
  abyss: lin('#7e6a6c'),
  sunLight: lin('#ffd9ad'),
  hemiSky: lin('#a8c8f0'),
  hemiGround: lin('#6a4a34'),
};

// ---- Platform ----
const ua = navigator.userAgent || '';
export const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
export const IS_IOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const IS_MOBILE = IS_TOUCH && (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || IS_IOS);

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Angle wrap to (-PI, PI]
export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}
