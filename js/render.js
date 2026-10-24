// Rendering pipeline: HDR scene -> bloom -> filmic grade, in mono or
// side-by-side stereo for phone headsets. WebXR bypasses post-processing.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SUN_DIR } from './config.js';

class ScenePass extends Pass {
  constructor(scene, camera, view) {
    super();
    this.scene = scene; this.camera = camera; this.view = view;
    this.needsSwap = false;
  }
  render(renderer, writeBuffer, readBuffer) {
    const target = this.renderToScreen ? null : readBuffer;
    this.view.draw(renderer, this.scene, this.camera, target);
  }
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uTime: { value: 0 },
    uStereo: { value: 0 },
    uVignette: { value: 0.32 },
    uFlash: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSunL: { value: new THREE.Vector4() },
    uSunR: { value: new THREE.Vector4() },
    uAspect: { value: 1.7 },
    uSpeed: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uExposure, uTime, uStereo, uVignette, uAspect, uSpeed;
    uniform vec4 uFlash, uSunL, uSunR;
    varying vec2 vUv;
    float eOff = 0.0, eW = 1.0;
    vec3 eyeTex(vec2 l) { return texture2D(tDiffuse, vec2(eOff + clamp(l.x, 0.001, 0.999) * eW, clamp(l.y, 0.001, 0.999))).rgb; }
    vec3 rrtOdt(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 aces(vec3 c) {
      const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      c *= uExposure / 0.6;
      return clamp(outM * rrtOdt(inM * c), 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c) {
      return mix(pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
    }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float ghost(vec2 l, vec2 at, float r) { return smoothstep(r, r * 0.5, length((l - at) * vec2(uAspect, 1.0))); }
    void main() {
      vec4 sun = uSunL;
      if (uStereo > 0.5) { eW = 0.5; if (vUv.x >= 0.5) { eOff = 0.5; sun = uSunR; } }
      vec2 l = vec2((vUv.x - eOff) / eW, vUv.y);       // position inside this eye
      vec2 fc = l - 0.5;
      float r2 = dot(fc, fc);
      // Camera-lens effects (colour fringe, glare, flare) are only for a
      // single flat image. In a headset each eye would judge them on its own
      // and the two images would disagree, so stereo skips them entirely.
      bool lens = uStereo < 0.5;
      vec3 c;
      if (lens) {
        vec2 ca = fc * r2 * (0.012 + uSpeed * 0.012);
        c = vec3(eyeTex(l + ca).r, eyeTex(l).g, eyeTex(l - ca).b);
      } else {
        c = eyeTex(l);
      }
      // speed blur: streak the screen edges toward the centre
      if (uSpeed > 0.01) {
        float k = uSpeed * smoothstep(0.06, 0.32, r2);
        vec3 acc = c;
        for (int i = 1; i <= 4; i++) acc += eyeTex(l - fc * (0.02 * float(i) * k));
        c = acc / 5.0;
      }
      // sun glare, anamorphic streak and lens ghosts (only when the sun disc is visible)
      if (lens && sun.z > 0.0) {
        vec2 sp = sun.xy;
        float inside = step(0.0, sp.x) * step(sp.x, 1.0) * step(0.0, sp.y) * step(sp.y, 1.0);
        float vis = sun.z * inside * smoothstep(1.5, 6.0, dot(eyeTex(sp), vec3(0.2126, 0.7152, 0.0722)));
        if (vis > 0.0) {
          vec2 dv = (l - sp) * vec2(uAspect, 1.0);
          float ds = length(dv);
          c += vec3(1.0, 0.74, 0.48) * (exp(-ds * 7.0) * 0.3 + exp(-ds * 2.0) * 0.05) * vis;
          c += vec3(1.0, 0.7, 0.45) * exp(-abs(dv.y) * 140.0) * exp(-abs(dv.x) * 2.2) * 0.35 * vis;
          vec2 ax = vec2(0.5) - sp;
          c += vec3(0.35, 0.65, 1.0) * ghost(l, sp + ax * 0.65, 0.045) * 0.07 * vis;
          c += vec3(1.0, 0.6, 0.3) * ghost(l, sp + ax * 1.25, 0.09) * 0.045 * vis;
          c += vec3(0.6, 1.0, 0.6) * ghost(l, sp + ax * 1.55, 0.022) * 0.09 * vis;
          c += vec3(0.75, 0.5, 1.0) * ghost(l, sp + ax * 2.1, 0.15) * 0.03 * vis;
        }
      }
      c = aces(c);
      // gentle grade: warm highlights, cool-teal shadows
      float lu = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(c, c * vec3(0.92, 1.0, 1.06), (1.0 - lu) * 0.25);
      c = mix(c, c * vec3(1.05, 1.0, 0.94), lu * 0.3);
      c = mix(vec3(lu), c, 1.1);
      c = toSRGB(clamp(c, 0.0, 1.0));
      float vig = smoothstep(0.85, 0.2, length(fc * vec2(1.0, 0.9)) * (1.0 + uVignette));
      c *= mix(1.0, vig, 0.85);
      c = mix(c, uFlash.rgb, uFlash.a);
      c += (hash(vUv * 1000.0 + uTime) - 0.5) * 0.016;
      if (uStereo > 0.5 && abs(vUv.x - 0.5) < 0.0015) c = vec3(0.0);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

// Sun shafts: radial blur of the brightest sky toward the sun's position,
// at half resolution, added back onto the scene before bloom.
class GodRaysPass extends Pass {
  constructor(view) {
    super();
    this.view = view;
    this.needsSwap = false;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.blur = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, uSunL: { value: view.sunL }, uSunR: { value: view.sunR }, uStereo: { value: 0 }, uAspect: { value: 1.7 } },
      vertexShader: GradeShader.vertexShader,
      fragmentShader: /* glsl */`
        uniform sampler2D tScene; uniform vec4 uSunL, uSunR; uniform float uStereo, uAspect;
        varying vec2 vUv;
        const int N = 40;
        void main() {
          float off = 0.0, w = 1.0; vec4 sun = uSunL;
          if (uStereo > 0.5) { w = 0.5; if (vUv.x >= 0.5) { off = 0.5; sun = uSunR; } }
          if (sun.z <= 0.0) { gl_FragColor = vec4(0.0); return; }
          vec2 l = vec2((vUv.x - off) / w, vUv.y);
          vec2 delta = (l - sun.xy) / float(N) * 0.9;
          vec2 p = l; float decay = 1.0; vec3 acc = vec3(0.0);
          for (int i = 0; i < N; i++) {
            p -= delta;
            vec3 s = texture2D(tScene, vec2(off + clamp(p.x, 0.0, 1.0) * w, clamp(p.y, 0.0, 1.0))).rgb;
            acc += s * smoothstep(0.85, 2.4, dot(s, vec3(0.2126, 0.7152, 0.0722))) * decay;
            decay *= 0.963;
          }
          acc /= float(N);
          float d = length((l - sun.xy) * vec2(uAspect, 1.0));
          gl_FragColor = vec4(acc * sun.z * (1.0 - smoothstep(0.05, 1.15, d)), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    }));
    this.add = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tRays: { value: null }, uStrength: { value: 0.62 } },
      vertexShader: GradeShader.vertexShader,
      fragmentShader: /* glsl */`
        uniform sampler2D tRays; uniform float uStrength; varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture2D(tRays, vUv).rgb * vec3(1.0, 0.86, 0.66) * uStrength, 1.0); }`,
      blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    }));
  }
  setSize(w, h) { this.rt.setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2))); }
  render(renderer, writeBuffer, readBuffer) {
    const v = this.view;
    // Screen-space shafts depend on what each eye sees around the sun, so the
    // two eyes would get different light. Flat screen only.
    if (v.isStereo) return;
    if (!(v.sunL.z > 0 || v.sunR.z > 0)) return;
    const u = this.blur.material.uniforms;
    u.tScene.value = readBuffer.texture;
    u.uStereo.value = v.isStereo ? 1 : 0;
    u.uAspect.value = v.eyeAspect;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    this.blur.render(renderer);
    this.add.material.uniforms.tRays.value = this.rt.texture;
    this.add.material.uniforms.uStrength.value = 0.62;
    renderer.setRenderTarget(readBuffer);
    this.add.render(renderer);
    renderer.autoClear = auto;
  }
  dispose() { this.rt.dispose(); }
}

// Places the two eye images side by side.
const StereoComposeShader = {
  uniforms: { tLeft: { value: null }, tRight: { value: null } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tLeft, tRight;
    varying vec2 vUv;
    void main() {
      gl_FragColor = vUv.x < 0.5
        ? texture2D(tLeft, vec2(vUv.x * 2.0, vUv.y))
        : texture2D(tRight, vec2(vUv.x * 2.0 - 1.0, vUv.y));
    }`,
};

export class View {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.stereo = new THREE.StereoCamera();
    this.stereo.aspect = 0.5;
    this.stereo.eyeSep = 0.064;
    this.isStereo = false;
    this.post = true;
    this.samples = 4;
    this.composer = null;
    this.eyes = null;
    this.sunL = new THREE.Vector4();
    this.sunR = new THREE.Vector4();
    this.eyeAspect = 1.7;
    this.raysEnabled = true;
    this.bloomEnabled = true;
    this.compose = new FullScreenQuad(new THREE.ShaderMaterial({ ...StereoComposeShader, uniforms: THREE.UniformsUtils.clone(StereoComposeShader.uniforms), depthTest: false, depthWrite: false }));
  }

  setStereo(on) {
    if (this.isStereo === on) return;
    this.isStereo = on;
    if (this.composer) this.setup(this.post, this.samples);
  }

  setup(post, samples) {
    this.post = post;
    this.samples = samples;
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      this.composer = null;
    }
    if (this.eyes) { for (const e of this.eyes) e.dispose(); this.eyes = null; }
    if (!post) return;
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    // Stereo: each eye gets its own full render target (antialiased), then the
    // pair is copied side by side. Drawing two scissored halves into one
    // multisampled target corrupts the second eye on many phone GPUs.
    if (this.isStereo) {
      const ew = Math.max(1, Math.floor(size.x / 2));
      this.eyes = [0, 1].map(() => new THREE.WebGLRenderTarget(ew, size.y, { type: THREE.HalfFloatType, samples }));
    }
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.isStereo ? 0 : samples });
    const composer = new EffectComposer(r, rt);
    composer.setPixelRatio(1);
    composer.setSize(size.x, size.y);
    composer.addPass(new ScenePass(this.scene, this.camera, this));
    if (this.rays) this.rays.dispose();
    this.rays = new GodRaysPass(this);
    this.rays.enabled = this.raysEnabled;
    composer.addPass(this.rays);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.66, 0.6, 0.9);
    this.bloom.enabled = this.bloomEnabled;
    composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uSunL.value = this.sunL;
    this.grade.uniforms.uSunR.value = this.sunR;
    composer.addPass(this.grade);
    this.composer = composer;
  }

  resize() {
    if (!this.composer) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer.setSize(size.x, size.y);
    if (this.eyes) for (const e of this.eyes) e.setSize(Math.max(1, Math.floor(size.x / 2)), size.y);
  }

  // Draw the scene (mono or stereo) into target (null = canvas).
  draw(renderer, scene, camera, target) {
    renderer.shadowMap.needsUpdate = true;
    if (!this.isStereo) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      return;
    }
    camera.updateMatrixWorld();
    this.stereo.update(camera);
    if (target) {
      const eyes = this.eyes;
      [this.stereo.cameraL, this.stereo.cameraR].forEach((cam, i) => {
        renderer.setRenderTarget(eyes[i]);
        renderer.render(scene, cam);
        renderer.shadowMap.needsUpdate = false;
      });
      const u = this.compose.material.uniforms;
      u.tLeft.value = eyes[0].texture;
      u.tRight.value = eyes[1].texture;
      renderer.setRenderTarget(target);
      this.compose.render(renderer);
    } else {
      renderer.setRenderTarget(null);
      const s = renderer.getSize(new THREE.Vector2());
      renderer.setScissorTest(true);
      for (const [i, cam] of [[0, this.stereo.cameraL], [1, this.stereo.cameraR]]) {
        renderer.setViewport(i * s.x / 2, 0, s.x / 2, s.y);
        renderer.setScissor(i * s.x / 2, 0, s.x / 2, s.y);
        renderer.render(scene, cam);
        renderer.shadowMap.needsUpdate = false;
      }
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, s.x, s.y);
    }
  }

  // Where the sun sits in each eye's image (xy) and how strongly it faces us (z).
  updateSun() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const size = this.renderer.getDrawingBufferSize(_size);
    this.eyeAspect = (size.x * (this.isStereo ? 0.5 : 1)) / Math.max(1, size.y);
    if (this.isStereo) {
      this.stereo.update(cam);
      projectSun(this.stereo.cameraL, this.sunL);
      projectSun(this.stereo.cameraR, this.sunR);
    } else {
      projectSun(cam, this.sunL);
      this.sunR.copy(this.sunL);
    }
  }

  setRays(on) {
    this.raysEnabled = on;
    if (this.rays) this.rays.enabled = on;
  }

  setBloom(on) {
    this.bloomEnabled = on;
    if (this.bloom) this.bloom.enabled = on;
  }

  render(time, flash, speed = 0) {
    const r = this.renderer;
    if (r.xr.isPresenting) {
      r.shadowMap.needsUpdate = true;
      r.render(this.scene, this.camera);
      return;
    }
    if (this.composer) {
      this.updateSun();
      const u = this.grade.uniforms;
      u.uTime.value = time % 100;
      u.uStereo.value = this.isStereo ? 1 : 0;
      u.uExposure.value = r.toneMappingExposure;
      u.uAspect.value = this.eyeAspect;
      u.uSpeed.value = this.isStereo ? 0 : speed;
      if (flash) u.uFlash.value.copy(flash);
      this.composer.render();
    } else {
      this.draw(r, this.scene, this.camera, null);
    }
  }
}

const _size = new THREE.Vector2();
const _pos = new THREE.Vector3(), _sp = new THREE.Vector3(), _inv = new THREE.Matrix4();
function projectSun(cam, out) {
  _pos.setFromMatrixPosition(cam.matrixWorld);
  _sp.copy(SUN_DIR).multiplyScalar(1000).add(_pos);
  _inv.copy(cam.matrixWorld).invert();
  _sp.applyMatrix4(_inv);                    // view space
  if (_sp.z >= -1) { out.set(0, 0, 0, 0); return; }
  const facing = -_sp.z / 1000;
  _sp.applyMatrix4(cam.projectionMatrix);    // NDC
  const x = _sp.x * 0.5 + 0.5, y = _sp.y * 0.5 + 0.5;
  const edge = Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5));
  const k = Math.min(1, facing * 1.4) * (1 - THREE.MathUtils.smoothstep(edge, 0.62, 1.15));
  out.set(x, y, Math.max(0, k), 0);
}
