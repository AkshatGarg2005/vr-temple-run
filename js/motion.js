// Real-body jump / crouch detection from the phone's accelerometer, for
// phone VR where the phone is strapped to the player's head.
//
// Vertical acceleration is taken from the *strength* of the measured
// acceleration (|a| minus gravity). Jumps and crouches are almost purely
// vertical, so this works however the phone sits in the headset and doesn't
// depend on axis or sign conventions, which differ between iOS and Android.
//
// Jump:   a push-off (|a| above gravity) followed by free fall (|a| near 0).
//         A single wobbly reading mid-air (strap or viewer bounce) doesn't
//         cancel the free fall, and air time is measured from the number of
//         readings as well as the clock, because a busy phone delivers sensor
//         readings late and in bunches.
// Crouch: the head moving down with real speed *and* real distance, from a
//         leaky integral of vertical acceleration (no long-term drift).
//         Needing both rejects nodding and small bobbing.
//
// A short calibration (stand still, jump once, crouch once) adapts the
// thresholds to the player's own movements and the phone's sensor. It can
// only make a jump easier to detect than the defaults, never harder, so a
// big calibration jump doesn't cause small hops to be missed later.
const G = 9.81;
const TAU_V = 0.8;     // leak of the velocity estimate (s)
const TAU_Z = 1.2;     // leak of the displacement estimate (s)
const STILL_SD = 0.45; // |a| spread (m/s^2) below which the phone counts as still

