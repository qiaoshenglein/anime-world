import * as THREE from 'three';
import { mat, addOutline, canvasTex, toon } from './materials.js';
import { makeRng } from './noise.js';

// materials that react to time of day (updated by world)
export const Glow = {
  window: new THREE.MeshBasicMaterial({ color: 0xbfe6ff }),
  lantern: new THREE.MeshBasicMaterial({ color: 0xffc46b }),
  crystal: new THREE.MeshBasicMaterial({ color: 0x9ff3ff }),
};

const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const CYL = (rt, rb, h, s = 12) => new THREE.CylinderGeometry(rt, rb, h, s);

function part(parent, geo, material, x = 0, y = 0, z = 0, o = {}) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  if (o.rx) m.rotation.x = o.rx;
  if (o.ry) m.rotation.y = o.ry;
  if (o.rz) m.rotation.z = o.rz;
  if (o.s) m.scale.setScalar(o.s);
  m.castShadow = o.cast !== false;
  m.receiveShadow = true;
  parent.add(m);
  if (o.outline) addOutline(m, o.outline);
  return m;
}

// add circle colliders along the long axis of a rotated box
export function boxColliders(list, x, z, w, d, rot = 0) {
  const long = Math.max(w, d), short = Math.min(w, d);
  const r = short / 2 + 0.25;
  const n = Math.max(1, Math.ceil(long / short));
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * (long - short);
    const lx = w >= d ? t : 0, lz = w >= d ? 0 : t;
    const c = Math.cos(rot), s = Math.sin(rot);
    list.push({ x: x + lx * c + lz * s, z: z - lx * s + lz * c, r });
  }
}

export function makeHouse({ w = 6, d = 5, h = 3.1, wall = 0xfff0da, roof = 0xd0584a, chimney = true } = {}) {
  const g = new THREE.Group();
  const th = 0.055;
  part(g, B(w + 0.6, 0.7, d + 0.6), mat(0xb9b2c8), 0, 0.3, 0, { outline: th });
  part(g, B(w, h, d), mat(wall), 0, 0.65 + h / 2, 0, { outline: th });
  const wood = mat(0x7a5544);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    part(g, B(0.26, h + 0.05, 0.26), wood, (sx * w) / 2, 0.65 + h / 2, (sz * d) / 2);
  part(g, B(w + 0.2, 0.2, d + 0.2), wood, 0, 0.65 + h * 0.98, 0);
  part(g, B(w + 0.1, 0.16, d + 0.1), wood, 0, 0.65 + h * 0.42, 0, { cast: false });
  // roof
  const rh = 2.7;
  const roofGeo = new THREE.ConeGeometry(1, rh, 4, 1);
  roofGeo.rotateY(Math.PI / 4);
  const rm = part(g, roofGeo, mat(roof), 0, 0.65 + h + rh / 2 - 0.1, 0, { outline: 0.06 });
  rm.scale.set((w / 2 + 1.1) / 0.7071, 1, (d / 2 + 1.1) / 0.7071);
  part(g, B(w + 2.3, 0.18, d + 2.3), mat(new THREE.Color(roof).multiplyScalar(0.7).getHex()), 0, 0.65 + h + 0.05, 0);
  part(g, new THREE.SphereGeometry(0.28, 10, 8), mat(0xffd36b), 0, 0.65 + h + rh - 0.05, 0);
  // door
  part(g, B(1.2, 2.1, 0.2), mat(0x8a5340), 0, 0.65 + 1.05, d / 2 + 0.04, { outline: 0.03 });
  part(g, new THREE.SphereGeometry(0.07, 8, 6), mat(0xffd36b), 0.38, 0.65 + 1.05, d / 2 + 0.17, { cast: false });
  part(g, B(1.6, 0.14, 0.9), mat(0xcbbba5), 0, 0.73, d / 2 + 0.55);
  // windows
  for (const sx of [-1, 1]) {
    const wx = sx * w * 0.3;
    part(g, B(1.0, 1.0, 0.1), Glow.window, wx, 0.65 + h * 0.62, d / 2 + 0.02, { cast: false });
    part(g, B(1.2, 0.1, 0.16), wood, wx, 0.65 + h * 0.62 - 0.55, d / 2 + 0.06, { cast: false });
    part(g, B(0.08, 1.0, 0.14), wood, wx, 0.65 + h * 0.62, d / 2 + 0.06, { cast: false });
    part(g, B(1.0, 0.08, 0.14), wood, wx, 0.65 + h * 0.62, d / 2 + 0.06, { cast: false });
    // flower box
    part(g, B(1.1, 0.25, 0.3), mat(0x9b6a4a), wx, 0.65 + h * 0.62 - 0.72, d / 2 + 0.22, { cast: false });
    for (let i = 0; i < 4; i++)
      part(g, new THREE.SphereGeometry(0.12, 6, 5), mat([0xff8fb8, 0xffe66b, 0xffffff, 0xff9f6b][i]),
        wx - 0.4 + i * 0.27, 0.65 + h * 0.62 - 0.5, d / 2 + 0.25, { cast: false });
  }
  for (const sx of [-1, 1]) part(g, B(0.1, 1.0, 1.0), Glow.window, sx * (w / 2 + 0.02), 0.65 + h * 0.62, 0, { cast: false });
  if (chimney) part(g, B(0.7, 1.9, 0.7), mat(0xa39bb5), w * 0.28, 0.65 + h + 1.3, -d * 0.2, { outline: 0.04 });
  return g;
}

