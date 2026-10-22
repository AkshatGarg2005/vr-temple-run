// Rendering pipeline: HDR scene -> bloom -> filmic grade, in mono or
// side-by-side stereo for phone headsets. WebXR bypasses post-processing.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

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
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uExposure, uTime, uStereo, uVignette;
    uniform vec4 uFlash;
    varying vec2 vUv;
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
    void main() {
      vec2 uv = vUv;
      vec3 c = texture2D(tDiffuse, uv).rgb;
      c = aces(c);
      // gentle grade: warm highlights, cool-teal shadows
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(c, c * vec3(0.92, 1.0, 1.06), (1.0 - l) * 0.25);
      c = mix(c, c * vec3(1.05, 1.0, 0.94), l * 0.3);
      c = mix(vec3(l), c, 1.08);
      c = toSRGB(clamp(c, 0.0, 1.0));
      // vignette (per eye in stereo)
      vec2 vu = uv;
      if (uStereo > 0.5) vu.x = fract(uv.x * 2.0);
      vec2 d = vu - 0.5;
      float vig = smoothstep(0.85, 0.2, length(d * vec2(1.0, 0.9)) * (1.0 + uVignette));
      c *= mix(1.0, vig, 0.85);
      c = mix(c, uFlash.rgb, uFlash.a);
      c += (hash(uv * 1000.0 + uTime) - 0.5) * 0.018;
      if (uStereo > 0.5 && abs(uv.x - 0.5) < 0.0015) c = vec3(0.0);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

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
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.62, 0.55, 0.92);
    composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
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

  render(time, flash) {
    const r = this.renderer;
    if (r.xr.isPresenting) {
      r.shadowMap.needsUpdate = true;
      r.render(this.scene, this.camera);
      return;
    }
    if (this.composer) {
      this.grade.uniforms.uTime.value = time % 100;
      this.grade.uniforms.uStereo.value = this.isStereo ? 1 : 0;
      this.grade.uniforms.uExposure.value = r.toneMappingExposure;
      if (flash) this.grade.uniforms.uFlash.value.copy(flash);
      this.composer.render();
    } else {
      this.draw(r, this.scene, this.camera, null);
    }
  }
}
