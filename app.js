// Relic Run — bootstrap: renderer, UI wiring, VR session handling, main loop.
import * as THREE from 'three';
import { Game } from './js/game.js';
import { Input } from './js/input.js';
import { Sound } from './js/audio.js';
import { View } from './js/render.js';
import { IS_TOUCH, IS_MOBILE, clamp } from './js/config.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('relicrun.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('relicrun.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const settings = Object.assign({ tilt: IS_TOUCH, sound: true, firstPerson: false, motion: 'normal', hints: true }, store.get('settings', {}));
delete settings.high; // graphics always run at maximum quality
const MOTION_LEVELS = ['normal', 'high', 'low'];
const MOTION_LABEL = { normal: 'Normal', high: 'High', low: 'Low' };

// ---------------------------------------------------------------------------
// Renderer
const canvas = $('game');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
} catch (err) {
  $('loading').querySelector('.loading-text').textContent = 'WebGL is not available in this browser.';
  throw err;
}
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');

// Multisampled anti-aliasing costs more than the rest of the frame put
// together at Retina / phone pixel density, where the pixels are already too
// small to show jagged edges. Only lower-density screens use it.
const msaaSamples = () => ((window.devicePixelRatio || 1) >= 1.5 ? 0 : 4);
const quality = {
  // Starts at the top graphics tier and steps down on its own if frames are missed.
  maxDpr: () => 2 * (game && game.mode === 'cardboard' ? 0.85 : 1),
  minDpr: 0.6,
  dpr: 1,
  samples: msaaSamples(),
  ceiling: 2,       // highest pixel ratio allowed; lowered when one proves too slow
};
quality.dpr = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(quality.dpr);
renderer.setSize(innerWidth, innerHeight);

const input = new Input();
const sound = new Sound();
sound.enabled = settings.sound;

// ---------------------------------------------------------------------------
// UI helpers
const hud = $('hud');
const ui = {
  lastStats: '',
  onState(state) {
    hud.hidden = !(state === 'run' || state === 'countdown' || state === 'dying' || state === 'calibrate');
  },
  stats({ score, coins, dist, mult, magnet }) {
    const key = `${score}|${coins}|${dist}|${mult}|${magnet > 0}`;
    if (key !== this.lastStats) {
      this.lastStats = key;
      $('hud-score').textContent = score.toLocaleString();
      $('hud-coins').textContent = coins;
      $('hud-dist').textContent = dist.toLocaleString();
      $('hud-mult').textContent = `x${mult}`;
    }
    $('hud-power').hidden = !(magnet > 0);
    if (magnet > 0) $('hud-power-fill').style.transform = `scaleX(${magnet.toFixed(3)})`;
  },
  hint(action, stage) {
    const el = $('hint');
    if (!action) { el.hidden = true; return; }
    el.hidden = false;
    el.dataset.action = action;
    el.dataset.stage = String(stage);
    const word = action === 'jump' ? 'Jump' : 'Slide';
    $('hint-text').textContent = stage === 2 ? `${word}!` : word;
  },
  toast(text) {
    if (game.isVR()) {
      game.vrHud.message([{ text: text.toUpperCase(), size: 64, color: '#ffd88a', display: true }]);
      clearTimeout(this.vrToastT);
      this.vrToastT = setTimeout(() => { if (game.state === 'run') game.vrHud.message(null); }, 1200);
      return;
    }
    const t = $('toast');
    t.hidden = false;
    t.textContent = text;
    t.style.animation = 'none';
    void t.offsetWidth;
    t.style.animation = '';
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => { t.hidden = true; }, 1200);
  },
  pause() { pauseGame(); },
  gameOver(stats) {
    const best = store.get('best', 0);
    const isBest = stats.score > best;
    if (isBest) store.set('best', stats.score);
    refreshBest();
    $('go-reason').textContent = stats.reason;
    $('go-score').textContent = stats.score.toLocaleString();
    $('go-dist').textContent = `${stats.dist.toLocaleString()} m`;
    $('go-coins').textContent = stats.coins;
    $('go-best').hidden = !isBest;
    // In phone VR the result shows inside the headset (tap restarts); the small
    // on-screen button stays so the player can still reach the menu.
    hud.hidden = !game.isVR();
    if (game.isVR()) return;
    setTimeout(() => { if (game.state === 'over') $('gameover').hidden = false; }, 250);
  },
  restart() { startRun(game.mode); },
  onSettings() { syncToggles(); store.set('settings', settings); },
};

