// Sky, aerial perspective and the far-away world: a sunset dome, layered
// mountain silhouettes with distant pyramids, a sea of clouds under the
// bridges and an endless jungle canopy far below.
import * as THREE from 'three';
import { PALETTE, SUN_DIR, rng } from './config.js';

const v3 = (c) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;

// One sky function shared by the dome, the fog and the cloud sea, so distant
// geometry always dissolves into exactly the colour of the sky behind it.
export const SKY_GLSL = /* glsl */`
const vec3 RR_SUN = vec3(${SUN_DIR.x.toFixed(4)}, ${SUN_DIR.y.toFixed(4)}, ${SUN_DIR.z.toFixed(4)});
vec3 rrSky(vec3 dir) {
  float up = clamp(dir.y, 0.0, 1.0);
  float dn = clamp(-dir.y, 0.0, 1.0);
  vec3 col = mix(${v3(PALETTE.horizon)}, ${v3(PALETTE.upper)}, smoothstep(0.0, 0.28, up));
  col = mix(col, ${v3(PALETTE.zenith)}, smoothstep(0.22, 0.9, up));
  col = mix(col, ${v3(PALETTE.belowHorizon)}, smoothstep(0.0, 0.06, dn));
  col = mix(col, ${v3(PALETTE.abyss)}, smoothstep(0.06, 0.55, dn));
  float sd = max(dot(dir, RR_SUN), 0.0);
  col += ${v3(PALETTE.sunGlow)} * (pow(sd, 5.0) * 0.5 + pow(sd, 40.0) * 0.9) * (1.0 - smoothstep(0.0, 0.5, dn) * 0.6);
  return col;
}
`;

// Replace three.js's fog with distance + height fog tinted by rrSky().
export function patchFog() {
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = `#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vRRView;\n#endif\n`;
  C.fog_vertex = `#ifdef USE_FOG\n vFogDepth = - mvPosition.z;\n vRRView = mvPosition.xyz;\n#endif\n`;
  C.fog_pars_fragment = `#ifdef USE_FOG\n uniform vec3 fogColor;\n varying float vFogDepth;\n varying vec3 vRRView;\n` +
    `#ifdef FOG_EXP2\n uniform float fogDensity;\n#else\n uniform float fogNear;\n uniform float fogFar;\n#endif\n` +
    SKY_GLSL + `#endif\n`;
  C.fog_fragment = /* glsl */`
#ifdef USE_FOG
  vec3 rrOff = transpose(mat3(viewMatrix)) * vRRView;
  float rrDist = length(vRRView);
  vec3 rrDir = rrOff / max(rrDist, 1e-3);
  float rrY = cameraPosition.y + rrOff.y;
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * rrDist * rrDist);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, rrDist);
  #endif
  float rrH = smoothstep(-8.0, -115.0, rrY) * smoothstep(4.0, 40.0, rrDist);
  fogFactor = max(fogFactor, rrH * 0.97);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, rrSky(rrDir), fogFactor);
#endif
`;
}

