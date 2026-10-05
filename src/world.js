import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Simplex2, makeRng, fbm, sstep, lerp, clamp } from './noise.js';
import { toon, mat, TIME, gradGeo, canvasTex, addOutline } from './materials.js';
import * as S from './structures.js';

export const HALF = 400, SEG = 320, SEA = 0;
const STEP = (HALF * 2) / SEG;
const NV = SEG + 1;

const nA = new Simplex2(11), nB = new Simplex2(23), nC = new Simplex2(37), nD = new Simplex2(53);
const gauss = (dx, dz, s) => Math.exp(-(dx * dx + dz * dz) / (2 * s * s));

export const POI = {
  village: { x: 0, z: 0 },
  shrine: { x: -140, z: -130 },
  lake: { x: 150, z: 70 },
  peaks: { x: 40, z: -250 },
  forest: { x: -210, z: 70 },
  meadow: { x: -60, z: 200 },
  ruins: { x: 190, z: -130 },
};
const FLAT = [
  { x: 0, z: 0, r: 50, b: 35, h: 4.5 },
  { x: -140, z: -130, r: 30, b: 25, h: 28 },
  { x: 190, z: -130, r: 24, b: 20, h: 10 },
];

export const REGIONS = [
  { name: '樱花之丘', en: 'Sakura Hill', ...POI.shrine, r: 85 },
  { name: '始源之村', en: 'Origin Village', ...POI.village, r: 62 },
  { name: '镜湖', en: 'Mirror Lake', ...POI.lake, r: 75 },
  { name: '雾岚山脉', en: 'Misty Peaks', ...POI.peaks, r: 120 },
  { name: '低语之森', en: 'Whisper Forest', ...POI.forest, r: 90 },
  { name: '繁花草甸', en: 'Flower Meadow', ...POI.meadow, r: 85 },
  { name: '古代遗迹', en: 'Ancient Ruins', ...POI.ruins, r: 55 },
];

const ROADS = [
  [[0, 0], [-30, -38], [-72, -66], [-110, -100], [-140, -130]],
  [[0, 0], [45, 12], [85, 32], [106, 50]],
  [[0, 0], [45, -30], [105, -78], [160, -112], [190, -130]],
  [[0, 0], [-14, 65], [-38, 135], [-60, 200]],
  [[0, 0], [-55, 22], [-120, 46], [-190, 68]],
];

function distSeg(px, pz, a, b) {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const t = clamp(((px - a[0]) * abx + (pz - a[1]) * abz) / (abx * abx + abz * abz), 0, 1);
  return Math.hypot(px - (a[0] + abx * t), pz - (a[1] + abz * t));
}
export function roadDist(x, z) {
  let best = 1e9;
  for (const r of ROADS) for (let i = 0; i < r.length - 1; i++) best = Math.min(best, distSeg(x, z, r[i], r[i + 1]));
  return best + nD.noise(x * 0.09, z * 0.09) * 1.1;
}

function rawHeight(x, z) {
  const d = Math.hypot(x, z);
  const ang = Math.atan2(z, x);
  const R = 315 + nC.noise(Math.cos(ang) * 1.3 + 9, Math.sin(ang) * 1.3) * 40;
  const m = sstep(R + 35, R - 55, d);
  let h = 7 + fbm(nA, x * 0.0045, z * 0.0045, 4) * 9 + fbm(nB, x * 0.016, z * 0.016, 3) * 2.2;
  const mt = gauss(x - POI.peaks.x, z - POI.peaks.z, 105);
  const ridge = Math.max(0, 1 - Math.abs(fbm(nC, x * 0.007 + 5, z * 0.007 - 3, 4) * 1.6));
  h += mt * (22 + ridge * ridge * 60);
  h += gauss(x - POI.shrine.x, z - POI.shrine.z, 62) * 20;
  const lk = gauss(x - POI.lake.x, z - POI.lake.z, 42);
  h = lerp(h, -5, sstep(0.25, 0.75, lk));
  for (const f of FLAT) {
    const w = 1 - sstep(f.r, f.r + f.b, Math.hypot(x - f.x, z - f.z));
    h = lerp(h, f.h, w);
  }
  // gentle carved road beds
  const rd = roadDist(x, z);
  if (rd < 5 && h > 1) h = lerp(h, h - 0.25, 1 - sstep(1.5, 5, rd));
  return lerp(-16, h, m);
}

