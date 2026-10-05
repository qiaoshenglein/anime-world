import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

let grad;
export function gradientMap() {
  if (!grad) {
    const d = new Uint8Array([75, 135, 205, 255]);
    grad = new THREE.DataTexture(d, 4, 1, THREE.RedFormat);
    grad.minFilter = grad.magFilter = THREE.NearestFilter;
    grad.generateMipmaps = false;
    grad.needsUpdate = true;
  }
  return grad;
}

export function toon(color, o = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: gradientMap(), ...o });
}

const matCache = new Map();
export function mat(hex, o = {}) {
  const key = hex + JSON.stringify(o);
  if (!matCache.has(key)) matCache.set(key, toon(hex, o));
  return matCache.get(key);
}

// ---- inverted hull outlines -------------------------------------------------
const outCache = new Map();
export function outlineMat(th = 0.02, color = 0x2b2140) {
  const key = th + '_' + color;
  if (outCache.has(key)) return outCache.get(key);
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace(
      '#include <begin_vertex>',
      `vec3 transformed = position + normal * ${th.toFixed(4)};`
    );
  };
  m.customProgramCacheKey = () => 'outline' + th;
  outCache.set(key, m);
  return m;
}

const outGeo = new WeakMap();
export function outlineGeometry(geo) {
  if (outGeo.has(geo)) return outGeo.get(geo);
  let g = geo.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g = mergeVertices(g, 1e-4);
  g.computeVertexNormals();
  outGeo.set(geo, g);
  return g;
}

export function addOutline(mesh, th = 0.02, color = 0x2b2140) {
  const o = new THREE.Mesh(outlineGeometry(mesh.geometry), outlineMat(th, color));
  o.userData.isOutline = true;
  o.castShadow = false;
  o.receiveShadow = false;
  mesh.add(o);
  return o;
}

// bake a solid vertex color into a geometry
export function colorGeo(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// vertical gradient from dark (bottom) to light (top) relative to y-range
export function gradGeo(geo, darkHex, lightHex, y0, y1) {
  const a = new THREE.Color(darkHex), b = new THREE.Color(lightHex), c = new THREE.Color();
  const p = geo.attributes.position;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, (p.getY(i) - y0) / (y1 - y0)));
    c.copy(a).lerp(b, t);
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// shared time uniform for animated shaders
export const TIME = { value: 0 };

export function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
