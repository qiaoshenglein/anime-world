import * as THREE from 'three';
import { toon, addOutline, canvasTex } from './materials.js';
import { lerpAngle, clamp, lerp } from './noise.js';

const KINDS = {
  green: 0x8be36a, blue: 0x6fd6ff, pink: 0xff9ad0, king: 0xb58cff, tide: 0x4fd8c4,
};
const faceTex = canvasTex(128, 64, (c) => {
  c.fillStyle = '#2a1a3a';
  for (const x of [34, 94]) { c.beginPath(); c.ellipse(x, 28, 10, 14, 0, 0, 7); c.fill(); }
  c.fillStyle = '#fff';
  for (const x of [34, 94]) { c.beginPath(); c.ellipse(x - 3, 22, 4, 5, 0, 0, 7); c.fill(); }
  c.strokeStyle = '#2a1a3a'; c.lineWidth = 4; c.lineCap = 'round';
  c.beginPath(); c.moveTo(54, 46); c.quadraticCurveTo(64, 56, 74, 46); c.stroke();
  c.fillStyle = 'rgba(255,100,130,.55)';
  for (const x of [14, 114]) { c.beginPath(); c.ellipse(x, 44, 9, 5, 0, 0, 7); c.fill(); }
});
const faceMat = new THREE.MeshBasicMaterial({ map: faceTex, transparent: true, depthWrite: false });
const bodyGeo = new THREE.SphereGeometry(0.75, 26, 18);

