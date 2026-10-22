// The explorer and the three temple guardians chasing them. Both are built
// from primitives and animated procedurally (no rigs, no model files).
import * as THREE from 'three';
import { lerp, damp, clamp } from './config.js';

function limb(r, len, mat) {
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 4, 10);
  g.translate(0, -len / 2, 0);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}
function ball(r, mat, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12), mat);
  m.scale.set(sx, sy, sz);
  m.castShadow = true;
  return m;
}
function joint(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}
const std = (color, rough = 0.85, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, ...extra });

// ---------------------------------------------------------------------------
export class Runner {
  constructor(goldMat) {
    const skin = std(0xc98b62, 0.7), shirt = std(0xcdb88e, 0.9), vest = std(0x6e4f33, 0.8),
      pants = std(0x4f4c34, 0.9), boots = std(0x33231a, 0.7), hat = std(0x6b4a2b, 0.85),
      band = std(0x241810, 0.8), scarf = std(0xb52f25, 0.8), pack = std(0x584430, 0.9), hair = std(0x2a1a10, 0.9);

    this.root = new THREE.Group();
    this.body = joint(this.root, 0, 0.95, 0);         // pelvis pivot
    const pelvis = ball(0.17, pants, 1.15, 0.8, 0.9);
    this.body.add(pelvis);

    this.torso = joint(this.body, 0, 0.05, 0);
    const chest = limb(0.19, 0.6, shirt); chest.position.y = 0.6; chest.scale.set(1.15, 1, 0.82);
    const vestM = limb(0.2, 0.5, vest); vestM.position.y = 0.56; vestM.scale.set(1.18, 1, 0.86);
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.035, 6, 18), band);
    belt.rotation.x = Math.PI / 2; belt.position.y = 0.06; belt.scale.set(1.12, 0.85, 1);
    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.4, 0.18), pack);
    backpack.position.set(0, 0.36, 0.21); backpack.castShadow = true;
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.38, 10), std(0x8a3d2a));
    roll.rotation.z = Math.PI / 2; roll.position.set(0, 0.6, 0.24); roll.castShadow = true;
    this.torso.add(chest, vestM, belt, backpack, roll);

    // head
    this.head = joint(this.torso, 0, 0.66, 0);
    const neck = limb(0.06, 0.12, skin); neck.position.y = 0.08;
    const face = ball(0.13, skin, 0.95, 1.08, 1);
    face.position.y = 0.17;
    const hairM = ball(0.135, hair, 1, 0.9, 1.02); hairM.position.set(0, 0.2, 0.02);
    const nose = ball(0.025, skin); nose.position.set(0, 0.16, -0.13);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.02, 24), hat);
    brim.position.y = 0.27; brim.castShadow = true;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.155, 0.15, 18), hat);
    crown.position.y = 0.35; crown.castShadow = true;
    const hband = new THREE.Mesh(new THREE.CylinderGeometry(0.157, 0.157, 0.04, 18), band);
    hband.position.y = 0.3;
    const scarfRing = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.045, 6, 14), scarf);
    scarfRing.rotation.x = Math.PI / 2; scarfRing.position.y = 0.02;
    this.head.add(neck, face, hairM, nose, brim, crown, hband, scarfRing);

    this.scarfTail = joint(this.torso, 0.04, 0.68, 0.1);
    const tail1 = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.02, 0.32).translate(0, 0, 0.16), scarf);
    tail1.castShadow = true;
    this.scarfTail.add(tail1);
    this.scarfTail2 = joint(this.scarfTail, 0, 0, 0.31);
    const tail2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.28).translate(0, 0, 0.14), scarf);
    tail2.castShadow = true;
    this.scarfTail2.add(tail2);

    // arms
    const arm = (side) => {
      const sh = joint(this.torso, side * 0.27, 0.58, 0);
      sh.add(limb(0.065, 0.32, shirt));
      const el = joint(sh, 0, -0.3, 0);
      el.add(limb(0.055, 0.28, skin));
      const hand = ball(0.06, skin); hand.position.y = -0.3;
      el.add(hand);
      return { sh, el, hand };
    };
    this.armL = arm(-1); this.armR = arm(1);
    // the stolen idol, clutched in the right hand
    const idol = new THREE.Mesh(new THREE.OctahedronGeometry(0.09, 0), goldMat);
    idol.scale.set(0.9, 1.4, 0.9); idol.position.set(0, -0.36, -0.03); idol.castShadow = true;
    this.armR.el.add(idol);

    // legs
    const leg = (side) => {
      const hip = joint(this.body, side * 0.11, -0.02, 0);
      hip.add(limb(0.085, 0.45, pants));
      const knee = joint(hip, 0, -0.43, 0);
      knee.add(limb(0.07, 0.43, pants));
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.27), boots);
      boot.position.set(0, -0.44, -0.05); boot.castShadow = true;
      knee.add(boot);
      return { hip, knee };
    };
    this.legL = leg(-1); this.legR = leg(1);

    this.root.traverse((o) => { if (o.isMesh) o.receiveShadow = false; });
    this.w = { jump: 0, slide: 0, stumble: 0, idle: 1 };
    this.phase = 0;
  }

  setVisible(v) { this.root.visible = v; }

  // st: { speed, airborne, vy, sliding, stumble, lean, time, idle, dead, deadType, deadT }
  animate(dt, st) {
    const w = this.w;
    w.jump = damp(w.jump, st.airborne ? 1 : 0, 14, dt);
    w.slide = damp(w.slide, st.sliding ? 1 : 0, 16, dt);
    w.stumble = damp(w.stumble, st.stumble > 0 ? 1 : 0, 10, dt);
    w.idle = damp(w.idle, st.idle ? 1 : 0, 6, dt);

    const cadence = clamp(st.speed / 4.4, 1.6, 5.2);
    if (!st.airborne) this.phase += dt * cadence * Math.PI * 2 * (st.idle ? 0 : 1);
    const p = this.phase, t = st.time;

    // run pose
    const run = {
      bodyY: 0.93 + Math.abs(Math.sin(p)) * 0.07, bodyX: 0, twist: Math.sin(p) * 0.16, torsoX: -0.22, headX: 0.12,
      thL: Math.sin(p) * 0.95 - 0.1, thR: Math.sin(p + Math.PI) * 0.95 - 0.1,
      knL: -(0.15 + 1.6 * Math.max(0, Math.cos(p))), knR: -(0.15 + 1.6 * Math.max(0, Math.cos(p + Math.PI))),
      shL: -Math.sin(p) * 0.9, shR: Math.sin(p) * 0.9, elL: 1.35, elR: 1.35, armOut: 0.08,
    };
    const jump = {
      bodyY: 0.95, bodyX: 0, twist: 0, torsoX: -0.35, headX: 0.2,
      thL: 1.25, thR: 0.25, knL: -1.7, knR: -1.1,
      shL: 2.4, shR: 0.4, elL: 0.6, elR: 1.6, armOut: 0.35,
    };
    if (st.vy < 0) { jump.thL = 0.7; jump.thR = 0.5; jump.knL = -0.9; jump.knR = -0.6; jump.shL = 1.5; }
    const slide = {
      bodyY: 0.38, bodyX: 1.15, twist: 0, torsoX: 0.05, headX: -0.75,
      thL: 0.35, thR: 0.05, knL: -0.25, knR: -1.0,
      shL: 0.9, shR: 0.4, elL: 0.8, elR: 1.2, armOut: 0.5,
    };
    const idle = {
      bodyY: 0.95 + Math.sin(t * 2) * 0.008, bodyX: 0, twist: Math.sin(t * 0.7) * 0.1, torsoX: 0.02, headX: Math.sin(t * 0.5) * 0.08,
      thL: 0.02, thR: -0.04, knL: -0.05, knR: -0.08,
      shL: 0.1, shR: 0.35 + Math.sin(t * 2) * 0.03, elL: 0.25, elR: 1.1, armOut: 0.12,
    };
    const pose = { ...run };
    const mix = (target, k) => { if (k < 0.001) return; for (const key in pose) pose[key] = lerp(pose[key], target[key], k); };
    mix(jump, w.jump);
    mix(slide, w.slide);
    mix(idle, w.idle);
    if (w.stumble > 0.01) {
      pose.torsoX = lerp(pose.torsoX, -0.75 + Math.sin(t * 22) * 0.15, w.stumble);
      pose.shL = lerp(pose.shL, 2.2 + Math.sin(t * 25) * 0.6, w.stumble);
      pose.shR = lerp(pose.shR, 1.6 + Math.cos(t * 23) * 0.6, w.stumble);
      pose.armOut = lerp(pose.armOut, 0.9, w.stumble);
    }

    if (st.dead) this.deathPose(pose, st);

    this.body.position.y = pose.bodyY;
    this.body.rotation.set(pose.bodyX, pose.twist * 0.5, st.lean * 0.6);
    this.torso.rotation.set(pose.torsoX, -pose.twist, 0);
    this.head.rotation.set(pose.headX, pose.twist * 0.6, 0);
    this.legL.hip.rotation.x = pose.thL; this.legR.hip.rotation.x = pose.thR;
    this.legL.knee.rotation.x = pose.knL; this.legR.knee.rotation.x = pose.knR;
    this.armL.sh.rotation.set(pose.shL, 0, -pose.armOut);
    this.armR.sh.rotation.set(pose.shR, 0, pose.armOut);
    this.armL.el.rotation.x = pose.elL; this.armR.el.rotation.x = pose.elR;
    const flap = Math.sin(t * 14) * 0.25 + Math.sin(t * 23) * 0.12;
    const rush = clamp(st.speed / 20, 0, 1) * (1 - w.idle);
    this.scarfTail.rotation.x = lerp(0.2, 1.25, rush) + flap * rush;
    this.scarfTail2.rotation.x = -0.25 + Math.sin(t * 17 + 1) * 0.35 * rush;
  }

  deathPose(pose, st) {
    const k = clamp(st.deadT / 0.45, 0, 1);
    const target = st.deadType === 'fall'
      ? { bodyY: 0.95, bodyX: -0.4, twist: 0.4, torsoX: -0.4, headX: 0.5, thL: 1.2, thR: -0.4, knL: -1.4, knR: -0.6, shL: 2.8, shR: 2.4, elL: 0.3, elR: 0.4, armOut: 1.1 }
      : { bodyY: 0.22, bodyX: 1.5, twist: 0.3, torsoX: 0.1, headX: -0.3, thL: 0.25, thR: -0.1, knL: -0.4, knR: -0.2, shL: 2.6, shR: 1.4, elL: 0.3, elR: 0.6, armOut: 1.3 };
    for (const key in pose) pose[key] = lerp(pose[key], target[key], k);
  }
}