export function makeTorii(scale = 1) {
  const g = new THREE.Group();
  const red = mat(0xdb3a2f), blk = mat(0x2b2235);
  for (const sx of [-1, 1]) {
    part(g, CYL(0.34, 0.4, 5.6, 12), red, sx * 2.7, 2.8, 0, { outline: 0.04 });
    part(g, CYL(0.5, 0.5, 0.4, 12), blk, sx * 2.7, 0.2, 0);
  }
  part(g, B(8.4, 0.5, 0.8), blk, 0, 5.75, 0, { outline: 0.04 });
  part(g, B(8.0, 0.3, 0.7), red, 0, 6.05, 0);
  part(g, B(6.3, 0.34, 0.4), red, 0, 4.55, 0, { outline: 0.03 });
  part(g, B(0.5, 1.0, 0.4), blk, 0, 5.1, 0);
  g.scale.setScalar(scale);
  return g;
}

export function makeStoneLantern() {
  const g = new THREE.Group();
  const st = mat(0xc9c2d6);
  part(g, CYL(0.5, 0.6, 0.3, 8), st, 0, 0.15, 0);
  part(g, CYL(0.18, 0.22, 1.2, 8), st, 0, 0.9, 0, { outline: 0.03 });
  part(g, CYL(0.5, 0.4, 0.2, 8), st, 0, 1.6, 0);
  part(g, B(0.55, 0.55, 0.55), Glow.lantern, 0, 1.98, 0, { cast: false });
  part(g, new THREE.ConeGeometry(0.7, 0.55, 8), st, 0, 2.5, 0, { outline: 0.03 });
  part(g, new THREE.SphereGeometry(0.12, 8, 6), st, 0, 2.85, 0);
  return g;
}

export function makeWindmill() {
  const g = new THREE.Group();
  part(g, CYL(2.0, 3.0, 9, 10), mat(0xfff3e0), 0, 4.5, 0, { outline: 0.06 });
  part(g, CYL(3.1, 3.1, 0.4, 10), mat(0x8f86a8), 0, 0.2, 0);
  part(g, new THREE.ConeGeometry(2.9, 3.2, 10), mat(0xd0584a), 0, 10.6, 0, { outline: 0.06 });
  part(g, B(1.2, 2.0, 0.2), mat(0x8a5340), 0, 1.0, 2.9, { rx: 0 });
  const hub = new THREE.Group();
  hub.position.set(0, 8.4, 2.3);
  g.add(hub);
  part(hub, CYL(0.35, 0.35, 0.8, 8), mat(0x7a5544), 0, 0, 0, { rx: Math.PI / 2 });
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    arm.rotation.z = (i * Math.PI) / 2;
    hub.add(arm);
    part(arm, B(0.25, 7.2, 0.18), mat(0x7a5544), 0, 3.6, 0.4);
    part(arm, B(1.5, 5.0, 0.08), mat(0xffffff), 0.85, 4.1, 0.46, { cast: false });
  }
  g.userData.hub = hub;
  return g;
}

export function makeWell() {
  const g = new THREE.Group();
  const stone = mat(0xb7afc6);
  part(g, CYL(1.4, 1.5, 1.1, 12), stone, 0, 0.55, 0, { outline: 0.04 });
  part(g, new THREE.CircleGeometry(1.2, 14), toon(0x4fc3e8), 0, 1.08, 0, { rx: -Math.PI / 2, cast: false });
  for (const sx of [-1, 1]) part(g, B(0.2, 2.2, 0.2), mat(0x7a5544), sx * 1.3, 2.0, 0);
  const rf = part(g, new THREE.ConeGeometry(2.0, 1.1, 4), mat(0xd0584a), 0, 3.6, 0, { ry: Math.PI / 4, outline: 0.04 });
  rf.scale.set(1, 1, 0.75);
  return g;
}