export class Slime {
  constructor(ctx, spot, kind = 'green') {
    this.ctx = ctx;
    this.kind = kind;
    this.king = kind === 'king';
    this.tide = kind === 'tide';   // 潮水史莱姆：整条分线一起涌上来的那波浪，真正的血量记在服务端的池子里
    this.scale = this.king ? 2.6 : this.tide ? 1.08 + Math.random() * 0.22 : 0.9 + Math.random() * 0.25;
    this.maxHp = this.king ? 26 : this.tide ? 5 : 3;
    this.hp = this.maxHp;
    this.radius = 0.8 * this.scale;
    this.dmg = this.king ? 18 : 8;
    this.home = { x: spot.x, z: spot.z };
    const w = ctx.world;
    this.pos = new THREE.Vector3(spot.x, w.heightAt(spot.x, spot.z), spot.z);
    this.group = new THREE.Group();
    this.sq = new THREE.Group(); // squash pivot at the ground
    this.group.add(this.sq);
    const col = KINDS[kind];
    this.mat = toon(col, { transparent: true, opacity: 0.93, emissive: col, emissiveIntensity: 0.12 });
    const body = new THREE.Mesh(bodyGeo, this.mat);
    body.scale.set(1, 0.78, 1);
    body.position.y = 0.58;
    body.castShadow = true;
    this.sq.add(body);
    addOutline(body, 0.03);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.47), faceMat);
    face.position.set(0, 0.55, 0.72);
    face.rotation.x = -0.08;
    this.sq.add(face);
    if (this.king) {
      const gold = toon(0xffd36b);
      const crown = new THREE.Group();
      crown.position.set(0, 1.12, 0.05);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.3, 5), gold);
        c.position.set(Math.cos(a) * 0.3, 0.1, Math.sin(a) * 0.3);
        crown.add(c);
        addOutline(c, 0.015);
      }
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.36, 0.14, 12, 1, true), gold);
      band.material.side = THREE.DoubleSide;
      crown.add(band);
      this.sq.add(crown);
    } else {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.32, 5), toon(0x5fc85a));
      leaf.position.set(0, 1.07, 0);
      leaf.rotation.z = 0.3;
      this.sq.add(leaf);
      addOutline(leaf, 0.015);
    }
    this.group.scale.setScalar(this.scale);
    this.group.position.copy(this.pos);
    ctx.scene.add(this.group);
    // hp bar
    this.bar = new THREE.Group();
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.14), new THREE.MeshBasicMaterial({ color: 0x2b2140, depthTest: false, transparent: true }));
    this.fill = new THREE.Mesh(new THREE.PlaneGeometry(1.14, 0.09), new THREE.MeshBasicMaterial({ color: 0xff5f8f, depthTest: false, transparent: true }));
    this.fill.position.z = 0.001;
    bg.renderOrder = 20; this.fill.renderOrder = 21;
    this.bar.add(bg, this.fill);
    this.bar.visible = false;
    ctx.scene.add(this.bar);

    this.state = 'idle';
    this.timer = 0.5 + Math.random() * 2;
    this.hopT = 0; this.hopDur = 0.55; this.hopH = 1.0;
    this.from = new THREE.Vector3(); this.to = new THREE.Vector3();
    this.kb = new THREE.Vector2();
    this.stun = 0; this.yaw = Math.random() * 6.28; this.dead = false; this.deadT = 0;
    this.squash = 0; this.slamCd = 4 + Math.random() * 3; this.slam = null; this.barT = 0;
    this.seed = Math.random() * 10;
  }

  startHop(dx, dz, dist, h = 0.9, dur = 0.55) {
    const w = this.ctx.world;
    const l = Math.hypot(dx, dz) || 1;
    const tx = this.pos.x + (dx / l) * dist, tz = this.pos.z + (dz / l) * dist;
    if (w.heightAt(tx, tz) < 0.3) return false;
    this.from.copy(this.pos);
    this.to.set(tx, w.heightAt(tx, tz), tz);
    this.hopT = 0; this.hopDur = dur; this.hopH = h; this.state = 'hop';
    this.yaw = Math.atan2(dx, dz);
    this.ctx.audio.play('slime');
    return true;
  }

  hit(dmg, dirx, dirz) {
    if (this.dead) return false;
    this.hp -= dmg;
    this.stun = this.king ? 0.12 : 0.4;
    this.kb.set(dirx, dirz).multiplyScalar(this.king ? 3 : 9);
    this.state = 'stun';
    this.slam = null;
    this.squash = -0.5;
    this.mat.emissiveIntensity = 1.0;
    this.barT = 4;
    this.bar.visible = true;
    this.fill.scale.x = Math.max(0.001, this.hp / this.maxHp);
    this.fill.position.x = -0.57 * (1 - this.fill.scale.x);
    const p = this.ctx.particles;
    p.burst(this.pos.x, this.pos.y + 0.7 * this.scale, this.pos.z, 10, 5, KINDS[this.kind], 0.4, 0.5);
    if (this.hp <= 0) {
      // 联机时史莱姆王的生死由服务端判定：本地伤害只是表现，不能自己把王打死
      if (this.ctx.holdKill && this.ctx.holdKill(this)) { this.hp = 1; return false; }
      this.die(); return true;
    }
    return false;
  }

  die() {
    this.dead = true; this.deadT = 0;
    const p = this.ctx.particles;
    p.burst(this.pos.x, this.pos.y + 0.6 * this.scale, this.pos.z, this.king ? 70 : 26, this.king ? 10 : 7, KINDS[this.kind], 0.6, 1.0, 4);
    p.burst(this.pos.x, this.pos.y + 0.6 * this.scale, this.pos.z, this.king ? 40 : 10, 5, 0xffffff, 0.35, 0.8, 2);
    this.bar.visible = false;
    this.ctx.audio.play('die');
    this.ctx.onKill(this);
  }

  update(dt, t) {
    const ctx = this.ctx, w = ctx.world, P = ctx.player;
    if (this.dead) {
      this.deadT += dt;
      const k = Math.max(0, 1 - this.deadT * 3);
      this.group.scale.setScalar(this.scale * k);
      if (this.deadT > 0.4) { this.remove(); return false; }
      return true;
    }
    this.mat.emissiveIntensity = lerp(this.mat.emissiveIntensity, 0.12, 1 - Math.exp(-dt * 8));
    const dx = P.pos.x - this.pos.x, dz = P.pos.z - this.pos.z, dist = Math.hypot(dx, dz);
    const aggro = this.king ? 26 : this.tide ? 17 : 11;
    const engaged = !P.dead && dist < aggro && Math.abs(P.pos.y - this.pos.y) < 14;
    this.barT -= dt;
    if (this.barT <= 0 && !this.king) this.bar.visible = false;
    if (this.king) this.bar.visible = engaged || this.hp < this.maxHp;

    if (this.state === 'stun') {
      this.stun -= dt;
      this.pos.x += this.kb.x * dt; this.pos.z += this.kb.y * dt;
      this.kb.multiplyScalar(Math.exp(-dt * 6));
      if (w.heightAt(this.pos.x, this.pos.z) < 0.2) { this.pos.x -= this.kb.x * dt; this.pos.z -= this.kb.y * dt; }
      this.pos.y = w.heightAt(this.pos.x, this.pos.z);
      if (this.stun <= 0) { this.state = 'idle'; this.timer = 0.2; }
    } else if (this.state === 'hop') {
      this.hopT += dt;
      const u = clamp(this.hopT / this.hopDur, 0, 1);
      this.pos.x = lerp(this.from.x, this.to.x, u);
      this.pos.z = lerp(this.from.z, this.to.z, u);
      this.pos.y = lerp(this.from.y, this.to.y, u) + Math.sin(u * Math.PI) * this.hopH;
      this.squash = Math.sin(u * Math.PI) * 0.25;
      if (u >= 1) this.land();
    } else if (this.state === 'slamWind') {
      this.slam.t += dt;
      this.squash = -0.35 * Math.min(1, this.slam.t / 0.7);
      this.yaw = lerpAngle(this.yaw, Math.atan2(this.slam.x - this.pos.x, this.slam.z - this.pos.z), 0.2);
      if (this.slam.t > 0.7) {
        this.from.copy(this.pos);
        this.to.set(this.slam.x, w.heightAt(this.slam.x, this.slam.z), this.slam.z);
        this.hopT = 0; this.hopDur = 0.8; this.hopH = 5.5; this.state = 'slamAir';
        ctx.audio.play('jump2');
      }
    } else if (this.state === 'slamAir') {
      this.hopT += dt;
      const u = clamp(this.hopT / this.hopDur, 0, 1);
      this.pos.x = lerp(this.from.x, this.to.x, u);
      this.pos.z = lerp(this.from.z, this.to.z, u);
      this.pos.y = lerp(this.from.y, this.to.y, u) + Math.sin(u * Math.PI) * this.hopH;
      this.squash = Math.sin(u * Math.PI) * 0.3;
      if (u >= 1) {
        ctx.fx.ring(this.pos.x, this.pos.y + 0.2, this.pos.z, 7, 0xc9a8ff, 0.6);
        ctx.particles.burst(this.pos.x, this.pos.y + 0.3, this.pos.z, 40, 9, 0xb58cff, 0.5, 0.8, 3);
        ctx.shake(0.5);
        ctx.audio.play('land');
        if (Math.hypot(P.pos.x - this.pos.x, P.pos.z - this.pos.z) < 7 && P.grounded) ctx.hurtPlayer(this.dmg + 4, this.pos);
        this.squash = -0.55;
        this.state = 'idle'; this.timer = 1.2; this.slam = null; this.slamCd = 5 + Math.random() * 3;
      }
    } else {
      // grounded idle / chase
      this.timer -= dt;
      this.slamCd -= dt;
      this.squash = lerp(this.squash, Math.sin(t * 3 + this.seed) * 0.04, 1 - Math.exp(-dt * 10));
      if (engaged) {
        this.yaw = lerpAngle(this.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt * 8));
        if (this.king && this.slamCd <= 0 && dist > 3 && dist < 20) {
          this.state = 'slamWind';
          this.slam = { t: 0, x: P.pos.x, z: P.pos.z };
          ctx.fx.ring(P.pos.x, w.heightAt(P.pos.x, P.pos.z) + 0.15, P.pos.z, 7, 0xff5f8f, 0.9, false);
        } else if (this.timer <= 0) {
          const d = Math.min(this.king ? 5 : 3.4, Math.max(0.6, dist - this.radius * 0.6));
          this.startHop(dx, dz, d, this.king ? 1.6 : 1.0, this.king ? 0.7 : 0.5);
          this.timer = (this.king ? 1.0 : 0.65) + Math.random() * 0.4;
        }
        if (dist < this.radius + 0.6 && this.state === 'idle' && ctx.canHurt()) ctx.hurtPlayer(this.dmg * 0.6, this.pos);
      } else if (this.timer <= 0) {
        const hd = Math.hypot(this.home.x - this.pos.x, this.home.z - this.pos.z);
        let ax = Math.random() - 0.5, az = Math.random() - 0.5;
        if (hd > 18) { ax = this.home.x - this.pos.x; az = this.home.z - this.pos.z; }
        this.startHop(ax, az, 1.8 + Math.random() * 1.6, 0.8, 0.5);
        this.timer = 1.4 + Math.random() * 2.4;
      }
    }
    // obstacles
    if (this.state !== 'slamAir') ctx.world.colliders.resolve(this.pos, this.radius * 0.6);
    this.sq.scale.set(1 - this.squash * 0.5, 1 + this.squash, 1 - this.squash * 0.5);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    // bar
    if (this.bar.visible) {
      this.bar.position.set(this.pos.x, this.pos.y + 1.55 * this.scale + 0.3, this.pos.z);
      this.bar.quaternion.copy(ctx.camera.quaternion);
      this.bar.scale.setScalar(this.king ? 2.6 : 1);
    }
    return true;
  }

  land() {
    const ctx = this.ctx, P = ctx.player;
    this.pos.y = ctx.world.heightAt(this.pos.x, this.pos.z);
    this.squash = -0.35;
    this.state = 'idle';
    if (this.timer < 0.25) this.timer = 0.25;
    ctx.particles.burst(this.pos.x, this.pos.y + 0.1, this.pos.z, 4, 2.5, KINDS[this.kind], 0.25, 0.4, 2);
    const d = Math.hypot(P.pos.x - this.pos.x, P.pos.z - this.pos.z);
    if (d < this.radius + 0.7 && Math.abs(P.pos.y - this.pos.y) < 1.6 && ctx.canHurt()) ctx.hurtPlayer(this.dmg, this.pos);
  }

  remove() {
    this.ctx.scene.remove(this.group);
    this.ctx.scene.remove(this.bar);
    this.removed = true;
  }
}