// ---------------------------------------------------------------------------
class Guardian {
  constructor(furMat, faceMat, eyeMat, scale) {
    this.root = new THREE.Group();
    this.body = joint(this.root, 0, 0.85, 0);
    const torso = ball(0.42, furMat, 0.95, 0.85, 1.25); torso.position.set(0, 0, 0.05);
    const chestFur = ball(0.36, furMat, 1.05, 0.95, 0.9); chestFur.position.set(0, 0.12, -0.35);
    this.body.add(torso, chestFur);
    this.head = joint(this.body, 0, 0.3, -0.66);
    const skull = ball(0.27, furMat, 1, 0.92, 1);
    const muzzle = ball(0.16, faceMat, 1.1, 0.8, 0.9); muzzle.position.set(0, -0.08, -0.2);
    const brow = ball(0.2, furMat, 1.3, 0.45, 0.6); brow.position.set(0, 0.1, -0.16);
    this.head.add(skull, muzzle, brow);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), eyeMat);
      eye.position.set(s * 0.1, 0.03, -0.25);
      const ear = ball(0.08, faceMat, 0.5, 1, 1); ear.position.set(s * 0.27, 0.06, 0);
      const fang = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.07, 5), std(0xe9e0c8, 0.5));
      fang.rotation.x = Math.PI; fang.position.set(s * 0.06, -0.19, -0.3);
      this.head.add(eye, ear, fang);
    }
    const mk = (x, y, z, l1, l2, r) => {
      const a = joint(this.body, x, y, z);
      a.add(limb(r, l1, furMat));
      const b = joint(a, 0, -l1 + 0.03, 0);
      b.add(limb(r * 0.85, l2, furMat));
      const paw = ball(r * 1.3, faceMat, 1, 0.6, 1.3); paw.position.y = -l2;
      b.add(paw);
      return { a, b };
    };
    this.armL = mk(-0.32, 0.12, -0.45, 0.5, 0.5, 0.09);
    this.armR = mk(0.32, 0.12, -0.45, 0.5, 0.5, 0.09);
    this.legL = mk(-0.25, -0.1, 0.38, 0.4, 0.42, 0.1);
    this.legR = mk(0.25, -0.1, 0.38, 0.4, 0.42, 0.1);
    const tailCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0.5), new THREE.Vector3(0, 0.25, 0.85), new THREE.Vector3(0, 0.7, 0.95), new THREE.Vector3(0, 0.9, 0.7),
    ]);
    const tail = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 16, 0.05, 6), furMat);
    tail.castShadow = true;
    this.body.add(tail);
    this.root.scale.setScalar(scale);
    this.phase = Math.random() * 6;
  }

  animate(dt, speed, t, lunge) {
    this.phase += dt * clamp(speed / 3.2, 2, 6.2) * Math.PI * 2;
    const p = this.phase;
    this.body.position.y = 0.85 + Math.abs(Math.sin(p)) * 0.22 + lunge * 0.3;
    this.body.rotation.x = Math.sin(p) * 0.22 - 0.15 - lunge * 0.5;
    this.armL.a.rotation.x = Math.sin(p) * 1.05 + 0.2 + lunge * 1.2;
    this.armR.a.rotation.x = Math.sin(p + 0.35) * 1.05 + 0.2 + lunge * 1.4;
    this.armL.b.rotation.x = -0.3 - Math.max(0, Math.cos(p)) * 0.8;
    this.armR.b.rotation.x = -0.3 - Math.max(0, Math.cos(p + 0.35)) * 0.8;
    this.legL.a.rotation.x = Math.sin(p + Math.PI) * 0.95;
    this.legR.a.rotation.x = Math.sin(p + Math.PI + 0.3) * 0.95;
    this.legL.b.rotation.x = -0.4 - Math.max(0, Math.cos(p + Math.PI)) * 0.9;
    this.legR.b.rotation.x = -0.4 - Math.max(0, Math.cos(p + Math.PI + 0.3)) * 0.9;
    this.head.rotation.x = -Math.sin(p) * 0.15 + 0.1;
    this.head.rotation.y = Math.sin(t * 3 + this.phase * 0.1) * 0.15;
  }
}

