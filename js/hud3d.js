// In-world HUD for headset play: canvas-textured panels attached to the
// camera rig (they stay in the running direction instead of glued to the face).
import * as THREE from 'three';

function panel(w, h, pxW, pxH) {
  const c = document.createElement('canvas');
  c.width = pxW; c.height = pxH;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  return { c, ctx: c.getContext('2d'), tex, mesh, key: '' };
}

const DISPLAY = '"Cinzel", "Times New Roman", serif';
const UI = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';

export class VRHud {
  constructor(rig) {
    this.group = new THREE.Group();
    rig.add(this.group);
    this.top = panel(1.5, 0.28, 768, 144);
    // above the horizon so it never covers the path ahead
    this.top.mesh.position.set(0, 1.2, -3.0);
    this.top.mesh.rotation.x = 0.36;
    this.center = panel(2.6, 1.3, 1024, 512);
    this.center.mesh.position.set(0, 0.05, -2.3);
    // jump / crouch hint, low over the path ahead
    this.hintP = panel(1.5, 0.42, 768, 216);
    this.hintP.mesh.position.set(0, -0.34, -2.2);
    this.hintP.mesh.rotation.x = -0.15;
    this.hintP.mesh.visible = false;
    this.group.add(this.top.mesh, this.center.mesh, this.hintP.mesh);
    this.group.visible = false;
    this.center.mesh.visible = false;
  }

  setVisible(v) {
    this.group.visible = v;
    if (!v && this.ring) this.ring.mesh.visible = false;
  }

  // Small head-locked ring for the look-down recenter gesture: it has to sit
  // wherever the player is looking, unlike the panels fixed to the path.
  attachHeadLocked(camera) {
    this.ring = panel(0.42, 0.42, 256, 256);
    this.ring.mesh.position.set(0, 0, -1.3);
    this.ring.mesh.visible = false;
    camera.add(this.ring.mesh);
  }

  recenterProgress(p) {
    const R = this.ring;
    if (!R) return;
    if (!(p > 0) || !this.group.visible) { R.mesh.visible = false; R.key = ''; return; }
    R.mesh.visible = true;
    const step = Math.min(40, Math.round(p * 40));
    const key = String(step);
    if (key === R.key) return;
    R.key = key;
    const { ctx, c } = R;
    const m = c.width / 2;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(16,10,8,0.72)';
    ctx.beginPath(); ctx.arc(m, m, 118, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 14; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(246,230,200,0.18)';
    ctx.beginPath(); ctx.arc(m, m, 100, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#7cf0be';
    ctx.beginPath(); ctx.arc(m, m, 100, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (step / 40)); ctx.stroke();
    ctx.fillStyle = '#f6e6c8';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 34px ${UI}`;
    ctx.fillText('RECENTER', m, m - 14);
    ctx.font = `600 24px ${UI}`;
    ctx.fillStyle = 'rgba(246,230,200,0.75)';
    ctx.fillText('keep looking down', m, m + 22);
    R.tex.needsUpdate = true;
  }

  setStats(score, coins, mult, flash) {
    const key = `${score}|${coins}|${mult}|${flash || ''}`;
    const p = this.top;
    if (key === p.key) return;
    p.key = key;
    const { ctx, c } = p;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(16,10,8,0.55)';
    ctx.beginPath(); ctx.roundRect(4, 4, c.width - 8, c.height - 8, 24); ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.font = `700 64px ${UI}`;
    ctx.fillStyle = '#f6e6c8';
    ctx.textAlign = 'left';
    ctx.fillText(String(score), 40, c.height / 2 + 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd88a';
    ctx.fillText(`● ${coins}`, c.width - 40, c.height / 2 + 2);
    ctx.textAlign = 'center';
    // centre slot: multiplier, or a flash confirming a real jump / crouch
    ctx.fillStyle = flash ? '#6fd3a8' : '#f0b44c';
    ctx.font = `700 ${flash ? 56 : 48}px ${UI}`;
    ctx.fillText(flash || `x${mult}`, c.width / 2, c.height / 2 + 2);
    p.tex.needsUpdate = true;
  }

  // action: 'jump' | 'slide' | null. stage 1 = get ready, 2 = now.
  hint(action, stage) {
    const p = this.hintP;
    if (!action) { p.mesh.visible = false; p.key = ''; return; }
    p.mesh.visible = true;
    const key = action + stage;
    if (key === p.key) return;
    p.key = key;
    const { ctx, c } = p;
    const now = stage === 2;
    const color = now ? '#7cf0be' : '#ffd88a';
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = now ? 'rgba(10,40,28,0.78)' : 'rgba(16,10,8,0.6)';
    ctx.beginPath(); ctx.roundRect(4, 4, c.width - 8, c.height - 8, 30); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = now ? 6 : 3; ctx.stroke();
    // arrow
    const ax = 110, ay = c.height / 2, s = now ? 52 : 42, up = action === 'jump';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(ax - s, ay + (up ? s * 0.55 : -s * 0.55));
    ctx.lineTo(ax + s, ay + (up ? s * 0.55 : -s * 0.55));
    ctx.lineTo(ax, ay + (up ? -s * 0.75 : s * 0.75));
    ctx.closePath(); ctx.fill();
    const word = up ? 'JUMP' : 'CROUCH';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const text = now ? word + '!' : word;
    let size = now ? 104 : 80;
    ctx.font = `800 ${size}px ${DISPLAY}`;
    const maxW = c.width - 230;
    const w = ctx.measureText(text).width;
    if (w > maxW) { size = Math.floor(size * maxW / w); ctx.font = `800 ${size}px ${DISPLAY}`; }
    ctx.fillText(text, 200, ay + (now ? 6 : -14));
    if (!now) {
      ctx.font = `600 36px ${UI}`;
      ctx.fillStyle = 'rgba(246,230,200,0.8)';
      ctx.fillText('get ready', 204, ay + 58);
    }
    p.tex.needsUpdate = true;
  }

  // lines: [{text, size, color, font}]
  message(lines) {
    const p = this.center;
    if (!lines) { p.mesh.visible = false; p.key = ''; return; }
    p.mesh.visible = true;
    const key = JSON.stringify(lines);
    if (key === p.key) return;
    p.key = key;
    const { ctx, c } = p;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(16,10,8,0.72)';
    ctx.beginPath(); ctx.roundRect(6, 6, c.width - 12, c.height - 12, 30); ctx.fill();
    ctx.strokeStyle = 'rgba(240,180,76,0.5)'; ctx.lineWidth = 3; ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const total = lines.reduce((a, l) => a + (l.size || 48) * 1.25, 0);
    let y = c.height / 2 - total / 2;
    for (const l of lines) {
      const s = l.size || 48;
      ctx.font = `${l.weight || 800} ${s}px ${l.display ? DISPLAY : UI}`;
      ctx.fillStyle = l.color || '#f6e6c8';
      ctx.fillText(l.text, c.width / 2, y + s * 0.62);
      y += s * 1.25;
    }
    p.tex.needsUpdate = true;
  }
}