export function makeStall(awning = 0xff8fb8) {
  const g = new THREE.Group();
  const wood = mat(0x8a5f45);
  part(g, B(3.4, 1.0, 1.6), wood, 0, 0.5, 0, { outline: 0.04 });
  for (const sx of [-1, 1]) part(g, CYL(0.09, 0.09, 2.6, 6), wood, sx * 1.6, 1.6, 0.7);
  const aw = part(g, B(3.8, 0.12, 2.2), mat(awning), 0, 2.9, 0.35, { rx: 0.22, outline: 0.03 });
  for (let i = 0; i < 6; i++)
    part(g, B(0.3, 0.13, 2.22), mat(0xffffff), -1.6 + i * 0.64, 2.9, 0.35, { rx: 0.22, cast: false });
  const fruit = [0xff5f6b, 0xffc34a, 0xa5e05a, 0xff9ad0];
  for (let i = 0; i < 8; i++)
    part(g, new THREE.SphereGeometry(0.2, 8, 6), mat(fruit[i % 4]), -1.2 + (i % 4) * 0.8, 1.2, -0.3 + Math.floor(i / 4) * 0.5, { cast: false });
  return g;
}

export function makeSign(text = '始源之村') {
  const g = new THREE.Group();
  part(g, B(0.25, 2.4, 0.25), mat(0x7a5544), 0, 1.2, 0);
  const tex = canvasTex(256, 128, (c, w, h) => {
    c.fillStyle = '#f4dcae'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#8a5f45'; c.lineWidth = 10; c.strokeRect(5, 5, w - 10, h - 10);
    c.fillStyle = '#5a3a2a'; c.font = 'bold 44px "Microsoft YaHei",sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, w / 2, h / 2);
  });
  part(g, B(2.4, 1.2, 0.14), new THREE.MeshToonMaterial({ map: tex, gradientMap: mat(0).gradientMap }), 0, 2.4, 0.12, { outline: 0.03 });
  return g;
}

