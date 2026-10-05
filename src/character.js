import * as THREE from 'three';
import { toon, addOutline, canvasTex } from './materials.js';
import { clamp } from './noise.js';

const darker = (hex, k) => new THREE.Color(hex).multiplyScalar(k).getHex();
const eyeCache = new Map();
function eyeTexture(iris) {
  if (eyeCache.has(iris)) return eyeCache.get(iris);
  const base = new THREE.Color(iris);
  const top = '#' + base.clone().multiplyScalar(0.35).getHexString();
  const mid = '#' + base.getHexString();
  const low = '#' + base.clone().lerp(new THREE.Color(0xffffff), 0.55).getHexString();
  const t = canvasTex(128, 128, (c) => {
    c.fillStyle = '#ffffff';
    c.beginPath(); c.ellipse(64, 68, 50, 54, 0, 0, 7); c.fill();
    const g = c.createLinearGradient(0, 20, 0, 116);
    g.addColorStop(0, top); g.addColorStop(0.55, mid); g.addColorStop(1, low);
    c.fillStyle = g;
    c.beginPath(); c.ellipse(64, 70, 38, 48, 0, 0, 7); c.fill();
    c.fillStyle = '#1a1030';
    c.beginPath(); c.ellipse(64, 66, 15, 23, 0, 0, 7); c.fill();
    c.fillStyle = '#ffffff';
    c.beginPath(); c.ellipse(49, 44, 12, 14, -0.3, 0, 7); c.fill();
    c.beginPath(); c.ellipse(80, 90, 6, 6, 0, 0, 7); c.fill();
    c.beginPath(); c.ellipse(74, 100, 3, 3, 0, 0, 7); c.fill();
    // upper lash
    c.strokeStyle = '#2a1a3a'; c.lineCap = 'round';
    c.lineWidth = 11;
    c.beginPath(); c.ellipse(64, 72, 48, 50, 0, Math.PI * 1.06, Math.PI * 1.94); c.stroke();
    c.lineWidth = 7;
    c.beginPath(); c.moveTo(108, 36); c.quadraticCurveTo(120, 28, 124, 14); c.stroke();
    c.lineWidth = 3;
    c.beginPath(); c.ellipse(64, 70, 46, 50, 0, Math.PI * 0.18, Math.PI * 0.82); c.stroke();
  });
  eyeCache.set(iris, t);
  return t;
}
const mouthTex = canvasTex(64, 32, (c) => {
  c.strokeStyle = '#7a2a3a'; c.lineWidth = 5; c.lineCap = 'round';
  c.beginPath(); c.moveTo(12, 10); c.quadraticCurveTo(32, 26, 52, 10); c.stroke();
});
const blushTex = canvasTex(64, 32, (c) => {
  const g = c.createRadialGradient(32, 16, 2, 32, 16, 30);
  g.addColorStop(0, 'rgba(255,110,140,.75)'); g.addColorStop(1, 'rgba(255,110,140,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 32);
});
const browTex = canvasTex(64, 16, (c) => {
  c.strokeStyle = '#fff'; c.lineWidth = 6; c.lineCap = 'round';
  c.beginPath(); c.moveTo(8, 11); c.quadraticCurveTo(32, 2, 56, 10); c.stroke();
});

const fl = (a, b, k) => a + (b - a) * k;

export function buildCharacter(opts = {}) {
  const o = Object.assign({
    hair: 0xff9ec8, eye: 0x3fd3e8, skin: 0xffe4d2, top: 0xfdfbff, skirt: 0x2a3270, trim: 0xffffff,
    accent: 0xe03a4e, scarf: 0xff9240, boots: 0x5b3a3a, sock: 0x2b2e58, style: 'twin', scale: 0.92,
    acc: [], sword: false, glider: false, scarfOn: true,
  }, opts);
  const mats = [];
  const M = (c, ex) => { const m = toon(c, ex); mats.push(m); return m; };
  const skinM = M(o.skin), hairM = M(o.hair), hairD = M(darker(o.hair, 0.78)), topM = M(o.top), skirtM = M(o.skirt, { side: THREE.DoubleSide, flatShading: true });
  const trimM = M(o.trim, { side: THREE.DoubleSide }), accM = M(o.accent), sockM = M(o.sock), bootM = M(o.boots), scarfM = M(o.scarf, { side: THREE.DoubleSide });
  const navyM = M(darker(o.skirt, 1.0));
  const goldM = M(0xffd36b);

  const mk = (parent, geo, m, p = [0, 0, 0], e = {}) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(p[0], p[1], p[2]);
    if (e.rot) mesh.rotation.set(e.rot[0], e.rot[1], e.rot[2]);
    if (e.scale) mesh.scale.set(e.scale[0], e.scale[1], e.scale[2]);
    mesh.castShadow = e.cast !== false;
    parent.add(mesh);
    if (e.outline) addOutline(mesh, e.outline);
    return mesh;
  };
  const grp = (parent, p = [0, 0, 0]) => { const g = new THREE.Group(); g.position.set(p[0], p[1], p[2]); parent.add(g); return g; };

  const root = new THREE.Group();
  const hips = grp(root, [0, 0.77, 0]);
  const C = { root, mats, opts: o };

  // ---- legs
  function leg(side) {
    const thigh = grp(hips, [side * 0.085, -0.02, 0]);
    mk(thigh, new THREE.CylinderGeometry(0.066, 0.064, 0.13, 10), skinM, [0, -0.07, 0], { outline: 0.011 });
    mk(thigh, new THREE.CylinderGeometry(0.07, 0.062, 0.22, 10), sockM, [0, -0.22, 0], { outline: 0.011 });
    const knee = grp(thigh, [0, -0.33, 0]);
    mk(knee, new THREE.SphereGeometry(0.062, 10, 8), sockM, [0, 0, 0]);
    mk(knee, new THREE.CylinderGeometry(0.062, 0.05, 0.3, 10), sockM, [0, -0.16, 0], { outline: 0.011 });
    const foot = grp(knee, [0, -0.33, 0]);
    mk(foot, new THREE.BoxGeometry(0.11, 0.09, 0.22), bootM, [0, 0.0, 0.04], { outline: 0.01 });
    mk(foot, new THREE.BoxGeometry(0.115, 0.04, 0.12), trimM, [0, 0.055, -0.01]);
    return { thigh, knee, foot };
  }
  const legL = leg(1), legR = leg(-1);

  // ---- skirt
  const skirt = grp(hips, [0, 0.0, 0]);
  mk(skirt, new THREE.CylinderGeometry(0.17, 0.33, 0.3, 16, 1, true), skirtM, [0, -0.12, 0], { outline: 0.0 });
  mk(skirt, new THREE.CylinderGeometry(0.334, 0.336, 0.035, 16, 1, true), trimM, [0, -0.255, 0]);
  mk(skirt, new THREE.CylinderGeometry(0.17, 0.17, 0.04, 16), accM, [0, 0.03, 0]);

  // ---- torso
  const torso = grp(hips, [0, 0.03, 0]);
  mk(torso, new THREE.CapsuleGeometry(0.125, 0.25, 6, 14), topM, [0, 0.25, 0], { scale: [1, 1, 0.85], outline: 0.012 });
  mk(torso, new THREE.TorusGeometry(0.135, 0.035, 8, 20), navyM, [0, 0.44, 0.0], { rot: [Math.PI / 2, 0, 0], scale: [1, 1, 0.8] });
  mk(torso, new THREE.BoxGeometry(0.3, 0.025, 0.24), navyM, [0, 0.43, -0.09], { rot: [0.15, 0, 0] });
  mk(torso, new THREE.BoxGeometry(0.3, 0.012, 0.03), trimM, [0, 0.44, -0.2], { rot: [0.15, 0, 0] });
  const bow = grp(torso, [0, 0.36, 0.12]);
  mk(bow, new THREE.ConeGeometry(0.05, 0.1, 6), accM, [0.05, 0, 0], { rot: [0, 0, -Math.PI / 2], outline: 0.008 });
  mk(bow, new THREE.ConeGeometry(0.05, 0.1, 6), accM, [-0.05, 0, 0], { rot: [0, 0, Math.PI / 2], outline: 0.008 });
  mk(bow, new THREE.SphereGeometry(0.03, 8, 6), accM, [0, 0, 0.01]);
  mk(torso, new THREE.CylinderGeometry(0.13, 0.135, 0.045, 14), goldM, [0, 0.03, 0], { scale: [1, 1, 0.85] });
  // neck
  mk(torso, new THREE.CylinderGeometry(0.04, 0.045, 0.1, 8), skinM, [0, 0.52, 0]);

  // ---- arms
  function arm(side) {
    const sh = grp(torso, [side * 0.185, 0.4, 0]);
    mk(sh, new THREE.SphereGeometry(0.055, 10, 8), topM, [0, 0, 0]);
    mk(sh, new THREE.CylinderGeometry(0.052, 0.058, 0.22, 10), topM, [0, -0.11, 0], { outline: 0.01 });
    const elbow = grp(sh, [0, -0.23, 0]);
    mk(elbow, new THREE.CylinderGeometry(0.058, 0.05, 0.1, 10), trimM, [0, -0.0, 0]);
    mk(elbow, new THREE.CylinderGeometry(0.042, 0.04, 0.15, 10), skinM, [0, -0.11, 0], { outline: 0.01 });
    const hand = grp(elbow, [0, -0.22, 0]);
    mk(hand, new THREE.SphereGeometry(0.052, 10, 8), skinM, [0, 0, 0], { outline: 0.01 });
    return { sh, elbow, hand };
  }
  const armL = arm(1), armR = arm(-1);

  // ---- head
  const HR = 0.27;
  const chestTop = grp(torso, [0, 0.47, 0]);
  const head = grp(chestTop, [0, 0.24, 0]);
  mk(head, new THREE.SphereGeometry(HR, 28, 20), skinM, [0, 0, 0], { scale: [1, 0.96, 0.97], outline: 0.014 });
  const onHead = (az, el, R) => ({
    p: [R * Math.sin(az) * Math.cos(el), R * Math.sin(el), R * Math.cos(az) * Math.cos(el)],
    r: [-el, az, 0],
  });
  const face = (geo, m, az, el, R, extra = {}) => {
    const { p, r } = onHead(az, el, R);
    const mesh = new THREE.Mesh(geo, m);
    mesh.rotation.order = 'YXZ';
    mesh.position.set(...p);
    mesh.rotation.set(r[0], r[1], 0);
    if (extra.sx) mesh.scale.x = extra.sx;
    head.add(mesh);
    return mesh;
  };
  const eyeMat = new THREE.MeshBasicMaterial({ map: eyeTexture(o.eye), transparent: true, alphaTest: 0.05, side: THREE.DoubleSide });
  const eyeGeo = new THREE.PlaneGeometry(0.155, 0.175);
  const eyeL = face(eyeGeo, eyeMat, 0.4, -0.06, HR * 0.97 + 0.004);
  const eyeR = face(eyeGeo, eyeMat, -0.4, -0.06, HR * 0.97 + 0.004, { sx: -1 });
  const mouth = face(new THREE.PlaneGeometry(0.07, 0.035), new THREE.MeshBasicMaterial({ map: mouthTex, transparent: true }), 0, -0.44, HR * 0.96 + 0.003);
  for (const s of [1, -1]) {
    face(new THREE.PlaneGeometry(0.1, 0.055), new THREE.MeshBasicMaterial({ map: blushTex, transparent: true, depthWrite: false }), s * 0.68, -0.26, HR * 0.96 + 0.002);
    const bm = new THREE.MeshBasicMaterial({ map: browTex, color: darker(o.hair, 0.5), transparent: true });
    face(new THREE.PlaneGeometry(0.1, 0.025), bm, s * 0.42, 0.26, HR * 0.97 + 0.003, { sx: s });
  }
  C.eyes = [eyeL, eyeR];
  C.mouth = mouth;

  // ---- hair
  const hairGroup = grp(head);
  const back = mk(hairGroup, new THREE.SphereGeometry(0.295, 24, 18), hairM, [0, 0.035, -0.07], { scale: [1.04, 1.0, 1.0], outline: 0.014 });
  const nBang = 7;
  for (let i = 0; i < nBang; i++) {
    const az = (i / (nBang - 1) - 0.5) * 1.9;
    const el = 0.5 + Math.cos(az * 1.3) * 0.08;
    const len = 0.21 + Math.abs(Math.sin(i * 2.1)) * 0.07 + (i === 3 ? 0.03 : 0);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.075, len, 7), i % 2 ? hairM : hairD);
    const { p } = onHead(az, el, HR * 1.0);
    cone.position.set(p[0], p[1] - len * 0.3, p[2]);
    cone.rotation.order = 'YXZ';
    cone.rotation.set(Math.PI - 0.32, az, (i - 3) * 0.08);
    cone.castShadow = true;
    hairGroup.add(cone);
    addOutline(cone, 0.011);
  }
  // side locks
  for (const s of [1, -1]) {
    const { p } = onHead(s * 1.22, 0.05, HR * 0.98);
    const lock = mk(hairGroup, new THREE.CapsuleGeometry(0.05, 0.2, 4, 8), hairM, [p[0], p[1] - 0.1, p[2]], { rot: [0, 0, s * 0.08], outline: 0.01 });
  }
  const tails = [];
  const bunMesh = [];
  if (o.style === 'twin') {
    for (const s of [1, -1]) {
      const { p } = onHead(s * 1.35, 0.42, HR * 0.98);
      const pivot = grp(hairGroup, p);
      pivot.rotation.z = s * 0.4;
      mk(pivot, new THREE.SphereGeometry(0.05, 8, 6), accM, [0, 0, 0], { outline: 0.008 });
      const segs = [];
      let parent = pivot;
      const spec = [[0.095, 0.2], [0.08, 0.2], [0.06, 0.18], [0.04, 0.14]];
      for (let i = 0; i < spec.length; i++) {
        const [r, len] = spec[i];
        const g = grp(parent, [0, i === 0 ? -0.04 : -spec[i - 1][1] * 0.95, 0]);
        mk(g, new THREE.CapsuleGeometry(r, len, 4, 8), i % 2 ? hairD : hairM, [0, -len / 2 - 0.02, 0], { outline: 0.01 });
        segs.push(g);
        parent = g;
      }
      tails.push({ pivot, segs, side: s });
    }
  } else if (o.style === 'long') {
    const g = grp(hairGroup, [0, -0.1, -0.21]);
    mk(g, new THREE.CapsuleGeometry(0.2, 0.55, 6, 12), hairM, [0, -0.25, 0], { scale: [1, 1, 0.55], outline: 0.013 });
    tails.push({ pivot: g, segs: [], side: 0, long: true });
  } else if (o.style === 'short') {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const c = mk(hairGroup, new THREE.ConeGeometry(0.09, 0.25, 6), i % 2 ? hairM : hairD, [Math.cos(a) * 0.17, 0.2 + (i % 2) * 0.03, -0.12 + Math.sin(a) * 0.1], { rot: [-Math.sin(a) * 0.9 - 0.6, 0, -Math.cos(a) * 0.9], outline: 0.01 });
    }
  } else if (o.style === 'bun') {
    mk(hairGroup, new THREE.SphereGeometry(0.11, 12, 10), hairM, [0, 0.33, -0.1], { outline: 0.012 });
    mk(hairGroup, new THREE.TorusGeometry(0.11, 0.02, 6, 14), accM, [0, 0.27, -0.1], { rot: [Math.PI / 2, 0, 0] });
    const g = grp(hairGroup, [0, -0.1, -0.21]);
    mk(g, new THREE.CapsuleGeometry(0.15, 0.3, 6, 12), hairM, [0, -0.15, 0], { scale: [1, 1, 0.55], outline: 0.012 });
    tails.push({ pivot: g, segs: [], side: 0, long: true });
  }
  // ahoge
  const aho = mk(hairGroup, new THREE.ConeGeometry(0.022, 0.2, 6), hairM, [0.02, 0.33, 0.0], { rot: [0.2, 0, -0.4], outline: 0.008 });
  // star clip
  const clipP = onHead(-0.95, 0.52, HR * 1.0).p;
  const clip = mk(hairGroup, new THREE.OctahedronGeometry(0.045, 0), goldM, [clipP[0], clipP[1], clipP[2] + 0.01], { scale: [1, 1, 0.4], outline: 0.008 });

  // ---- accessories
  if (o.acc.includes('hat')) {
    const hat = grp(head, [0, 0.2, 0]);
    mk(hat, new THREE.CylinderGeometry(0.42, 0.42, 0.03, 20), M(0xe8cf8a), [0, 0, 0], { outline: 0.012 });
    mk(hat, new THREE.CylinderGeometry(0.2, 0.26, 0.22, 16), M(0xe8cf8a), [0, 0.12, 0], { outline: 0.012 });
    mk(hat, new THREE.CylinderGeometry(0.265, 0.265, 0.06, 16), accM, [0, 0.06, 0]);
  }
  if (o.acc.includes('beard')) {
    mk(head, new THREE.ConeGeometry(0.17, 0.55, 10), M(0xf4f4ff), [0, -0.33, 0.1], { rot: [Math.PI - 0.1, 0, 0], outline: 0.012 });
  }
  if (o.acc.includes('staff')) {
    const st = grp(armR.hand, [0, 0, 0]);
    st.rotation.x = 1.4;
    mk(st, new THREE.CylinderGeometry(0.025, 0.03, 1.5, 8), M(0x8a5f45), [0, 0.25, 0], { outline: 0.01 });
    mk(st, new THREE.TorusGeometry(0.1, 0.02, 6, 14), goldM, [0, 1.05, 0]);
    mk(st, new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff9ad0 }), [0, 1.05, 0]);
  }
  if (o.acc.includes('apron')) {
    mk(torso, new THREE.BoxGeometry(0.26, 0.3, 0.03), M(0xffffff), [0, 0.2, 0.115], { outline: 0.008 });
    mk(skirt, new THREE.CylinderGeometry(0.2, 0.3, 0.2, 10, 1, true, -0.9, 1.8), M(0xffffff, { side: THREE.DoubleSide }), [0, -0.1, 0.02]);
  }
  if (o.acc.includes('ears')) {
    for (const s of [1, -1]) {
      const e = mk(head, new THREE.ConeGeometry(0.1, 0.2, 4), hairM, [s * 0.17, 0.29, -0.02], { rot: [0, 0, -s * 0.3], outline: 0.01 });
    }
  }
  if (o.acc.includes('halo')) {
    const ring = mk(head, new THREE.TorusGeometry(0.2, 0.012, 6, 24), new THREE.MeshBasicMaterial({ color: 0xfff2a0 }), [0, 0.5, -0.05], { rot: [Math.PI / 2, 0, 0], cast: false });
  }

  // ---- scarf
  const scarfSegs = [];
  if (o.scarfOn) {
    mk(chestTop, new THREE.TorusGeometry(0.115, 0.05, 8, 18), scarfM, [0, -0.02, 0], { rot: [Math.PI / 2, 0, 0], outline: 0.01 });
    let p = grp(chestTop, [0, -0.03, -0.1]);
    for (let i = 0; i < 5; i++) {
      const g = grp(p, [0, i === 0 ? 0 : -0.1, 0]);
      mk(g, new THREE.BoxGeometry(0.11 - i * 0.008, 0.11, 0.025), scarfM, [0, -0.05, 0], { outline: i === 0 ? 0.008 : 0 });
      scarfSegs.push(g);
      p = g;
    }
  }

  // ---- sword
  let sword = null, backSlot = null;
  if (o.sword) {
    sword = new THREE.Group();
    const blade = mk(sword, new THREE.BoxGeometry(0.075, 0.95, 0.02), M(0xe7f4ff, { emissive: 0x6fd8ff, emissiveIntensity: 0.35 }), [0, 0.6, 0], { outline: 0.008 });
    mk(sword, new THREE.ConeGeometry(0.0375, 0.12, 4), M(0xe7f4ff, { emissive: 0x6fd8ff, emissiveIntensity: 0.35 }), [0, 1.14, 0], { rot: [0, Math.PI / 4, 0] });
    mk(sword, new THREE.BoxGeometry(0.26, 0.04, 0.06), goldM, [0, 0.1, 0], { outline: 0.008 });
    mk(sword, new THREE.CylinderGeometry(0.025, 0.025, 0.2, 8), M(0x5a3b5a), [0, -0.02, 0]);
    mk(sword, new THREE.SphereGeometry(0.04, 8, 6), goldM, [0, -0.13, 0]);
    backSlot = grp(torso, [0, 0.2, -0.17]);
    backSlot.rotation.z = 0.9;
    backSlot.add(sword);
    sword.position.set(0, -0.1, 0);
    C.sword = sword;
  }
  C.setSwordInHand = (inHand) => {
    if (!sword) return;
    if (inHand) { armR.hand.add(sword); sword.position.set(0, -0.02, 0); sword.rotation.set(Math.PI / 2, 0, 0); }
    else { backSlot.add(sword); sword.position.set(0, -0.1, 0); sword.rotation.set(0, 0, 0); }
    C.swordInHand = inHand;
  };

  // ---- glider
  if (o.glider) {
    const gl = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 1.0, -1.5, 0.0, -0.7, 0, 0.18, -0.35,
      0, 0, 1.0, 0, 0.18, -0.35, 1.5, 0.0, -0.7,
      -1.5, 0.0, -0.7, 0, 0, -0.75, 0, 0.18, -0.35,
      1.5, 0.0, -0.7, 0, 0.18, -0.35, 0, 0, -0.75,
    ], 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute([
      1, 1, 1, 0.3, 0.75, 0.9, 0.5, 0.85, 1, 1, 1, 1, 0.5, 0.85, 1, 0.3, 0.75, 0.9,
      0.3, 0.75, 0.9, 1, 0.5, 0.6, 0.5, 0.85, 1, 0.3, 0.75, 0.9, 0.5, 0.85, 1, 1, 0.5, 0.6,
    ], 3));
    geo.computeVertexNormals();
    const gm = toon(0xffffff, { vertexColors: true, side: THREE.DoubleSide });
    const cloth = new THREE.Mesh(geo, gm);
    cloth.castShadow = true;
    gl.add(cloth);
    addOutline(cloth, 0.02);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1.5, 0, -0.7), new THREE.Vector3(-0.1, -1.4, 0.0), new THREE.Vector3(1.5, 0, -0.7), new THREE.Vector3(0.1, -1.4, 0.0),
      new THREE.Vector3(0, 0.1, 1), new THREE.Vector3(0, -1.4, 0.0),
    ]);
    gl.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff })));
    gl.position.set(0, 2.3, 0);
    gl.visible = false;
    root.add(gl);
    C.glider = gl;
  }

  root.scale.setScalar(o.scale);
  root.traverse((m) => { if (m.isMesh && !m.userData.isOutline) m.receiveShadow = false; });

  // ---- animation ----------------------------------------------------------
  const cur = {
    hipsY: 0.77, pitch: 0, torsoX: 0, torsoY: 0, torsoZ: 0, headX: 0, headY: 0, headZ: 0,
    aLx: 0, aLz: 0.12, aRx: 0, aRz: -0.12, eL: 0.1, eR: 0.1,
    tLx: 0, tRx: 0, tLz: 0, tRz: 0, kL: 0, kR: 0,
  };
  const tgt = { ...cur };
  let phase = 0, blink = 2, blinkT = 0, t = 0;
  const hair = { x: 0, z: 0 };
  C.phase = () => phase;
  C.mouthOpen = 0;

  C.flash = 0;
  C.animate = (dt, s) => {
    t += dt;
    const sp = s.speed || 0;
    const T = tgt;
    // defaults = idle
    const br = Math.sin(t * 2.1) * 0.012;
    T.hipsY = 0.77 + br * 0.5; T.pitch = 0;
    T.torsoX = br * 2; T.torsoY = 0; T.torsoZ = 0;
    T.headX = -br * 3 + (s.talk ? Math.sin(t * 8) * 0.05 : 0); T.headY = 0; T.headZ = Math.sin(t * 0.9) * 0.03;
    T.aLx = Math.sin(t * 1.6) * 0.04; T.aLz = 0.1 + br; T.aRx = -Math.sin(t * 1.6) * 0.04; T.aRz = -0.1 - br;
    T.eL = 0.12; T.eR = 0.12;
    T.tLx = 0; T.tRx = 0; T.tLz = 0; T.tRz = 0; T.kL = 0; T.kR = 0;
    let rate = 22;

    if (s.swim) {
      phase += dt * (5 + sp * 3);
      T.pitch = 1.3; T.hipsY = 0.9;
      T.torsoX = -0.3; T.headX = -0.5;
      T.aLx = -1.7 + Math.sin(phase) * 1.1; T.aRx = -1.7 + Math.sin(phase + Math.PI) * 1.1; T.aLz = 0.25; T.aRz = -0.25;
      T.tLx = Math.sin(phase * 2) * 0.35; T.tRx = -Math.sin(phase * 2) * 0.35; T.kL = 0.2; T.kR = 0.2;
    } else if (s.glide) {
      T.aLx = -2.85; T.aRx = -2.85; T.aLz = 0.3; T.aRz = -0.3; T.eL = 0.1; T.eR = 0.1;
      T.tLx = 0.25 + Math.sin(t * 3) * 0.06; T.tRx = 0.0 + Math.sin(t * 3 + 1) * 0.06; T.kL = 0.5; T.kR = 0.9;
      T.torsoX = 0.08; T.headX = -0.1;
    } else if (s.air) {
      if (s.vy > 0.5) {
        T.tLx = -0.85; T.kL = 1.2; T.tRx = 0.35; T.kR = 0.6;
        T.aLx = -2.3; T.aLz = 0.55; T.aRx = -1.7; T.aRz = -0.55; T.torsoX = 0.1;
      } else {
        T.tLx = -0.25; T.tRx = 0.3; T.kL = 0.3; T.kR = 0.5;
        T.aLx = -0.5; T.aLz = 1.05; T.aRx = -0.5; T.aRz = -1.05; T.torsoX = 0.05; T.headX = -0.15;
      }
    } else if (sp > 0.05) {
      const run = clamp(sp, 0, 1.4);
      phase += dt * (6.5 + run * 7);
      const A = 0.55 + run * 0.5;
      T.hipsY = 0.77 - 0.035 * run + Math.abs(Math.cos(phase)) * 0.055 * run;
      T.tLx = -Math.sin(phase) * A; T.tRx = Math.sin(phase) * A;
      T.kL = Math.max(0, Math.cos(phase)) * A * 1.5 + 0.1; T.kR = Math.max(0, -Math.cos(phase)) * A * 1.5 + 0.1;
      const B = 0.5 + run * 0.6;
      T.aLx = Math.sin(phase) * B; T.aRx = -Math.sin(phase) * B;
      T.aLz = 0.12; T.aRz = -0.12; T.eL = 0.3 + run * 0.5; T.eR = 0.3 + run * 0.5;
      T.torsoX = 0.08 + run * 0.16; T.torsoY = Math.sin(phase) * 0.14 * run; T.headX = -T.torsoX * 0.6;
    }

    if (s.cast) {
      T.aLx = -2.7; T.aRx = -2.7; T.aLz = 0.5; T.aRz = -0.5; T.headX = -0.35; T.torsoX = -0.1;
      T.tLx = -0.1; T.tRx = 0.1;
    }
    if (s.hurt) {
      T.torsoX = -0.35; T.headX = 0.3; T.aLx = -0.8; T.aRx = -0.8; T.aLz = 0.9; T.aRz = -0.9; rate = 40;
    }
    if (s.atk) {
      const u = s.atk.t, idx = s.atk.idx;
      rate = 60;
      const wind = clamp(u / 0.3, 0, 1), swing = clamp((u - 0.3) / 0.28, 0, 1), sw = 1 - Math.pow(1 - swing, 3);
      if (idx === 2) {
        const a = fl(-3.1, -0.45, sw);
        T.aRx = a; T.aRz = -0.1; T.eR = fl(0.4, 0.05, sw);
        T.torsoX = fl(-0.35, 0.55, u < 0.3 ? 0 : sw); if (u < 0.3) T.torsoX = fl(0, -0.35, wind);
        T.aLx = 0.5; T.aLz = 0.5;
        T.tLx = -0.5; T.tRx = 0.4; T.kL = 0.5; T.kR = 0.3;
        T.headX = -T.torsoX * 0.5;
      } else {
        const dir = idx === 0 ? 1 : -1;
        const a0 = -0.95 * dir, a1 = 0.95 * dir;
        T.torsoY = u < 0.3 ? fl(0, a0, wind) : fl(a0, a1, sw);
        T.aRx = -1.45; T.aRz = -0.15; T.eR = 0.08;
        T.aLx = 0.4; T.aLz = 0.5; T.torsoX = 0.2;
        T.tLx = -0.6; T.tRx = 0.5; T.kL = 0.4; T.kR = 0.4;
        T.headY = -T.torsoY * 0.6;
      }
      C.mouthOpen = 1;
    } else C.mouthOpen = s.talk ? (Math.sin(t * 14) * 0.5 + 0.5) : 0;

    const k = 1 - Math.exp(-dt * rate);
    for (const key in cur) cur[key] = fl(cur[key], T[key], k);
    hips.position.y = cur.hipsY;
    hips.rotation.x = cur.pitch;
    torso.rotation.set(cur.torsoX, cur.torsoY, cur.torsoZ);
    head.rotation.set(cur.headX, cur.headY, cur.headZ);
    armL.sh.rotation.set(cur.aLx, 0, cur.aLz);
    armR.sh.rotation.set(cur.aRx, 0, cur.aRz);
    armL.elbow.rotation.x = -cur.eL;
    armR.elbow.rotation.x = -cur.eR;
    legL.thigh.rotation.x = cur.tLx; legR.thigh.rotation.x = cur.tRx;
    legL.thigh.rotation.z = -cur.tLz; legR.thigh.rotation.z = cur.tRz;
    legL.knee.rotation.x = cur.kL; legR.knee.rotation.x = cur.kR;
    skirt.rotation.x = clamp(-(cur.tLx + cur.tRx) * 0.1, -0.1, 0.1);
    skirt.scale.set(1 + Math.abs(cur.tLx - cur.tRx) * 0.1, 1, 1 + Math.abs(cur.tLx - cur.tRx) * 0.1);

    // blink
    blink -= dt;
    if (blink < 0) { blinkT = 0.12; blink = 2 + Math.random() * 3; }
    blinkT -= dt;
    const es = blinkT > 0 ? 0.1 : s.hurt ? 0.5 : 1;
    C.eyes[0].scale.y = C.eyes[1].scale.y = fl(C.eyes[0].scale.y, es, 0.6);
    mouth.scale.set(1 + C.mouthOpen * 0.3, 0.6 + C.mouthOpen * 2.6, 1);

    // hair + scarf physics
    const fwd = s.lf || 0, side = s.ls || 0, vy = s.vy || 0;
    const hk = 1 - Math.exp(-dt * 7);
    hair.x = fl(hair.x, clamp(fwd * 0.07 + (s.glide ? 0.5 : 0) - vy * 0.02 + (s.swim ? 0.6 : 0), -0.6, 1.0), hk);
    hair.z = fl(hair.z, clamp(-side * 0.08, -0.5, 0.5), hk);
    for (const tl of tails) {
      if (tl.long) {
        tl.pivot.rotation.x = clamp(hair.x * 0.9, -0.1, 0.9) + Math.sin(t * 2.2) * 0.02;
        tl.pivot.rotation.z = hair.z * 0.5;
        continue;
      }
      tl.pivot.rotation.z = tl.side * 0.4 + hair.z * 0.4;
      tl.segs.forEach((sg, i) => {
        sg.rotation.x = hair.x * 0.55 + Math.sin(t * 3.1 - i * 0.9 + tl.side) * 0.05 * (1 + sp);
        sg.rotation.z = Math.sin(t * 2.4 - i * 0.7) * 0.03 + hair.z * 0.3;
      });
    }
    const flow = 0.25 + Math.min(1, Math.abs(fwd) * 0.1) * 0.7 + (s.glide ? 0.5 : 0) + (s.air && !s.glide ? 0.3 : 0);
    scarfSegs.forEach((sg, i) => {
      sg.rotation.x = flow * 0.6 + Math.sin(t * 7 - i * 1.0) * 0.14 * (0.3 + Math.abs(fwd) * 0.1 + (s.air ? 0.6 : 0)) + 0.03;
      sg.rotation.z = Math.sin(t * 5 - i * 0.8) * 0.1 * (0.3 + sp);
    });
    aho.rotation.z = -0.4 + Math.sin(t * 3) * 0.1 + hair.z;

    // flash (damage)
    if (C.flash > 0) {
      C.flash = Math.max(0, C.flash - dt * 4);
      for (const m of mats) { m.emissive.setRGB(C.flash, C.flash * 0.15, C.flash * 0.15); }
    } else if (C._flashed) { for (const m of mats) m.emissive.setRGB(0, 0, 0); }
    C._flashed = C.flash > 0;
    if (C.glider) {
      const want = s.glide ? 1 : 0;
      C.glider.visible = want > 0 || C.glider.scale.x > 0.02;
      const gs = fl(C.glider.scale.x, want, 1 - Math.exp(-dt * 12));
      C.glider.scale.setScalar(Math.max(gs, 0.001));
      C.glider.rotation.x = -0.1 + Math.sin(t * 2) * 0.03;
    }
  };
  C.parts = { head, torso, hips, armL, armR, legL, legR };
  return C;
}