function refreshBest() {
  const best = store.get('best', 0);
  $('best-line').hidden = !best;
  $('best-score').textContent = best.toLocaleString();
}

// ---------------------------------------------------------------------------
// Game
let game = null;
let view = null;

function applyQuality() {
  quality.ceiling = quality.maxDpr();
  // phone VR starts a little lower and climbs back if the phone keeps up
  const start = game.mode === 'cardboard' ? 1.5 : quality.ceiling;
  quality.dpr = Math.min(window.devicePixelRatio || 1, start);
  quality.samples = msaaSamples();
  perf.t = 0; perf.dts.length = 0; perf.cooldown = 3; perf.calm = 0;
  view.setRays(true);
  view.setBloom(true);
  renderer.setPixelRatio(quality.dpr);
  renderer.setSize(innerWidth, innerHeight);
  view.setup(true, quality.samples);
  onResize();
}

function onResize() {
  const w = innerWidth, h = innerHeight;
  game.camera.aspect = w / h;
  game.camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  view.resize();
  game.setParticleScale(h * quality.dpr);
  checkRotate();
}

let rotatePaused = false;
function checkRotate() {
  const needLandscape = game.mode === 'cardboard' && innerHeight > innerWidth;
  $('rotate').hidden = !needLandscape;
  if (needLandscape && (game.state === 'run' || game.state === 'countdown' || game.state === 'calibrate')) {
    rotatePaused = true;
    game.prevState = game.state;
    game.state = 'paused';
  } else if (!needLandscape && rotatePaused) {
    rotatePaused = false;
    if (game.state === 'paused') { game.state = game.prevState; game.calibrate(); }
  }
}

function pauseGame() {
  if (game.state === 'over') { $('gameover').hidden = false; return; }
  if (!(game.state === 'run' || game.state === 'countdown' || game.state === 'calibrate')) return;
  game.prevState = game.state;
  game.state = 'paused';
  $('pause').hidden = false;
  $('btn-recenter').hidden = game.mode !== 'cardboard';
}
function resumeGame() {
  $('pause').hidden = true;
  if (game.state === 'paused') {
    game.state = game.prevState || 'run';
    input.drain();
    lastTs = performance.now();
  }
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release(); wakeLock = null;
    }
  } catch { wakeLock = null; }
}

function startRun(mode, calibrate = false) {
  $('menu').hidden = true;
  $('gameover').hidden = true;
  $('pause').hidden = true;
  document.body.classList.toggle('vr', mode !== 'flat');
  view.setStereo(mode === 'cardboard');
  game.start(mode, { calibrate });
  hud.hidden = false;
  ui.lastStats = '';
  ui.stats({ score: 0, coins: 0, dist: 0, mult: 1, magnet: 0 });
  keepAwake(true);
  checkRotate();
}