// stacked shrine hall
export function makeShrine() {
  const g = new THREE.Group();
  const red = mat(0xdb3a2f), white = mat(0xfff6ea), dark = mat(0x3a2a3f), gold = mat(0xffd36b);
  for (let i = 0; i < 3; i++) part(g, B(13 - i * 0.8, 0.5, 11 - i * 0.8), mat(0xc9c2d6), 0, 0.25 + i * 0.5, 0);
  part(g, B(9, 4, 7), white, 0, 1.5 + 2, 0, { outline: 0.06 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    part(g, CYL(0.3, 0.3, 4.2, 10), red, sx * 4.4, 3.6, sz * 3.4, { outline: 0.04 });
  part(g, B(9.8, 0.3, 7.8), red, 0, 5.65, 0);
  // layered roof
  for (let i = 0; i < 3; i++) {
    const r = part(g, new THREE.ConeGeometry(1, 1.5 - i * 0.2, 4), dark, 0, 6.3 + i * 1.0, 0, { ry: Math.PI / 4, outline: 0.06 });
    const k = 1 - i * 0.22;
    r.scale.set((7.6 * k) / 0.7071, 1, (6.2 * k) / 0.7071);
  }
  part(g, new THREE.SphereGeometry(0.4, 10, 8), gold, 0, 9.3, 0);
  part(g, new THREE.ConeGeometry(0.16, 0.9, 8), gold, 0, 9.9, 0);
  // door + rope
  part(g, B(2.6, 2.8, 0.2), mat(0x7a3a30), 0, 3.3, 3.55);
  part(g, new THREE.TorusGeometry(1.6, 0.14, 8, 20, Math.PI), mat(0xffffff), 0, 4.6, 3.75, { rx: Math.PI, cast: false });
  // offering box
  part(g, B(2.2, 0.9, 1.0), mat(0x8a5f45), 0, 1.5 + 0.45, 6.3, { outline: 0.04 });
  for (let i = 0; i < 5; i++) part(g, B(2.3, 0.08, 0.14), dark, 0, 2.0 + 0, 5.85 + i * 0.18, { cast: false });
  g.userData.doorZ = 7;
  return g;
}

export function makeMagicCircle(color = '#ff9ad0', size = 10) {
  const tex = canvasTex(512, 512, (c, w, h) => {
    c.translate(w / 2, h / 2);
    c.strokeStyle = color; c.fillStyle = color; c.shadowColor = color; c.shadowBlur = 12;
    c.lineWidth = 8; c.beginPath(); c.arc(0, 0, 240, 0, 7); c.stroke();
    c.lineWidth = 3; c.beginPath(); c.arc(0, 0, 215, 0, 7); c.stroke();
    c.lineWidth = 4; c.beginPath(); c.arc(0, 0, 130, 0, 7); c.stroke();
    c.lineWidth = 5;
    for (const n of [5, 6]) {
      c.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = (((i * 2) % n) / n) * Math.PI * 2 - Math.PI / 2;
        const px = Math.cos(a) * 215, py = Math.sin(a) * 215;
        i ? c.lineTo(px, py) : c.moveTo(px, py);
      }
      c.stroke();
    }
    c.font = '28px serif'; c.textAlign = 'center';
    for (let i = 0; i < 24; i++) {
      c.save(); c.rotate((i / 24) * Math.PI * 2); c.fillText('✦', 0, -175); c.restore();
    }
  });
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 2;
  return m;
}

export function makeGreatTree() {
  const g = new THREE.Group();
  const bark = mat(0x8a5f6e);
  const trunk = part(g, CYL(1.8, 3.2, 13, 10), bark, 0, 6.5, 0, { outline: 0.1 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const b = part(g, CYL(0.55, 1.1, 10, 7), bark, Math.cos(a) * 2.6, 11.5, Math.sin(a) * 2.6, {
      rz: Math.cos(a) * -0.9, rx: Math.sin(a) * 0.9, outline: 0.07,
    });
  }
  const rng = makeRng(5);
  const pinks = [0xffb0d0, 0xff9cc2, 0xffc8de, 0xffa6c9];
  const blob = new THREE.IcosahedronGeometry(1, 2);
  for (let i = 0; i < 22; i++) {
    const a = rng() * Math.PI * 2, r = rng() * 9;
    const s = 4.5 + rng() * 4.5;
    const m = part(g, blob, mat(pinks[i % 4], { emissive: 0xff6fa5, emissiveIntensity: 0.12 }),
      Math.cos(a) * r, 15 + rng() * 9 + (1 - r / 9) * 3, Math.sin(a) * r, { cast: true });
    m.scale.set(s, s * 0.8, s);
  }
  return g;
}

export function makePillar(h = 5, broken = false) {
  const g = new THREE.Group();
  const st = mat(0xb6aec8);
  part(g, B(1.9, 0.5, 1.9), st, 0, 0.25, 0, { outline: 0.04 });
  part(g, CYL(0.7, 0.8, h, 8), st, 0, 0.5 + h / 2, 0, { outline: 0.04 });
  if (!broken) part(g, B(1.7, 0.5, 1.7), st, 0, 0.5 + h + 0.25, 0, { outline: 0.04 });
  else part(g, B(1.0, 0.9, 1.0), st, 1.6, 0.45, 0.6, { ry: 0.5, rz: 0.3, outline: 0.04 });
  const rune = part(g, new THREE.TorusGeometry(0.82, 0.05, 6, 16), Glow.crystal, 0, 2.0, 0, { rx: Math.PI / 2, cast: false });
  return g;
}

export function makeCrystalCluster(color = 0x9ff3ff, s = 1) {
  const g = new THREE.Group();
  const m = new THREE.MeshToonMaterial({ color, gradientMap: mat(0).gradientMap, emissive: color, emissiveIntensity: 0.6 });
  const geo = new THREE.OctahedronGeometry(1, 0);
  const rng = makeRng(13);
  for (let i = 0; i < 5; i++) {
    const c = part(g, geo, m, (rng() - 0.5) * 1.6 * s, 0.9 * s, (rng() - 0.5) * 1.6 * s, { outline: 0.04 });
    c.scale.set(0.35 * s, (1.0 + rng() * 1.4) * s, 0.35 * s);
    c.rotation.set((rng() - 0.5) * 0.5, rng() * 3, (rng() - 0.5) * 0.5);
    c.position.y = c.scale.y * 0.8;
  }
  return g;
}

export function makeFloatingIsland(r = 9, seed = 1) {
  const g = new THREE.Group();
  const rng = makeRng(seed);
  const rock = new THREE.ConeGeometry(r * 0.98, r * 1.5, 9, 1);
  rock.rotateX(Math.PI);
  const p = rock.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < -1) { p.setX(i, p.getX(i) * (0.9 + rng() * 0.3)); p.setZ(i, p.getZ(i) * (0.9 + rng() * 0.3)); }
  }
  rock.computeVertexNormals();
  part(g, rock, mat(0x7a6a98, { flatShading: true }), 0, -r * 0.75, 0, { outline: 0.1 });
  part(g, CYL(r, r * 0.98, 1.0, 14), mat(0x8fe05a), 0, -0.5, 0, { outline: 0.08 });
  part(g, CYL(r * 0.99, r, 0.35, 14), mat(0x6e4f5c), 0, -1.1, 0);
  // little tree
  part(g, CYL(0.25, 0.35, 2.2, 7), mat(0x8a5f45), r * 0.4, 1.1, r * 0.1);
  for (const [x, y, s] of [[0, 2.6, 1.6], [0.8, 2.2, 1.2], [-0.7, 2.3, 1.1]]) {
    const b = part(g, new THREE.IcosahedronGeometry(1, 1), mat(0xff9cc2), r * 0.4 + x, y, r * 0.1, { outline: 0.05 });
    b.scale.setScalar(s);
  }
  // rocks + crystals
  const cc = makeCrystalCluster(0xb8a0ff, 0.9);
  cc.position.set(-r * 0.45, 0, -r * 0.2);
  g.add(cc);
  // hanging vines of glowing dots
  g.userData.radius = r;
  return g;
}

