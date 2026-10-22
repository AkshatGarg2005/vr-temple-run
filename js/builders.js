// Geometry + material factories for every piece of the temple world.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PATH_W, HALF_W, TILE, SLAB_DEPTH, CURB_H, CURB_W, rng } from './config.js';
import * as TX from './textures.js';
import { treeGeometry, paint, mergeNonIndexed, SKY_GLSL } from './atmosphere.js';

// Box with UVs in world units (one texture repeat per `unit` metres).
export function box(w, h, d, x = 0, y = 0, z = 0, unit = 4, off = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * dims[f][0] / unit + off, uv.getY(i) * dims[f][1] / unit + off * 0.7);
    }
  }
  g.translate(x, y, z);
  return g;
}

// Wind sway for foliage: bends vertices by their height above (ferns) or
// below (hanging vines) the attachment point. Shared time uniform.
export const FX_TIME = { value: 0 };
function addSway(mat, amp, hanging) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = FX_TIME;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 rrIP = instanceMatrix[3].xyz;
      #else
        vec3 rrIP = vec3(0.0);
      #endif
      float rrK = ${hanging ? '-min(position.y, 0.0) * 0.35' : 'max(position.y, 0.0)'};
      float rrSw = (sin(uTime * 1.6 + rrIP.x * 0.31 + rrIP.z * 0.23) + 0.4 * sin(uTime * 3.7 + rrIP.z * 0.7)) * ${amp.toFixed(3)} * rrK;
      transformed.x += rrSw;
      transformed.z += rrSw * 0.6;
    `);
  };
  mat.customProgramCacheKey = () => 'sway' + amp + hanging;
  return mat;
}

export function createMaterials(maxAniso) {
  TX.setAnisotropy(Math.min(16, maxAniso));
  const path = TX.pathTextures();
  const wall = TX.wallTextures();
  const junc = TX.junctionTextures();
  const relief = TX.reliefTextures();
  const bark = TX.barkTextures();
  const flame = TX.flameTexture();
  const glow = TX.glowTexture();
  const vineTex = TX.vineTexture();
  const fernTex = TX.fernTexture();

  const M = {
    path: new THREE.MeshStandardMaterial({
      map: path.map, normalMap: path.normalMap, normalScale: new THREE.Vector2(1.15, 1.15),
      aoMap: path.ormMap, aoMapIntensity: 1, roughnessMap: path.ormMap, roughness: 1, metalness: 0,
    }),
    stone: new THREE.MeshStandardMaterial({ map: wall.map, normalMap: wall.normalMap, aoMap: wall.ormMap, roughnessMap: wall.ormMap, roughness: 1, metalness: 0 }),
    stoneDark: new THREE.MeshStandardMaterial({ map: wall.map, normalMap: wall.normalMap, aoMap: wall.ormMap, roughnessMap: wall.ormMap, color: 0x8a7f78, roughness: 1 }),
    junction: new THREE.MeshStandardMaterial({
      map: junc.map, normalMap: junc.normalMap, aoMap: junc.ormMap, roughnessMap: junc.ormMap, metalnessMap: junc.ormMap,
      emissiveMap: junc.emissiveMap, emissive: 0xffa040, emissiveIntensity: 0.7, roughness: 1, metalness: 1,
    }),
    relief: new THREE.MeshStandardMaterial({
      map: relief.map, normalMap: relief.normalMap, emissiveMap: relief.emissiveMap, aoMap: relief.ormMap, roughnessMap: relief.ormMap,
      emissive: 0xff8a2a, emissiveIntensity: 3.4, roughness: 1,
    }),
    bark: new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, roughness: 0.95 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xffc23d, metalness: 1, roughness: 0.18, emissive: 0x8a4a00, emissiveIntensity: 0.45, envMapIntensity: 1.4 }),
    brazier: new THREE.MeshStandardMaterial({ color: 0x3b2a1e, metalness: 0.6, roughness: 0.45 }),
    ember: new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.4, 0.35) }),
    vine: new THREE.MeshStandardMaterial({ color: 0x3d6b2a, roughness: 0.8, side: THREE.DoubleSide }),
    rock: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }),
    flame: new THREE.SpriteMaterial({ map: flame, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, color: new THREE.Color(2.2, 1.6, 1.2) }),
    vineCurtain: addSway(new THREE.MeshStandardMaterial({ map: vineTex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 }), 0.05, true),
    fern: addSway(new THREE.MeshStandardMaterial({ map: fernTex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.7 }), 0.09, false),
    glow, flameTex: flame,
  };
  return M;
}

// ---------------------------------------------------------------------------
// Bridge slabs. A "piece" covers [a, b] metres of a 6 m tile (tile centre at origin).
function slabPiece(a, b, r) {
  const len = b - a, zc = -((a + b) / 2 - TILE / 2);
  const outer = PATH_W + 2 * CURB_W;
  const parts = [
    box(outer, SLAB_DEPTH, len, 0, -SLAB_DEPTH / 2 - 0.01, zc, 4, r()),
    box(outer + 0.32, 0.26, len, 0, -0.34, zc, 4, r()),
    box(outer + 0.18, 0.22, len, 0, -SLAB_DEPTH + 0.12, zc, 4, r()),
  ];
  const blocks = Math.max(1, Math.round(len / 3));
  const bl = len / blocks;
  for (const side of [-1, 1]) {
    for (let i = 0; i < blocks; i++) {
      const z = -((a + bl * (i + 0.5)) - TILE / 2);
      parts.push(box(CURB_W, CURB_H, bl - 0.07, side * (HALF_W + CURB_W / 2), CURB_H / 2, z, 2, r()));
      parts.push(box(CURB_W + 0.1, 0.09, bl - 0.02, side * (HALF_W + CURB_W / 2), CURB_H + 0.045, z, 2, r()));
    }
  }
  return parts;
}
function pathPiece(a, b) {
  const g = new THREE.PlaneGeometry(PATH_W, b - a);
  g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, a / TILE + uv.getY(i) * (b - a) / TILE);
  g.translate(0, 0, -((a + b) / 2 - TILE / 2));
  return g;
}

export function tileGeometries() {
  const r = rng(5);
  return {
    full: { structure: mergeGeometries(slabPiece(0, TILE, r)), top: pathPiece(0, TILE) },
    gap: {
      structure: mergeGeometries([...slabPiece(0, 1.5, r), ...slabPiece(4.5, TILE, r)]),
      top: mergeGeometries([pathPiece(0, 1.5), pathPiece(4.5, TILE)]),
    },
  };
}

export function pillarGeometry() {
  const parts = [
    box(2.2, 0.55, 2.2, 0, -SLAB_DEPTH - 0.27, 0, 4),
    box(1.75, 0.3, 1.75, 0, -SLAB_DEPTH - 0.7, 0, 4),
    box(1.5, 150, 1.5, 0, -SLAB_DEPTH - 75.8, 0, 4),
    box(1.8, 0.5, 1.8, 0, -SLAB_DEPTH - 9, 0, 4),
    box(1.8, 0.5, 1.8, 0, -SLAB_DEPTH - 24, 0, 4),
  ];
  return mergeGeometries(parts);
}

// Junction plaza: slab + corner posts; the top uses the sun-disc material.
export function junctionGeometries() {
  const outer = PATH_W + 2 * CURB_W;
  const parts = [
    box(outer, SLAB_DEPTH, outer, 0, -SLAB_DEPTH / 2 - 0.01, 0, 4),
    box(outer + 0.32, 0.26, outer + 0.32, 0, -0.34, 0, 4),
    box(outer + 0.18, 0.22, outer + 0.18, 0, -SLAB_DEPTH + 0.12, 0, 4),
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (HALF_W + 0.28), z = sz * (HALF_W + 0.28);
      parts.push(box(0.72, 1.25, 0.72, x, 0.62, z, 2));
      parts.push(box(0.92, 0.2, 0.92, x, 1.33, z, 2));
      parts.push(box(0.5, 0.35, 0.5, x, 1.6, z, 2));
    }
  }
  const top = new THREE.PlaneGeometry(PATH_W, PATH_W);
  top.rotateX(-Math.PI / 2);
  const curb = mergeGeometries([
    box(CURB_W, CURB_H, PATH_W - 0.1, 0, CURB_H / 2, 0, 2),
    box(CURB_W + 0.1, 0.09, PATH_W, 0, CURB_H + 0.045, 0, 2),
  ]);
  return { structure: mergeGeometries(parts), top, curb };
}

// ---------------------------------------------------------------------------
// Flame sprite helper: returns a Sprite with flicker metadata.
export function makeFlame(M, scale = 1, rot = 0) {
  const mat = M.flame.clone();
  mat.rotation = rot;
  const s = new THREE.Sprite(mat);
  s.scale.set(0.7 * scale, 1.35 * scale, 1);
  s.userData.base = scale;
  s.userData.phase = Math.random() * 100;
  s.renderOrder = 5;
  return s;
}

export function makeBrazier(M) {
  const g = new THREE.Group();
  const stand = new THREE.Mesh(mergeGeometries([
    new THREE.CylinderGeometry(0.1, 0.16, 0.7, 8).translate(0, 0.35, 0),
    new THREE.CylinderGeometry(0.32, 0.14, 0.26, 10).translate(0, 0.82, 0),
  ]), M.brazier);
  stand.castShadow = true;
  const coals = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.04, 10).translate(0, 0.94, 0), M.ember);
  const flame = makeFlame(M, 0.75);
  flame.position.set(0, 1.4, 0);
  g.add(stand, coals, flame);
  g.userData.flames = [flame];
  g.userData.lightPos = new THREE.Vector3(0, 1.5, 0);
  return g;
}

export function makeFrontWall(M) {
  const g = new THREE.Group();
  const zf = -(HALF_W + 0.25);
  const W = PATH_W + 3.4;
  const body = new THREE.Mesh(mergeGeometries([
    box(W, 7.2, 1.3, 0, 3.6 - 1.4, zf - 0.65, 4),
    box(W + 0.7, 0.6, 1.7, 0, 7.4 - 1.4, zf - 0.65, 4),
    box(W - 1.2, 0.9, 1.3, 0, 8.1 - 1.4, zf - 0.65, 4),
    box(2.8, 1.2, 1.1, 0, 9.1 - 1.4, zf - 0.65, 4),
    box(1.2, 8.2, 1.7, -(W / 2 - 0.3), 4.1 - 1.4, zf - 0.55, 4),
    box(1.2, 8.2, 1.7, (W / 2 - 0.3), 4.1 - 1.4, zf - 0.55, 4),
    box(W, 0.35, 0.3, 0, 6.5 - 1.4, zf + 0.12, 4),
  ]), M.stone);
  body.castShadow = true; body.receiveShadow = true;
  const relief = new THREE.Mesh(new THREE.PlaneGeometry(3.9, 3.9), M.relief);
  relief.position.set(0, 2.55, zf + 0.012);
  g.add(body, relief);
  g.userData.flames = [];
  for (const sx of [-1, 1]) {
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.18, 0.3, 10), M.brazier);
    bowl.position.set(sx * (W / 2 - 0.3), 5.6, zf + 0.6);
    const coal = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 10), M.ember);
    coal.position.set(sx * (W / 2 - 0.3), 5.75, zf + 0.6);
    const f = makeFlame(M, 1.0);
    f.position.set(sx * (W / 2 - 0.3), 6.3, zf + 0.6);
    g.add(bowl, coal, f);
    g.userData.flames.push(f);
  }
  g.userData.lightPos = new THREE.Vector3(0, 4.5, zf + 1.5);
  return g;
}

// ---------------------------------------------------------------------------
// Obstacles (local space: path centred on x, runner approaches from +z)
export function rootGeometry(seed) {
  const r = rng(seed);
  const parts = [];
  for (let k = 0; k < 2; k++) {
    const pts = [];
    const zoff = (k === 0 ? 0 : (r() - 0.5) * 0.7);
    for (let i = 0; i <= 8; i++) {
      const x = -3.1 + i * 6.2 / 8;
      const edge = Math.abs(x) > HALF_W ? 0.35 : 0;
      pts.push(new THREE.Vector3(x, (k === 0 ? 0.3 : 0.17) + edge + Math.sin(i * 1.7 + seed) * 0.08, zoff + Math.sin(i * 2.3 + seed * 3) * 0.25));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    parts.push(new THREE.TubeGeometry(curve, 48, k === 0 ? 0.26 : 0.15, 8, false));
  }
  // knots
  for (let i = 0; i < 3; i++) {
    const s = new THREE.SphereGeometry(0.22 + r() * 0.1, 8, 6);
    s.translate(-1.8 + i * 1.8 + (r() - 0.5), 0.28, (r() - 0.5) * 0.3);
    parts.push(s);
  }
  return mergeGeometries(parts.map((g) => { g.deleteAttribute('tangent'); return g; }));
}

export function makeRoot(M, seed) {
  const m = new THREE.Mesh(rootGeometry(seed), M.bark);
  m.castShadow = true; m.receiveShadow = true;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

export function makeLog(M) {
  const g = new THREE.Group();
  const logGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.36, 0.42, 6.6, 12, 1).rotateZ(Math.PI / 2).translate(0, 1.6, 0),
    new THREE.CylinderGeometry(0.07, 0.13, 0.9, 6).rotateZ(-0.7).translate(-1.2, 2.0, 0.1),
    new THREE.CylinderGeometry(0.06, 0.11, 0.7, 6).rotateZ(0.9).translate(1.5, 1.95, -0.1),
  ]);
  const log = new THREE.Mesh(logGeo, M.bark);
  log.rotation.y = 0.04;
  log.castShadow = true;
  const stumps = new THREE.Mesh(mergeGeometries([
    box(0.9, 1.25, 1.0, -2.8, 0.62, 0, 2), box(1.0, 0.25, 1.1, -2.8, 1.3, 0, 2),
    box(0.9, 1.25, 1.0, 2.8, 0.62, 0, 2), box(1.0, 0.25, 1.1, 2.8, 1.3, 0, 2),
  ]), M.stone);
  stumps.castShadow = true; stumps.receiveShadow = true;
  // hanging moss strands
  const strands = [];
  for (let i = 0; i < 9; i++) {
    const x = -2.2 + i * 0.55;
    const len = 0.25 + Math.random() * 0.35;
    strands.push(new THREE.PlaneGeometry(0.12, len).translate(x, 1.25 - len / 2, 0.2 + (i % 2) * -0.4));
  }
  const moss = new THREE.Mesh(mergeGeometries(strands), M.vine);
  g.add(log, stumps, moss);
  return g;
}

export function makeFireTrap(M) {
  const g = new THREE.Group();
  const stone = new THREE.Mesh(mergeGeometries([
    box(0.85, 3.6, 1.0, -2.85, 1.8, 0, 2), box(1.05, 0.3, 1.2, -2.85, 3.75, 0, 2),
    box(0.85, 3.6, 1.0, 2.85, 1.8, 0, 2), box(1.05, 0.3, 1.2, 2.85, 3.75, 0, 2),
    box(7.0, 0.8, 1.1, 0, 4.3, 0, 4), box(3.2, 0.6, 0.9, 0, 5.0, 0, 4),
  ]), M.stone);
  stone.castShadow = true; stone.receiveShadow = true;
  const mouths = new THREE.Mesh(mergeGeometries([
    box(0.08, 0.36, 0.5, -2.42, 1.6, 0, 1), box(0.08, 0.36, 0.5, 2.42, 1.6, 0, 1),
  ]), M.ember);
  g.add(stone, mouths);
  g.userData.flames = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const f = makeFlame(M, 0.95 - i * 0.08, side < 0 ? -Math.PI / 2 : Math.PI / 2);
      f.position.set(side * (2.05 - i * 0.55), 1.6 + (i % 2) * 0.08, 0);
      f.scale.set(0.9, 1.6, 1);
      f.userData.base = 1.0 - i * 0.07;
      f.userData.jet = true;
      g.add(f);
      g.userData.flames.push(f);
    }
  }
  g.userData.lightPos = new THREE.Vector3(0, 1.8, 0.3);
  return g;
}

export function makeBlock(M) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(mergeGeometries([
    box(1.42, 2.05, 1.3, 0, 1.025, 0, 2),
    box(1.6, 0.22, 1.45, 0, 2.15, 0, 2),
    box(1.1, 0.35, 1.0, 0, 2.43, 0, 2),
  ]), M.stoneDark);
  body.castShadow = true; body.receiveShadow = true;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.3), M.relief);
  face.position.set(0, 1.1, 0.656);
  g.add(body, face);
  return g;
}

export function makeArch(M) {
  const g = new THREE.Group();
  const x = HALF_W + CURB_W / 2;
  const stone = new THREE.Mesh(mergeGeometries([
    box(0.9, 5.6, 0.9, -x - 0.1, 2.8, 0, 2), box(1.1, 0.3, 1.1, -x - 0.1, 5.7, 0, 2),
    box(0.9, 5.6, 0.9, x + 0.1, 2.8, 0, 2), box(1.1, 0.3, 1.1, x + 0.1, 5.7, 0, 2),
    box(PATH_W + 2.8, 0.9, 1.15, 0, 6.3, 0, 4),
    box(PATH_W + 1.4, 0.5, 0.95, 0, 7.0, 0, 4),
    box(1.6, 0.9, 0.8, 0, 7.6, 0, 2),
  ]), M.stone);
  stone.castShadow = true; stone.receiveShadow = true;
  const vines = [];
  const r = rng(Math.floor(Math.random() * 1e6));
  for (let i = 0; i < 7; i++) {
    const vx = -2.6 + r() * 5.2;
    const len = 1.2 + r() * 1.4;
    const pts = [];
    for (let k = 0; k <= 5; k++) pts.push(new THREE.Vector3(vx + Math.sin(k + i) * 0.08, 5.85 - len * k / 5, 0.45 * (r() - 0.5) + 0.3));
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.035, 4, false);
    tube.deleteAttribute('tangent');
    vines.push(tube);
    for (let k = 1; k <= 4; k++) {
      const leaf = new THREE.PlaneGeometry(0.22, 0.14);
      leaf.rotateY(r() * Math.PI);
      leaf.rotateZ((r() - 0.5) * 1.2);
      leaf.translate(pts[k].x + 0.08, pts[k].y, pts[k].z);
      leaf.deleteAttribute('uv');
      leaf.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(8).fill(0), 2));
      vines.push(leaf);
    }
  }
  const vineMesh = new THREE.Mesh(mergeGeometries(vines), M.vine);
  g.add(stone, vineMesh);
  return g;
}

// ---------------------------------------------------------------------------
// Collectibles
export function coinGeometry() {
  const g = mergeGeometries([
    new THREE.CylinderGeometry(0.34, 0.34, 0.07, 22),
    new THREE.TorusGeometry(0.3, 0.035, 6, 22).rotateX(Math.PI / 2).translate(0, 0.04, 0),
    new THREE.TorusGeometry(0.3, 0.035, 6, 22).rotateX(Math.PI / 2).translate(0, -0.04, 0),
  ].map((x) => x.toNonIndexed()));
  g.rotateX(Math.PI / 2);
  return g;
}

export function makeMagnet(M) {
  const g = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xd8262b, metalness: 0.5, roughness: 0.3, emissive: 0x500000 });
  const silver = new THREE.MeshStandardMaterial({ color: 0xe8eef5, metalness: 1, roughness: 0.15 });
  const arc = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.12, 10, 24, Math.PI), red);
  arc.rotation.z = Math.PI;
  const tipGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.2, 12);
  const t1 = new THREE.Mesh(tipGeo, silver); t1.position.set(-0.34, 0.1, 0);
  const t2 = new THREE.Mesh(tipGeo, silver); t2.position.set(0.34, 0.1, 0);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: M.glow, color: new THREE.Color(0.6, 1.6, 3.0), blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  halo.scale.set(2.2, 2.2, 1);
  g.add(arc, t1, t2, halo);
  return g;
}

// ---------------------------------------------------------------------------
// Scenery: rock spires rising from the clouds, some crowned with idol heads.
export function spireGeometry(seed) {
  const r = rng(seed);
  const height = 150;
  const radTop = 4 + r() * 4;
  const cyl = new THREE.CylinderGeometry(radTop, radTop * (0.55 + r() * 0.3), height, 9, 14, false);
  const p = cyl.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const a = Math.atan2(p.getZ(i), p.getX(i));
    const n = 1 + Math.sin(a * 3 + y * 0.07 + seed) * 0.12 + Math.sin(a * 7 - y * 0.13) * 0.07 + (r() - 0.5) * 0.12;
    const bulge = y > height / 2 - 2 ? 1.08 : 1;
    p.setX(i, p.getX(i) * n * bulge);
    p.setZ(i, p.getZ(i) * n * bulge);
    if (y > height / 2 - 0.1) p.setY(i, y + (r() - 0.5) * 0.8);
  }
  cyl.translate(0, -height / 2, 0);
  const rock = cyl.toNonIndexed();
  const rp = rock.attributes.position;
  const col = new Float32Array(rp.count * 3);
  const top = new THREE.Color('#58743a'), hi = new THREE.Color('#9a8774'), lo = new THREE.Color('#4c4048');
  const c = new THREE.Color();
  for (let i = 0; i < rp.count; i += 3) {
    const y = (rp.getY(i) + rp.getY(i + 1) + rp.getY(i + 2)) / 3;
    const t = Math.min(1, -y / 60);
    c.copy(hi).lerp(lo, t).multiplyScalar(0.85 + r() * 0.3);
    if (y > -1.2) c.copy(top).multiplyScalar(0.85 + r() * 0.3);
    for (let k = 0; k < 3; k++) { col[(i + k) * 3] = c.r; col[(i + k) * 3 + 1] = c.g; col[(i + k) * 3 + 2] = c.b; }
  }
  rock.setAttribute('color', new THREE.BufferAttribute(col, 3));
  rock.deleteAttribute('uv');
  rock.deleteAttribute('normal');
  const parts = [rock];
  const trees = 3 + Math.floor(r() * 4);
  for (let i = 0; i < trees; i++) {
    const t = treeGeometry(seed * 10 + i, { trunkH: 1.1, blobs: 4 });
    const s = 2.6 + r() * 2.4;
    t.scale(s, s, s);
    const a = r() * Math.PI * 2, d = r() * radTop * 0.7;
    t.translate(Math.cos(a) * d, -0.3, Math.sin(a) * d);
    t.deleteAttribute('normal');
    parts.push(t);
  }
  const merged = mergeNonIndexed(parts);
  merged.computeVertexNormals();
  merged.userData = { radius: radTop * 1.2 };
  return merged;
}

export function idolGeometry() {
  const stone = new THREE.Color('#8f8070'), dark = new THREE.Color('#3a302a'), moss = new THREE.Color('#5d7a3a');
  const b = (w, h, d, x, y, z, c) => paint(new THREE.BoxGeometry(w, h, d).toNonIndexed().translate(x, y, z), c);
  const parts = [
    b(7, 8, 6.4, 0, 4, 0, stone),
    b(7.6, 1.1, 1.2, 0, 5.6, 3.3, stone),
    b(1.6, 3.4, 1.4, 0, 3.6, 3.6, stone),
    b(4.2, 0.9, 0.8, 0, 1.4, 3.3, dark),
    b(1.3, 2.8, 2.4, -4.0, 4.3, 0.6, stone),
    b(1.3, 2.8, 2.4, 4.0, 4.3, 0.6, stone),
    b(8.4, 1.2, 7.2, 0, 8.6, 0, moss),
    b(5.5, 1.6, 5.5, 0, 9.9, 0, stone),
    b(2.6, 1.6, 2.6, 0, 11.4, 0, stone),
    b(1.6, 1.0, 0.4, -1.9, 4.6, 3.1, dark),
    b(1.6, 1.0, 0.4, 1.9, 4.6, 3.1, dark),
  ];
  const g = mergeNonIndexed(parts);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Foliage geometry
export function vineCurtainGeometry() {
  // two hanging sheets, top edge at y = 0, facing +x (outwards from the bridge)
  const a = new THREE.PlaneGeometry(TILE * 0.95, 3.4).translate(0, -1.7, 0);
  const b = new THREE.PlaneGeometry(TILE * 0.6, 2.4).translate(0.8, -1.2, 0.12);
  const g = mergeGeometries([a, b]);
  g.rotateY(Math.PI / 2);
  return g;
}

export function fernGeometry() {
  const a = new THREE.PlaneGeometry(1.0, 0.8).translate(0, 0.4, 0);
  const b = a.clone().rotateY(Math.PI / 2);
  const c = a.clone().rotateY(Math.PI / 4).scale(0.8, 0.85, 0.8);
  return mergeGeometries([a, b, c]);
}

// ---------------------------------------------------------------------------
// Waterfall: an animated sheet of water falling from a spire into the clouds.
export function waterfallMaterial(noiseTex) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: FX_TIME, uNoise: { value: noiseTex } },
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec3 p = position;
        p.z += (1.0 - uv.y) * (1.0 - uv.y) * 6.0; // the water arcs away from the cliff as it falls
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform sampler2D uNoise;
      varying vec2 vUv; varying vec3 vWorld;
      ${SKY_GLSL}
      void main() {
        float y = 1.0 - vUv.y;                 // 0 at the lip, 1 at the bottom
        // long vertical ribbons of water sliding down at different speeds
        vec2 uv1 = vec2(vUv.x * 3.5, y * 1.2 - uTime * 0.85);
        vec2 uv2 = vec2(vUv.x * 7.0 + 0.37, y * 2.6 - uTime * 1.5);
        vec2 uv3 = vec2(vUv.x * 1.6 + 0.71, y * 0.6 - uTime * 0.5);
        float n = texture2D(uNoise, uv1).r * 0.5 + texture2D(uNoise, uv2).r * 0.3 + texture2D(uNoise, uv3).r * 0.2;
        float streak = smoothstep(0.3, 0.8, n);
        float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x);
        float a = (0.12 + 0.88 * streak) * edge * smoothstep(0.0, 0.02, y) * (1.0 - smoothstep(0.5, 1.0, y));
        a *= 0.85;
        vec3 dir = normalize(vWorld - cameraPosition);
        float sd = max(dot(dir, RR_SUN), 0.0);
        vec3 col = mix(vec3(0.42, 0.55, 0.62), vec3(1.3, 1.28, 1.2), streak);
        col += vec3(1.0, 0.6, 0.3) * pow(sd, 8.0) * 0.6;
        col = mix(col, vec3(1.4), smoothstep(0.08, 0.0, y) * 0.6); // white foam at the lip
        float dist = length(vWorld - cameraPosition);
        float fog = 1.0 - exp(-pow(dist * 0.0068, 2.0));
        col = mix(col, rrSky(dir), fog);
        gl_FragColor = vec4(col, a * (1.0 - fog * 0.6));
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}

export function makeWaterfall(mat, glowTex) {
  const g = new THREE.Group();
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 64, 1, 24).translate(0, -32, 0.8), mat);
  sheet.renderOrder = 2;
  sheet.frustumCulled = false;
  const spray = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(0.9, 0.95, 1.0), transparent: true, opacity: 0.55, depthWrite: false }));
  spray.scale.set(16, 9, 1);
  g.add(sheet, spray);
  g.userData.spray = spray;
  return g;
}

// Small stepped temple to crown some spires, with a glowing doorway.
export function shrineGeometry() {
  const stone = new THREE.Color('#9a8a76'), dark = new THREE.Color('#5d5146'), moss = new THREE.Color('#5d7a3a');
  const b = (w, h, d, x, y, z, c) => paint(new THREE.BoxGeometry(w, h, d).toNonIndexed().translate(x, y, z), c);
  const parts = [];
  const tiers = [[12, 2.2], [9.4, 2.0], [7, 1.9], [4.8, 1.8]];
  let y = 0;
  tiers.forEach(([w, h], i) => {
    parts.push(b(w, h, w, 0, y + h / 2, 0, i % 2 ? stone : dark));
    parts.push(b(w + 0.4, 0.25, w + 0.4, 0, y + h, 0, i === 0 ? moss : stone));
    y += h;
  });
  parts.push(b(3.2, 2.6, 3.2, 0, y + 1.3, 0, stone));
  parts.push(b(3.8, 0.4, 3.8, 0, y + 2.8, 0, dark));
  // stairway on the front
  for (let i = 0; i < 8; i++) parts.push(b(2.4, 0.4, 1.0, 0, 0.2 + i * 0.95, 6 - i * 0.62, stone));
  const g = mergeNonIndexed(parts);
  g.computeVertexNormals();
  g.userData = { top: y, doorY: y + 1.0 };
  return g;
}
