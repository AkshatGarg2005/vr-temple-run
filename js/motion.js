// Real-body jump / crouch detection from the phone's accelerometer, for
// phone VR where the phone is strapped to the player's head.
//
// Vertical acceleration is taken from the *strength* of the measured
// acceleration (|a| minus gravity). Jumps and crouches are almost purely
// vertical, so this works however the phone sits in the headset and doesn't
// depend on axis or sign conventions, which differ between iOS and Android.
//
// Jump:   a push-off (|a| above gravity) followed by free fall (|a| near 0).
// Crouch: the head moving down with real speed *and* real distance, from a
//         leaky integral of vertical acceleration (no long-term drift).
//         Needing both rejects nodding and small bobbing.
//
// A short calibration (stand still, jump once, crouch once) adapts the
// thresholds to the player's own movements and the phone's sensor.
const G = 9.81;
const TAU_V = 0.8;     // leak of the velocity estimate (s)
const TAU_Z = 1.2;     // leak of the displacement estimate (s)

export const SENSITIVITY = { low: 0.75, normal: 1, high: 1.35 };
export const DEFAULTS = { ffDepth: 4.8, ffTime: 0.05, push: 3.0, crouchV: 0.4, crouchZ: 0.08 };

export class BodyMotion {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.enabled = false;
    this.scale = 1;
    this.th = { ...DEFAULTS };
    this.calibrated = false;
    this.rest = G;          // |a| when still (absorbs per-device sensor bias)
    this.mag = G;
    this.av = 0;            // vertical acceleration, + = up
    this.v = 0;             // estimated vertical velocity of the head (m/s)
    this.z = 0;             // estimated vertical displacement of the head (m)
    this.zRef = 0;          // recent highest head position
    this.drop = 0;          // how far the head is below zRef (<= 0)
    this.settleAt = 0;
    this.samples = 0;
    this.last = 0;
    this.lastEvent = '';
    this.lastEventAt = 0;
    this.pushT = -9; this.ffStart = -1;
    this.jumpCool = 0; this.crouchBlockUntil = 0; this.crouched = false;
    this.capture = null;
  }

  setSensitivity(name) { this.scale = SENSITIVITY[name] || 1; }

  // Effective thresholds after the sensitivity setting (higher = easier).
  cfg() {
    const s = this.scale, t = this.th;
    return { ffMag: this.rest - t.ffDepth / s, ffTime: t.ffTime / s, push: t.push / s, crouchV: t.crouchV / s, crouchZ: t.crouchZ / s };
  }

  reset() {
    this.pushT = -9; this.ffStart = -1; this.crouched = false; this.v = 0; this.z = 0; this.zRef = 0; this.drop = 0;
    this.jumpCool = 0.3; this.crouchBlockUntil = this.last + 0.3;
  }

  // mag: |accelerationIncludingGravity| in m/s^2. now: seconds.
  sample(mag, now) {
    const dt = this.last ? Math.min(0.05, Math.max(0.004, now - this.last)) : 1 / 60;
    this.last = now;
    this.samples++;
    this.mag = mag;
    if (this.samples < 5) this.rest = mag;
    // track resting gravity only while nearly still
    if (Math.abs(mag - this.rest) < 0.5) this.rest += (mag - this.rest) * (1 - Math.exp(-dt / 2.5));
    const av = mag - this.rest;
    this.av = av;

    this.v = (this.v + av * dt) * Math.exp(-dt / TAU_V);
    this.z = (this.z + this.v * dt) * Math.exp(-dt / TAU_Z);
    // after a landing the head is still again: drop what the jump left behind
    if (this.settleAt && now >= this.settleAt) { this.v = 0; this.z = 0; this.zRef = 0; this.settleAt = 0; }
    // depth of a crouch = drop from where the head recently was, so leftovers
    // from an earlier movement can't hide (or fake) a crouch
    if (this.z > this.zRef) this.zRef = this.z;
    else this.zRef += (this.z - this.zRef) * (1 - Math.exp(-dt / 0.9));
    this.drop = this.z - this.zRef;

    if (this.capture) this.captureSample(now, mag, av);
    this.jumpCool -= dt;
    if (!this.enabled || this.samples < 20) return;
    const c = this.cfg();

    // jump: push-off, then a real free-fall phase
    if (av > c.push) this.pushT = now;
    if (mag < c.ffMag) {
      if (this.ffStart < 0) this.ffStart = now;
      if (now - this.ffStart >= c.ffTime && now - this.pushT < 0.65 && this.jumpCool <= 0) {
        this.jumpCool = 0.7;
        this.crouchBlockUntil = now + 0.9;  // the landing must not read as a crouch
        this.settleAt = now + 0.6;
        this.emit('jump', now);
      }
    } else {
      this.ffStart = -1;
    }

    // crouch: head moving down fast enough and far enough
    if (!this.crouched && now > this.crouchBlockUntil && this.v < -c.crouchV && this.drop < -c.crouchZ) {
      this.crouched = true;
      this.emit('crouch', now);
    }
    if (this.crouched && this.v > -c.crouchV * 0.3 && this.drop > -c.crouchZ * 0.5) this.crouched = false;
  }

  emit(type, now) {
    this.lastEvent = type;
    this.lastEventAt = now;
    this.onEvent(type);
  }

  // ---------------------------------------------------------------- calibration
  // kind: 'still' | 'jump' | 'crouch'. Poll captureResult() until it returns non-null.
  beginCapture(kind) {
    this.capture = { kind, t0: this.last, samples: [], peakT: -1, result: null };
    this.v = 0; this.z = 0; this.zRef = 0; this.drop = 0;
  }
  cancelCapture() { this.capture = null; }

  captureSample(now, mag, av) {
    const C = this.capture;
    C.samples.push([now, mag, av, this.v, this.drop]);
    if (C.samples.length > 900) C.samples.shift();
    const age = now - C.t0;
    if (C.kind === 'still') {
      if (age >= 2) {
        const mags = C.samples.map((s) => s[1]);
        const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
        const sd = Math.sqrt(mags.reduce((a, b) => a + (b - mean) ** 2, 0) / mags.length);
        this.rest = mean;
        C.result = { ok: true, rest: mean, noise: sd };
      }
      return;
    }
    if (C.kind === 'jump') {
      // wait for a clear unloading of the sensor, then analyse around it
      if (C.peakT < 0 && mag < this.rest - 3.0 && age > 0.3) C.peakT = now;
      if (C.peakT >= 0 && now - C.peakT > 0.6) C.result = this.analyseJump(C);
      else if (age > 9) C.result = { ok: false };
      return;
    }
    if (C.kind === 'crouch') {
      if (C.peakT < 0 && this.v < -0.2 && this.drop < -0.03 && age > 0.3) C.peakT = now;
      if (C.peakT >= 0 && now - C.peakT > 0.8) C.result = this.analyseCrouch(C);
      else if (age > 9) C.result = { ok: false };
    }
  }

  analyseJump(C) {
    const S = C.samples.filter((s) => s[0] >= C.peakT - 0.8 && s[0] <= C.peakT + 0.6);
    let minMag = Infinity, minT = 0;
    for (const s of S) if (s[1] < minMag) { minMag = s[1]; minT = s[0]; }
    let push = 0;
    for (const s of S) if (s[0] < minT && s[2] > push) push = s[2];
    const depth = this.rest - minMag;               // how far |a| dropped
    const low = this.rest - depth * 0.55;
    // contiguous time spent below `low` around the deepest point
    let i = S.findIndex((s) => s[0] === minT), a = i, b = i;
    while (a > 0 && S[a - 1][1] < low) a--;
    while (b < S.length - 1 && S[b + 1][1] < low) b++;
    const air = S[b][0] - S[a][0];
    this.th.ffDepth = Math.min(Math.max(depth * 0.55, 2.5), 6.5);
    this.th.ffTime = Math.min(Math.max(air * 0.45, 0.025), 0.08);
    this.th.push = Math.min(Math.max(push * 0.4, 1.2), 4);
    return { ok: true, depth, air, push };
  }

  analyseCrouch(C) {
    const S = C.samples.filter((s) => s[0] >= C.peakT - 0.6 && s[0] <= C.peakT + 0.8);
    let vmin = 0, zmin = 0;
    for (const s of S) { if (s[3] < vmin) vmin = s[3]; if (s[4] < zmin) zmin = s[4]; }
    this.th.crouchV = Math.min(Math.max(-vmin * 0.5, 0.15), 0.6);
    this.th.crouchZ = Math.min(Math.max(-zmin * 0.45, 0.04), 0.2);
    return { ok: true, speed: -vmin, depth: -zmin };
  }

  captureResult() {
    const C = this.capture;
    if (!C || !C.result) return null;
    this.capture = null;
    return C.result;
  }
}