// ---------------------------------------------------------------- colliders
export class Colliders {
  constructor(cell = 24) { this.cell = cell; this.map = new Map(); }
  add(x, z, r) {
    const c = { x, z, r }, k = this.cell;
    for (let i = Math.floor((x - r) / k); i <= Math.floor((x + r) / k); i++)
      for (let j = Math.floor((z - r) / k); j <= Math.floor((z + r) / k); j++) {
        const key = i * 4096 + j;
        if (!this.map.has(key)) this.map.set(key, []);
        this.map.get(key).push(c);
      }
  }
  resolve(pos, radius) {
    let hit = false;
    const k = this.cell, ci = Math.floor(pos.x / k), cj = Math.floor(pos.z / k);
    for (let i = ci - 1; i <= ci + 1; i++)
      for (let j = cj - 1; j <= cj + 1; j++) {
        const arr = this.map.get(i * 4096 + j);
        if (!arr) continue;
        for (const c of arr) {
          const dx = pos.x - c.x, dz = pos.z - c.z, rr = c.r + radius;
          const d2 = dx * dx + dz * dz;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 0.001;
            pos.x = c.x + (dx / d) * rr;
            pos.z = c.z + (dz / d) * rr;
            hit = true;
          }
        }
      }
    return hit;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- shaders
const WATER_VS = /* glsl */ `
attribute float depth;
varying float vDepth; varying vec3 vWP;
uniform float uTime;
#include <fog_pars_vertex>
void main(){
  vec3 p = position;
  vec4 wp = modelMatrix * vec4(p,1.);
  float wave = sin(wp.x*.15+uTime*.8)*.07 + sin(wp.z*.2+uTime*1.1)*.06;
  p.y += wave * smoothstep(0.,3.,depth);
  vDepth = depth; vWP = wp.xyz;
  vec4 mvPosition = modelViewMatrix * vec4(p,1.);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WATER_FS = /* glsl */ `
varying float vDepth; varying vec3 vWP;
uniform float uTime, uNight; uniform vec3 uKeyDir;
#include <fog_pars_fragment>
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }
void main(){
  float d = vDepth;
  vec2 uv = vWP.xz;
  vec3 shallow = vec3(.42,.93,.90), mid = vec3(.14,.62,.90), deep = vec3(.07,.28,.70);
  vec3 col = mix(shallow, mid, smoothstep(0.,2.5,d));
  col = mix(col, deep, smoothstep(2.5,14.,d));
  float r1 = vn(uv*.33 + vec2(uTime*.08,uTime*.05));
  float r2 = vn(uv*.61 - vec2(uTime*.06,-uTime*.09));
  float rip = smoothstep(.64,.68,r1*.5+r2*.5);
  col += vec3(.22,.26,.28)*rip;
  float wob = sin(uTime*1.3+uv.x*.21+uv.y*.17)*.14;
  float nz = (vn(uv*1.3+vec2(uTime*.12,0.))-.5)*.5;
  float foam = 1. - step(.42+wob, max(d,0.) + nz);
  float ring = step(abs(d-1.35-wob*2.-nz), .11) * step(.5, vn(uv*1.8 + uTime*.15));
  foam = max(foam, ring*.85);
  vec3 V = normalize(cameraPosition - vWP);
  vec3 N = normalize(vec3(sin(uv.x*.6+uTime*1.3)*.07, 1., cos(uv.y*.7+uTime*1.1)*.07));
  float spec = pow(max(dot(N, normalize(uKeyDir+V)),0.), 150.);
  col += vec3(1.,.97,.9) * step(.5,spec) * .7;
  col = mix(col, vec3(1.), foam);
  col *= mix(1., .35, uNight);
  float a = mix(.62, .96, smoothstep(0.,2.5,d));
  a = max(a, foam);
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}`;

// ---------------------------------------------------------------- world
export async function createWorld(scene, onProgress = () => {}) {
  const W = {};
  const rng = makeRng(2024);
  const colliders = (W.colliders = new Colliders());
  const H = new Float32Array(NV * NV);
  const GR = new Float32Array(NV * NV); // grassiness
  const COL = new Float32Array(NV * NV * 3);

  // -- heights
  for (let j = 0; j < NV; j++)
    for (let i = 0; i < NV; i++) H[j * NV + i] = rawHeight(-HALF + i * STEP, -HALF + j * STEP);
  onProgress(0.1, '塑造大地…');
  await tick();

  W.heightAt = (x, z) => {
    let fx = (x + HALF) / STEP, fz = (z + HALF) / STEP;
    fx = clamp(fx, 0, SEG - 0.0001); fz = clamp(fz, 0, SEG - 0.0001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz, i = iz * NV + ix;
    const a = H[i], d = H[i + 1], b = H[i + NV], c = H[i + NV + 1];
    return tx + tz <= 1 ? a + tx * (d - a) + tz * (b - a) : c + (1 - tx) * (b - c) + (1 - tz) * (d - c);
  };
  const heightAt = W.heightAt;
  W.normalAt = (x, z, out = new THREE.Vector3()) => {
    const e = 1.2;
    return out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
  };

  // -- terrain mesh
  const geo = new THREE.PlaneGeometry(HALF * 2, HALF * 2, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, H[i]);
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal;

  const C = (h) => new THREE.Color(h);
  const cGA = C(0x95e35e), cGB = C(0x5cc45c), cGC = C(0xbdea70), cPink = C(0xf7bcd8), cMeadow = C(0xc9ec72);
  const cForest = C(0x3fae58), cHigh = C(0x5d9a62), cSand = C(0xf5e3b2), cWet = C(0xd8c493);
  const cRock = C(0x9a93b6), cRock2 = C(0x857ca4), cSnow = C(0xf6faff), cDirt = C(0xe6c48c), cPlaza = C(0xdcd3e6), cRuin = C(0xb9b0cc);
  const tmp = new THREE.Color();
  const colAttr = new Float32Array(pos.count * 3);
  for (let j = 0; j < NV; j++)
    for (let i = 0; i < NV; i++) {
      const idx = j * NV + i, x = -HALF + i * STEP, z = -HALF + j * STEP, h = H[idx], ny = nrm.getY(idx);
      const n1 = nB.noise(x * 0.035, z * 0.035) * 0.5 + 0.5, n2 = nA.noise(x * 0.12 + 7, z * 0.12) * 0.5 + 0.5;
      tmp.copy(cGB).lerp(cGA, n1);
      if (n2 > 0.6) tmp.lerp(cGC, 0.5);
      tmp.lerp(cPink, gauss(x - POI.shrine.x, z - POI.shrine.z, 68) * (0.3 + 0.7 * n2) * 0.6);
      tmp.lerp(cMeadow, gauss(x - POI.meadow.x, z - POI.meadow.z, 70) * 0.65);
      tmp.lerp(cForest, gauss(x - POI.forest.x, z - POI.forest.z, 80) * 0.5);
      tmp.lerp(cHigh, sstep(16, 42, h) * 0.6);
      const beach = 1 - sstep(0.4, 2.3, h + (n2 - 0.5) * 0.9);
      tmp.lerp(cSand, beach);
      if (h < 0) tmp.lerp(cWet, sstep(0, -1.5, h) * 0.5);
      const slope = 1 - ny;
      const rk = sstep(0.17, 0.3, slope + (n1 - 0.5) * 0.08);
      tmp.lerp(n2 > 0.5 ? cRock : cRock2, rk);
      const sn = sstep(50, 58, h + (n2 - 0.5) * 6) * (1 - sstep(0.3, 0.5, slope));
      tmp.lerp(cSnow, sn);
      const rm = 1 - sstep(2.0, 3.3, roadDist(x, z));
      tmp.lerp(cDirt, rm * 0.92 * (1 - sn));
      const dv = Math.hypot(x - POI.village.x, z - POI.village.z);
      const pl = 1 - sstep(9, 11.5, dv);
      tmp.lerp(cPlaza, pl);
      const dr = Math.hypot(x - POI.ruins.x, z - POI.ruins.z);
      tmp.lerp(cRuin, (1 - sstep(16, 20, dr)) * 0.85);
      colAttr[idx * 3] = tmp.r; colAttr[idx * 3 + 1] = tmp.g; colAttr[idx * 3 + 2] = tmp.b;
      GR[idx] = clamp(1 - Math.max(beach, rk * 1.5, sn, rm * 1.3, pl, (1 - sstep(16, 20, dr))), 0, 1) * (h > 0.8 ? 1 : 0);
    }
  COL.set(colAttr);
  geo.setAttribute('color', new THREE.BufferAttribute(colAttr, 3));
  const terrainMat = toon(0xffffff, { vertexColors: true });
  terrainMat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWP = (modelMatrix * vec4(transformed,1.)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWP;
float th21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float tvn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(th21(i),th21(i+vec2(1,0)),f.x),mix(th21(i+vec2(0,1)),th21(i+vec2(1,1)),f.x),f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float tn = tvn(vWP.xz*.55)*.6 + tvn(vWP.xz*1.9)*.4;
diffuseColor.rgb *= .9 + .2*floor(tn*3.)/3.;`);
  };
  const terrain = new THREE.Mesh(geo, terrainMat);
  terrain.receiveShadow = true;
  scene.add(terrain);
  W.terrain = terrain;
  onProgress(0.25, '铺上草地与道路…');
  await tick();

  // -- water
  W.waterU = {
    uTime: TIME, uNight: { value: 0 }, uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
  };
  const waterMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, W.waterU]),
    vertexShader: WATER_VS, fragmentShader: WATER_FS, transparent: true, depthWrite: false, fog: true,
  });
  waterMat.uniforms.uTime = TIME;
  waterMat.uniforms.uNight = W.waterU.uNight;
  waterMat.uniforms.uKeyDir = W.waterU.uKeyDir;
  const wg = new THREE.PlaneGeometry(HALF * 2, HALF * 2, SEG, SEG);
  wg.rotateX(-Math.PI / 2);
  const dep = new Float32Array(wg.attributes.position.count);
  for (let i = 0; i < dep.length; i++) dep[i] = SEA - H[i];
  wg.setAttribute('depth', new THREE.BufferAttribute(dep, 1));
  const water = new THREE.Mesh(wg, waterMat);
  water.renderOrder = 1;
  scene.add(water);
  const og = new THREE.PlaneGeometry(6000, 6000, 1, 1);
  og.rotateX(-Math.PI / 2);
  og.setAttribute('depth', new THREE.BufferAttribute(new Float32Array(4).fill(30), 1));
  const ocean = new THREE.Mesh(og, waterMat);
  ocean.position.y = -0.12;
  ocean.renderOrder = 0;
  scene.add(ocean);

  // -- utilities
  const colorAt = (x, z, out) => {
    const i = clamp(Math.round((x + HALF) / STEP), 0, SEG), j = clamp(Math.round((z + HALF) / STEP), 0, SEG);
    const k = (j * NV + i) * 3;
    return out.setRGB(COL[k], COL[k + 1], COL[k + 2]);
  };
  const grassAt = (x, z) => {
    const i = clamp(Math.round((x + HALF) / STEP), 0, SEG), j = clamp(Math.round((z + HALF) / STEP), 0, SEG);
    return GR[j * NV + i];
  };
  W.grassAt = grassAt;
  const dummy = new THREE.Object3D();
  const chunkCell = 50;
  W.chunks = []; // {mesh, cx, cz, range}
  function chunked(geo, material, items, { cell = chunkCell, shadow = false, range = 9999, receive = true } = {}) {
    const groups = new Map();
    for (const it of items) {
      const key = Math.floor((it.x + HALF) / cell) * 1000 + Math.floor((it.z + HALF) / cell);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    for (const arr of groups.values()) {
      const m = new THREE.InstancedMesh(geo, material, arr.length);
      let cx = 0, cz = 0;
      arr.forEach((it, i) => {
        dummy.position.set(it.x, it.y, it.z);
        dummy.rotation.set(it.rx || 0, it.ry || 0, it.rz || 0);
        dummy.scale.set(it.sx ?? it.s ?? 1, it.sy ?? it.s ?? 1, it.sz ?? it.s ?? 1);
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
        if (it.color) m.setColorAt(i, it.color);
        cx += it.x; cz += it.z;
      });
      m.castShadow = shadow;
      m.receiveShadow = receive;
      m.computeBoundingSphere();
      scene.add(m);
      W.chunks.push({ mesh: m, cx: cx / arr.length, cz: cz / arr.length, range });
    }
  }

  // -- trees
  const prep = (g) => {
    if (g.index) g = g.toNonIndexed();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    return g;
  };
  const blob = (r, x, y, z, sy, dark, light) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.scale(1, sy, 1);
    g.translate(x, y, z);
    gradGeo(g, dark, light, y - r * sy, y + r * sy);
    return prep(g);
  };
  const trunk = (rt, rb, h, col = 0x8a5f45) => {
    const g = new THREE.CylinderGeometry(rt, rb, h, 7);
    g.translate(0, h / 2, 0);
    gradGeo(g, new THREE.Color(col).multiplyScalar(0.7).getHex(), col, 0, h);
    return prep(g);
  };
  const treeGeos = {
    round: mergeGeometries([trunk(0.25, 0.4, 2.6), blob(1.9, 0, 3.7, 0, 0.9, 0x2f9a4f, 0x8ee05a), blob(1.3, 1.2, 3.0, 0.5, 0.9, 0x2f9a4f, 0x7bd455), blob(1.4, -1.1, 3.2, -0.4, 0.9, 0x2f9a4f, 0x7bd455), blob(1.2, 0.1, 4.9, 0, 0.9, 0x3fae58, 0xa6ec68)]),
    pine: mergeGeometries([trunk(0.22, 0.38, 2.0, 0x7a5544), ...[0, 1, 2, 3].map((i) => {
      const g = new THREE.ConeGeometry(2.1 - i * 0.42, 2.6, 8);
      g.translate(0, 2.4 + i * 1.5 + 1.3, 0);
      gradGeo(g, 0x1f7a5a, 0x5ac88a, 2.4 + i * 1.5, 2.4 + i * 1.5 + 2.6);
      return prep(g);
    })]),
    sakura: mergeGeometries([trunk(0.3, 0.5, 2.8, 0x8a5f6e), blob(2.1, 0, 4.2, 0, 0.85, 0xf08fb8, 0xffd3e4), blob(1.5, 1.4, 3.5, 0.6, 0.85, 0xf08fb8, 0xffc4dc), blob(1.6, -1.3, 3.6, -0.5, 0.85, 0xf08fb8, 0xffc4dc), blob(1.3, 0.2, 5.4, 0.1, 0.85, 0xf79cc2, 0xffdbe9)]),
    maple: mergeGeometries([trunk(0.25, 0.4, 2.6, 0x7a5544), blob(1.9, 0, 3.7, 0, 0.9, 0xd8462f, 0xffb23f), blob(1.3, 1.2, 3.0, 0.5, 0.9, 0xd8462f, 0xff9f3a), blob(1.4, -1.1, 3.2, -0.4, 0.9, 0xd8462f, 0xff9f3a), blob(1.2, 0.1, 4.9, 0, 0.9, 0xe8632f, 0xffcf5a)]),
  };
  const treeMat = toon(0xffffff, { vertexColors: true });
  const treeItems = { round: [], pine: [], sakura: [], maple: [] };
  {
    const cellSize = 3.2, occ = new Set();
    let tries = 0, placed = 0;
    const MAXT = 1700;
    while (tries < 60000 && placed < MAXT) {
      tries++;
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 330;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = heightAt(x, z);
      if (h < 1.6 || h > 46) continue;
      const ny = W.normalAt(x, z).y;
      if (ny < 0.8) continue;
      if (Math.hypot(x, z) < 58) continue;
      if (roadDist(x, z) < 5) continue;
      if (Math.hypot(x - POI.shrine.x, z - POI.shrine.z) < 34) continue;
      if (Math.hypot(x - POI.ruins.x, z - POI.ruins.z) < 30) continue;
      if (Math.hypot(x - POI.lake.x, z - POI.lake.z) < 52) continue;
      const forest = gauss(x - POI.forest.x, z - POI.forest.z, 85);
      const sak = gauss(x - POI.shrine.x, z - POI.shrine.z, 85);
      const meadow = gauss(x - POI.meadow.x, z - POI.meadow.z, 70);
      let dens = (sstep(-0.15, 0.5, nA.noise(x * 0.012 + 40, z * 0.012)) * 0.5 + forest * 0.95 + sak * 0.4) * (1 - meadow * 0.85);
      if (h > 30) dens *= 0.5;
      if (rng() > dens) continue;
      const key = Math.floor(x / cellSize) * 5000 + Math.floor(z / cellSize);
      if (occ.has(key)) continue;
      occ.add(key);
      let type = 'round';
      if (h > 24 || nB.noise(x * 0.02 + 90, z * 0.02) > 0.5) type = 'pine';
      if (sak > 0.3 && rng() < 0.75) type = 'sakura';
      else if (forest > 0.3 && nA.noise(x * 0.02 + 200, z * 0.02) > 0.35) type = 'maple';
      const s = (type === 'sakura' ? 1.2 : 1) * (0.85 + rng() * 0.75);
      const v = 0.92 + rng() * 0.16;
      treeItems[type].push({ x, y: h - 0.15, z, ry: rng() * 6.28, s, sy: s * (0.9 + rng() * 0.3), color: new THREE.Color(v, v, v + (rng() - 0.5) * 0.06) });
      colliders.add(x, z, 0.55 * s);
      placed++;
    }
    for (const k in treeItems) chunked(treeGeos[k], treeMat, treeItems[k], { shadow: true, cell: 80 });
    W.treeCount = placed;
  }
  onProgress(0.4, '种下森林…');
  await tick();

  // -- grass tufts
  {
    const verts = [], cols = [], nrms = [];
    const r2 = makeRng(5);
    for (let b = 0; b < 6; b++) {
      const a = (b / 6) * Math.PI * 2 + r2() * 0.6;
      const ox = Math.cos(a) * 0.12, oz = Math.sin(a) * 0.12;
      const hgt = 0.55 + r2() * 0.55, lean = 0.2 + r2() * 0.3;
      const tx = Math.cos(a) * (0.12 + lean), tz = Math.sin(a) * (0.12 + lean);
      const px = -Math.sin(a) * 0.055, pz = Math.cos(a) * 0.055;
      verts.push(ox - px, 0, oz - pz, ox + px, 0, oz + pz, tx, hgt, tz);
      cols.push(0.55, 0.62, 0.55, 0.55, 0.62, 0.55, 1.15, 1.2, 0.95);
      nrms.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    gg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    gg.setAttribute('normal', new THREE.Float32BufferAttribute(nrms, 3));
    const grassMat = toon(0xffffff, { vertexColors: true, side: THREE.DoubleSide });
    grassMat.onBeforeCompile = (s) => {
      s.uniforms.uTime = TIME;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vec4 gw = instanceMatrix * vec4(0.,0.,0.,1.);
float sway = sin(uTime*1.7 + gw.x*.33 + gw.z*.29)*.5 + sin(uTime*2.9 + gw.x*.8)*.2;
transformed.x += sway * position.y * .35;
transformed.z += sway * position.y * .18;
float gdist = distance(gw.xyz, cameraPosition);
transformed *= 1.0 - smoothstep(55., 85., gdist);`);
    };
    const items = [];
    const gc = new THREE.Color();
    for (let cx = 0; cx < 16; cx++)
      for (let cz = 0; cz < 16; cz++) {
        const x0 = -HALF + cx * chunkCell, z0 = -HALF + cz * chunkCell;
        const midG = grassAt(x0 + 25, z0 + 25);
        if (Math.hypot(x0 + 25, z0 + 25) > 400) continue;
        for (let k = 0; k < 1100; k++) {
          const x = x0 + rng() * chunkCell, z = z0 + rng() * chunkCell;
          const g = grassAt(x, z);
          if (rng() > g * 0.95 || g < 0.35) continue;
          if (W.normalAt(x, z).y < 0.75) continue;
          colorAt(x, z, gc);
          const l = 0.95 + rng() * 0.3;
          items.push({ x, y: heightAt(x, z) - 0.03, z, ry: rng() * 6.28, s: 0.8 + rng() * 0.7, color: new THREE.Color(gc.r * l, gc.g * l * 1.05, gc.b * l) });
        }
      }
    chunked(gg, grassMat, items, { range: 95, receive: true });
    W.grassCount = items.length;
  }
  onProgress(0.6, '让草地随风摇曳…');
  await tick();

  // -- flowers
  {
    const stem = new THREE.CylinderGeometry(0.015, 0.02, 0.5, 4);
    stem.translate(0, 0.25, 0);
    const sc = new Float32Array(stem.attributes.position.count * 3);
    for (let i = 0; i < sc.length; i += 3) { sc[i] = 0.25; sc[i + 1] = 0.75; sc[i + 2] = 0.25; }
    stem.setAttribute('color', new THREE.BufferAttribute(sc, 3));
    const head = new THREE.IcosahedronGeometry(0.17, 0);
    head.scale(1, 0.55, 1);
    head.translate(0, 0.52, 0);
    const hc = new Float32Array(head.attributes.position.count * 3).fill(1);
    head.setAttribute('color', new THREE.BufferAttribute(hc, 3));
    const center = new THREE.IcosahedronGeometry(0.07, 0);
    center.translate(0, 0.58, 0);
    const cc = new Float32Array(center.attributes.position.count * 3);
    for (let i = 0; i < cc.length; i += 3) { cc[i] = 1; cc[i + 1] = 0.85; cc[i + 2] = 0.2; }
    center.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    const fg = mergeGeometries([prep(stem), prep(head), prep(center)]);
    const pal = [0xff7fae, 0xffe066, 0xffffff, 0xb08cff, 0x7fd0ff, 0xff9d5c].map((c) => new THREE.Color(c));
    const items = [];
    for (let n = 0; n < 9000; n++) {
      const x = (rng() - 0.5) * 760, z = (rng() - 0.5) * 760;
      const g = grassAt(x, z);
      if (g < 0.6) continue;
      const mead = gauss(x - POI.meadow.x, z - POI.meadow.z, 75), sak = gauss(x - POI.shrine.x, z - POI.shrine.z, 80);
      if (rng() > 0.05 + mead * 1.2 + sak * 0.3 + (Math.hypot(x, z) < 70 ? 0.25 : 0)) continue;
      if (W.normalAt(x, z).y < 0.85) continue;
      const c = pal[Math.floor(rng() * pal.length)];
      items.push({ x, y: heightAt(x, z), z, ry: rng() * 6, s: 0.8 + rng() * 0.8, color: c });
    }
    chunked(fg, toon(0xffffff, { vertexColors: true }), items, { range: 120, receive: false });
  }

  // -- rocks
  {
    const rg = new THREE.DodecahedronGeometry(1, 0);
    const p = rg.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.85 + ((i * 7) % 5) * 0.06), p.getY(i) * 0.75, p.getZ(i) * (0.9 + ((i * 3) % 4) * 0.07));
    rg.computeVertexNormals();
    const rockMat = toon(0xffffff, { flatShading: true });
    const items = [];
    for (let n = 0; n < 2600 && items.length < 420; n++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 340;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = heightAt(x, z);
      if (h < -1.5 || Math.hypot(x, z) < 56 || roadDist(x, z) < 4.5) continue;
      if (Math.hypot(x - POI.shrine.x, z - POI.shrine.z) < 32 || Math.hypot(x - POI.ruins.x, z - POI.ruins.z) < 28) continue;
      const steep = 1 - W.normalAt(x, z).y;
      if (rng() > 0.12 + steep * 3 + (h > 30 ? 0.4 : 0)) continue;
      const s = 0.5 + Math.pow(rng(), 2.2) * 3.6;
      const t = rng();
      const col = new THREE.Color(t < 0.5 ? 0x9f98bd : 0x8a81aa).multiplyScalar(0.9 + rng() * 0.25);
      items.push({ x, y: h + s * 0.2, z, ry: rng() * 6, rx: (rng() - 0.5) * 0.3, sx: s * 1.2, sy: s, sz: s, color: col });
      if (s > 1.4) colliders.add(x, z, s * 1.0);
    }
    chunked(rg, rockMat, items, { shadow: true, cell: 80 });
  }
  onProgress(0.72, '搭建村庄与神社…');
  await tick();

  // -- structures
  const put = (obj, x, z, ry = 0, y = null) => {
    obj.position.set(x, y ?? heightAt(x, z), z);
    obj.rotation.y = ry;
    scene.add(S.finalize(obj));
    return obj;
  };
  W.windmill = null;
  const houses = [
    { x: 0, z: -27, ry: 0, w: 8.5, d: 6.5, wall: 0xfff3e2, roof: 0x4f78c8, h: 3.6, tag: 'elder' },
    { x: -25, z: -11, ry: Math.PI / 2, w: 6, d: 5, wall: 0xfff0da, roof: 0xd0584a },
    { x: 25, z: -13, ry: -Math.PI / 2, w: 6.5, d: 5, wall: 0xf6ecff, roof: 0x8a68c8 },
    { x: -29, z: 13, ry: Math.PI / 2 + 0.25, w: 6, d: 5.5, wall: 0xfff0da, roof: 0xe08a4f },
    { x: 28, z: 14, ry: -Math.PI / 2 - 0.25, w: 6, d: 5, wall: 0xeaf7ee, roof: 0x3fa08a },
    { x: -13, z: 31, ry: Math.PI + 0.1, w: 5.5, d: 5, wall: 0xfff0da, roof: 0xd0584a },
    { x: 14, z: 32, ry: Math.PI - 0.15, w: 6, d: 5, wall: 0xfdeef2, roof: 0xe06a90 },
    { x: -39, z: -28, ry: Math.PI / 3, w: 5.5, d: 5, wall: 0xfff0da, roof: 0x4f78c8 },
  ];
  W.houses = houses;
  for (const hs of houses) {
    const g = S.makeHouse(hs);
    put(g, hs.x, hs.z, hs.ry);
    const list = [];
    S.boxColliders(list, hs.x, hs.z, hs.w + 0.6, hs.d + 0.6, hs.ry);
    for (const c of list) colliders.add(c.x, c.z, c.r);
  }
  {
    const wm = S.makeWindmill();
    put(wm, 36, -36, -0.5);
    colliders.add(36, -36, 3.3);
    W.windmill = wm;
    const well = S.makeWell();
    put(well, 0, 0);
    colliders.add(0, 0, 1.9);
    const st1 = S.makeStall(0xff8fb8); put(st1, -10, 9, -0.3); colliders.add(-10, 9, 1.9);
    const st2 = S.makeStall(0x6fc4ff); put(st2, 10, 10, 0.3); colliders.add(10, 10, 1.9);
    const sign = S.makeSign('始源之村'); put(sign, 6, 44, 0.3);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      put(S.makeLampPost(), Math.cos(a) * 15, Math.sin(a) * 15, 0);
    }
    put(S.makeBench(), -6, -8, Math.PI); put(S.makeBench(), 6, -8, Math.PI);
    // fences
    for (let i = 0; i < 4; i++) { put(S.makeFence(4), -38 + i * 4, 23, 0); }
    for (let i = 0; i < 3; i++) put(S.makeFence(4), 36, 24 + i * 4, Math.PI / 2);
  }
  // torii and lanterns along the shrine road
  {
    const road = ROADS[0];
    const torii = [[road[1], road[2]], [road[2], road[3]], [road[3], road[4]]];
    torii.forEach(([a, b], i) => {
      const t = i === 2 ? 0.55 : 0.5;
      const x = lerp(a[0], b[0], t), z = lerp(a[1], b[1], t);
      put(S.makeTorii(i === 2 ? 1.25 : 1), x, z, Math.atan2(b[0] - a[0], b[1] - a[1]));
    });
    for (let s = 70; s < 185; s += 11) {
      // walk polyline
      let acc = 0, px = 0, pz = 0, dx = 0, dz = 0;
      for (let i = 0; i < road.length - 1; i++) {
        const L = Math.hypot(road[i + 1][0] - road[i][0], road[i + 1][1] - road[i][1]);
        if (acc + L >= s) { const t = (s - acc) / L; px = lerp(road[i][0], road[i + 1][0], t); pz = lerp(road[i][1], road[i + 1][1], t); dx = (road[i + 1][0] - road[i][0]) / L; dz = (road[i + 1][1] - road[i][1]) / L; break; }
        acc += L;
      }
      for (const sd of [-1, 1]) {
        const lx = px - dz * 4.2 * sd, lz = pz + dx * 4.2 * sd;
        put(S.makeStoneLantern(), lx, lz, Math.random() * 6);
        colliders.add(lx, lz, 0.6);
      }
    }
  }
  // shrine plateau
  {
    const sh = S.makeShrine();
    put(sh, -122, -114, Math.PI / 4 + 0.1);
    const list = [];
    S.boxColliders(list, -122, -114, 13, 11, Math.PI / 4 + 0.1);
    for (const c of list) colliders.add(c.x, c.z, c.r);
    const tree = S.makeGreatTree();
    put(tree, -160, -152, 0);
    colliders.add(-160, -152, 4.6);
    W.greatTree = tree;
    W.altar = { x: -142, z: -133 };
    const mc = S.makeMagicCircle('#ff9ad0', 13);
    mc.position.set(W.altar.x, heightAt(W.altar.x, W.altar.z) + 0.1, W.altar.z);
    scene.add(mc);
    W.altarCircle = mc;
    put(S.makeTorii(1.0), -152, -110, 0.4);
  }
  // ruins
  {
    const rx = POI.ruins.x, rz = POI.ruins.z, ry = heightAt(rx, rz);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const p = S.makePillar(3.5 + rng() * 2.5, i % 3 === 0);
      put(p, rx + Math.cos(a) * 15, rz + Math.sin(a) * 15, rng() * 6);
      colliders.add(rx + Math.cos(a) * 15, rz + Math.sin(a) * 15, 1.1);
    }
    const mc = S.makeMagicCircle('#b58cff', 26);
    mc.position.set(rx, ry + 0.12, rz);
    scene.add(mc);
    W.ruinCircle = mc;
    const cc = S.makeCrystalCluster(0xb58cff, 1.6);
    put(cc, rx, rz);
    colliders.add(rx, rz, 1.6);
    W.ruinCrystal = cc;
  }
  // lake pier
  {
    const lx = POI.lake.x, lz = POI.lake.z;
    const vx = POI.village.x - lx, vz = POI.village.z - lz, vl = Math.hypot(vx, vz);
    let sx = 0, sz = 0;
    for (let t = 0; t < vl; t += 0.5) {
      sx = lx + (vx / vl) * t; sz = lz + (vz / vl) * t;
      if (heightAt(sx, sz) > 0.9) break;
    }
    const ang = Math.atan2(-(vz / vl), -(vx / vl)); // direction into lake
    const pier = S.makePier(16);
    pier.position.set(sx, 0.55, sz);
    pier.rotation.y = -Math.atan2(-(vz / vl), -(vx / vl));
    scene.add(S.finalize(pier));
    W.pier = { x: sx, z: sz, dirx: -(vx / vl), dirz: -(vz / vl) };
    const boat = S.makeBoat();
    boat.position.set(sx - (vz / vl) * 5 + (-(vx / vl)) * 14, 0.0, sz + (vx / vl) * 5 + (-(vz / vl)) * 14);
    boat.rotation.y = 0.6;
    scene.add(S.finalize(boat));
    W.boat = boat;
    // register pier as a walkable platform strip (sampled as circles)
    W.platforms = W.platforms || [];
    for (let t = 0.5; t < 16; t += 1.4)
      W.platforms.push({ x: sx + W.pier.dirx * t, z: sz + W.pier.dirz * t, r: 1.9, y: 0.62 });
    const sign = S.makeSign('镜湖'); put(sign, sx + 3, sz - 4, 0.4);
  }
  // floating islands near the highest peak
  {
    let best = -1e9, bx = 0, bz = 0;
    for (let z = POI.peaks.z - 100; z < POI.peaks.z + 100; z += 4)
      for (let x = POI.peaks.x - 100; x < POI.peaks.x + 100; x += 4) {
        const h = heightAt(x, z);
        if (h > best) { best = h; bx = x; bz = z; }
      }
    W.peak = { x: bx, z: bz, y: best };
    W.platforms = W.platforms || [];
    W.islands = [];
    const dirx = Math.sign(POI.peaks.x - bx || 1) * 0.6, dirz = 0.8;
    const spots = [
      { x: bx + 40, z: bz + 34, y: best - 4, r: 9, seed: 1 },
      { x: bx + 84, z: bz + 62, y: best - 14, r: 8, seed: 2 },
      { x: bx + 128, z: bz + 96, y: best - 26, r: 10, seed: 3 },
    ];
    for (const sp of spots) {
      const isl = S.makeFloatingIsland(sp.r, sp.seed);
      isl.position.set(sp.x, sp.y, sp.z);
      scene.add(S.finalize(isl));
      W.islands.push({ ...sp, group: isl, baseY: sp.y });
      W.platforms.push({ x: sp.x, z: sp.z, r: sp.r - 0.2, y: sp.y });
    }
  }
  onProgress(0.85, '点亮星屑…');
  await tick();

  // ground query including floating platforms / pier
  W.groundAt = (x, z, yFeet) => {
    let g = heightAt(x, z);
    if (W.platforms) for (const p of W.platforms) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < p.r * p.r && yFeet >= p.y - 0.7 && p.y > g) g = p.y;
    }
    return g;
  };

  // -- collectible shards
  {
    const quotas = [
      [POI.village, 55, 110, 9], [POI.shrine, 0, 60, 8], [POI.lake, 0, 70, 8], [POI.forest, 0, 70, 9],
      [POI.meadow, 0, 60, 8], [POI.ruins, 0, 40, 5], [POI.peaks, 0, 90, 6],
    ];
    const list = [];
    for (const [c, rmin, rmax, n] of quotas) {
      let k = 0, tries = 0;
      while (k < n && tries++ < 3000) {
        const a = rng() * 6.283, r = rmin + rng() * (rmax - rmin);
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        const h = heightAt(x, z);
        if (h < 0.9 || Math.hypot(x, z) > 300 || W.normalAt(x, z).y < 0.7) continue;
        if (Math.hypot(x - POI.shrine.x, z - POI.shrine.z) < 6) continue;
        list.push({ x, z, y: h + 1.4, taken: false });
        k++;
      }
    }
    // pier end and floating islands and summit
    const pe = W.pier;
    list.push({ x: pe.x + pe.dirx * 15, z: pe.z + pe.dirz * 15, y: 0.62 + 1.4, taken: false });
    for (const isl of W.islands) {
      for (let k = 0; k < 2; k++) {
        const a = k * 2.5 + isl.seed;
        list.push({ x: isl.x + Math.cos(a) * 4.5, z: isl.z + Math.sin(a) * 4.5, y: isl.y + 1.5, taken: false });
      }
    }
    list.push({ x: W.peak.x, z: W.peak.z, y: W.peak.y + 1.6, taken: false });
    W.shards = list;
    const sg = new THREE.OctahedronGeometry(0.42, 0);
    sg.scale(1, 1.6, 1);
    const sm = new THREE.MeshToonMaterial({ color: 0xffe27a, gradientMap: mat(0).gradientMap, emissive: 0xffb830, emissiveIntensity: 0.9 });
    W.shardMesh = new THREE.InstancedMesh(sg, sm, list.length);
    W.shardMesh.frustumCulled = false;
    scene.add(W.shardMesh);
    const beamTex = canvasTex(4, 128, (c, w, h) => {
      const g = c.createLinearGradient(0, h, 0, 0);
      g.addColorStop(0, '#fff6c0'); g.addColorStop(0.5, '#6a5a20'); g.addColorStop(1, '#000');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    });
    const bg = new THREE.CylinderGeometry(0.16, 0.5, 46, 8, 1, true);
    bg.translate(0, 23, 0);
    W.beamMesh = new THREE.InstancedMesh(bg, new THREE.MeshBasicMaterial({ map: beamTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }), list.length);
    W.beamMesh.frustumCulled = false;
    W.beamMesh.renderOrder = 3;
    scene.add(W.beamMesh);
  }

  // -- spawn hints for gameplay
  {
    const sl = [];
    const quotas = [[POI.forest, 90, 13], [POI.meadow, 80, 8], [POI.lake, 110, 6], [POI.ruins, 50, 7], [POI.peaks, 100, 4], [POI.shrine, 80, 5]];
    for (const [c, R, n] of quotas) {
      let k = 0, tries = 0;
      while (k < n && tries++ < 2000) {
        const a = rng() * 6.283, r = Math.sqrt(rng()) * R;
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        const h = heightAt(x, z);
        if (h < 1.2 || Math.hypot(x, z) < 75 || W.normalAt(x, z).y < 0.8) continue;
        if (Math.hypot(x - POI.shrine.x, z - POI.shrine.z) < 22 || Math.hypot(x - POI.lake.x, z - POI.lake.z) < 45 && h < 1.5) continue;
        if (Math.hypot(x - POI.ruins.x, z - POI.ruins.z) < 9) continue;
        sl.push({ x, z });
        k++;
      }
    }
    W.slimeSpots = sl;
  }

  // -- butterflies
  {
    const wg2 = new THREE.BufferGeometry();
    wg2.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.1, 0.5, 0, 0.3, 0.45, 0, -0.25, 0, 0, 0.1, 0.45, 0, -0.25, 0.05, 0, -0.1], 3));
    wg2.computeVertexNormals();
    const bm = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const N = 22;
    W.butterflies = new THREE.InstancedMesh(wg2, bm, N * 2);
    W.butterflies.frustumCulled = false;
    const cols = [0xffb3d9, 0xfff08a, 0xa8e8ff, 0xd8b8ff, 0xffc69a];
    const bf = [];
    for (let i = 0; i < N; i++) {
      const c = new THREE.Color(cols[i % cols.length]);
      W.butterflies.setColorAt(i * 2, c); W.butterflies.setColorAt(i * 2 + 1, c);
      bf.push({ a: rng() * 6.28, r: 4 + rng() * 30, h: 1 + rng() * 2.5, sp: 0.3 + rng() * 0.5, ph: rng() * 10, ox: 0, oz: 0 });
    }
    W.bf = bf;
    scene.add(W.butterflies);
  }

  // -- minimap bake
  W.bakeMap = (size = 512) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const col = new THREE.Color();
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const x = (i / size) * HALF * 2 - HALF, z = (j / size) * HALF * 2 - HALF;
        const h = heightAt(x, z);
        let r, g, b;
        if (h < 0) {
          const t = clamp(-h / 8, 0, 1);
          r = lerp(130, 40, t); g = lerp(215, 110, t); b = lerp(230, 190, t);
        } else {
          colorAt(x, z, col);
          const sh = clamp(1 + (heightAt(x - 2, z - 2) - heightAt(x + 2, z + 2)) * 0.09, 0.65, 1.3);
          r = Math.min(255, Math.pow(col.r, 1 / 2.2) * 255 * sh);
          g = Math.min(255, Math.pow(col.g, 1 / 2.2) * 255 * sh);
          b = Math.min(255, Math.pow(col.b, 1 / 2.2) * 255 * sh);
        }
        const k = (j * size + i) * 4;
        img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    return c;
  };

  // -- per-frame
  const dm = new THREE.Object3D();
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1), yAxis = new THREE.Vector3(0, 1, 0);
  const winDay = new THREE.Color(0xbfe6ff), winNight = new THREE.Color(0xffc46b);
  let chunkT = 0;
  W.update = (dt, t, cam, playerPos, night, keyDir) => {
    W.waterU.uNight.value = night;
    W.waterU.uKeyDir.value.copy(keyDir);
    S.Glow.window.color.copy(winDay).lerp(winNight, night);
    S.Glow.lantern.color.setRGB(1, 0.72 + 0.03 * Math.sin(t * 3), 0.4).multiplyScalar(0.6 + night * 0.6);
    const cp = 0.6 + 0.4 * Math.sin(t * 2);
    S.Glow.crystal.color.setRGB(0.5 * cp + 0.3, 0.85, 1);
    if (W.windmill) W.windmill.userData.hub.rotation.z += dt * 0.5;
    for (const isl of W.islands) {
      isl.group.rotation.y += dt * 0.03;
      isl.group.position.y = isl.baseY;
    }
    W.altarCircle.rotation.z += dt * 0.15;
    W.altarCircle.material.opacity = 0.8;
    W.ruinCircle.rotation.z -= dt * 0.1;
    if (W.boat) { W.boat.position.y = Math.sin(t * 1.3) * 0.08; W.boat.rotation.z = Math.sin(t * 1.1) * 0.04; }
    // chunk visibility
    chunkT -= dt;
    if (chunkT <= 0) {
      chunkT = 0.25;
      for (const c of W.chunks) c.mesh.visible = Math.hypot(c.cx - playerPos.x, c.cz - playerPos.z) < c.range + 45;
    }
    // shards
    const sm = W.shardMesh, bm = W.beamMesh;
    for (let i = 0; i < W.shards.length; i++) {
      const s = W.shards[i];
      const near = Math.hypot(s.x - playerPos.x, s.z - playerPos.z);
      if (s.taken) { dm.scale.setScalar(0); dm.position.set(0, -500, 0); }
      else {
        dm.position.set(s.x, s.y + Math.sin(t * 2 + i) * 0.2, s.z);
        dm.rotation.set(0, t * 1.5 + i, 0);
        dm.scale.setScalar(1 + 0.08 * Math.sin(t * 4 + i));
      }
      dm.updateMatrix();
      sm.setMatrixAt(i, dm.matrix);
      if (!s.taken) { dm.position.set(s.x, s.y - 1.4 - 0.1, s.z); dm.rotation.set(0, 0, 0); dm.scale.set(1, 1, 1); }
      dm.updateMatrix();
      bm.setMatrixAt(i, dm.matrix);
    }
    sm.instanceMatrix.needsUpdate = true;
    bm.instanceMatrix.needsUpdate = true;
    // butterflies
    const bu = W.butterflies, show = night < 0.5;
    for (let i = 0; i < W.bf.length; i++) {
      const b = W.bf[i];
      b.a += dt * b.sp;
      const x = playerPos.x + b.ox + Math.cos(b.a) * b.r + Math.sin(t * 0.7 + b.ph) * 3;
      const z = playerPos.z + b.oz + Math.sin(b.a * 1.3) * b.r;
      const g = heightAt(x, z);
      const y = Math.max(g, 0.5) + b.h + Math.sin(t * 2 + b.ph) * 0.4;
      const heading = -b.a + Math.PI / 2;
      const flap = 0.25 + Math.abs(Math.sin(t * 18 + b.ph)) * 1.1;
      const vis = show && grassAt(x, z) > 0.3 ? 1 : 0;
      for (let s = 0; s < 2; s++) {
        const side = s ? -1 : 1;
        qa.setFromAxisAngle(yAxis, heading);
        qb.setFromAxisAngle(zAxis, side * flap);
        qa.multiply(qb);
        dm.position.set(x, y, z);
        dm.quaternion.copy(qa);
        dm.scale.set(side * 0.7 * vis, 0.7 * vis, 0.7 * vis);
        dm.updateMatrix();
        bu.setMatrixAt(i * 2 + s, dm.matrix);
      }
    }
    bu.instanceMatrix.needsUpdate = true;
  };

  W.regionAt = (x, z) => {
    for (const r of REGIONS) if (Math.hypot(x - r.x, z - r.z) < r.r) return r;
    const h = heightAt(x, z);
    if (Math.hypot(x, z) > 290 || h < 2) return { name: '白沙海岸', en: 'Pearl Coast' };
    return { name: '翠绿原野', en: 'Verdant Plains' };
  };
  onProgress(1, '完成');
  return W;
}
