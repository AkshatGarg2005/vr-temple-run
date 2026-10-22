// Game rules, runner physics, cameras (flat / phone VR / WebXR) and the
// per-frame orchestration of every system.
import * as THREE from 'three';
import {
  PATH_W, HALF_W, LANES, X_LIMIT, GRAVITY, JUMP_V, SLIDE_TIME, START_SPEED, MAX_SPEED, RUNNER_H, SLIDE_H,
  SUN_DIR, PALETTE, clamp, damp, wrapAngle,
} from './config.js';
import { patchFog, createSky, createMountains, createCloudSea, createCanopy, buildEnvironment, createBirds } from './atmosphere.js';
import { cloudNoiseTexture } from './textures.js';
import { createMaterials } from './builders.js';
import { World } from './world.js';
import { Runner, Chasers } from './characters.js';
import { Particles, createMotes } from './particles.js';
import { VRHud } from './hud3d.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _m = new THREE.Matrix4();
const _e = new THREE.Euler(), _q = new THREE.Quaternion();
// Haptics only after the player has interacted (browsers block it otherwise).
const buzz = (pattern) => {
  if (!navigator.vibrate || (navigator.userActivation && !navigator.userActivation.hasBeenActive)) return;
  try { navigator.vibrate(pattern); } catch { /* unsupported */ }
};
// Which way the player's body faces (yaw), even while looking straight up or
// down: the gaze direction stops pointing anywhere horizontal near the
// vertical, but the top of the head then tilts away from the facing
// direction, so we blend the two.
const _fw = new THREE.Vector3(), _up = new THREE.Vector3();
function facingYaw(q) {
  _fw.set(0, 0, -1).applyQuaternion(q);
  _up.set(0, 1, 0).applyQuaternion(q);
  const x = _fw.x - _up.x * _fw.y, z = _fw.z - _up.z * _fw.y;
  return Math.atan2(-x, -z);
}
const nearestLane = (x) => { let b = 0; for (let i = 1; i < 3; i++) if (Math.abs(LANES[i] - x) < Math.abs(LANES[b] - x)) b = i; return b; };

export class Game {
  constructor({ renderer, input, sound, ui, settings, mobile }) {
    this.renderer = renderer;
    this.input = input;
    this.sound = sound;
    this.ui = ui;
    this.settings = settings;
    this.mobile = mobile;
    this.mode = 'flat';           // flat | cardboard | xr
    this.state = 'menu';
    this.time = 0;
    this.shake = 0;
    this.flash = new THREE.Vector4(0, 0, 0, 0);

    patchFog();
    const scene = new THREE.Scene();
    this.scene = scene;
    scene.fog = new THREE.FogExp2(PALETTE.horizon.clone(), 0.0068);

    this.camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.1, 4000);
    this.rig = new THREE.Group();
    this.rig.add(this.camera);
    scene.add(this.rig);

    const cloudTex = cloudNoiseTexture();
    scene.environment = buildEnvironment(renderer, cloudTex);
    scene.environmentIntensity = 0.75;

    this.sky = createSky(cloudTex);
    this.mountains = createMountains();
    this.clouds = createCloudSea(cloudTex);
    this.canopy = createCanopy(mobile ? 360 : 520);
    scene.add(this.sky, this.mountains, this.clouds, this.canopy);

