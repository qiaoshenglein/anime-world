import * as THREE from 'three';
import { makeRng } from './noise.js';

const VS = /* glsl */ `
attribute float size; attribute float alpha; attribute vec3 pcolor;
varying float vA; varying vec3 vC;
uniform float uScale;
void main(){
  vA = alpha; vC = pcolor;
  vec4 mv = modelViewMatrix * vec4(position,1.);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * uScale / max(0.1, -mv.z);
}`;
const FS = /* glsl */ `
varying float vA; varying vec3 vC;
uniform float uStar;
void main(){
  vec2 p = gl_PointCoord - .5;
  float d = length(p);
  float a = smoothstep(.5,.0,d);
  a = a*a*1.4;
  float cross = smoothstep(.06,.0,min(abs(p.x),abs(p.y))) * smoothstep(.5,.05,d);
  a += cross * uStar;
  if(a*vA < .01) discard;
  gl_FragColor = vec4(vC, clamp(a,0.,1.)*vA);
}`;

export const pointUniforms = { uScale: { value: 500 } };

class PointCloud {
  constructor(scene, n, { additive = true, star = 0 } = {}) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: pointUniforms.uScale, uStar: { value: star } },
      vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }
  upload() {
    const a = this.geo.attributes;
    a.position.needsUpdate = a.pcolor.needsUpdate = a.size.needsUpdate = a.alpha.needsUpdate = true;
  }
}

export class Particles extends PointCloud {
  constructor(scene, n = 2200) {
    super(scene, n, { additive: true, star: 0.7 });
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.base = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.next = 0;
  }
  emit(x, y, z, vx, vy, vz, life, size, color, grav = 0, drag = 0.5) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.base[i] = size; this.grav[i] = grav; this.drag[i] = drag;
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
  }
  burst(x, y, z, n, speed, color, size = 0.35, life = 0.7, grav = 6) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283, b = Math.acos(2 * Math.random() - 1), s = speed * (0.3 + Math.random() * 0.7);
      this.emit(x, y, z, Math.sin(b) * Math.cos(a) * s, Math.cos(b) * s + speed * 0.3, Math.sin(b) * Math.sin(a) * s, life * (0.6 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.8), color, grav, 1.2);
    }
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      this.life[i] -= dt;
      const l = this.life[i] / this.maxLife[i];
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = Math.min(1, l * 2.2);
      this.size[i] = this.base[i] * (0.4 + 0.6 * l);
    }
    this.upload();
  }
}

