// Keyboard, swipe/tap and phone motion sensors. The game reads discrete
// actions from a queue plus two continuous signals: tilt steering and the
// phone's full orientation (used as the VR head pose).
import * as THREE from 'three';
import { clamp } from './config.js';
import { BodyMotion } from './motion.js';

const D2R = Math.PI / 180;
const ZEE = new THREE.Vector3(0, 0, 1);
const Q_BACK = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // look out of the back of the device

function screenAngle() {
  const a = screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle : window.orientation;
  return (a || 0) * D2R;
}

export class Input {
  constructor() {
    this.queue = [];
    this.tilt = 0;                 // -1 (left) .. 1 (right)
    this.hasMotion = false;
    this.motionAllowed = false;
    this.deviceQuat = new THREE.Quaternion();
    this.lastOrientationAt = 0;
    this._euler = new THREE.Euler();
    this._q0 = new THREE.Quaternion();
    this._ptr = null;
    this.enabled = true;
    this.longPress = false;
    this.upDev = [0, 1, 0];       // world "up" in device axes, from the orientation sensor
    this.upAt = 0;
    this.hasAccel = false;
    this.lastMotionAt = 0;
    this.body = new BodyMotion((ev) => this.push(ev === 'jump' ? 'bodyJump' : 'bodyCrouch'));

    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('pointerdown', (e) => this.onDown(e), { passive: false });
    window.addEventListener('pointermove', (e) => this.onMove(e), { passive: false });
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', () => { this._ptr = null; clearTimeout(this._lpTimer); });
    this._onOrient = (e) => this.onOrientation(e);
    this._onMotion = (e) => this.onMotion(e);
    this.listenSensors();
  }

  push(a) { if (this.enabled) this.queue.push(a); }
  drain() { const q = this.queue; this.queue = []; return q; }

  onKey(e) {
    if (e.repeat) return;
    const k = e.key;
    const map = {
      ArrowLeft: 'left', a: 'left', A: 'left',
      ArrowRight: 'right', d: 'right', D: 'right',
      ArrowUp: 'jump', w: 'jump', W: 'jump', ' ': 'jump',
      ArrowDown: 'slide', s: 'slide', S: 'slide',
      p: 'pause', P: 'pause', Escape: 'pause',
      c: 'camera', C: 'camera', Enter: 'confirm', r: 'confirm', R: 'confirm',
    };
    const a = map[k];
    if (!a) return;
    if (['left', 'right', 'jump', 'slide'].includes(a)) e.preventDefault();
    if (a === 'jump' && k === ' ') this.push('confirm');
    this.push(a);
  }

  isUI(e) { return e.target && e.target.closest && e.target.closest('button, .overlay:not([hidden]) .panel, .menu-inner'); }

  onDown(e) {
    if (this.isUI(e)) return;
    clearTimeout(this._lpTimer);
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), fired: false };
    this._ptr = p;
    // holding still (e.g. the headset button held down) = long press; VR only,
    // so slow swipes on a normal screen are never swallowed
    if (this.longPress) this._lpTimer = setTimeout(() => {
      if (this._ptr === p && !p.fired) { p.fired = true; this.push('longpress'); }
    }, 700);
  }
  onMove(e) {
    const p = this._ptr;
    if (!p || p.id !== e.pointerId || p.fired) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    const th = Math.max(26, Math.min(innerWidth, innerHeight) * 0.045);
    if (Math.hypot(dx, dy) < th) return;
    p.fired = true;
    if (Math.abs(dx) > Math.abs(dy)) this.push(dx > 0 ? 'right' : 'left');
    else this.push(dy < 0 ? 'jump' : 'slide');
    e.preventDefault();
  }
  onUp(e) {
    const p = this._ptr;
    this._ptr = null;
    clearTimeout(this._lpTimer);
    if (!p || p.id !== e.pointerId || p.fired) return;
    const dt = performance.now() - p.t;
    if (dt < 350 && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 20) this.push('tap');
  }

  // Must be called from a click/tap handler (iOS asks for permission).
  // Both sensors are requested in the same tap: orientation for looking
  // around and steering, motion (accelerometer) for real jumps and crouches.
  async requestMotion() {
    const DOE = window.DeviceOrientationEvent, DME = window.DeviceMotionEvent;
    const ask = (E) => (E && typeof E.requestPermission === 'function' ? E.requestPermission().catch(() => 'denied') : Promise.resolve(E ? 'granted' : 'denied'));
    try {
      const [o, m] = await Promise.all([ask(DOE), ask(DME)]);
      this.motionAllowed = o === 'granted';
      this.accelAllowed = m === 'granted' || o === 'granted';
    } catch {
      this.motionAllowed = false;
    }
    // re-attach after permission so every browser starts delivering events
    this.listenSensors();
    return this.motionAllowed;
  }

  listenSensors() {
    window.removeEventListener('deviceorientation', this._onOrient);
    window.removeEventListener('devicemotion', this._onMotion);
    window.addEventListener('deviceorientation', this._onOrient);
    window.addEventListener('devicemotion', this._onMotion);
  }

  accelLive() { return this.hasAccel && performance.now() - this.lastMotionAt < 1000; }

  onMotion(e) {
    const now = performance.now();
    const a = e.accelerationIncludingGravity;
    let mag;
    if (a && a.x != null) {
      mag = Math.hypot(a.x, a.y, a.z);
    } else {
      // Some devices only report acceleration without gravity: project it on
      // world-up from the orientation sensor and rebuild a magnitude.
      const l = e.acceleration;
      if (!l || l.x == null || now - this.upAt > 500) return;
      const u = this.upDev;
      mag = this.body.rest + (l.x * u[0] + l.y * u[1] + l.z * u[2]);
    }
    if (!Number.isFinite(mag)) return;
    this.hasAccel = true;
    this.lastMotionAt = now;
    this.body.sample(mag, now / 1000);
  }

  onOrientation(e) {
    if (e.beta == null && e.gamma == null) return;
    this.hasMotion = true;
    this.lastOrientationAt = performance.now();
    const a = (e.alpha || 0) * D2R, b = (e.beta || 0) * D2R, g = (e.gamma || 0) * D2R;
    const orient = screenAngle();
    // Full orientation for VR head tracking (same maths as three's old DeviceOrientationControls).
    this._euler.set(b, a, -g, 'YXZ');
    this.deviceQuat.setFromEuler(this._euler);
    this.deviceQuat.multiply(Q_BACK);
    this.deviceQuat.multiply(this._q0.setFromAxisAngle(ZEE, -orient));
    // Steering tilt: world "up" expressed in screen coordinates. Works in
    // portrait or landscape, phone held flat or upright.
    const cb = Math.cos(b);
    const ux = -cb * Math.sin(g), uy = Math.sin(b);
    this.upDev[0] = ux; this.upDev[1] = uy; this.upDev[2] = cb * Math.cos(g);
    this.upAt = performance.now();
    const sx = ux * Math.cos(orient) - uy * Math.sin(orient);
    const ang = Math.asin(clamp(-sx, -1, 1));
    const dead = 2.5 * D2R, full = 22 * D2R;
    const v = Math.abs(ang) < dead ? 0 : (ang - Math.sign(ang) * dead) / (full - dead);
    this.tilt = clamp(v, -1, 1);
  }

  motionLive() { return this.hasMotion && performance.now() - this.lastOrientationAt < 1000; }
}