async function enterFullscreen(landscape) {
  if (!IS_TOUCH) return;
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
    if (landscape && screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch { /* not supported (e.g. iPhone) */ }
}

function backToMenu() {
  const session = renderer.xr.getSession();
  if (session) session.end().catch(() => {});
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
  rotatePaused = false;
  $('rotate').hidden = true;
  $('pause').hidden = true;
  $('gameover').hidden = true;
  hud.hidden = true;
  document.body.classList.remove('vr');
  view.setStereo(false);
  game.toMenu();
  $('menu').hidden = false;
  refreshBest();
  keepAwake(false);
  applyQuality();
}

// ---------------------------------------------------------------------------
// Menu wiring
function bindToggle(id, key, after) {
  const el = $(id);
  el.addEventListener('click', () => {
    settings[key] = !settings[key];
    syncToggles();
    store.set('settings', settings);
    after?.();
  });
}
function syncToggles() {
  $('tg-tilt').setAttribute('aria-pressed', String(!!settings.tilt));
  $('tg-sound').setAttribute('aria-pressed', String(!!settings.sound));
  $('tg-cam').setAttribute('aria-pressed', String(!!settings.firstPerson));
  $('tg-hints').setAttribute('aria-pressed', String(!!settings.hints));
  $('tg-motion-val').textContent = MOTION_LABEL[settings.motion] || 'Normal';
}

function wireUI() {
  syncToggles();
  refreshBest();
  if (!IS_TOUCH) $('tg-tilt').hidden = true;
  if (IS_TOUCH && !window.isSecureContext) $('secure-warning').hidden = false;

  bindToggle('tg-tilt', 'tilt', () => { if (settings.tilt) input.requestMotion(); });
  bindToggle('tg-sound', 'sound', () => { sound.init(); sound.setEnabled(settings.sound); });
  bindToggle('tg-cam', 'firstPerson');
  bindToggle('tg-hints', 'hints', () => { if (!settings.hints) game.clearHint(); });
  $('tg-motion').addEventListener('click', () => {
    settings.motion = MOTION_LEVELS[(MOTION_LEVELS.indexOf(settings.motion) + 1) % MOTION_LEVELS.length];
    input.body.setSensitivity(settings.motion);
    syncToggles();
    store.set('settings', settings);
  });

  $('btn-play').addEventListener('click', () => {
    sound.init();
    if (IS_TOUCH && settings.tilt) input.requestMotion();
    enterFullscreen(false);
    startRun('flat');
  });
  $('btn-cardboard').addEventListener('click', () => {
    sound.init();
    input.requestMotion().then((ok) => {
      if (!ok && IS_TOUCH) ui.toast('Motion sensors blocked');
    });
    enterFullscreen(true).then(() => onResize());
    startRun('cardboard', true);
    applyQuality();
  });
  $('btn-webxr').addEventListener('click', async () => {
    sound.init();
    try {
      const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
      await renderer.xr.setSession(session);
      session.addEventListener('end', () => { if (game.mode === 'xr') backToMenu(); });
      startRun('xr');
    } catch (err) {
      console.warn('WebXR session failed', err);
      ui.toast('Could not start VR');
    }
  });
  if (navigator.xr && navigator.xr.isSessionSupported) {
    navigator.xr.isSessionSupported('immersive-vr').then((ok) => { $('btn-webxr').hidden = !ok; }).catch(() => {});
  }

  $('btn-pause').addEventListener('click', () => pauseGame());
  $('btn-recenter-vr').addEventListener('click', () => game.recenter());
  $('btn-resume').addEventListener('click', () => { resumeGame(); if (game.isVR()) game.calibrate(); });
  $('btn-recenter').addEventListener('click', () => { resumeGame(); game.recenter(); });
  $('btn-quit').addEventListener('click', () => backToMenu());
  $('btn-again').addEventListener('click', () => startRun(game.mode));
  $('btn-menu').addEventListener('click', () => backToMenu());
  $('btn-exit-vr').addEventListener('click', () => backToMenu());

  window.addEventListener('resize', () => onResize());
  screen.orientation?.addEventListener?.('change', () => setTimeout(onResize, 120));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseGame();
    else if (game.state === 'run' || game.state === 'paused') keepAwake(true);
  });
}

// ---------------------------------------------------------------------------
// Main loop with automatic quality
let lastTs = performance.now();
let clock = 0;

// Aim for every frame on time, at the display's refresh rate or 60 fps,
// whichever is slower. As soon as frames are being missed (or the game runs
// under ~50 fps), step down: anti-aliasing first, then resolution (sized to
// how far behind it is), then sun shafts. In phone VR the lenses magnify the
// screen, so resolution only goes below 1.25 after bloom has been turned off. Step back up only after a long
// smooth stretch and never near a resolution that already proved too slow,
// so quality doesn't bounce (each change briefly freezes the game while its
// buffers are rebuilt).
const perf = { t: 0, dts: [], cooldown: 3, calm: 0 };

function setDpr(v) {
  quality.dpr = v;
  renderer.setPixelRatio(v);
  onResize();
}

function stepDown(load) {
  const floor = game.mode === 'cardboard' && view.bloomEnabled ? 1.25 : quality.minDpr;
  if (quality.samples > 0) {
    quality.samples = 0;
    view.setup(true, 0);
  } else if (quality.dpr > floor + 0.01) {
    // GPU time grows with the pixel count (pixel ratio squared)
    const fit = quality.dpr * Math.sqrt(1 / load) * 0.92;
    quality.ceiling = quality.dpr - 0.1;
    setDpr(Math.max(floor, clamp(fit, quality.dpr - 0.5, quality.dpr - 0.1)));
  } else if (game.mode === 'cardboard' && view.bloomEnabled) {
    view.setBloom(false);
  } else if (view.raysEnabled && game.mode === 'flat') {
    view.setRays(false);
  }
}