export function makePier(len = 16) {
  const g = new THREE.Group();
  const wood = mat(0xb08560);
  for (let i = 0; i < len * 2; i++) part(g, B(0.9, 0.14, 2.8), mat(i % 2 ? 0xb08560 : 0xa17853), i * 0.5, 0, 0, { cast: false });
  for (let i = 0; i <= len / 2; i++)
    for (const sz of [-1, 1]) part(g, CYL(0.14, 0.14, 4, 6), mat(0x6e4f3c), i * 2, -1.5, sz * 1.3);
  const lan = makeStoneLantern();
  lan.scale.setScalar(0.5);
  lan.position.set(len - 0.6, 0.1, 1.1);
  g.add(lan);
  return g;
}

export function makeBoat() {
  const g = new THREE.Group();
  const hull = new THREE.CylinderGeometry(1.1, 0.6, 4, 8, 1, false, 0, Math.PI);
  hull.rotateZ(Math.PI / 2);
  const h = part(g, hull, mat(0xe9d2a0), 0, 0.2, 0, { outline: 0.04, rx: Math.PI });
  part(g, new THREE.ConeGeometry(0.8, 1.2, 6), mat(0xe9d2a0), 2.3, 0.5, 0, { rz: -Math.PI / 2 });
  part(g, B(0.1, 3.5, 0.1), mat(0x7a5544), 0, 2.1, 0);
  part(g, new THREE.PlaneGeometry(2.2, 2.6), new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: mat(0).gradientMap, side: THREE.DoubleSide }), 0.1, 2.3, 0.1);
  return g;
}

export function makeBench() {
  const g = new THREE.Group();
  part(g, B(2.0, 0.12, 0.6), mat(0xa17853), 0, 0.55, 0);
  part(g, B(2.0, 0.5, 0.1), mat(0xa17853), 0, 0.95, -0.3);
  for (const sx of [-1, 1]) part(g, B(0.1, 0.55, 0.5), mat(0x6e4f3c), sx * 0.85, 0.27, 0);
  return g;
}

export function makeFence(len = 4) {
  const g = new THREE.Group();
  const wood = mat(0xd9b98a);
  for (let i = 0; i <= 2; i++) part(g, B(0.16, 1.0, 0.16), wood, -len / 2 + (i * len) / 2, 0.5, 0);
  part(g, B(len, 0.12, 0.08), wood, 0, 0.8, 0);
  part(g, B(len, 0.12, 0.08), wood, 0, 0.4, 0);
  return g;
}

export function makeLampPost() {
  const g = new THREE.Group();
  part(g, CYL(0.09, 0.12, 3.4, 6), mat(0x3a2a3f), 0, 1.7, 0);
  part(g, new THREE.SphereGeometry(0.32, 10, 8), Glow.lantern, 0, 3.6, 0, { cast: false });
  part(g, new THREE.ConeGeometry(0.42, 0.3, 8), mat(0x3a2a3f), 0, 4.0, 0);
  return g;
}

// mark every mesh in a group for shadow casting / receiving properly
export function finalize(group) {
  group.traverse((o) => {
    if (o.isMesh && o.userData.isOutline) { o.castShadow = false; o.receiveShadow = false; }
  });
  return group;
}
