// Endless track: bridge segments that end in 90° junctions, populated with
// obstacles, coins, braziers and scenery. Heading never strays more than one
// turn from "north", so the path can never cross itself.
import * as THREE from 'three';
import { PATH_W, HALF_W, TILE, CURB_H, CURB_W, DIRS, dirYaw, LANES, clamp } from './config.js';
import * as B from './builders.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const LOOKAHEAD = 200;
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);
const rand = Math.random;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

class InstPool {
  constructor(mesh) {
    this.mesh = mesh;
    this.free = [];
    for (let i = mesh.count - 1; i >= 0; i--) { this.free.push(i); mesh.setMatrixAt(i, ZERO); }
  }
  alloc(matrix) {
    const i = this.free.pop();
    if (i === undefined) return -1;
    this.mesh.setMatrixAt(i, matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    return i;
  }
  release(i) {
    if (i < 0) return;
    this.mesh.setMatrixAt(i, ZERO);
    this.free.push(i);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

class ObjPool {
  constructor(parent, factory) { this.parent = parent; this.factory = factory; this.items = []; }
  acquire() { const o = this.items.pop() || this.factory(); this.parent.add(o); return o; }
  release(o) { this.parent.remove(o); this.items.push(o); }
}

export class Segment {
  constructor(dir, heading, sx, sz, len, exit) {
    this.dir = dir; this.heading = heading; this.sx = sx; this.sz = sz; this.len = len; this.exit = exit;
    this.d = DIRS[dir]; this.r = DIRS[(dir + 1) % 4]; this.yaw = dirYaw(dir);
    this.obstacles = []; this.gaps = []; this.coins = []; this.powerups = [];
    this.inst = []; this.objs = []; this.flames = []; this.lights = []; this.spires = [];
    this.next = null; this.branches = null;
  }
  world(s, x, y = 0, out = new THREE.Vector3()) {
    return out.set(this.sx + this.d[0] * s + this.r[0] * x, y, this.sz + this.d[1] * s + this.r[1] * x);
  }
  local(px, pz) {
    const dx = px - this.sx, dz = pz - this.sz;
    return { s: dx * this.d[0] + dz * this.d[1], x: dx * this.r[0] + dz * this.r[1] };
  }
  get juncS() { return this.len + HALF_W; }
  hasExit(side) { return this.exit === 'T' || this.exit === side; }
}

export class World {
  constructor(scene, M, opts = {}) {
    this.scene = scene;
    this.M = M;
    this.shadows = opts.shadows !== false;
    const root = new THREE.Group();
    scene.add(root);
    this.root = root;

    const tg = B.tileGeometries();
    const jg = B.junctionGeometries();
    const mk = (geo, mat, n, cast, recv = true) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.frustumCulled = false;
      m.castShadow = cast && this.shadows; m.receiveShadow = recv;
      root.add(m);
      return new InstPool(m);
    };
    this.P = {
      top: mk(tg.full.top, M.path, 260, false),
      struct: mk(tg.full.structure, M.stone, 260, true),
      gapTop: mk(tg.gap.top, M.path, 40, false),
      gapStruct: mk(tg.gap.structure, M.stone, 40, true),
      pillar: mk(B.pillarGeometry(), M.stone, 160, false, false),
      jTop: mk(jg.top, M.junction, 24, false),
      jStruct: mk(jg.structure, M.stone, 24, true),
      jCurb: mk(jg.curb, M.stone, 30, true),
      vines: mk(B.vineCurtainGeometry(), M.vineCurtain, 280, false),
      ferns: mk(B.fernGeometry(), M.fern, 900, false),
    };
    // per-instance tint so slabs don't look stamped
    const tint = new THREE.Color();
    for (const key of ['top', 'struct']) {
      const mesh = this.P[key].mesh;
      for (let i = 0; i < mesh.count; i++) {
        const v = 0.86 + rand() * 0.22;
        tint.setRGB(v, v * (0.97 + rand() * 0.05), v * (0.94 + rand() * 0.06));
        mesh.setColorAt(i, tint);
      }
    }

    const coinMesh = new THREE.InstancedMesh(B.coinGeometry(), M.gold, 600);
    coinMesh.frustumCulled = false;
    coinMesh.castShadow = false;
    root.add(coinMesh);
    this.coinPool = new InstPool(coinMesh);

    const rootVariants = [B.rootGeometry(1), B.rootGeometry(2), B.rootGeometry(3)];
    const spireVariants = [1, 2, 3, 4, 5].map((s) => B.spireGeometry(s * 13));
    const idolGeo = B.idolGeometry();
    const idolMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 2.2, 0.5) });

