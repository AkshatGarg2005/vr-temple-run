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

const settings = Object.assign({ tilt: IS_TOUCH, sound: true, firstPerson: false, high: true, motion: 'normal' }, store.get('settings', {}));
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

const quality = {
  maxDpr: () => (settings.high ? (IS_MOBILE ? 1.6 : 2) : (IS_MOBILE ? 1 : 1.25)) * (game && game.mode === 'cardboard' ? 0.85 : 1),
  minDpr: 0.6,
  dpr: 1,
};
quality.dpr = Math.min(window.devicePixelRatio || 1, settings.high ? (IS_MOBILE ? 1.6 : 2) : 1.25);
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
  quality.dpr = Math.min(window.devicePixelRatio || 1, quality.maxDpr());
  renderer.setPixelRatio(quality.dpr);
  renderer.setSize(innerWidth, innerHeight);
  view.setup(true, settings.high ? (IS_MOBILE ? 2 : 4) : 0);
  game.setShadowSize(settings.high ? (IS_MOBILE ? 1024 : 2048) : 1024);
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
  $('tg-quality').setAttribute('aria-pressed', String(!!settings.high));
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
  bindToggle('tg-quality', 'high', () => applyQuality());
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
  $('btn-resume').addEventListener('click', () => { resumeGame(); if (game.isVR()) game.calibrate(); });
  $('btn-recenter').addEventListener('click', () => { resumeGame(); game.calibrate(); });
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
// Main loop with dynamic resolution
let lastTs = performance.now();
let clock = 0;
let perf = { t: 0, frames: 0, cooldown: 3 };

function frame(ts) {
  const now = ts || performance.now();
  const dt = clamp((now - lastTs) / 1000, 0, 0.05);
  lastTs = now;
  clock += dt;
  game.update(dt, clock);
  view.render(clock, game.flash);

  if (!renderer.xr.isPresenting && (game.state === 'run' || game.state === 'menu')) {
    perf.t += dt; perf.frames++; perf.cooldown -= dt;
    if (perf.t >= 2) {
      const fps = perf.frames / perf.t;
      perf.t = 0; perf.frames = 0;
      if (perf.cooldown <= 0) {
        let next = quality.dpr;
        if (fps < 46 && quality.dpr > quality.minDpr) next = Math.max(quality.minDpr, quality.dpr - 0.15);
        else if (fps > 58 && quality.dpr < Math.min(window.devicePixelRatio || 1, quality.maxDpr())) next = Math.min(quality.maxDpr(), quality.dpr + 0.1);
        if (Math.abs(next - quality.dpr) > 0.01) {
          quality.dpr = next;
          renderer.setPixelRatio(next);
          onResize();
          perf.cooldown = 4;
        }
      }
    }
  }
}

async function boot() {
  try {
    await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]);
  } catch { /* fonts optional */ }
  game = new Game({ renderer, input, sound, ui, settings, mobile: IS_MOBILE });
  view = new View(renderer, game.scene, game.camera);
  view.setup(true, settings.high ? (IS_MOBILE ? 2 : 4) : 0);
  wireUI();
  onResize();
  // warm up shaders before revealing the scene
  view.render(0, game.flash);
  renderer.compile(game.scene, game.camera);
  renderer.setAnimationLoop(frame);
  $('loading').hidden = true;
  window.__relic = { game, renderer, view };
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