function stepUp() {
  const top = Math.min(window.devicePixelRatio || 1, quality.maxDpr(), quality.ceiling);
  if (quality.dpr <= top - 0.1) setDpr(Math.min(top, quality.dpr + 0.15));
}

function adaptQuality(interval) {
  perf.t += interval;
  perf.cooldown -= interval;
  perf.dts.push(interval);
  if (perf.t < 2) return;
  const dts = perf.dts.sort((a, b) => a - b);
  perf.t = 0;
  perf.dts = [];
  if (perf.cooldown > 0 || dts.length < 20) return;
  const fast = dts[Math.floor(dts.length * 0.1)];        // frame interval when keeping up
  const budget = Math.max(fast, 1 / 60);
  const missed = dts.filter((d) => d > budget * 1.5).length / dts.length;
  const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
  if (missed > 0.08 || fast > 1 / 50) {
    stepDown(Math.max(1.05, mean / budget));
    perf.cooldown = 3;
    perf.calm = 0;
  } else if (missed < 0.01 && (perf.calm += 2) >= 30) {
    stepUp();
    perf.cooldown = 3;
    perf.calm = 0;
  }
}

function frame(ts) {
  const now = ts || performance.now();
  const interval = (now - lastTs) / 1000;
  const dt = clamp(interval, 0, 0.05);
  lastTs = now;
  clock += dt;
  game.update(dt, clock);
  view.render(clock, game.flash, game.speedFx());

  // also adapt during calibration and the countdown, so any brief freezes
  // from changing quality happen before the run starts
  const s = game.state;
  const measure = s === 'run' || s === 'menu' || s === 'countdown' || s === 'calibrate';
  if (!renderer.xr.isPresenting && measure && interval > 0 && interval < 0.5) {
    adaptQuality(interval);
  }
}

async function boot() {
  try {
    await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]);
  } catch { /* fonts optional */ }
  try { sound.prepare(); } catch { /* audio unavailable: init() retries on the first tap */ }
  game = new Game({ renderer, input, sound, ui, settings, mobile: IS_MOBILE });
  view = new View(renderer, game.scene, game.camera);
  view.setup(true, quality.samples);
  wireUI();
  onResize();
  // warm up shaders before revealing the scene
  view.render(0, game.flash);
  renderer.compile(game.scene, game.camera);
  renderer.setAnimationLoop(frame);
  $('loading').hidden = true;
  window.__relic = { game, renderer, view, loadMs: Math.round(performance.now()) };
  if (/[?&]debug\b/.test(location.search)) startDebug();
}

// Live sensor readout for tuning on a real phone: open the page with ?debug
function startDebug() {
  const el = document.createElement('div');
  el.id = 'debug';
  document.body.appendChild(el);
  const deg = (r) => (r * 180 / Math.PI).toFixed(0).padStart(4);
  setInterval(() => {
    const b = input.body, h = game.head, c = b.cfg();
    el.textContent =
      `orient ${input.motionLive() ? 'on' : 'off'}  accel ${input.accelLive() ? 'on' : 'off'}  sens ${settings.motion}  calibrated ${b.calibrated ? 'yes' : 'no'}\n` +
      `|a| ${b.mag.toFixed(1).padStart(5)}  rest ${b.rest.toFixed(2)}  vert ${b.av.toFixed(1).padStart(5)}  v ${b.v.toFixed(2).padStart(5)}  drop ${b.drop.toFixed(2).padStart(5)}\n` +
      `jump if |a|<${c.ffMag.toFixed(1)} for ${(c.ffTime * 1000).toFixed(0)}ms after push>${c.push.toFixed(1)}  crouch if v<-${c.crouchV.toFixed(2)} & drop<-${c.crouchZ.toFixed(2)}\n` +
      `yaw ${deg(h.yaw)}  pitch ${deg(h.pitch)}  roll ${deg(h.roll)}  lane ${['L', 'C', 'R'][h.lane]}\n` +
      `last ${b.lastEvent || '-'}  state ${game.state}`;
  }, 100);
}

boot().catch((err) => {
  console.error(err);
  $('loading').querySelector('.loading-text').textContent = 'Something went wrong loading the temple. Check the console.';
});
