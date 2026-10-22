// Lightweight CPU particle systems (coin sparkles, embers, dust) and GPU
// pollen motes drifting through the sunlight around the camera.
import * as THREE from 'three';

const VERT = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    vAlpha = aAlpha; vColor = aColor;
  }`;
const FRAG = /* glsl */`
  uniform sampler2D uTex;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 t = texture2D(uTex, gl_PointCoord);
    gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
  }`;

export class Particles {
  constructor(scene, tex, n = 600, additive = true) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { uTex: { value: tex }, uScale: { value: 600 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
    this.geo = g;
  }

  emit(x, y, z, vx, vy, vz, r, g, b, life, s0, s1 = s0 * 0.2, alpha = 1, grav = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.life[i] = life; this.max[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = alpha; this.grav[i] = grav;
  }

  burst(p, count, color, speed, life, size, grav = -6, spreadUp = 1) {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1;
      const s = speed * (0.4 + Math.random() * 0.6);
      const h = Math.sqrt(1 - u * u);
      this.emit(p.x, p.y, p.z, Math.cos(a) * h * s, (Math.abs(u) * spreadUp + 0.2) * s, Math.sin(a) * h * s,
        color.r, color.g, color.b, life * (0.6 + Math.random() * 0.4), size * (0.6 + Math.random() * 0.6), size * 0.1, 1, grav);
    }
  }

  update(dt) {
    const { n, pos, vel, life, max, size, alpha, s0, s1, a0, grav } = this;
    for (let i = 0; i < n; i++) {
      if (life[i] <= 0) { if (alpha[i] !== 0) { alpha[i] = 0; size[i] = 0; } continue; }
      life[i] -= dt;
      const k = 1 - Math.max(0, life[i]) / max[i];
      vel[i * 3 + 1] += grav[i] * dt;
      const drag = Math.exp(-1.6 * dt);
      vel[i * 3] *= drag; vel[i * 3 + 2] *= drag;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      size[i] = s0[i] + (s1[i] - s0[i]) * k;
      alpha[i] = a0[i] * (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85);
    }
    const a = this.geo.attributes;
    a.position.needsUpdate = true; a.aSize.needsUpdate = true; a.aAlpha.needsUpdate = true; a.aColor.needsUpdate = true;
  }

  setScale(px) { this.uniforms.uScale.value = px; }
}

// Pollen / firefly motes that wrap around the camera — zero CPU per frame.
export function createMotes(scene, tex, count = 420) {
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 70;
    pos[i * 3 + 1] = -6 + Math.random() * 22;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 70;
    seed[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const uniforms = { uTex: { value: tex }, uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uScale: { value: 600 } };
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime, uScale;
      uniform vec3 uCenter;
      varying float vA; varying float vWarm;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * (0.3 + aSeed * 0.4) + aSeed * 40.0) * 1.5;
        p.y += sin(uTime * (0.5 + aSeed * 0.3) + aSeed * 17.0) * 0.8;
        p.z += cos(uTime * (0.25 + aSeed * 0.35) + aSeed * 23.0) * 1.5;
        p.xz = uCenter.xz + mod(p.xz - uCenter.xz + 35.0, 70.0) - 35.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 0.55 + 0.45 * sin(uTime * (2.0 + aSeed * 3.0) + aSeed * 60.0);
        float s = aSeed > 0.92 ? 0.22 : 0.07;
        gl_PointSize = s * uScale / max(0.1, -mv.z);
        vA = tw * smoothstep(40.0, 8.0, length(mv.xyz)) * (aSeed > 0.92 ? 1.0 : 0.6);
        vWarm = aSeed;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex;
      varying float vA; varying float vWarm;
      void main() {
        vec4 t = texture2D(uTex, gl_PointCoord);
        vec3 c = vWarm > 0.92 ? vec3(2.4, 2.2, 0.8) : vec3(1.6, 1.25, 0.85);
        gl_FragColor = vec4(c * t.rgb, t.a * vA);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = 11;
  scene.add(pts);
  return { points: pts, uniforms };
}