// drifting sakura petals (instanced quads) around the camera
export class Petals {
  constructor(scene, n = 260) {
    const g = new THREE.CircleGeometry(0.11, 6);
    g.scale(1, 1.5, 1);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: true });
    this.mesh = new THREE.InstancedMesh(g, this.mat, n);
    this.mesh.frustumCulled = false;
    const rng = makeRng(4);
    this.d = [];
    const cols = [0xffb7d1, 0xffc9dc, 0xff9fc2, 0xffe0ec];
    for (let i = 0; i < n; i++) {
      this.d.push({ x: (rng() - 0.5) * 70, y: rng() * 30, z: (rng() - 0.5) * 70, ph: rng() * 20, fall: 0.6 + rng() * 0.8, sp: 1 + rng() * 2 });
      this.mesh.setColorAt(i, new THREE.Color(cols[i % 4]));
    }
    this.n = n;
    this.dum = new THREE.Object3D();
    scene.add(this.mesh);
  }
  update(dt, t, center, wind, amount) {
    const dm = this.dum;
    for (let i = 0; i < this.n; i++) {
      const p = this.d[i];
      p.y -= p.fall * dt;
      p.x += (wind.x + Math.sin(t * p.sp * 0.6 + p.ph) * 0.6) * dt;
      p.z += (wind.z + Math.cos(t * p.sp * 0.5 + p.ph) * 0.6) * dt;
      if (p.y < -2) p.y += 30;
      const wx = ((((p.x + 35) % 70) + 70) % 70) - 35, wz = ((((p.z + 35) % 70) + 70) % 70) - 35;
      p.x = wx; p.z = wz;
      dm.position.set(center.x + wx, center.y - 2 + p.y, center.z + wz);
      dm.rotation.set(t * p.sp + p.ph, t * p.sp * 0.7, p.ph);
      dm.scale.setScalar(i < this.n * amount ? 1 : 0);
      dm.updateMatrix();
      this.mesh.setMatrixAt(i, dm.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// 雨与流星都用「细长光条 + 实例网格」：不读光照、不写深度，软件渲染也扛得住。
// amount 是 0..1 的强度，天气切换时由调用方慢慢推，所以永远不会有一帧突然变天的突兀感。
export class Rain {
  constructor(scene, n = 260) {
    const g = new THREE.BoxGeometry(0.02, 0.85, 0.02);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xc8dcff, transparent: true, opacity: 0.5, fog: true, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(g, this.mat, n);
    this.mesh.frustumCulled = false;
    const rng = makeRng(11);
    this.d = [];
    for (let i = 0; i < n; i++) this.d.push({ x: (rng() - 0.5) * 44, y: rng() * 26, z: (rng() - 0.5) * 44, sp: 20 + rng() * 12 });
    this.n = n;
    this.dum = new THREE.Object3D();
    scene.add(this.mesh);
  }
  update(dt, t, center, wind, amount) {
    const dm = this.dum;
    this.mat.opacity = 0.5 * amount;
    this.mesh.visible = amount > 0.01;
    if (!this.mesh.visible) return;
    for (let i = 0; i < this.n; i++) {
      const p = this.d[i];
      p.y -= p.sp * dt;
      p.x += wind.x * 2.4 * dt; p.z += wind.z * 2.4 * dt;
      if (p.y < -3) p.y += 26;
      const wx = ((((p.x + 22) % 44) + 44) % 44) - 22, wz = ((((p.z + 22) % 44) + 44) % 44) - 22;
      p.x = wx; p.z = wz;
      dm.position.set(center.x + wx, center.y - 3 + p.y, center.z + wz);
      dm.rotation.set(wind.z * 0.05, 0, -wind.x * 0.05);
      dm.scale.setScalar(i < this.n * Math.min(1, amount) ? 1 : 0);
      dm.updateMatrix();
      this.mesh.setMatrixAt(i, dm.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class Meteors {
  constructor(scene, n = 9) {
    const g = new THREE.BoxGeometry(0.5, 0.5, 26);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xfff2c8, transparent: true, opacity: 0.85, fog: false, depthWrite: false, blending: THREE.AdditiveBlending });
    this.mesh = new THREE.InstancedMesh(g, this.mat, n);
    this.mesh.frustumCulled = false;
    this.d = [];
    for (let i = 0; i < n; i++) this.d.push({ live: false, t: 0, dur: 1, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 });
    this.n = n;
    this.next = 0.6;
    this.dum = new THREE.Object3D();
    scene.add(this.mesh);
  }
  update(dt, t, center, amount) {
    this.mesh.visible = amount > 0.01;
    if (!this.mesh.visible) return;
    this.next -= dt * amount;
    if (this.next <= 0) {
      this.next = 0.8 + Math.random() * 2.4;
      const s = this.d.find((m) => !m.live);
      if (s) {
        const a = Math.random() * Math.PI * 2, r = 120 + Math.random() * 140;
        s.live = true; s.t = 0; s.dur = 1.5 + Math.random() * 1.1;
        s.x = center.x + Math.cos(a) * r; s.z = center.z + Math.sin(a) * r; s.y = 150 + Math.random() * 70;
        const b = Math.random() * Math.PI * 2;
        s.dx = Math.cos(b) * (60 + Math.random() * 40); s.dz = Math.sin(b) * 50; s.dy = -110 - Math.random() * 60;
      }
    }
    for (let i = 0; i < this.n; i++) {
      const m = this.d[i];
      if (!m.live) { this.dum.scale.setScalar(0); this.dum.position.set(0, -9999, 0); this.dum.updateMatrix(); this.mesh.setMatrixAt(i, this.dum.matrix); continue; }
      m.t += dt;
      const u = m.t / m.dur;
      if (u >= 1) { m.live = false; continue; }
      const px = m.x + m.dx * m.t, py = m.y + m.dy * m.t, pz = m.z + m.dz * m.t;
      this.dum.position.set(px, py, pz);
      this.dum.lookAt(px + m.dx, py + m.dy, pz + m.dz);
      const fade = Math.sin(Math.PI * Math.min(1, u));
      this.dum.scale.set(1, 1, 0.4 + fade * 0.9);
      this.dum.updateMatrix();
      this.mesh.setMatrixAt(i, this.dum.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mat.opacity = 0.85 * amount;
  }
}

export class Fireflies extends PointCloud {
  constructor(scene, n = 140) {
    super(scene, n, { additive: true, star: 0.0 });
    this.d = [];
    for (let i = 0; i < n; i++) {
      this.d.push({ x: (Math.random() - 0.5) * 60, y: Math.random() * 6, z: (Math.random() - 0.5) * 60, ph: Math.random() * 20 });
      this.col[i * 3] = 0.8; this.col[i * 3 + 1] = 1; this.col[i * 3 + 2] = 0.4;
      this.size[i] = 0.5;
    }
  }
  update(dt, t, center, heightAt, amount) {
    for (let i = 0; i < this.n; i++) {
      const p = this.d[i];
      p.x += Math.sin(t * 0.5 + p.ph) * 0.8 * dt;
      p.z += Math.cos(t * 0.4 + p.ph * 1.3) * 0.8 * dt;
      const wx = ((((p.x + 30) % 60) + 60) % 60) - 30, wz = ((((p.z + 30) % 60) + 60) % 60) - 30;
      p.x = wx; p.z = wz;
      const x = center.x + wx, z = center.z + wz;
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = Math.max(heightAt(x, z), 0.3) + 0.8 + p.y * 0.4 + Math.sin(t + p.ph) * 0.3;
      this.pos[i * 3 + 2] = z;
      this.alpha[i] = amount * (0.4 + 0.6 * Math.max(0, Math.sin(t * 2 + p.ph * 3)));
      this.size[i] = 0.5;
    }
    this.upload();
  }
}