// ---------------------------------------------------------------------------
export function createSky(cloudTex) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uClouds: { value: cloudTex } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
        gl_Position.z = gl_Position.w * 0.99999;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform sampler2D uClouds;
      varying vec3 vDir;
      ${SKY_GLSL}
      void main() {
        vec3 dir = normalize(vDir);
        vec3 col = rrSky(dir);
        float sd = max(dot(dir, RR_SUN), 0.0);
        // clouds projected onto a high plane
        if (dir.y > 0.0) {
          vec2 uv = dir.xz / (dir.y + 0.08) * 0.11 + vec2(uTime * 0.0035, uTime * 0.001);
          float n = texture2D(uClouds, uv).r * 0.65 + texture2D(uClouds, uv * 2.7 + 0.31).r * 0.35;
          float d = smoothstep(0.42, 0.85, n) * smoothstep(0.0, 0.18, dir.y) * (1.0 - smoothstep(0.55, 0.95, dir.y));
          vec3 shade = vec3(0.30, 0.22, 0.30);
          vec3 lit = vec3(1.25, 0.72, 0.42);
          vec3 cc = mix(shade, lit, pow(sd, 3.0) * 0.8 + 0.25 * n);
          cc += vec3(1.6, 1.0, 0.55) * pow(sd, 18.0) * (1.0 - n) * 1.5; // silver lining near the sun
          col = mix(col, cc, d * 0.8);
        }
        // sun disc (HDR so bloom catches it)
        float disc = smoothstep(0.99935, 0.99968, sd);
        col += vec3(28.0, 18.0, 9.0) * disc;
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(2000, 48, 24), mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

// Layered silhouettes (three rings) with a few stepped pyramids on the skyline.
export function createMountains() {
  const group = new THREE.Group();
  const layers = [
    { R: 1500, base: 70, amp: 150, haze: 0.78, color: '#6a5470', seed: 3, pyramids: 3 },
    { R: 1150, base: 35, amp: 95, haze: 0.6, color: '#463a4c', seed: 8, pyramids: 2 },
    { R: 850, base: 6, amp: 60, haze: 0.4, color: '#2b3029', seed: 14, pyramids: 0 },
  ];
  for (const L of layers) {
    const r = rng(L.seed);
    const N = 360;
    const phases = Array.from({ length: 6 }, () => r() * Math.PI * 2);
    const pyr = Array.from({ length: L.pyramids }, () => ({ a: r() * Math.PI * 2, w: 70 + r() * 50, h: 70 + r() * 60 }));
    const pos = [], hv = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      let h = L.base +
        L.amp * (0.5 * Math.abs(Math.sin(a * 3 + phases[0])) + 0.3 * Math.abs(Math.sin(a * 7 + phases[1])) +
          0.15 * Math.sin(a * 17 + phases[2]) + 0.08 * Math.sin(a * 41 + phases[3]));
      for (const p of pyr) {
        let d = Math.abs(((a - p.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * L.R;
        const steps = 6;
        if (d < p.w) {
          const step = Math.floor((1 - d / p.w) * steps + 0.999) / steps;
          h = Math.max(h, L.base * 0.4 + p.h * step + (d < p.w * 0.12 ? 10 : 0));
        }
      }
      const x = Math.cos(a) * L.R, z = Math.sin(a) * L.R;
      pos.push(x, h, z, x, -260, z);
      hv.push(1, 0);
    }
    const idx = [];
    for (let i = 0; i < N; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aTop', new THREE.Float32BufferAttribute(hv, 1));
    g.setIndex(idx);
    const col = new THREE.Color(L.color);
    const mat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */`
        attribute float aTop;
        varying vec3 vWorld; varying float vTop;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz; vTop = aTop;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vWorld; varying float vTop;
        ${SKY_GLSL}
        void main() {
          vec3 dir = normalize(vWorld - cameraPosition);
          vec3 sky = rrSky(dir);
          float sd = max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(RR_SUN.x, 0.0, RR_SUN.z))), 0.0);
          vec3 base = ${v3(col)} * (0.8 + 0.5 * pow(sd, 4.0));
          float haze = ${L.haze.toFixed(2)} + (1.0 - smoothstep(-40.0, 120.0, vWorld.y)) * 0.35;
          vec3 c = mix(base, sky, clamp(haze, 0.0, 0.97));
          c += vec3(1.0, 0.55, 0.25) * pow(sd, 10.0) * smoothstep(0.75, 1.0, vTop) * 0.35;
          gl_FragColor = vec4(c, 1.0);
        }`,
      fog: false,
    });
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.renderOrder = -900;
    group.add(m);
  }
  return group;
}

// Two translucent cloud layers under the bridges.
export function createCloudSea(cloudTex) {
  const group = new THREE.Group();
  const uniforms = { uTime: { value: 0 }, uNoise: { value: cloudTex } };
  const layers = [
    { y: -26, scale: 0.0042, alpha: 0.72, speed: 1.0 },
    { y: -44, scale: 0.0028, alpha: 0.9, speed: 0.6 },
  ];
  for (const L of layers) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uScale: { value: L.scale }, uAlpha: { value: L.alpha }, uSpeed: { value: L.speed } },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uScale, uAlpha, uSpeed;
        uniform sampler2D uNoise;
        varying vec3 vWorld;
        ${SKY_GLSL}
        void main() {
          vec2 uv = vWorld.xz * uScale + vec2(uTime * 0.004, uTime * 0.0016) * uSpeed;
          float n = texture2D(uNoise, uv).r * 0.6 + texture2D(uNoise, uv * 2.6 + vec2(0.37, 0.71) - uTime * 0.002).r * 0.4;
          vec3 toP = vWorld - cameraPosition;
          float dist = length(toP);
          vec3 dir = toP / dist;
          vec3 sky = rrSky(dir);
          float sd = max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(RR_SUN.x, 0.0, RR_SUN.z))), 0.0);
          vec3 lit = sky * (0.72 + 0.55 * n) + vec3(1.0, 0.55, 0.28) * pow(sd, 6.0) * n * 0.5;
          float a = smoothstep(0.28, 0.78, n) * uAlpha;
          a *= smoothstep(1500.0, 500.0, dist);
          gl_FragColor = vec4(lit, a);
        }`,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3200, 3200, 1, 1), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = L.y;
    m.renderOrder = -10;
    m.frustumCulled = false;
    group.add(m);
  }
  group.userData.uniforms = uniforms;
  return group;
}

// Low-poly tree with vertex colours. Used for the canopy and on rock spires.
export function treeGeometry(seed, opts = {}) {
  const r = rng(seed);
  const parts = [];
  const trunkH = opts.trunkH ?? 1.0;
  const trunk = new THREE.CylinderGeometry(0.06, 0.12, trunkH, 5, 1).toNonIndexed();
  trunk.translate(0, trunkH / 2, 0);
  paint(trunk, new THREE.Color('#4a3424'));
  parts.push(trunk);
  const greens = ['#3f6b2a', '#4f7d2e', '#2f5a28', '#5d8a34', '#365f30'];
  const blobs = opts.blobs ?? 4;
  for (let i = 0; i < blobs; i++) {
    const b = new THREE.IcosahedronGeometry(0.45 + r() * 0.3, 0);
    const p = b.attributes.position;
    for (let k = 0; k < p.count; k++) {
      p.setXYZ(k, p.getX(k) * (1 + (r() - 0.5) * 0.25), p.getY(k) * (0.75 + (r() - 0.5) * 0.2), p.getZ(k) * (1 + (r() - 0.5) * 0.25));
    }
    const a = r() * Math.PI * 2, rad = i === 0 ? 0 : 0.3 + r() * 0.25;
    b.translate(Math.cos(a) * rad, trunkH + 0.15 + r() * 0.45 - (i === 0 ? 0 : 0.15), Math.sin(a) * rad);
    paint(b, new THREE.Color(greens[Math.floor(r() * greens.length)]).multiplyScalar(0.85 + r() * 0.3));
    parts.push(b);
  }
  const merged = mergeNonIndexed(parts);
  merged.computeVertexNormals();
  return merged;
}

export function paint(geo, color) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

export function mergeNonIndexed(geos) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const g0 of geos) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

// Endless jungle canopy far below: instances wrap around the camera in the
// vertex shader, so the forest never runs out and costs one draw call.
export function createCanopy(count = 520, half = 380) {
  const geo = treeGeometry(5, { trunkH: 1.2, blobs: 5 });
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const wrap = { uWrapCenter: { value: new THREE.Vector2() }, uWrapHalf: { value: half } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wrap);
    shader.vertexShader = 'uniform vec2 uWrapCenter;\nuniform float uWrapHalf;\n' +
      shader.vertexShader.replace('#include <project_vertex>', /* glsl */`
        vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mat4 rrIM = instanceMatrix;
          vec2 rrT = rrIM[3].xz;
          rrT = uWrapCenter + mod(rrT - uWrapCenter + uWrapHalf, 2.0 * uWrapHalf) - uWrapHalf;
          rrIM[3].x = rrT.x; rrIM[3].z = rrT.y;
          mvPosition = rrIM * mvPosition;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
      `);
  };
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const r = rng(99);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const sc = 9 + r() * 12;
    p.set((r() * 2 - 1) * half, -58 - r() * 22, (r() * 2 - 1) * half);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
    s.set(sc * (0.8 + r() * 0.5), sc, sc * (0.8 + r() * 0.5));
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    c.setHSL(0.22 + r() * 0.1, 0.35 + r() * 0.2, 0.42 + r() * 0.25);
    mesh.setColorAt(i, c);
  }
  mesh.frustumCulled = false;
  mesh.userData.wrap = wrap;
  return mesh;
}

export function buildEnvironment(renderer, cloudTex) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const sky = createSky(cloudTex);
  sky.material.depthTest = true;
  envScene.add(sky);
  const rt = pmrem.fromScene(envScene, 0.02, 0.1, 5000);
  pmrem.dispose();
  sky.geometry.dispose();
  sky.material.dispose();
  return rt.texture;
}