export class Chasers {
  constructor(scene) {
    const fur = new THREE.MeshStandardMaterial({ color: 0x2c201b, roughness: 1 });
    const face = new THREE.MeshStandardMaterial({ color: 0x6b4a3a, roughness: 0.9 });
    const eye = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 1.2, 0.3) });
    this.list = [
      { g: new Guardian(fur, face, eye, 0.95), back: 0, side: -0.8 },
      { g: new Guardian(fur, face, eye, 1.05), back: 1.1, side: 0.85 },
      { g: new Guardian(fur, face, eye, 0.9), back: 2.1, side: -0.05 },
    ];
    for (const c of this.list) scene.add(c.g.root);
    this.dist = 3;
    this.visible = true;
  }

  setVisible(v) { for (const c of this.list) c.g.root.visible = v; }

  // crumbs: [{x,y,z,yaw,odo}] oldest first. odo: runner odometer.
  update(dt, crumbs, odo, speed, t, lunge = 0) {
    if (!crumbs.length) return;
    const first = crumbs[0];
    const step = crumbs.length > 1 ? (crumbs[crumbs.length - 1].odo - first.odo) / (crumbs.length - 1) : 1;
    for (const c of this.list) {
      const target = odo - this.dist - c.back;
      let x, y, z, yaw;
      if (target <= first.odo) {
        const back = first.odo - target;
        x = first.x + Math.sin(first.yaw) * back;
        z = first.z + Math.cos(first.yaw) * back;
        y = 0; yaw = first.yaw;
      } else {
        const f = clamp((target - first.odo) / step, 0, crumbs.length - 1.001);
        const i = Math.floor(f), k = f - i;
        const a = crumbs[i], b = crumbs[i + 1] || a;
        x = lerp(a.x, b.x, k); y = lerp(a.y, b.y, k); z = lerp(a.z, b.z, k);
        let dy = b.yaw - a.yaw;
        if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
        yaw = a.yaw + dy * k;
      }
      // lateral spread (right vector of yaw)
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const root = c.g.root;
      root.position.set(x + rx * c.side, Math.max(0, y), z + rz * c.side);
      let dyaw = yaw - root.rotation.y;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      root.rotation.y += dyaw * Math.min(1, dt * 10);
      c.g.animate(dt, speed, t, lunge);
    }
  }
}