    this.sun = new THREE.DirectionalLight(PALETTE.sunLight, 3.1);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -24; sc.right = 24; sc.top = 24; sc.bottom = -24; sc.near = 1; sc.far = 160;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 0.55);
    scene.add(this.hemi);
    this.setShadowSize(mobile ? 2048 : 4096);

    this.M = createMaterials(renderer.capabilities.getMaxAnisotropy());
    this.world = new World(scene, this.M, { lights: mobile ? 3 : 4, noiseTex: cloudTex });
    this.runner = new Runner(this.M.gold);
    scene.add(this.runner.root);
    this.chasers = new Chasers(scene);
    this.glow = new Particles(scene, this.M.glow, 700, true);
    this.dust = new Particles(scene, this.M.glow, 260, false);
    this.motes = createMotes(scene, this.M.glow, mobile ? 320 : 520);
    this.birds = createBirds(30);
    scene.add(this.birds.mesh);
    this.vrHud = new VRHud(this.rig);
    this.vrHud.attachHeadLocked(this.camera);
    this.lookUpT = 0;

    this.camPos = new THREE.Vector3(6, 3, -8);
    this.camLook = new THREE.Vector3();
    this.camYaw = 0;
    this.calibYaw = 0;
    this.calibQ = new THREE.Quaternion();
    this.head = { roll: 0, yaw: 0, pitch: 0, lane: 1 };
    this.xrPads = {};
    this.xrBody = { base: null, prevY: 0, vel: 0, armJ: true, armC: true };
    this.vrEyeY = 1.62;
    this.bodyNote = null;           // last real-world jump/crouch, shown during the countdown
    this.laneControl = true;
    this.statTimer = 0;

    this.resetRun();
    this.state = 'menu';
  }

  setShadowSize(n) {
    this.sun.shadow.mapSize.set(n, n);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
  }

  // ------------------------------------------------------------------ run lifecycle
  resetRun() {
    this.world.reset();
    const seg = this.world.current;
    this.P = {
      seg, s: 3.2, x: 0, targetX: 0, lane: 1, y: 0, vy: 0, airborne: false,
      sliding: false, slideT: 0, slideQueued: false,
      speed: START_SPEED, slow: 0, time: 0, odo: 0, stumbleAge: 99,
      coins: 0, score: 0, mult: 1, magnetT: 0, turnReq: null, streak: 0, streakT: 0,
      yaw: seg.yaw, lean: 0, pos: new THREE.Vector3(), offset: new THREE.Vector3(), ahead: new THREE.Vector3(),
      deadType: null, deadT: 0, knock: 0, dustT: 0,
    };
    seg.world(this.P.s, 0, 0, this.P.pos);
    this.crumbs = [{ x: this.P.pos.x, y: 0, z: this.P.pos.z, yaw: seg.yaw, odo: 0 }];
    this.lastCrumb = 0;
    this.chasers.dist = 1.5;
    this.camYaw = seg.yaw;
    this.runner.root.rotation.set(0, seg.yaw, 0);
    this.runner.root.position.copy(this.P.pos);
    this.runner.phase = 0;
    this.chasers.setVisible(false);
    this.countT = 0;
  }

  start(mode, opts = {}) {
    this.mode = mode;
    this.resetRun();
    this.laneControl = mode !== 'flat' || !this.useTilt();
    this.chasers.setVisible(true);
    this.vrHud.setVisible(mode !== 'flat');
    // VR is always first person; the explorer's body is hidden so it never blocks the view
    this.runner.setVisible(mode === 'flat' && !this.firstPerson());
    this.head.lane = 1;
    this.bodyNote = null;
    this.input.body.setSensitivity(this.settings.motion);
    this.input.body.reset();
    this.xrBody.base = null;
    if (mode === 'flat') {
      this.state = 'run';
      this.sound.roar();
    } else if (mode === 'cardboard' && (opts.calibrate || !this.input.body.calibrated)) {
      this.beginCalibration();
    } else {
      this.state = 'countdown';
      this.countT = 3.2;
    }
    this.clearHint();
    this.ui.onState(this.state);
    this.sound.startMusic();
  }

  toMenu() {
    this.clearHint();
    this.state = 'menu';
    this.mode = 'flat';
    this.resetRun();
    this.vrHud.setVisible(false);
    this.vrHud.message(null);
    this.runner.setVisible(true);
    this.sound.stopMusic();
  }

  firstPerson() { return !!this.settings.firstPerson; }
  useTilt() { return this.mode === 'flat' && this.settings.tilt && this.input.motionLive(); }
  isVR() { return this.mode !== 'flat'; }

  // Treat the current head direction as "straight ahead".
  calibrate() {
    this.recenter(true);
    this.input.body.reset();
    if (this.mode === 'xr') this.xrBody.base = this.camera.position.y;
  }

  // Make the direction the player is facing "straight ahead" (VR only).
  recenter(silent = false) {
    let q;
    if (this.mode === 'cardboard') q = this.input.deviceQuat;
    else if (this.mode === 'xr') q = this.camera.quaternion;
    else return;
    this.calibYaw = facingYaw(q);
    this.calibQ.setFromAxisAngle(UP, this.calibYaw);
    if (!silent) {
      this.ui.toast('View recentered');
      this.sound.recenter();
      buzz(30);
    }
  }


  // ------------------------------------------------------------------ input
  handleActions() {
    for (const a of this.input.drain()) {
      if (this.state === 'run') {
        if (a === 'left' || a === 'right') this.sideInput(a === 'left' ? 'L' : 'R');
        else if (a === 'jump') this.jump();
        else if (a === 'slide') this.slide();
        else if (a === 'tap' && this.isVR()) this.jump();       // headset button: backup jump
        else if (a === 'bodyJump' && this.isVR()) { this.jump(); this.bodyFlash = { text: '▲ JUMP', t: 0.7 }; }
        else if (a === 'bodyCrouch' && this.isVR()) { this.slide(); this.bodyFlash = { text: '▼ SLIDE', t: 0.7 }; }
      }
      if (this.state === 'calibrate' && a === 'tap') this.calSkip = true;
      if ((a === 'recenter' || a === 'longpress') && this.isVR()) this.recenter();
      if (this.state === 'countdown' && (a === 'bodyJump' || a === 'bodyCrouch')) {
        this.bodyNote = { text: a === 'bodyJump' ? 'Jump detected' : 'Crouch detected', t: 1.2 };
      }
      if (a === 'pause' && (this.state === 'run' || this.state === 'countdown' || this.state === 'calibrate')) this.ui.pause();
      if (a === 'camera' && !this.isVR()) {
        this.settings.firstPerson = !this.settings.firstPerson;
        this.runner.setVisible(!this.firstPerson() || this.state === 'menu');
        this.ui.onSettings?.();
      }
      if ((a === 'confirm' || a === 'tap' || a === 'jump') && this.state === 'over' && this.overT > 0.9) this.ui.restart();
      else if (a === 'bodyJump' && this.state === 'over' && this.isVR() && this.overT > 1.5) this.ui.restart();
    }
  }

  sideInput(side) {
    const P = this.P, seg = P.seg;
    const early = Math.max(7, P.speed * 0.55);
    if (!this.isVR() && seg.hasExit(side) && P.s > seg.len - early - P.speed * 0.45) {
      if (this.inTurnWindow(side)) this.doTurn(side);
      else P.turnReq = { side, t: 0.5 };
      return;
    }
    if (this.laneControl) {
      P.lane = clamp(P.lane + (side === 'L' ? -1 : 1), 0, 2);
    }
  }

  inTurnWindow(side) {
    const P = this.P, seg = P.seg;
    if (!seg.hasExit(side) || !this.world.turnTarget(seg, side)) return false;
    const early = Math.max(7, P.speed * 0.55);
    return P.s >= seg.len - early && P.s <= seg.len + PATH_W - 0.3;
  }

  doTurn(side) {
    const P = this.P;
    const before = P.seg.world(P.s, P.x, 0);
    const n = this.world.commitTurn(side);
    if (!n) return;
    const l = n.local(before.x, before.z);
    P.seg = n;
    P.s = l.s;
    P.x = clamp(l.x, -X_LIMIT, X_LIMIT);
    P.lane = this.isVR() ? this.head.lane : nearestLane(P.x);
    const after = n.world(P.s, P.x, 0);
    P.offset.add(before.sub(after));
    P.turnReq = null;
    this.sound.turn();
    buzz(12);
  }

  jump() {
    const P = this.P;
    if (P.airborne) return;
    P.sliding = false; P.slideT = 0;
    P.vy = JUMP_V; P.airborne = true;
    this.sound.jump();
  }

  slide() {
    const P = this.P;
    if (P.airborne) { P.vy = Math.min(P.vy, -17); P.slideQueued = true; return; }
    P.sliding = true; P.slideT = SLIDE_TIME;
    this.sound.slide();
  }

  // VR head: free look everywhere; tilting the head (while facing roughly
  // forward) picks the lane: left ear down = left lane, level = centre,
  // right ear down = right lane.
  headGestures(dt) {
    if (!this.isVR()) return;
    const q = this.mode === 'cardboard' ? this.camera.quaternion : _q.copy(this.calibQ).invert().multiply(this.camera.quaternion);
    _e.setFromQuaternion(q, 'YXZ');
    const H = this.head;
    H.pitch = _e.x; H.yaw = wrapAngle(_e.y); H.roll = _e.z;
    this.lookUpRecenter(dt);
    if (this.state !== 'run') return;
    if (Math.abs(H.yaw) < 0.6 && Math.abs(H.pitch) < 0.75) {
      const r = -H.roll; // + = tilted right
      let lane = H.lane;
      if (r > 0.16) lane = 2;
      else if (r < -0.16) lane = 0;
      else if (Math.abs(r) < 0.08) lane = 1;
      if (lane !== H.lane) { H.lane = lane; this.P.lane = lane; }
    }
    // let slow body rotation re-centre the view while looking roughly forward
    if (this.mode === 'cardboard' && Math.abs(H.yaw) < 0.3) {
      this.calibYaw += wrapAngle(H.yaw) * Math.min(1, dt * 0.12);
      this.calibQ.setFromAxisAngle(UP, this.calibYaw);
    }
  }

  // Hands-free recenter: wherever you're facing, look up (about 55 deg or
  // more) and hold for 2 s. A circle of dots fills in the middle of the view;
  // looking back down early cancels. The way your body faces becomes the
  // running direction. Lane steering is ignored while looking up.
  lookUpRecenter(dt) {
    const active = this.state === 'run' || this.state === 'countdown' || this.state === 'over' || this.state === 'calibrate';
    const H = this.head;
    const HOLD = 2.0;
    if (!active) { this.lookUpT = 0; this.vrHud.recenterProgress(0); return; }
    if (H.pitch > 0.95) {
      if (this.lookUpT >= 0) {
        this.lookUpT += dt;
        if (this.lookUpT >= HOLD) { this.recenter(); this.lookUpT = -1; }
      }
    } else if (H.pitch < (this.lookUpT < 0 ? 0.6 : 0.8)) {
      this.lookUpT = 0; // cancel, or re-arm once the player looks back down
    }
    const p = this.lookUpT > 0.2 ? this.lookUpT / HOLD : 0;
    this.vrHud.recenterProgress(p);
  }


  // WebXR headsets with positional tracking (e.g. Quest): read real jumps and
  // crouches straight from head height.
  xrBodyTrack(dt) {
    if (this.mode !== 'xr' || !this.renderer.xr.isPresenting) return;
    const X = this.xrBody;
    const y = this.camera.position.y;
    if (X.base == null) X.base = y;
    X.vel = damp(X.vel, (y - X.prevY) / Math.max(dt, 1e-3), 12, dt);
    X.prevY = y;
    if (this.state === 'countdown') { X.base = damp(X.base, y, 2, dt); return; }
    if (X.armC && y < X.base - 0.28) { X.armC = false; this.input.push('bodyCrouch'); }
    if (y > X.base - 0.15) X.armC = true;
    if (X.armJ && X.vel > 0.9 && y > X.base + 0.04) { X.armJ = false; this.input.push('bodyJump'); }
    if (y < X.base + 0.02 && X.vel < 0.2) X.armJ = true;
    if (Math.abs(y - X.base) < 0.08 && Math.abs(X.vel) < 0.1) X.base = damp(X.base, y, 0.3, dt);
  }

  xrControllers() {
    if (this.mode !== 'xr') return;
    const session = this.renderer.xr.getSession();
    if (!session) return;
    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const id = src.handedness || 'none';
      const st = this.xrPads[id] || (this.xrPads[id] = {});
      const ax = gp.axes.length >= 4 ? gp.axes[2] : (gp.axes[0] || 0);
      const ay = gp.axes.length >= 4 ? gp.axes[3] : (gp.axes[1] || 0);
      const edge = (key, on, action) => { if (on && !st[key]) { this.laneControl = this.laneControl || action === 'left' || action === 'right'; this.input.push(action); } st[key] = on; };
      edge('l', ax < -0.7, 'left');
      edge('r', ax > 0.7, 'right');
      edge('u', ay < -0.7, 'jump');
      edge('d', ay > 0.7, 'slide');
      edge('trig', !!(gp.buttons[0] && gp.buttons[0].pressed), this.state === 'over' ? 'confirm' : 'jump');
      edge('grip', !!(gp.buttons[1] && gp.buttons[1].pressed), 'slide');
      edge('stick', !!(gp.buttons[3] && gp.buttons[3].pressed), 'recenter');
    }
  }

  // ------------------------------------------------------------------ rules
  stumble() {
    const P = this.P;
    if (P.stumbleAge < 7) return this.die('caught');
    P.stumbleAge = 0;
    P.slow = 1;
    this.shake = 0.35;
    this.sound.stumble();
    this.ui.toast('Watch your step!');
    buzz(60);
  }

  die(type) {
    const P = this.P;
    if (this.state !== 'run') return;
    this.clearHint();
    this.state = 'dying';
    P.deadType = type;
    P.deadT = 0;
    P.sliding = false;
    if (type === 'fall') { P.knock = P.speed * 0.45; P.vy = Math.min(P.vy, 0); P.airborne = true; }
    else { P.knock = -3.5; P.vy = 3.5; P.airborne = true; this.shake = 0.7; }
    if (type === 'fire') this.flash.set(1, 0.55, 0.2, 0.35);
    else if (type !== 'fall') this.flash.set(0.7, 0.1, 0.05, 0.25);
    this.sound.death(type);
    if (type === 'caught' || type === 'hit' || type === 'wall') setTimeout(() => this.sound.roar(), 250);
    buzz([80, 40, 120]);
    this.ui.onState('dying');
  }

  finish() {
    const P = this.P;
    this.state = 'over';
    this.overT = 0;
    const reasons = {
      wall: 'You ran into the temple wall',
      hit: 'The ruins stopped you cold',
      fire: 'The fire trap got you',
      fall: 'You fell into the clouds',
      caught: 'The guardians caught you',
    };
    const stats = { score: Math.floor(P.score), dist: Math.floor(P.odo), coins: P.coins, reason: reasons[P.deadType] || 'Run over' };
    this.lastStats = stats;
    this.ui.gameOver(stats);
    if (this.isVR()) {
      this.vrHud.message([
        { text: stats.reason.toUpperCase(), size: 34, color: '#ff7a3d', weight: 700 },
        { text: 'RUN OVER', size: 92, color: '#f0b44c', display: true },
        { text: `${stats.score} pts  ·  ${stats.dist} m  ·  ${stats.coins} coins`, size: 44 },
        { text: 'Jump to run again', size: 40, color: '#6fd3a8', weight: 700 },
      ]);
    }
  }

  // ------------------------------------------------------------------ frame
  update(dt, t) {
    this.time = t;
    if (this.mode === 'cardboard') {
      this.camera.quaternion.copy(this.calibQ).invert().multiply(this.input.deviceQuat);
    }
    this.input.longPress = this.isVR();
    this.input.body.enabled = this.isVR() && (this.state === 'run' || this.state === 'countdown' || this.state === 'over');
    this.xrControllers();
    this.xrBodyTrack(dt);
    this.headGestures(dt);
    if (this.state !== 'paused') this.handleActions();

    switch (this.state) {
      case 'menu': this.updateMenu(dt, t); break;
      case 'calibrate': this.updateCalibrate(dt, t); break;
      case 'countdown': this.updateCountdown(dt, t); break;
      case 'run': this.updateRun(dt, t); break;
      case 'dying': this.updateDying(dt, t); break;
      case 'over': this.overT += dt; this.idleWorld(dt, t); break;
      case 'paused': break;
    }
    if (this.state !== 'paused') {
      this.updateCamera(dt, t);
      this.updateAtmosphere(dt, t);
      this.glow.update(dt);
      this.dust.update(dt);
    }
    this.flash.w = Math.max(0, this.flash.w - dt * 0.8);
  }

  idleWorld(dt, t) {
    this.world.update(dt, t, this.P);
    this.runner.animate(dt, this.runnerState(t));
  }

  runnerState(t) {
    const P = this.P;
    return {
      speed: P.speed, airborne: P.airborne, vy: P.vy, sliding: P.sliding, stumble: P.stumbleAge < 0.6 ? 1 : 0,
      lean: P.lean, time: t, idle: this.state === 'menu' || this.state === 'countdown' || this.state === 'calibrate',
      dead: this.state === 'dying' || this.state === 'over', deadType: P.deadType, deadT: P.deadT,
    };
  }

  updateMenu(dt, t) {
    this.P.ahead.copy(this.P.pos).add(_v.set(0, 0, -10));
    this.idleWorld(dt, t);
  }

  // ------------------------------------------------------------------ body calibration
  // Phone VR: stand still, jump once, crouch once. The detector adapts its
  // thresholds to this player and this phone. Tapping the screen skips a step.
  beginCalibration() {
    this.state = 'calibrate';
    this.calStep = 'still';
    this.calT = 0;
    this.calSkip = false;
    this.calNote = '';
    this.input.body.beginCapture('still');
  }

  updateCalibrate(dt, t) {
    const body = this.input.body;
    this.calT += dt;
    const next = (step, note) => {
      this.calStep = step; this.calT = 0; this.calSkip = false;
      if (note !== undefined) this.calNote = note;
      if (step === 'jump' || step === 'crouch') body.beginCapture(step);
    };
    const sensorDead = !this.input.accelLive();
    if (sensorDead && this.calT > 2.5 && this.calStep !== 'done') {
      body.cancelCapture();
      this.vrHud.message([
        { text: 'MOTION SENSOR NOT RESPONDING', size: 42, color: '#ff7a3d', weight: 700 },
        { text: 'Allow motion access and use the https:// address', size: 32, weight: 600 },
        { text: 'Tap the screen to play without body sensing', size: 32, color: '#6fd3a8', weight: 600 },
      ]);
      if (this.calSkip) { this.calSkip = false; this.state = 'countdown'; this.countT = 3.2; }
      this.idleWorld(dt, t);
      return;
    }
    const res = body.captureResult();
    switch (this.calStep) {
      case 'still':
        this.vrHud.message([
          { text: 'BODY CALIBRATION', size: 36, color: '#6fd3a8', weight: 700 },
          { text: 'STAND STILL', size: 96, color: '#f0b44c', display: true },
          { text: 'Look straight ahead for a moment', size: 34, weight: 600 },
        ]);
        if (res) next('jump');
        break;
      case 'jump':
        this.vrHud.message([
          { text: this.calNote || 'STEP 1 OF 2', size: 34, color: this.calNote ? '#ffd88a' : '#6fd3a8', weight: 700 },
          { text: 'JUMP ONCE', size: 104, color: '#f0b44c', display: true },
          { text: 'A small hop is enough · tap to skip', size: 34, weight: 600 },
        ]);
        if (res) next('crouch', res.ok ? 'Jump recorded ✓' : 'No jump seen, using default jump settings');
        else if (this.calSkip) { body.cancelCapture(); next('crouch', 'Jump skipped'); }
        break;
      case 'crouch':
        this.vrHud.message([
          { text: this.calNote || 'STEP 2 OF 2', size: 34, color: '#ffd88a', weight: 700 },
          { text: 'CROUCH ONCE', size: 104, color: '#f0b44c', display: true },
          { text: 'Bend your knees, then stand back up · tap to skip', size: 32, weight: 600 },
        ]);
        if (res) next('done', res.ok ? 'Crouch recorded ✓' : 'No crouch seen, using default crouch settings');
        else if (this.calSkip) { body.cancelCapture(); next('done', 'Crouch skipped'); }
        break;
      case 'done':
        this.vrHud.message([
          { text: this.calNote, size: 34, color: '#ffd88a', weight: 700 },
          { text: 'READY', size: 110, color: '#f0b44c', display: true },
          { text: 'Jump to jump · Crouch to slide · Tilt head to change lane', size: 30, weight: 600 },
        ]);
        if (this.calT > 1.6) {
          body.calibrated = true;
          this.state = 'countdown';
          this.countT = 3.2;
        }
        break;
    }
    this.idleWorld(dt, t);
  }

  updateCountdown(dt, t) {
    this.countT -= dt;
    const n = Math.ceil(this.countT);
    if (this.bodyNote) { this.bodyNote.t -= dt; if (this.bodyNote.t <= 0) this.bodyNote = null; }
    if (n > 0) {
      this.vrHud.message([
        { text: 'STAND TALL · LOOK STRAIGHT AHEAD', size: 38, color: '#6fd3a8', weight: 700 },
        { text: String(n), size: 140, color: '#f0b44c', display: true },
        { text: 'Tilt head = change lane · Jump = jump · Crouch = slide', size: 32, weight: 600 },
        { text: this.bodyNote ? this.bodyNote.text : 'Turns happen on their own', size: 32, weight: 700, color: this.bodyNote ? '#ffd88a' : '#c9b89a' },
      ]);
    }
    if (this.countT <= 0.25 && !this.calibrated) { this.calibrate(); this.calibrated = true; }
    if (this.countT <= 0) {
      this.calibrated = false;
      this.vrHud.message(null);
      this.state = 'run';
      this.sound.roar();
      this.ui.onState('run');
    }
    this.P.ahead.copy(this.P.pos);
    this.idleWorld(dt, t);
    this.chasers.update(dt, this.crumbs, this.P.odo, 0.5, t);
  }

  updateRun(dt, t) {
    const P = this.P;
    P.time += dt;
    P.stumbleAge += dt;
    P.magnetT = Math.max(0, P.magnetT - dt);

    const base = START_SPEED + (MAX_SPEED - START_SPEED) * (1 - Math.exp(-P.time / 110));
    P.slow = Math.max(0, P.slow - dt * 0.7);
    P.speed = base * (1 - P.slow * 0.3);

    if (P.turnReq) {
      P.turnReq.t -= dt;
      if (P.turnReq.t <= 0) P.turnReq = null;
      else if (this.inTurnWindow(P.turnReq.side)) this.doTurn(P.turnReq.side);
    }

    // lateral
    if (this.useTilt()) { this.laneControl = false; P.targetX = this.input.tilt * X_LIMIT; }
    else if (this.mode === 'flat') { this.laneControl = true; }
    if (this.laneControl) P.targetX = LANES[P.lane];
    const prevX = P.x;
    P.x = clamp(damp(P.x, P.targetX, this.laneControl ? 13 : 8, dt), -X_LIMIT, X_LIMIT);
    P.lean = damp(P.lean, clamp((P.x - prevX) / Math.max(dt, 1e-3) * 0.08, -0.5, 0.5), 10, dt);

    // vertical
    const seg = P.seg;
    if (P.airborne) {
      P.vy -= GRAVITY * dt;
      P.y += P.vy * dt;
      if (P.y <= 0) {
        if (this.world.overGap(seg, P.s)) { P.y = Math.min(P.y, 0); this.die('fall'); return; }
        P.y = 0; P.vy = 0; P.airborne = false;
        this.sound.land();
        this.puff(4);
        if (P.slideQueued) { P.slideQueued = false; P.sliding = true; P.slideT = SLIDE_TIME; this.sound.slide(); }
      }
    } else if (this.world.overGap(seg, P.s)) { this.die('fall'); return; }
    if (P.sliding) { P.slideT -= dt; if (P.slideT <= 0) P.sliding = false; }

    // forward
    const ds = P.speed * dt;
    P.s += ds;
    P.odo += ds;
    P.score += ds * P.mult * 0.5;
    // VR: turns happen automatically at the centre of each junction. At a fork
    // the runner takes the side you're looking towards, otherwise a random one.
    if (this.isVR() && P.s >= seg.len + HALF_W - 0.25) {
      let side = seg.exit;
      if (side === 'T') side = Math.abs(this.head.yaw) > 0.35 ? (this.head.yaw > 0 ? 'L' : 'R') : (Math.random() < 0.5 ? 'L' : 'R');
      if (this.world.turnTarget(seg, side)) { this.doTurn(side); return; }
    }
    if (P.s > seg.len + PATH_W - 0.55) { P.s = seg.len + PATH_W - 0.55; this.die('wall'); return; }

    // obstacles
    const bodyH = P.sliding ? SLIDE_H : RUNNER_H;
    for (const o of seg.obstacles) {
      if (o.hit || P.s < o.s0 - 0.2 || P.s > o.s1 + 0.2) continue;
      if (P.y >= o.y1 || P.y + bodyH <= o.y0) continue;
      const overlap = Math.min(P.x + 0.3, o.x1) - Math.max(P.x - 0.3, o.x0);
      if (overlap <= 0) continue;
      o.hit = true;
      if (o.type === 'root') this.stumble();
      else if (o.type === 'block' && overlap < 0.3) {
        const cx = (o.x0 + o.x1) / 2;
        P.x = P.x < cx ? o.x0 - 0.31 : o.x1 + 0.31;
        P.lane = nearestLane(P.x);
        this.stumble();
      } else { this.die(o.type === 'fire' ? 'fire' : 'hit'); return; }
      if (this.state !== 'run') return;
    }

    // multiplier
    const mult = Math.min(9, 1 + Math.floor(P.odo / 750));
    if (mult !== P.mult) { P.mult = mult; this.ui.toast(`x${mult} multiplier`); this.sound.power(); }

    // display transform
    P.seg.world(P.s, P.x, P.y, _v);
    P.offset.multiplyScalar(Math.exp(-7 * dt));
    P.pos.copy(_v).add(P.offset);
    P.yaw += wrapAngle(P.seg.yaw - P.yaw) * Math.min(1, dt * 11);
    _f.set(-Math.sin(P.yaw), 0, -Math.cos(P.yaw));
    P.ahead.copy(P.pos).addScaledVector(_f, 10);

    // coins and power-ups
    P.streakT -= dt;
    if (P.streakT < 0) P.streak = 0;
    _v.copy(P.pos); _v.y += P.sliding ? 0.45 : 0.95;
    this.world.collect(P.seg, _v, P.magnetT > 0, dt, (c) => {
      P.coins++; P.score += 5 * P.mult; P.streak++; P.streakT = 0.6;
      this.sound.coin(P.streak);
      this.glow.burst(c.pos, 7, { r: 3, g: 2.1, b: 0.7 }, 3.2, 0.45, 0.22, -4);
    }, (pu) => {
      if (pu.type === 'magnet') { P.magnetT = 12; this.ui.toast('Coin magnet'); this.sound.power(); }
      this.glow.burst(pu.obj.position, 24, { r: 0.8, g: 1.8, b: 3.5 }, 5, 0.7, 0.3, -2);
    });

    // breadcrumbs for the chasers
    if (P.odo - this.lastCrumb >= 0.5) {
      this.lastCrumb = P.odo;
      this.crumbs.push({ x: P.pos.x, y: P.y, z: P.pos.z, yaw: P.yaw, odo: P.odo });
      if (this.crumbs.length > 180) this.crumbs.shift();
    }
    const close = P.stumbleAge < 7;
    const vrNear = this.isVR() ? 0.8 : 1;
    const chaseTarget = close ? 1.25 * vrNear : P.time < 3.2 ? 1.5 * vrNear : 16;
    this.chasers.dist = damp(this.chasers.dist, chaseTarget, close && P.stumbleAge < 1 ? 5 : 0.7, dt);
    this.chasers.update(dt, this.crumbs, P.odo, P.speed, t);
    this.sound.setPace((P.speed - START_SPEED) / (MAX_SPEED - START_SPEED), close ? 1 : 0);

    this.world.update(dt, t, P);
    this.updateHints();
    this.runner.root.position.copy(P.pos);
    this.runner.root.rotation.set(0, P.yaw, 0);
    this.runner.animate(dt, this.runnerState(t));

    // ambient fx
    P.dustT -= dt;
    if (!P.airborne && P.dustT <= 0) { P.dustT = P.sliding ? 0.03 : 0.16; this.puff(1); }
    this.embers(dt);

    this.statTimer -= dt;
    if (this.statTimer <= 0) {
      this.statTimer = 0.1;
      this.ui.stats({ score: Math.floor(P.score), coins: P.coins, dist: Math.floor(P.odo), mult: P.mult, magnet: P.magnetT / 12 });
    }
    if (this.isVR()) {
      if (this.bodyFlash) { this.bodyFlash.t -= dt; if (this.bodyFlash.t <= 0) this.bodyFlash = null; }
      this.vrHud.setStats(Math.floor(P.score), P.coins, P.mult, this.bodyFlash && this.bodyFlash.text);
    }
  }

  // ------------------------------------------------------------------ hints
  // Tells the player when to jump or slide: an early "get ready" cue, then a
  // "now" cue with a sound. Phone VR cues come earlier because a real jump or
  // crouch takes longer to detect than a key press.
  updateHints() {
    const P = this.P;
    let want = null;
    if (this.settings.hints && this.state === 'run') {
      const vr = this.isVR();
      const leadT = vr ? 1.5 : 1.0, nowT = vr ? 0.6 : 0.34;
      const v = Math.max(P.speed, 1);
      let best = null;
      const consider = (seg, base) => {
        for (const o of seg.obstacles) {
          if (o.hit) continue;
          const act = o.type === 'root' ? 'jump' : (o.type === 'log' || o.type === 'fire') ? 'slide' : null;
          if (!act) continue;
          const d = base + o.s0;
          if (d > -0.3 && (!best || d < best.d)) best = { act, d };
        }
        for (const [a] of seg.gaps) {
          const d = base + a;
          if (d > -0.3 && (!best || d < best.d)) best = { act: 'jump', d };
        }
      };
      consider(P.seg, -P.s);
      if (P.seg.next) consider(P.seg.next, P.seg.len + PATH_W - P.s);
      if (best && best.d / v <= leadT) {
        const done = best.act === 'jump' ? P.airborne : P.sliding;
        if (!done) want = { act: best.act, stage: best.d / v <= nowT ? 2 : 1 };
      }
    }
    const key = want ? want.act + want.stage : '';
    if (key === this.hintKey) return;
    if (want && want.stage === 2) this.sound.hint(want.act);
    this.hintKey = key;
    const vr = this.isVR();
    this.ui.hint(want && !vr ? want.act : null, want ? want.stage : 0);
    this.vrHud.hint(want && vr ? want.act : null, want ? want.stage : 0);
  }

  clearHint() {
    this.hintKey = '';
    this.ui.hint(null, 0);
    this.vrHud.hint(null, 0);
  }

  updateDying(dt, t) {
    const P = this.P;
    P.deadT += dt;
    P.vy -= GRAVITY * (P.deadType === 'fall' ? 0.7 : 1) * dt;
    P.y += P.vy * dt;
    if (P.deadType !== 'fall') {
      if (P.y < 0) { P.y = 0; P.vy = 0; }
      P.knock = damp(P.knock, 0, 4, dt);
    } else {
      P.knock = damp(P.knock, 0, 1.2, dt);
    }
    P.s += P.knock * dt;
    P.seg.world(P.s, P.x, P.y, _v);
    P.offset.multiplyScalar(Math.exp(-7 * dt));
    P.pos.copy(_v).add(P.offset);
    this.runner.root.position.copy(P.pos);
    if (P.deadType === 'fall') this.runner.root.rotation.x -= dt * 2.2;
    this.runner.animate(dt, this.runnerState(t));

    const lunge = P.deadType === 'fall' ? 0 : clamp((P.deadT - 0.3) * 2, 0, 1);
    const target = P.deadType === 'fall' ? 4 : 0.4;
    this.chasers.dist = damp(this.chasers.dist, target, 2.5, dt);
    if (P.deadT < 1.2) {
      P.odo += Math.max(0, P.knock) * dt;
      this.chasers.update(dt, this.crumbs, P.odo, P.deadType === 'fall' ? P.speed * 0.4 : 6, t, lunge);
    }
    this.world.update(dt, t, P);
    if (P.deadT > (P.deadType === 'fall' ? 1.9 : 1.6)) this.finish();
  }

  puff(n) {
    const P = this.P;
    for (let i = 0; i < n; i++) {
      this.dust.emit(P.pos.x + (Math.random() - 0.5) * 0.4, Math.max(P.pos.y, 0) + 0.08, P.pos.z + (Math.random() - 0.5) * 0.4,
        (Math.random() - 0.5) * 1.2, 0.5 + Math.random() * 0.8, (Math.random() - 0.5) * 1.2,
        0.62, 0.52, 0.42, 0.7, 0.35, 1.3, 0.35, 0.4);
    }
  }

  embers(dt) {
    const seg = this.P.seg;
    const pool = seg.flames.length ? seg.flames : (seg.next ? seg.next.flames : []);
    if (!pool.length) return;
    const n = Math.random() < dt * 30 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const f = pool[Math.floor(Math.random() * pool.length)];
      f.getWorldPosition(_v);
      this.glow.emit(_v.x + (Math.random() - 0.5) * 0.3, _v.y, _v.z + (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.8, 1.2 + Math.random() * 1.5, (Math.random() - 0.5) * 0.8,
        3.2, 1.2, 0.3, 1.4, 0.1, 0.03, 1, 0.6);
    }
  }

  // ------------------------------------------------------------------ camera
  updateCamera(dt, t) {
    const P = this.P;
    this.shake = Math.max(0, this.shake - dt * 1.4);
    const vr = this.isVR();
    if (this.state === 'menu') return this.menuCamera(dt, t);

    this.camYaw += wrapAngle(P.yaw - this.camYaw) * Math.min(1, dt * (vr ? 8 : 7));
    _f.set(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw));
    _r.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    const falling = (this.state === 'dying' || this.state === 'over') && P.deadType === 'fall';
    const base = _v.copy(P.pos);
    if (falling) base.y = Math.max(base.y, -1.5);
    const fp = this.firstPerson();

    if (!vr) {
      let desired, look;
      if (fp) {
        const h = P.sliding ? 0.8 : 1.62;
        desired = base.clone().addScaledVector(UP, h + Math.sin(this.runner.phase * 2) * 0.025).addScaledVector(_f, 0.2);
        look = desired.clone().addScaledVector(_f, 10).addScaledVector(UP, -1.3);
        this.camPos.copy(desired);
        this.camLook.copy(look);
      } else {
        const jumpY = Math.max(0, P.y) * 0.4;
        desired = base.clone().addScaledVector(UP, 2.75 + jumpY - Math.max(0, P.y)).addScaledVector(_f, -5.0).addScaledVector(_r, -P.x * 0.45);
        look = base.clone().addScaledVector(UP, 0.95 - Math.max(0, P.y) * 0.6).addScaledVector(_f, 7).addScaledVector(_r, -P.x * 0.3);
        if (falling) { desired.y = Math.max(desired.y, 1.5); }
        const k = this.state === 'dying' || this.state === 'over' ? 2.5 : 10;
        this.camPos.x = damp(this.camPos.x, desired.x, k, dt);
        this.camPos.z = damp(this.camPos.z, desired.z, k, dt);
        this.camPos.y = damp(this.camPos.y, desired.y, k * 0.7, dt);
        this.camLook.lerp(look, 1 - Math.exp(-12 * dt));
      }
      const shake = this.shake * this.shake;
      this.rig.position.copy(this.camPos).add(_v.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake));
      _m.lookAt(this.rig.position, this.camLook, UP);
      this.rig.quaternion.setFromRotationMatrix(_m);
      this.camera.position.set(0, 0, 0);
      this.camera.quaternion.identity();
      const fov = fp ? 74 : 64 + (P.speed - START_SPEED) * 0.5;
      if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov = damp(this.camera.fov, fov, 3, dt); this.camera.updateProjectionMatrix(); }
    } else {
      // First person: eyes at the runner's head. Ground position is exact (no
      // lag at speed); only height is smoothed. Real crouches lower the view
      // in WebXR by themselves, so only phone VR adds the game's slide height.
      const xr = this.mode === 'xr';
      const eye = xr ? 1.65 - (this.xrBody.base ?? 0) : (P.sliding ? 0.95 : 1.62);
      this.vrEyeY = damp(this.vrEyeY, eye + Math.max(0, P.y) * 0.55, 12, dt);
      const groundY = Math.max(Math.min(P.pos.y, 0), -1.5);
      if (this.state === 'dying' || this.state === 'over') {
        this.camPos.x = damp(this.camPos.x, base.x, 3, dt);
        this.camPos.z = damp(this.camPos.z, base.z, 3, dt);
      } else {
        this.camPos.x = base.x; this.camPos.z = base.z;
      }
      this.camPos.y = groundY + this.vrEyeY;
      this.rig.position.copy(this.camPos);
      this.rig.quaternion.setFromAxisAngle(UP, this.camYaw - (xr ? this.calibYaw : 0));
      if (this.mode === 'cardboard' && Math.abs(this.camera.fov - 82) > 0.01) { this.camera.fov = 82; this.camera.updateProjectionMatrix(); }
    }
  }

  menuCamera(dt, t) {
    const P = this.P;
    // sweep slowly across the front of the runner: idol thief, temple door, sunset
    const a = Math.sin(t * 0.09) * 0.75 - 0.25;
    const r = 5.4;
    const target = _v.copy(P.pos).add(new THREE.Vector3(0, 1.15, 0));
    this.camPos.set(P.pos.x + Math.sin(a) * r, 1.7 + Math.sin(t * 0.3) * 0.25, P.pos.z - Math.cos(a) * r);
    // keep the runner in the right part of the frame (menu panel sits on the left)
    const toCam = new THREE.Vector3().subVectors(this.camPos, target).normalize();
    const side = new THREE.Vector3().crossVectors(UP, toCam).normalize();
    const portrait = innerHeight > innerWidth;
    this.camLook.copy(target).addScaledVector(side, portrait ? 0 : -2.1).addScaledVector(UP, portrait ? -0.7 : 0.1);
    this.rig.position.copy(this.camPos);
    _m.lookAt(this.rig.position, this.camLook, UP);
    this.rig.quaternion.setFromRotationMatrix(_m);
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.identity();
    if (this.camera.fov !== 55) { this.camera.fov = 55; this.camera.updateProjectionMatrix(); }
  }

  updateAtmosphere(dt, t) {
    const cam = this.camera.getWorldPosition(_v);
    this.sky.position.copy(cam);
    this.sky.material.uniforms.uTime.value = t;
    this.mountains.position.set(cam.x, 0, cam.z);
    this.clouds.position.set(cam.x, 0, cam.z);
    this.clouds.userData.uniforms.uTime.value = t;
    this.canopy.userData.wrap.uWrapCenter.value.set(cam.x, cam.z);
    this.motes.uniforms.uTime.value = t;
    this.motes.uniforms.uCenter.value.copy(cam);
    this.birds.update(t, this.P.pos);
    // sun + shadow frustum follow the runner (snapped to texels to avoid shimmer)
    const P = this.P;
    const texel = 48 / this.sun.shadow.mapSize.x;
    const cx = Math.round(P.pos.x / texel) * texel, cz = Math.round(P.pos.z / texel) * texel;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + SUN_DIR.x * 80, SUN_DIR.y * 80 + 20, cz + SUN_DIR.z * 80);
    this.sun.target.updateMatrixWorld();
  }

  // 0..1 strength of the edge speed blur (normal screen, while running fast)
  speedFx() {
    if (this.state !== 'run' || this.isVR()) return 0;
    return clamp((this.P.speed - 16) / (MAX_SPEED - 16), 0, 1) * 0.9;
  }

  setParticleScale(heightPx) {
    const s = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.glow.setScale(s); this.dust.setScale(s); this.motes.uniforms.uScale.value = s;
  }
}
