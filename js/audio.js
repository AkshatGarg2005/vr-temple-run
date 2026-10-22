// All sound is synthesised with WebAudio: a tribal drum groove whose tempo
// follows the run speed, a low drone, and effects for every action.
export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.musicOn = false;
    this.tempo = 112;
    this.intensity = 0;
  }

  init() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.8 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    // temple reverb from a synthetic impulse
    const len = ctx.sampleRate * 2.2;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    this.wet = ctx.createGain(); this.wet.gain.value = 0.28;
    this.reverb.connect(this.wet).connect(this.master);
    this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master); this.sfx.connect(this.reverb);
    this.mus = ctx.createGain(); this.mus.gain.value = 0.55;
    this.mus.connect(this.master); this.mus.connect(this.reverb);
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.05);
  }

  now() { return this.ctx.currentTime; }

  tone(freq, t, dur, { type = 'sine', gain = 0.3, to = null, out = this.sfx, attack = 0.005 } = {}) {
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.05);
  }

  noise(t, dur, { gain = 0.3, type = 'bandpass', f = 1000, to = null, q = 1, out = this.sfx } = {}) {
    const c = this.ctx;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf;
    const fl = c.createBiquadFilter(); fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f, t);
    if (to) fl.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl).connect(g).connect(out);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }

  ok() { return this.ctx && this.enabled; }

  coin(streak = 0) {
    if (!this.ok()) return;
    const t = this.now();
    const base = 1318 * Math.pow(2, (streak % 8) / 24);
    this.tone(base, t, 0.09, { type: 'triangle', gain: 0.12 });
    this.tone(base * 1.5, t + 0.05, 0.22, { type: 'sine', gain: 0.1 });
  }
  jump() { if (!this.ok()) return; const t = this.now(); this.noise(t, 0.25, { f: 500, to: 2400, gain: 0.18, q: 2 }); }
  slide() { if (!this.ok()) return; const t = this.now(); this.noise(t, 0.45, { type: 'lowpass', f: 1800, to: 300, gain: 0.22 }); }
  turn() { if (!this.ok()) return; const t = this.now(); this.noise(t, 0.3, { f: 1600, to: 500, gain: 0.14, q: 1.5 }); }
  land() { if (!this.ok()) return; const t = this.now(); this.tone(120, t, 0.12, { to: 60, gain: 0.25 }); }
  // "now" cue for hints: rising for jump, falling for slide/crouch
  hint(action) {
    if (!this.ok()) return;
    const t = this.now();
    const [a, b] = action === 'jump' ? [660, 990] : [990, 560];
    this.tone(a, t, 0.09, { type: 'triangle', gain: 0.2 });
    this.tone(b, t + 0.08, 0.14, { type: 'triangle', gain: 0.2 });
  }
  power() {
    if (!this.ok()) return;
    const t = this.now();
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, t + i * 0.07, 0.25, { type: 'triangle', gain: 0.12 }));
  }
  roar() {
    if (!this.ok()) return;
    const c = this.ctx, t = this.now();
    const o = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), fl = c.createBiquadFilter(), g = c.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(260, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.7);
    lfo.frequency.value = 28; lg.gain.value = 40;
    lfo.connect(lg).connect(o.frequency);
    fl.type = 'bandpass'; fl.frequency.value = 900; fl.Q.value = 1.4;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(fl).connect(g).connect(this.sfx);
    o.start(t); lfo.start(t); o.stop(t + 0.85); lfo.stop(t + 0.85);
  }
  stumble() {
    if (!this.ok()) return;
    const t = this.now();
    this.tone(90, t, 0.25, { to: 45, gain: 0.4 });
    this.noise(t, 0.2, { type: 'lowpass', f: 700, gain: 0.3 });
    setTimeout(() => this.roar(), 120);
  }
  death(type) {
    if (!this.ok()) return;
    const t = this.now();
    this.tone(70, t, 0.9, { to: 30, gain: 0.55 });
    this.noise(t, 0.6, { type: 'lowpass', f: 1200, to: 120, gain: 0.4 });
    if (type === 'fall') this.noise(t + 0.1, 1.6, { f: 900, to: 200, gain: 0.18, q: 3 });
    if (type === 'fire') this.noise(t, 0.8, { type: 'highpass', f: 2000, gain: 0.2 });
  }

  // ---- music ----
  startMusic() {
    if (!this.ctx || this.musicOn) return;
    this.musicOn = true;
    const c = this.ctx;
    this.step = 0;
    this.nextT = c.currentTime + 0.1;
    // drone
    this.drone = [];
    const dg = c.createGain(); dg.gain.value = 0.0001;
    dg.gain.setTargetAtTime(0.05, c.currentTime, 1.5);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    lp.connect(dg).connect(this.mus);
    for (const [f, d] of [[55, -6], [55, 7], [82.4, 3]]) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d;
      o.connect(lp); o.start();
      this.drone.push(o);
    }
    this.droneGain = dg;
    this.timer = setInterval(() => this.schedule(), 40);
  }
  stopMusic() {
    if (!this.musicOn) return;
    this.musicOn = false;
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.droneGain.gain.setTargetAtTime(0.0001, t, 0.3);
    for (const o of this.drone) o.stop(t + 1.5);
  }
  schedule() {
    const c = this.ctx;
    const spb = 60 / this.tempo / 4;
    while (this.nextT < c.currentTime + 0.12) {
      this.hit(this.step % 16, this.nextT, Math.floor(this.step / 16));
      this.nextT += spb;
      this.step++;
    }
  }
  hit(s, t, bar) {
    if (!this.enabled) return;
    const out = this.mus;
    const I = this.intensity;
    if ([0, 6, 8, 11].includes(s)) this.tone(85, t, 0.32, { to: 48, gain: 0.5, out });
    if ([4, 12].includes(s)) { this.tone(190, t, 0.18, { to: 120, gain: 0.26, out }); this.noise(t, 0.08, { f: 1800, gain: 0.12, q: 0.8, out }); }
    if (s === 14 || (s === 15 && bar % 2)) this.tone(160, t, 0.15, { to: 110, gain: 0.2, out });
    if (s % 2 === 0) this.noise(t, 0.05, { type: 'highpass', f: 6000, gain: s % 4 === 2 ? 0.07 : 0.035, out });
    if (I > 0.5 && s % 2 === 1) this.noise(t, 0.04, { type: 'highpass', f: 7000, gain: 0.04 * I, out });
    // sparse flute line on A minor pentatonic
    if (s === 0 && bar % 2 === 0) {
      const scale = [220, 261.6, 293.7, 329.6, 392, 440, 523.3];
      const f = scale[Math.floor(Math.random() * scale.length)];
      this.tone(f * 2, t, 0.9, { type: 'sine', gain: 0.05, out, attack: 0.06 });
      this.tone(f * 2 * 1.5, t + 0.45, 0.7, { type: 'sine', gain: 0.03, out, attack: 0.05 });
    }
  }
  setPace(speed01, intensity) {
    this.tempo = 108 + speed01 * 46;
    this.intensity = intensity;
  }
}