    const shrineGeo = B.shrineGeometry();
    const doorMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.3, 0.35) });
    const waterMat = B.waterfallMaterial(opts.noiseTex);
    this.O = {
      brazier: new ObjPool(root, () => B.makeBrazier(M)),
      wall: new ObjPool(root, () => B.makeFrontWall(M)),
      root: new ObjPool(root, () => {
        const m = new THREE.Mesh(pick(rootVariants), M.bark);
        m.castShadow = this.shadows; m.receiveShadow = true;
        const g = new THREE.Group(); g.add(m); return g;
      }),
      log: new ObjPool(root, () => B.makeLog(M)),
      fire: new ObjPool(root, () => B.makeFireTrap(M)),
      block: new ObjPool(root, () => B.makeBlock(M)),
      arch: new ObjPool(root, () => B.makeArch(M)),
      magnet: new ObjPool(root, () => B.makeMagnet(M)),
      spire: new ObjPool(root, () => {
        const geo = pick(spireVariants);
        const m = new THREE.Mesh(geo, M.rock);
        m.userData.radius = geo.userData.radius;
        return m;
      }),
      waterfall: new ObjPool(root, () => B.makeWaterfall(waterMat, M.glow)),
      shrine: new ObjPool(root, () => {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(shrineGeo, idolMat));
        const door = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.9), doorMat);
        door.position.set(0, shrineGeo.userData.doorY, 1.62);
        g.add(door);
        return g;
      }),
      idol: new ObjPool(root, () => {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(idolGeo, idolMat));
        const eyes = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.2), eyeMat);
        const e2 = eyes.clone();
        eyes.position.set(-1.9, 4.6, 3.32); e2.position.set(1.9, 4.6, 3.32);
        g.add(eyes, e2);
        return g;
      }),
    };

    // Firelight: a few real lights follow the nearest flames.
    this.lights = [];
    for (let i = 0; i < (opts.lights ?? 3); i++) {
      const l = new THREE.PointLight(0xff9440, 0, 15, 1.7);
      root.add(l);
      this.lights.push(l);
    }

    this.buildStartTemple();
    this.segments = new Set();
    this.trail = [];
    this.pending = null;
  }

  // ------------------------------------------------------------------ lifecycle
  reset() {
    for (const seg of [...this.segments]) this.release(seg);
    this.segments.clear();
    this.trail = [];
    this.pending = null;
    this.generated = 0;
    this.activeSpires = [];
    const first = this.spawn(null, null);
    this.current = first;
    this.ensureAhead(0);
  }

  difficulty() { return clamp(this.generated / 3200, 0, 1); }

  spawn(prev, side) {
    let dir = 0, heading = 0, sx = 0, sz = 0, len;
    if (prev) {
      const turn = side === 'R' ? 1 : -1;
      dir = (prev.dir + (turn > 0 ? 1 : 3)) % 4;
      heading = prev.heading + turn;
      const c = prev.world(prev.juncS, 0);
      sx = c.x + DIRS[dir][0] * HALF_W;
      sz = c.z + DIRS[dir][1] * HALF_W;
      len = TILE * (6 + Math.floor(rand() * 8));
      if (prev.exit === 'T') len = Math.max(len, TILE * 10);
    } else {
      len = TILE * 14;
    }
    let exit;
    if (heading === 0) { const r = rand(); exit = r < 0.36 ? 'L' : r < 0.72 ? 'R' : 'T'; }
    else exit = heading > 0 ? 'L' : 'R';
    const seg = new Segment(dir, heading, sx, sz, len, exit);
    seg.isStart = !prev;
    this.segments.add(seg);
    this.generated += len;
    this.clearSpiresFor(seg);
    this.buildSegment(seg);
    this.populate(seg);
    this.decorate(seg);
    return seg;
  }

  ensureAhead(playerS) {
    let seg = this.current;
    let dist = seg.len + PATH_W - playerS;
    while (seg.next) { seg = seg.next; dist += seg.len + PATH_W; }
    let guard = 0;
    while (dist < LOOKAHEAD && seg.exit !== 'T' && guard++ < 10) {
      const n = this.spawn(seg, seg.exit);
      seg.next = n; seg = n; dist += n.len + PATH_W;
    }
    if (seg.exit === 'T' && !seg.branches) {
      seg.branches = { L: this.spawn(seg, 'L'), R: this.spawn(seg, 'R') };
    }
  }

  turnTarget(seg, side) {
    if (!seg.hasExit(side)) return null;
    if (seg.exit === 'T') return seg.branches ? seg.branches[side] : null;
    return seg.next;
  }

  commitTurn(side) {
    const seg = this.current;
    const n = this.turnTarget(seg, side);
    if (!n) return null;
    if (seg.exit === 'T') {
      const other = seg.branches[side === 'L' ? 'R' : 'L'];
      if (this.pending) this.release(this.pending.seg);
      this.pending = { seg: other, at: n };
      seg.next = n; seg.branches = null;
    }
    this.trail.push(seg);
    while (this.trail.length > 2) this.release(this.trail.shift());
    this.current = n;
    return n;
  }

  release(seg) {
    if (!this.segments.has(seg)) return;
    this.segments.delete(seg);
    for (const [pool, i] of seg.inst) pool.release(i);
    for (const [pool, o] of seg.objs) pool.release(o);
    for (const c of seg.coins) if (c.idx >= 0) { this.coinPool.release(c.idx); c.idx = -1; }
    for (const sp of seg.spires) this.releaseSpire(sp);
    seg.inst.length = 0; seg.objs.length = 0; seg.coins.length = 0; seg.flames.length = 0; seg.lights.length = 0;
    if (seg.branches) { this.release(seg.branches.L); this.release(seg.branches.R); seg.branches = null; }
  }

  // ------------------------------------------------------------------ building
  mat(seg, s, x, y, yaw = 0, scale = 1) {
    seg.world(s, x, y, _p);
    _q.setFromAxisAngle(UP, seg.yaw + yaw);
    _s.setScalar(scale);
    return _m.compose(_p, _q, _s);
  }
  addInst(seg, pool, s, x, y, yaw = 0, scale = 1) {
    const i = pool.alloc(this.mat(seg, s, x, y, yaw, scale));
    if (i >= 0) seg.inst.push([pool, i]);
    return i;
  }
  addObj(seg, poolName, s, x, y, yaw = 0) {
    const pool = this.O[poolName];
    const o = pool.acquire();
    seg.world(s, x, y, o.position);
    o.rotation.set(0, seg.yaw + yaw, 0);
    o.updateMatrixWorld(true);
    seg.objs.push([pool, o]);
    if (o.userData.flames) for (const f of o.userData.flames) seg.flames.push(f);
    if (o.userData.lightPos) seg.lights.push(o.localToWorld(o.userData.lightPos.clone()));
    return o;
  }

  buildSegment(seg) {
    const n = seg.len / TILE;
    seg.gapTiles = new Set();
    seg.tileCount = n;
    // tiles are added after populate() decides gaps -> deferred to decorate()
    // junction
    const js = seg.juncS;
    this.addInst(seg, this.P.jTop, js, 0, 0.002);
    this.addInst(seg, this.P.jStruct, js, 0, 0);
    this.addInst(seg, this.P.pillar, js, 0, 0);
    if (seg.exit === 'L') this.addInst(seg, this.P.jCurb, js, HALF_W + CURB_W / 2, 0);
    if (seg.exit === 'R') this.addInst(seg, this.P.jCurb, js, -(HALF_W + CURB_W / 2), 0);
    this.addObj(seg, 'wall', js, 0, 0);
  }

  populate(seg) {
    const diff = this.difficulty();
    let s = seg.isStart ? 52 : 16;
    const end = seg.len - 12;
    const speedGuess = 13 + 14 * diff;
    while (s < end) {
      const space = clamp(speedGuess * 1.35, 18, 36) * (1.2 - diff * 0.3) + rand() * 9;
      const roll = rand();
      if (roll < 0.22 - diff * 0.1) {
        const lane = pick(LANES);
        const count = 6 + Math.floor(rand() * 5);
        if (rand() < 0.4) this.coinZigzag(seg, s, count);
        else for (let i = 0; i < count; i++) this.addCoin(seg, s + i * 2.1, lane, 0.95);
        if (rand() < 0.08 && diff > 0.05) this.addMagnet(seg, s + count * 2.1 + 4, pick(LANES));
        s += count * 2.1 + space * 0.6;
        continue;
      }
      const types = [['root', 3], ['block1', 3], ['log', 2], ['gap', diff > 0.03 ? 2 : 0], ['fire', diff > 0.12 ? 2 : 0], ['block2', diff > 0.25 ? 2 : 0]];
      let total = 0; for (const t of types) total += t[1];
      let k = rand() * total, type = 'root';
      for (const t of types) { k -= t[1]; if (k <= 0) { type = t[0]; break; } }

      if (type === 'gap') {
        const tile = Math.floor(s / TILE);
        if (tile < 1 || tile > seg.tileCount - 2 || seg.gapTiles.has(tile) || seg.gapTiles.has(tile - 1)) { s += 4; continue; }
        seg.gapTiles.add(tile);
        const a = tile * TILE + 1.5, b = tile * TILE + 4.5;
        seg.gaps.push([a, b]);
        this.coinArc(seg, (a + b) / 2, pick(LANES));
        s = tile * TILE + TILE + space;
        continue;
      }
      if (type === 'root') {
        this.addObstacle(seg, 'root', s, { s0: s - 0.45, s1: s + 0.45, x0: -9, x1: 9, y0: 0, y1: 0.62 }, rand() < 0.5 ? Math.PI : 0);
        this.coinArc(seg, s, pick(LANES));
      } else if (type === 'log') {
        this.addObstacle(seg, 'log', s, { s0: s - 0.45, s1: s + 0.45, x0: -9, x1: 9, y0: 1.17, y1: 9 });
        const lane = pick(LANES);
        for (let i = -2; i <= 2; i++) this.addCoin(seg, s + i * 1.8, lane, 0.5);
      } else if (type === 'fire') {
        this.addObstacle(seg, 'fire', s, { s0: s - 0.5, s1: s + 0.5, x0: -9, x1: 9, y0: 1.05, y1: 9 });
        const lane = pick(LANES);
        for (let i = -2; i <= 2; i++) this.addCoin(seg, s + i * 1.8, lane, 0.5);
      } else if (type === 'block1') {
        const li = Math.floor(rand() * 3);
        this.addBlock(seg, s, LANES[li]);
        const free = LANES.filter((_, i) => i !== li);
        const lane = pick(free);
        for (let i = -3; i <= 3; i++) this.addCoin(seg, s + i * 2.0, lane, 0.95);
      } else if (type === 'block2') {
        const freeI = Math.floor(rand() * 3);
        LANES.forEach((x, i) => { if (i !== freeI) this.addBlock(seg, s, x); });
        for (let i = -3; i <= 3; i++) this.addCoin(seg, s + i * 2.0, LANES[freeI], 0.95);
      }
      s += space;
    }
  }

  addObstacle(seg, type, s, box, yaw = 0) {
    const obj = this.addObj(seg, type, s, 0, 0, yaw);
    seg.obstacles.push({ type, ...box, obj });
  }
  addBlock(seg, s, x) {
    const obj = this.addObj(seg, 'block', s, x, 0);
    seg.obstacles.push({ type: 'block', s0: s - 0.66, s1: s + 0.66, x0: x - 0.72, x1: x + 0.72, y0: 0, y1: 2.5, obj });
  }
  addCoin(seg, s, x, y) {
    if (s < 1 || s > seg.len - 1) return;
    for (const [a, b] of seg.gaps) if (s > a - 0.5 && s < b + 0.5 && y < 1.2) return;
    const pos = seg.world(s, x, y);
    const c = { s, x, y, pos, home: pos.clone(), idx: -1, state: 0, t: 0, phase: s * 0.35, yaw: seg.yaw };
    _q.setFromAxisAngle(UP, seg.yaw);
    c.idx = this.coinPool.alloc(_m.compose(pos, _q, _s.setScalar(1)));
    seg.coins.push(c);
  }
  coinArc(seg, sc, lane) {
    for (let i = -3; i <= 3; i++) {
      const t = i / 3.6;
      this.addCoin(seg, sc + i * 1.75, lane, 0.95 + 1.55 * (1 - t * t));
    }
  }
  coinZigzag(seg, s, count) {
    let li = Math.floor(rand() * 3), dir = rand() < 0.5 ? -1 : 1;
    for (let i = 0; i < count; i++) {
      const x = LANES[li];
      this.addCoin(seg, s + i * 2.1, x, 0.95);
      if (i % 3 === 2) {
        if (li + dir < 0 || li + dir > 2) dir = -dir;
        li += dir;
      }
    }
  }
  addMagnet(seg, s, x) {
    if (s > seg.len - 4) return;
    const obj = this.addObj(seg, 'magnet', s, x, 1.0);
    obj.visible = true;
    seg.powerups.push({ type: 'magnet', s, x, y: 1.0, obj, taken: false });
  }

  decorate(seg) {
    // tiles (gaps are known now)
    for (let t = 0; t < seg.tileCount; t++) {
      const s = t * TILE + TILE / 2;
      const flip = rand() < 0.5 ? Math.PI : 0;
      if (seg.gapTiles.has(t)) {
        this.addInst(seg, this.P.gapTop, s, 0, 0, flip);
        this.addInst(seg, this.P.gapStruct, s, 0, 0);
      } else {
        this.addInst(seg, this.P.top, s, 0, 0, flip);
        this.addInst(seg, this.P.struct, s, 0, 0);
        if (t % 2 === 1) this.addInst(seg, this.P.pillar, s, 0, 0, 0, 1);
        // jungle creeping over the bridge: vines down the sides, ferns on the curbs
        for (const side of [-1, 1]) {
          if (rand() < 0.5) this.addInst(seg, this.P.vines, s + (rand() - 0.5) * 0.6, side * (HALF_W + CURB_W + 0.19), -0.24, side > 0 ? 0 : Math.PI, 0.85 + rand() * 0.3);
        }
        const tufts = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < tufts; k++) {
          const side = rand() < 0.5 ? -1 : 1;
          this.addInst(seg, this.P.ferns, t * TILE + 0.5 + rand() * (TILE - 1), side * (HALF_W + CURB_W * (0.3 + rand() * 0.5)), CURB_H + 0.05, rand() * Math.PI * 2, 0.6 + rand() * 0.7);
        }
      }
    }
    const busy = (s, r) => seg.obstacles.some((o) => o.type !== 'block' && s > o.s0 - r && s < o.s1 + r) ||
      seg.gaps.some(([a, b]) => s > a - r && s < b + r);
    // braziers on the curbs
    let side = rand() < 0.5 ? -1 : 1;
    for (let s = 8; s < seg.len - 3; s += 12) {
      if (!busy(s, 2.5)) this.addObj(seg, 'brazier', s, side * (HALF_W + CURB_W / 2), CURB_H + 0.09);
      side = -side;
    }
    // decorative arches
    const arches = Math.floor(seg.len / 40);
    for (let i = 0; i < arches; i++) {
      const s = 12 + rand() * (seg.len - 22);
      if (!busy(s, 3.5)) this.addObj(seg, 'arch', s, 0, 0);
    }
    // rock spires (checked against every live segment so nothing clips the path)
    const count = 1 + Math.floor(seg.len / 28);
    for (let i = 0; i < count; i++) {
      const s = 14 + rand() * Math.max(1, seg.len - 30);
      const lat = (rand() < 0.5 ? -1 : 1) * (16 + rand() * 30);
      const p = seg.world(s, lat, -4 - rand() * 12);
      const roll = rand();
      this.addSpire(seg, p, roll < 0.18 ? 'idol' : roll < 0.36 ? 'shrine' : null, rand() < 0.38);
    }
  }

  // crown: 'idol' | 'shrine' | null. waterfall: pour water off the side facing the path.
  addSpire(seg, p, crown, waterfall) {
    const pool = this.O.spire;
    const o = pool.acquire();
    const scale = 0.8 + rand() * 0.6;
    const radius = Math.max(o.userData.radius * scale, crown === 'idol' ? 7 : crown === 'shrine' ? 9 : 0);
    if (this.hitsTrack(p.x, p.z, radius + 1.5)) { pool.release(o); return; }
    o.position.copy(p);
    o.rotation.set(0, rand() * Math.PI * 2, 0);
    o.scale.set(scale, 1, scale);
    const sp = { o, pool, x: p.x, z: p.z, radius, seg, idol: null, shrine: null, water: null };
    const loc = seg.local(p.x, p.z);
    const toPath = seg.world(loc.s, 0, 0).sub(p);
    toPath.y = 0;
    toPath.normalize();
    const facePath = Math.atan2(toPath.x, toPath.z);
    if (crown === 'idol') {
      const idol = this.O.idol.acquire();
      idol.position.set(p.x, p.y - 0.4, p.z);
      idol.rotation.set(0, facePath, 0);
      sp.idol = idol;
    } else if (crown === 'shrine') {
      const sh = this.O.shrine.acquire();
      sh.position.set(p.x, p.y - 0.3, p.z);
      sh.rotation.set(0, facePath, 0);
      sp.shrine = sh;
    }
    if (waterfall) {
      const w = this.O.waterfall.acquire();
      const edge = o.userData.radius * scale * 0.86;
      w.position.set(p.x + toPath.x * edge, p.y - 0.15, p.z + toPath.z * edge);
      w.rotation.set(0, facePath, 0);
      w.userData.spray.position.set(0, -26 - p.y, 5);
      w.updateMatrixWorld(true);
      sp.water = w;
    }
    seg.spires.push(sp);
    this.activeSpires.push(sp);
  }

  releaseSpire(sp) {
    if (sp.released) return;
    sp.released = true;
    sp.pool.release(sp.o);
    if (sp.idol) this.O.idol.release(sp.idol);
    if (sp.shrine) this.O.shrine.release(sp.shrine);
    if (sp.water) this.O.waterfall.release(sp.water);
    const i = this.activeSpires.indexOf(sp);
    if (i >= 0) this.activeSpires.splice(i, 1);
  }
  segHits(seg, x, z, r) {
    const l = seg.local(x, z);
    const ds = Math.max(-PATH_W - l.s, l.s - (seg.len + PATH_W + 2), 0);
    const dx = Math.max(Math.abs(l.x) - 4.4, 0);
    return Math.hypot(ds, dx) < r;
  }
  hitsTrack(x, z, r) {
    for (const seg of this.segments) if (this.segHits(seg, x, z, r)) return true;
    if (this.startBounds && Math.hypot(x - this.startBounds.x, z - this.startBounds.z) < r + this.startBounds.r) return true;
    return false;
  }
  clearSpiresFor(seg) {
    if (!this.activeSpires) return;
    for (const sp of [...this.activeSpires]) {
      if (this.segHits(seg, sp.x, sp.z, sp.radius + 1.5)) {
        const owner = sp.seg;
        const i = owner.spires.indexOf(sp);
        if (i >= 0) owner.spires.splice(i, 1);
        this.releaseSpire(sp);
      }
    }
  }

  // The temple the runner escapes from (static, at the origin).
  buildStartTemple() {
    const M = this.M;
    const g = new THREE.Group();
    const parts = [];
    const tiers = 6;
    for (let i = 0; i < tiers; i++) {
      const w = 30 - i * 4.2, h = 3.4;
      parts.push(B.box(w, h, w, 0, -1.4 + h / 2 + i * h, 15, 4, i * 0.37));
      parts.push(B.box(w + 0.5, 0.35, w + 0.5, 0, -1.4 + (i + 1) * h, 15, 4, i * 0.21));
    }
    parts.push(B.box(30, 150, 30, 0, -1.4 - 75, 15, 4));
    parts.push(B.box(7, 6, 4, 0, -1.4 + tiers * 3.4 + 3, 15, 4));
    // stair ramp toward the summit shrine
    for (let i = 0; i < 10; i++) parts.push(B.box(5, 0.5, 1.2, 0, 0.2 + i * 1.9, 1.6 + i * 1.25, 2));
    const temple = new THREE.Mesh(mergeGeometries(parts), M.stone);
    temple.castShadow = this.shadows; temple.receiveShadow = true;
    g.add(temple);
    // dark doorway the runner bursts out of
    const door = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 5.2), new THREE.MeshBasicMaterial({ color: 0x050302 }));
    door.position.set(0, 2.6, -0.02); // front face of the lowest tier
    g.add(door);
    const lintel = new THREE.Mesh(mergeGeometries([B.box(6, 1, 1.2, 0, 5.6, -0.4, 2), B.box(1, 5.6, 1.2, -2.6, 2.8, -0.4, 2), B.box(1, 5.6, 1.2, 2.6, 2.8, -0.4, 2)]), M.stone);
    lintel.castShadow = this.shadows;
    g.add(lintel);
    this.startFlames = [];
    for (const sx of [-1, 1]) {
      const b = B.makeBrazier(M);
      b.position.set(sx * 3.6, 0, -1.2);
      b.scale.setScalar(1.4);
      g.add(b);
      this.startFlames.push(...b.userData.flames);
    }
    this.startLight = new THREE.Vector3(0, 2.5, -2);
    this.startBounds = { x: 0, z: 15, r: 24 };
    this.root.add(g);
    this.startTemple = g;
  }

  // ------------------------------------------------------------------ per frame
  update(dt, time, player) {
    B.FX_TIME.value = time;
    if (this.pending && this.current === this.pending.at && player.s > 28) {
      this.release(this.pending.seg);
      this.pending = null;
    }
    this.ensureAhead(player.s);

    // coins: spin + collect animation
    const coinMesh = this.coinPool.mesh;
    let touched = false;
    for (const seg of this.segments) {
      for (const c of seg.coins) {
        if (c.idx < 0) continue;
        const dx = c.pos.x - player.pos.x, dz = c.pos.z - player.pos.z;
        if (dx * dx + dz * dz > 150 * 150 && c.state === 0) continue;
        let scale = 1;
        if (c.state === 2) {
          c.t += dt;
          const k = c.t / 0.35;
          if (k >= 1) { this.coinPool.release(c.idx); c.idx = -1; continue; }
          c.pos.y += dt * 6;
          scale = 1 - k * 0.8;
        }
        _q.setFromAxisAngle(UP, c.yaw + time * 3.2 + c.phase);
        coinMesh.setMatrixAt(c.idx, _m.compose(c.pos, _q, _s.setScalar(scale)));
        touched = true;
      }
      for (const pu of seg.powerups) {
        if (pu.taken) continue;
        pu.obj.rotation.y = seg.yaw + time * 2;
        pu.obj.position.y = 1.0 + Math.sin(time * 3) * 0.15;
      }
    }
    if (touched) coinMesh.instanceMatrix.needsUpdate = true;

    // flames flicker
    const flick = (f) => {
      const ph = f.userData.phase, b = f.userData.base;
      const k = 0.85 + Math.sin(time * 13 + ph) * 0.1 + Math.sin(time * 27.3 + ph * 2.1) * 0.07;
      if (f.userData.jet) f.scale.set(0.9 * b * (0.9 + (k - 0.85)), 1.65 * b * k, 1);
      else f.scale.set(0.7 * b * (0.95 + (k - 0.85) * 0.5), 1.35 * b * k, 1);
    };
    for (const seg of this.segments) for (const f of seg.flames) flick(f);
    for (const f of this.startFlames) flick(f);

    // assign point lights to the nearest flames ahead of the runner
    const ahead = player.ahead;
    const cands = [];
    for (const seg of this.segments) for (const p of seg.lights) cands.push(p);
    cands.push(this.startLight);
    cands.sort((a, b) => a.distanceToSquared(ahead) - b.distanceToSquared(ahead));
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const p = cands[i];
      if (!p || p.distanceToSquared(ahead) > 60 * 60) { l.intensity = 0; continue; }
      l.position.copy(p);
      l.intensity = 26 * (0.85 + Math.sin(time * 17 + i * 3) * 0.08 + Math.sin(time * 31 + i) * 0.07);
    }
  }

  // ------------------------------------------------------------------ queries
  overGap(seg, s) {
    for (const [a, b] of seg.gaps) if (s > a + 0.35 && s < b - 0.35) return true;
    return false;
  }

  collect(seg, bodyPos, magnet, dt, onCoin, onPower) {
    const segs = [seg];
    if (seg.next) segs.push(seg.next);
    const pull = magnet ? 7.5 : 0;
    for (const sg of segs) {
      for (const c of sg.coins) {
        if (c.idx < 0 || c.state === 2) continue;
        const d = c.pos.distanceTo(bodyPos);
        if (c.state === 1 || (pull && d < pull)) {
          c.state = 1;
          c.pos.lerp(bodyPos, Math.min(1, dt * 14));
        }
        if (d < 1.05) { c.state = 2; c.t = 0; onCoin(c); }
      }
      for (const pu of sg.powerups) {
        if (pu.taken) continue;
        if (pu.obj.position.distanceTo(bodyPos) < 1.3) {
          pu.taken = true;
          pu.obj.visible = false;
          onPower(pu);
        }
      }
    }
  }
}