export const SENSITIVITY = { low: 0.75, normal: 1, high: 1.35 };
export const DEFAULTS = { ffDepth: 4.5, ffTime: 0.04, push: 2.5, crouchV: 0.4, crouchZ: 0.08 };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class BodyMotion {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.enabled = false;
    this.scale = 1;
    this.th = { ...DEFAULTS };
    this.calibrated = false;
    this.rest = G;          // |a| when still (absorbs per-device sensor bias)
    this.mag = G;
    this.mMean = G;         // short-term mean and variance of |a|, to tell when the phone is still
    this.mVar = 1;
    this.period = 1 / 60;   // typical time between sensor readings
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
    this.pushT = -9;
    this.ffStart = -1; this.ffLow = -1; this.ffN = 0;
    this.jumpCool = 0; this.crouchBlockUntil = 0; this.crouched = false; this.crouchAt = -9;
    this.capture = null;
  }

  setSensitivity(name) { this.scale = SENSITIVITY[name] || 1; }

  // Effective thresholds after the sensitivity setting (higher = easier).
  cfg() {
    const s = this.scale, t = this.th;
    return {
      ffMag: this.rest - Math.max(t.ffDepth / s, 2.8),
      ffTime: Math.max(t.ffTime / s, 0.02),
      push: Math.max(t.push / s, 1),
      crouchV: t.crouchV / s,
      crouchZ: t.crouchZ / s,
    };
  }

  reset() {
    this.pushT = -9; this.ffStart = -1; this.crouched = false; this.crouchAt = -9; this.v = 0; this.z = 0; this.zRef = 0; this.drop = 0;
    this.jumpCool = 0.3; this.crouchBlockUntil = this.last + 0.3;
  }

  // mag: |accelerationIncludingGravity| in m/s^2. now: seconds.
  sample(mag, now) {
    const raw = this.last ? now - this.last : 1 / 60;
    // readings delivered in a bunch arrive almost together; the average gap
    // between them is still the sensor's real rate
    if (this.last && raw > 0 && raw < 0.25) this.period = clamp(this.period + (raw - this.period) * 0.03, 0.004, 0.06);
    const dt = clamp(raw, 0.0005, 0.05);
    this.last = now;
    this.samples++;
    this.mag = mag;

    // resting gravity: learnt only while the phone is still, so a bad first
    // reading (the phone still being put in the headset) can't stick
    if (this.samples < 3) this.mMean = mag;
    const k = 1 - Math.exp(-dt / 0.4);
    const dev = mag - this.mMean;
    this.mMean += dev * k;
    this.mVar += (dev * dev - this.mVar) * k;
    if (this.samples > 10 && this.mVar < STILL_SD * STILL_SD && Math.abs(dev) < 1) {
      this.rest += (this.mMean - this.rest) * (1 - Math.exp(-dt / 2));
    }
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

    // jump: push-off, then a real free-fall phase. The landing of the last
    // jump (during the cooldown) doesn't count as a new push-off. Standing up
    // quickly from a crouch briefly unloads the sensor too, so just after a
    // crouch only a near-complete free fall counts.
    if (av > c.push && this.jumpCool <= 0) this.pushT = now;
    const ffMag = now - this.crouchAt < 1.6 ? Math.min(c.ffMag, this.rest - 7) : c.ffMag;
    if (mag < ffMag) {
      if (this.ffStart < 0) { this.ffStart = now; this.ffN = 0; }
      this.ffN++;
      this.ffLow = now;
    } else if (this.ffStart >= 0 && (av > -2.5 || now - this.ffLow > 0.035)) {
      // back on the ground (or never left it). A hop that got close to
      // counting still mustn't have its landing read as a crouch.
      if (this.ffStart - this.pushT < 0.6) this.crouchBlockUntil = Math.max(this.crouchBlockUntil, now + 0.5);
      this.ffStart = -1;
    }
    if (this.ffStart >= 0) {
      const air = Math.max(this.ffLow - this.ffStart, (this.ffN - 1) * this.period);
      if (air >= c.ffTime && this.ffStart - this.pushT < 0.6 && this.jumpCool <= 0) {
        this.jumpCool = 0.7;
        this.crouchBlockUntil = now + 0.9;  // the landing must not read as a crouch
        this.settleAt = now + 0.6;
        this.ffStart = -1;
        this.pushT = -9;
        this.emit('jump', now);
      }
    }

    // crouch: head moving down fast enough and far enough
    if (!this.crouched && now > this.crouchBlockUntil && this.v < -c.crouchV && this.drop < -c.crouchZ) {
      this.crouched = true;
      this.crouchAt = now;
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
      // wait for ~1.2 s of real stillness (the player may still be putting
      // the headset on); give up after 6 s and keep the learnt value
      if (age < 1.5) return;
      const recent = C.samples.filter((s) => s[0] >= now - 1.2).map((s) => s[1]);
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length);
      if (sd < STILL_SD) {
        this.rest = mean;
        C.result = { ok: true, rest: mean, noise: sd };
      } else if (age > 6) {
        C.result = { ok: false, rest: this.rest, noise: sd };
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
    const air = Math.max(S[b][0] - S[a][0], (b - a) * this.period);
    // only ever loosen the defaults: game hops are often smaller than the
    // calibration jump
    this.th.ffDepth = clamp(depth * 0.5, 3.5, DEFAULTS.ffDepth);
    this.th.ffTime = clamp(air * 0.4, 0.025, DEFAULTS.ffTime);
    this.th.push = clamp(push * 0.35, 1.5, DEFAULTS.push);
    return { ok: true, depth, air, push };
  }

  analyseCrouch(C) {
    const S = C.samples.filter((s) => s[0] >= C.peakT - 0.6 && s[0] <= C.peakT + 0.8);
    let vmin = 0, zmin = 0;
    for (const s of S) { if (s[3] < vmin) vmin = s[3]; if (s[4] < zmin) zmin = s[4]; }
    this.th.crouchV = clamp(-vmin * 0.5, 0.15, 0.6);
    this.th.crouchZ = clamp(-zmin * 0.45, 0.04, 0.2);
    return { ok: true, speed: -vmin, depth: -zmin };
  }

  captureResult() {
    const C = this.capture;
    if (!C || !C.result) return null;
    this.capture = null;
    return C.result;
  }
}
