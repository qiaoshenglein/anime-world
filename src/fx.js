import * as THREE from 'three';

// short-lived ring / slash visuals
export class FX {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this.ringGeo = new THREE.RingGeometry(0.86, 1, 56);
    this.ringGeo.rotateX(-Math.PI / 2);
    const arc = Math.PI * 0.95;
    this.arcGeo = new THREE.RingGeometry(0.5, 1.7, 32, 1, -Math.PI / 2 - arc / 2, arc);
    this.arcGeo.rotateX(-Math.PI / 2);
    // fade alpha along the arc using vertex colors
    const p = this.arcGeo.attributes.position, c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot(p.getX(i), p.getZ(i));
      const k = Math.min(1, Math.max(0, (r - 0.5) / 1.2));
      const v = 0.25 + 0.75 * Math.pow(k, 1.5);
      c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = v;
    }
    this.arcGeo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }

  _mat(color, vc = false) {
    return new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, vertexColors: vc, fog: false });
  }

  ring(x, y, z, r, color = 0xffffff, dur = 0.5, grow = true) {
    const m = new THREE.Mesh(this.ringGeo, this._mat(color));
    m.position.set(x, y, z);
    m.renderOrder = 4;
    this.scene.add(m);
    this.list.push({ m, t: 0, dur, r, kind: grow ? 'ring' : 'warn' });
  }

  slash(x, y, z, yaw, idx, color = 0xbdf3ff) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = yaw;
    const m = new THREE.Mesh(this.arcGeo, this._mat(color, true));
    m.rotation.z = idx === 2 ? Math.PI / 2 : idx === 1 ? -0.3 : 0.3;
    m.scale.set(1.6, 1, 1.6);
    m.renderOrder = 4;
    g.add(m);
    this.scene.add(g);
    this.list.push({ m: g, mesh: m, t: 0, dur: 0.26, kind: 'slash', idx });
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i];
      f.t += dt;
      const u = f.t / f.dur;
      if (u >= 1) {
        this.scene.remove(f.m);
        (f.mesh || f.m).material.dispose();
        this.list.splice(i, 1);
        continue;
      }
      if (f.kind === 'ring') {
        const e = 1 - Math.pow(1 - u, 3);
        f.m.scale.setScalar(Math.max(0.01, f.r * e));
        f.m.material.opacity = (1 - u) * 0.9;
      } else if (f.kind === 'warn') {
        f.m.scale.setScalar(f.r);
        f.m.material.opacity = (0.25 + 0.35 * Math.sin(f.t * 20)) * (1 - u * 0.3);
      } else {
        const e = 1 - Math.pow(1 - u, 2);
        f.mesh.scale.set(1.5 + e * 0.5, 1, 1.5 + e * 0.5);
        f.mesh.material.opacity = (1 - u) * 0.95;
        f.m.rotation.y += (f.idx === 1 ? -1 : 1) * 0.0;
      }
    }
  }
}
