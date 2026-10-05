import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { clamp, lerp, lerpAngle, sstep } from './noise.js';
import { TIME, canvasTex, toon } from './materials.js';
import { DayNight, CloudField } from './sky.js';
import { createWorld, POI, SEA } from './world.js';
import { buildCharacter } from './character.js';
import { Particles, Petals, Fireflies, pointUniforms } from './particles.js';
import { AudioSys } from './audio.js';
import { FX } from './fx.js';
import { Slime } from './enemies.js';
import { net } from './net.js';

const $ = (id) => document.getElementById(id);
const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// ------------------------------------------------------------------ renderer
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
const PR = Math.min(window.devicePixelRatio || 1, 1.75);
renderer.setPixelRatio(PR);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1600);
scene.add(camera);

const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.7, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(PR);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointUniforms.uScale.value = (h * PR) / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ state
const G = { state: 'loading', t: 0, hitstop: 0, shakeAmt: 0, paused: false, locked: false, noLock: false, cine: null, timeScale: 1, bloomOn: true };
const audio = new AudioSys();
const P = {
  pos: new THREE.Vector3(0, 0, 16), vel: new THREE.Vector3(), vy: 0, yaw: Math.PI,
  grounded: true, airT: 0, jumps: 0, glide: false, swim: false, swimCd: 0, coyote: 0,
  hp: 100, maxHp: 100, stamina: 100, exhausted: false, stRegen: 0, energy: 0,
  atk: null, combo: 0, comboT: 0, cast: null, hurtT: 0, invuln: 0, dead: false, deadT: 0, swordT: 0, dmgBonus: 0,
  sprinting: false, stepD: 0, dustT: 0, lf: 0, ls: 0, wallet: 0, collected: 0, kills: 0, atkQueued: false,
};
const Q = { stage: 0, k0: 0, kingDead: false, upgraded: false };
const cam = { yaw: 0.0, pitch: 0.32, dist: 7.6, target: new THREE.Vector3(), pos: new THREE.Vector3(), fov: 55 };

const keys = {}, pressed = {};
const touch = { x: 0, y: 0, sprint: false, jump: false };

let world, dayNight, clouds, char, particles, petals, fireflies, fx;
let npcs = [], enemies = [], drops = [], respawns = [];
let mapBase, mmCtx;

const tmpV = new THREE.Vector3();

// ------------------------------------------------------------------ UI helpers
function toast(text, cls = '') {
  const d = document.createElement('div');
  d.className = 'toast panel ' + cls;
  d.textContent = text;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 3300);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}
function dmgNumber(pos, text, cls = '') {
  tmpV.copy(pos).project(camera);
  if (tmpV.z > 1) return;
  const d = document.createElement('div');
  d.className = 'dn ' + cls;
  d.textContent = text;
  d.style.left = (tmpV.x * 0.5 + 0.5) * window.innerWidth + 'px';
  d.style.top = (-tmpV.y * 0.5 + 0.5) * window.innerHeight + 'px';
  $('dmg').appendChild(d);
  setTimeout(() => d.remove(), 950);
}
function shake(a) { G.shakeAmt = Math.max(G.shakeAmt, a); }
function flashScreen(a = 0.6) {
  const f = $('flash');
  f.style.transition = 'none'; f.style.opacity = a;
  requestAnimationFrame(() => { f.style.transition = 'opacity .6s'; f.style.opacity = 0; });
}
let bannerT = 0, lastRegion = '';
function showBanner(n, e) {
  $('bn').textContent = n; $('be').textContent = e;
  $('banner').classList.add('show');
  bannerT = 3.6;
}

// ------------------------------------------------------------------ quests
function questInfo() {
  switch (Q.stage) {
    case 0: return { t: '初到始源之村', d: '与村长阿澄交谈，了解星屑碎片的传说。', target: npcById('elder')?.pos, p: 0 };
    case 1: return { t: '星屑的碎片', d: `收集世界中散落的星屑碎片（${Math.min(12, P.collected)} / 12）。金色光柱就是它们的位置！`, p: P.collected / 12 };
    case 2: return { t: '史莱姆骚动', d: `击败荒野里躁动的史莱姆（${Math.min(8, P.kills - Q.k0)} / 8）。`, p: (P.kills - Q.k0) / 8 };
    case 3: return { t: '史莱姆王', d: '前往东方的古代遗迹，击败史莱姆王。小心它的跳跃践踏！', target: { x: POI.ruins.x, z: POI.ruins.z }, p: 0 };
    case 4: return { t: '樱花神树的愿望', d: '前往西北方樱花之丘，与巫女「樱」交谈，在神树下许愿。', target: world.altar, p: 0 };
    default: return { t: '自由探索', d: `世界由你书写。继续收集星屑碎片（${P.collected} / ${world.shards.length}），或者乘滑翔翼登上浮空岛吧！`, p: P.collected / world.shards.length };
  }
}
let lastQKey = '';
function renderQuest() {
  const q = questInfo();
  const key = q.t + q.d + Math.round(q.p * 100);
  if (key === lastQKey) return;
  lastQKey = key;
  $('qt').textContent = q.t; $('qd').textContent = q.d;
  $('qpf').style.width = clamp(q.p, 0, 1) * 100 + '%';
}
function setStage(s, msg) {
  Q.stage = s;
  Q.k0 = P.kills;
  audio.play('quest');
  toast(msg || '任务更新', 'big');
  lastQKey = '';
  renderQuest();
  checkQuest();
}
function checkQuest() {
  if (Q.stage === 1 && P.collected >= 12) setStage(2, '✿ 任务完成：星屑的碎片 ✿');
  else if (Q.stage === 2 && P.kills - Q.k0 >= 8) setStage(3, '✿ 任务完成：史莱姆骚动 ✿');
  if (Q.stage === 3 && Q.kingDead) setStage(4, '✿ 击败了史莱姆王！前往樱花之丘 ✿');
}

// ------------------------------------------------------------------ NPCs & dialogue
const D = { open: false, lines: [], i: 0, chars: 0, name: '', done: null, npc: null, blip: 0 };
function openDialog(name, lines, done, npc) {
  D.open = true; D.lines = lines; D.i = 0; D.chars = 0; D.name = name; D.done = done; D.npc = npc;
  $('dname').textContent = name;
  $('dialog').classList.remove('hidden');
  $('prompt').classList.add('hidden');
  P.vel.set(0, 0, 0);
  audio.play('ui');
}
function advanceDialog() {
  const full = D.lines[D.i];
  if (D.chars < full.length) { D.chars = full.length; return; }
  D.i++;
  audio.play('ui');
  if (D.i >= D.lines.length) {
    D.open = false;
    $('dialog').classList.add('hidden');
    const cb = D.done; D.done = null; D.npc = null;
    if (cb) cb();
  } else D.chars = 0;
}

const NPC_DEFS = [
  {
    id: 'elder', name: '阿澄 · 村长', x: -2, z: -20.5,
    look: { hair: 0xf2f2ff, style: 'long', eye: 0x8ab0ff, top: 0xfff0d8, skirt: 0x4f78c8, scarfOn: false, acc: ['beard', 'staff'], scale: 0.9, accent: 0xd0584a },
    lines: () => {
      if (Q.stage === 0) return [
        ['欢迎来到始源之村，旅人。我是村长阿澄。'],
        ['最近，天空中的星屑碎片四散坠落，连史莱姆们也躁动了起来……'],
        ['你愿意帮我们找回 12 枚星屑碎片吗？它们会发出金色的光柱，很容易找到。'],
        ['对了，在空中按住【空格】可以展开滑翔翼，别忘了试试！'],
      ].flat();
      if (Q.stage === 1) return [`星屑碎片还差 ${12 - P.collected} 枚呢。看到金色光柱就朝它走吧。`, '荒野里有史莱姆，别忘了用【左键】挥剑，三连斩会更强哦。'];
      if (Q.stage === 2) return ['多亏了你，星屑的力量稳定了一些。', '可是史莱姆们还在躁动……请打倒 8 只，让它们冷静下来吧。'];
      if (Q.stage === 3) return ['躁动的根源是东方古代遗迹里的「史莱姆王」。', '它会高高跳起践踏——看到地上的红色圈圈就赶紧躲开！'];
      if (Q.stage === 4) return ['你打败了史莱姆王？太好了……', '去西北方的樱花之丘吧，那里的巫女「樱」会引导你完成最后的仪式。'];
      return ['世界重新恢复了平静，谢谢你，星屑守护者。', '要是想挑战自己，就去收集剩下所有的星屑碎片吧。'];
    },
    done: () => { if (Q.stage === 0) setStage(1, '新任务：星屑的碎片'); },
  },
  {
    id: 'kid', name: '小葵 · 团子摊', x: -8.5, z: 13.5,
    look: { hair: 0xffd36b, style: 'twin', eye: 0x6fd8ff, top: 0xfff0f5, skirt: 0xe06a90, scarf: 0x6fd8ff, accent: 0x6fd8ff, scale: 0.78, acc: ['apron'] },
    lines: () => {
      if (P.wallet >= 3 && P.hp < P.maxHp) return ['欢迎光临～三色团子，3 枚星屑一串！', '（你吃下团子，感觉浑身都是力量！生命完全恢复了）'];
      if (P.wallet < 3) return ['欢迎光临～三色团子，3 枚星屑一串！', '诶，星屑不够呢……打倒史莱姆或者捡星屑碎片就能换啦！'];
      return ['你看起来精神满满呢！受伤的时候再来找我吧～'];
    },
    done: () => { if (P.wallet >= 3 && P.hp < P.maxHp) { P.wallet -= 3; P.hp = P.maxHp; audio.play('heal'); dmgNumber(playerHead(), '+生命全满', 'heal'); particles.burst(P.pos.x, P.pos.y + 1, P.pos.z, 30, 4, 0xa8ff9a, 0.5, 1, -1); } },
  },
  {
    id: 'smith', name: '大河 · 铁匠', x: 11.5, z: 12.5,
    look: { hair: 0x4a5ac8, style: 'short', eye: 0xffa040, top: 0xdce8ff, skirt: 0x3a3a5a, accent: 0xff8a3d, scarf: 0xff8a3d, scale: 0.95, acc: [] },
    lines: () => {
      if (!Q.upgraded && P.wallet >= 10) return ['哟，是你！我看你那把剑该保养了。', '10 枚星屑，我给你灌注星屑之力——成交？', '（剑身闪耀起光芒，攻击力提升了！）'];
      if (!Q.upgraded) return ['想强化你的剑吗？攒够 10 枚星屑再来找我吧。', '荒野的史莱姆掉落的星屑最多。'];
      return ['那把剑现在可是削铁如泥！', '对了，史莱姆王的跳跃践踏前会有预警圈，别站在里面。'];
    },
    done: () => { if (!Q.upgraded && P.wallet >= 10) { P.wallet -= 10; Q.upgraded = true; P.dmgBonus = 1; audio.play('special'); toast('攻击力提升！（伤害 +1）', 'gold'); flashScreen(0.3); } },
  },
  {
    id: 'trader', name: '米露 · 旅行商人', x: 0, z: 0, pier: true,
    look: { hair: 0xbfa0ff, style: 'bun', eye: 0xffd36b, top: 0xffe8c8, skirt: 0x6a4a8a, acc: ['hat'], scale: 0.88, scarf: 0xffd36b, accent: 0xffd36b },
    lines: () => ['这座镜湖的水一直通到天边呢～', '听说北方雾岚山脉的山顶上，悬着好几座浮空岛，岛上还藏着星屑碎片。', '从山顶跳下来，按住空格滑翔，说不定能一座一座飞过去！'],
  },
  {
    id: 'miko', name: '樱 · 巫女', x: 0, z: 0, altar: true,
    look: { hair: 0x2b2250, style: 'long', eye: 0xff8fb8, top: 0xffffff, skirt: 0xdb3a2f, accent: 0xdb3a2f, scarfOn: false, scale: 0.9, acc: ['halo'] },
    lines: () => {
      if (Q.stage === 4) return ['……等你很久了，星屑的守护者。', '世界上的星屑在你的手中汇聚，神树也在回应你。', '请站在法阵中央，诚心地许一个愿望吧。'];
      if (Q.stage < 4) return ['这棵神树已经沉睡了很久很久。', '当星屑再次汇聚、躁动的王者被击败时，它就会苏醒。'];
      return ['愿你一路上，总有樱花为你盛开。', '——愿望实现了，不是吗？'];
    },
    done: () => { if (Q.stage === 4) startEnding(); },
  },
];

function npcById(id) { return npcs.find((n) => n.def.id === id); }
function playerHead() { return tmpV.set(P.pos.x, P.pos.y + 2.1, P.pos.z).clone(); }

function makeMarker(text, color) {
  const tex = canvasTex(64, 64, (c) => {
    c.fillStyle = '#fff'; c.beginPath(); c.arc(32, 32, 28, 0, 7); c.fill();
    c.strokeStyle = color; c.lineWidth = 5; c.stroke();
    c.fillStyle = color; c.font = '900 40px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 32, 35);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(0.7, 0.7, 1);
  s.renderOrder = 15;
  return s;
}

function spawnNPCs() {
  for (const def of NPC_DEFS) {
    let x = def.x, z = def.z;
    if (def.pier) { x = world.pier.x + world.pier.dirx * 2.5 + 1.2; z = world.pier.z + world.pier.dirz * 2.5 + 1.2; }
    if (def.altar) { x = world.altar.x + 3; z = world.altar.z + 6; }
    const c = buildCharacter(def.look);
    const y = world.groundAt(x, z, 1000);
    c.root.position.set(x, y, z);
    scene.add(c.root);
    const mk1 = makeMarker('!', '#ff6fa8'), mk2 = makeMarker('…', '#8a6ad0');
    mk1.visible = mk2.visible = false;
    scene.add(mk1, mk2);
    const n = { def, char: c, pos: c.root.position, home: new THREE.Vector3(x, y, z), yaw: Math.PI * (def.altar ? 0.6 : 0), mk1, mk2, t: Math.random() * 10 };
    world.colliders.add(x, z, 0.5);
    npcs.push(n);
  }
}
function updateNPCs(dt) {
  for (const n of npcs) {
    n.t += dt;
    const dx = P.pos.x - n.pos.x, dz = P.pos.z - n.pos.z, d = Math.hypot(dx, dz);
    const talking = D.open && D.npc === n;
    if (d < 9 || talking) n.yaw = lerpAngle(n.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt * 4));
    n.char.root.rotation.y = n.yaw;
    n.char.animate(dt, { speed: 0, talk: talking && Math.floor(D.chars) < D.lines[D.i].length });
    const quest = (n.def.id === 'elder' && Q.stage === 0) || (n.def.id === 'miko' && Q.stage === 4);
    n.mk1.visible = quest && d < 60;
    n.mk2.visible = !quest && d < 11 && !talking;
    const s = n.mk1.visible ? n.mk1 : n.mk2;
    s.position.set(n.pos.x, n.pos.y + 2.25 + Math.sin(n.t * 3) * 0.08, n.pos.z);
  }
}
function nearestNPC(r = 3.6) {
  let best = null, bd = r;
  for (const n of npcs) {
    const d = Math.hypot(n.pos.x - P.pos.x, n.pos.z - P.pos.z);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

// ------------------------------------------------------------------ enemies & drops
const enemyCtx = {};
function kindRoll() { const r = Math.random(); return r < 0.4 ? 'green' : r < 0.75 ? 'blue' : 'pink'; }
function spawnSlime(x, z, kind) {
  const e = new Slime(enemyCtx, { x, z }, kind || kindRoll());
  enemies.push(e);
  return e;
}
const heartGeo = (() => {
  const s = new THREE.Shape();
  s.moveTo(0, -0.5); s.bezierCurveTo(-0.9, 0.1, -0.6, 0.8, 0, 0.4); s.bezierCurveTo(0.6, 0.8, 0.9, 0.1, 0, -0.5);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.2, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2 });
  g.center(); g.scale(0.5, 0.5, 0.5);
  return g;
})();
const shardGeo = new THREE.OctahedronGeometry(0.3, 0);
shardGeo.scale(1, 1.5, 1);
function spawnDrop(type, x, y, z) {
  const m = new THREE.Mesh(type === 'heart' ? heartGeo : shardGeo, type === 'heart'
    ? toon(0xff6f9a, { emissive: 0xff2f6a, emissiveIntensity: 0.7 })
    : toon(0xffe27a, { emissive: 0xffb830, emissiveIntensity: 0.9 }));
  m.position.set(x, y, z);
  scene.add(m);
  const a = Math.random() * 6.28;
  drops.push({ m, type, vx: Math.cos(a) * 3, vz: Math.sin(a) * 3, vy: 6 + Math.random() * 2, t: 0 });
}
function updateDrops(dt) {
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.t += dt;
    const m = d.m;
    const g = world.heightAt(m.position.x, m.position.z) + 0.6;
    if (d.vy !== 0 || m.position.y > g) {
      d.vy -= 22 * dt;
      m.position.x += d.vx * dt; m.position.z += d.vz * dt; m.position.y += d.vy * dt;
      if (m.position.y <= g) { m.position.y = g; d.vy = 0; d.vx = d.vz = 0; }
    } else m.position.y = g + Math.sin(d.t * 4) * 0.1;
    m.rotation.y += dt * 3;
    const dx = P.pos.x - m.position.x, dz = P.pos.z - m.position.z, dy = P.pos.y + 0.9 - m.position.y;
    const dist = Math.hypot(dx, dy, dz);
    if (d.t > 0.5 && dist < 5 && !P.dead) {
      const k = 1 - Math.exp(-dt * 7);
      m.position.x += dx * k; m.position.z += dz * k; m.position.y += dy * k; d.vy = 0.0001;
    }
    if (dist < 1.1 && d.t > 0.4 && !P.dead) {
      if (d.type === 'heart') { P.hp = Math.min(P.maxHp, P.hp + 15); audio.play('heal'); dmgNumber(playerHead(), '+15', 'heal'); }
      else { P.wallet += 1; audio.play('pickup'); P.energy = Math.min(100, P.energy + 4); }
      particles.burst(m.position.x, m.position.y, m.position.z, 8, 3, d.type === 'heart' ? 0xff8fb8 : 0xffe27a, 0.3, 0.5, 0);
      scene.remove(m);
      drops.splice(i, 1);
    } else if (d.t > 40) { scene.remove(m); drops.splice(i, 1); }
  }
}

// ------------------------------------------------------------------ combat
function hurtPlayer(dmg, from) {
  if (P.invuln > 0 || P.dead || P.cast) return;
  dmg = Math.round(dmg);
  P.hp -= dmg;
  P.invuln = 1.0; P.hurtT = 0.3;
  const dx = P.pos.x - from.x, dz = P.pos.z - from.z, l = Math.hypot(dx, dz) || 1;
  P.vel.set((dx / l) * 10, 0, (dz / l) * 10);
  if (P.grounded) { P.vy = 5.5; P.grounded = false; }
  P.atk = null;
  char.flash = 1;
  audio.play('hurt');
  dmgNumber(playerHead(), '-' + dmg, 'me');
  $('vig').style.opacity = 1; setTimeout(() => ($('vig').style.opacity = 0), 220);
  shake(0.35); G.hitstop = 0.06;
  if (P.hp <= 0) killPlayer();
}
function killPlayer() {
  P.hp = 0; P.dead = true; P.deadT = 0; P.atk = null; P.glide = false;
  $('fade').style.transition = 'opacity 1.2s'; $('fade').style.opacity = 1;
  toast('你倒下了……', '');
}
function respawnPlayer() {
  P.dead = false; P.hp = P.maxHp; P.pos.set(0, world.heightAt(0, 16), 16); P.vel.set(0, 0, 0); P.vy = 0; P.invuln = 2;
  P.stamina = 100; P.exhausted = false; P.yaw = Math.PI;
  for (const e of enemies) if (!e.dead) e.state = 'idle';
  $('fade').style.opacity = 0;
  toast('在村庄的长椅上醒来了……', '');
}

function startAttack() {
  if (P.atk || P.cast || P.dead || D.open || G.cine) return;
  if (P.swim) return;
  const idx = P.comboT > 0 ? (P.combo + 1) % 3 : 0;
  P.combo = idx;
  P.atk = { t: 0, idx, dur: idx === 2 ? 0.66 : 0.48, hit: false, fx: false };
  P.swordT = 3;
  // auto-face nearest enemy in front/any within 7m
  let best = null, bd = 7;
  for (const e of enemies) {
    if (e.dead) continue;
    const d = Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z);
    if (d < bd) { bd = d; best = e; }
  }
  if (best) P.yaw = Math.atan2(best.pos.x - P.pos.x, best.pos.z - P.pos.z);
  else if (Math.hypot(P.vel.x, P.vel.z) < 0.5) { /* keep facing */ }
  const lunge = idx === 2 ? 8.5 : 6;
  P.vel.x = Math.sin(P.yaw) * lunge; P.vel.z = Math.cos(P.yaw) * lunge;
  audio.play('slash');
}
function updateAttack(dt) {
  const a = P.atk;
  if (!a) { P.comboT = Math.max(0, P.comboT - dt); return; }
  a.t += dt;
  if (!a.fx && a.t > a.dur * 0.28) {
    a.fx = true;
    fx.slash(P.pos.x + Math.sin(P.yaw) * 0.3, P.pos.y + 0.9, P.pos.z + Math.cos(P.yaw) * 0.3, P.yaw, a.idx, a.idx === 2 ? 0xffe8a0 : 0xbdf3ff);
  }
  if (!a.hit && a.t > a.dur * 0.4) {
    a.hit = true;
    const fx_ = Math.sin(P.yaw), fz_ = Math.cos(P.yaw);
    let any = false;
    for (const e of enemies) {
      if (e.dead) continue;
      const ex = e.pos.x - P.pos.x, ez = e.pos.z - P.pos.z, d = Math.hypot(ex, ez);
      const reach = 2.9 + e.radius;
      if (d < reach && Math.abs(e.pos.y - P.pos.y) < 3 + e.radius) {
        const dot = (ex * fx_ + ez * fz_) / (d || 1);
        if (dot > 0.2 || d < 1.3 + e.radius) {
          const crit = Math.random() < 0.15;
          const dmg = (1 + (a.idx === 2 ? 1 : 0) + P.dmgBonus) * (crit ? 2 : 1);
          const pt = new THREE.Vector3(e.pos.x, e.pos.y + 1.4 * e.scale, e.pos.z);
          dmgNumber(pt, dmg, crit ? 'crit' : '');
          const died = e.hit(dmg, ex / (d || 1), ez / (d || 1));
          P.energy = Math.min(100, P.energy + (died ? 10 : 6));
          any = true;
        }
      }
    }
    if (any) {
      G.hitstop = a.idx === 2 ? 0.09 : 0.05;
      shake(a.idx === 2 ? 0.35 : 0.18);
      audio.play('hit');
    }
  }
  if (a.t >= a.dur) {
    P.atk = null; P.comboT = 0.5;
    if (P.atkQueued) { P.atkQueued = false; startAttack(); }
  }
}
function startSpecial() {
  if (P.cast || P.atk || P.energy < 60 || P.dead || D.open || G.cine) return;
  P.energy -= 60;
  P.cast = { t: 0, fired: false };
  P.vel.set(0, 0, 0);
  P.swordT = 3;
  audio.play('special');
}
function updateSpecial(dt) {
  const c = P.cast;
  if (!c) return;
  c.t += dt;
  P.vy = 0; P.vel.multiplyScalar(0.8);
  if (c.t > 0.4 && !c.fired) {
    c.fired = true;
    fx.ring(P.pos.x, P.pos.y + 0.2, P.pos.z, 9, 0xfff2a0, 0.7);
    fx.ring(P.pos.x, P.pos.y + 0.4, P.pos.z, 6, 0xff9ad0, 0.5);
    particles.burst(P.pos.x, P.pos.y + 1, P.pos.z, 90, 13, 0xffe8a0, 0.6, 1.2, 1);
    particles.burst(P.pos.x, P.pos.y + 1, P.pos.z, 50, 9, 0xff9ad0, 0.5, 1, 1);
    shake(0.6); flashScreen(0.45); G.hitstop = 0.08;
    for (const e of enemies) {
      if (e.dead) continue;
      const ex = e.pos.x - P.pos.x, ez = e.pos.z - P.pos.z, d = Math.hypot(ex, ez);
      if (d < 9.5 + e.radius) {
        dmgNumber(new THREE.Vector3(e.pos.x, e.pos.y + 1.5 * e.scale, e.pos.z), 3 + P.dmgBonus, 'crit');
        e.hit(3 + P.dmgBonus, ex / (d || 1), ez / (d || 1));
      }
    }
  }
  if (c.t > 0.95) P.cast = null;
}

enemyCtx.scene = scene;
enemyCtx.player = P;
enemyCtx.hurtPlayer = hurtPlayer;
enemyCtx.canHurt = () => P.invuln <= 0 && !P.dead;
enemyCtx.shake = shake;
enemyCtx.onKill = (e) => {
  P.kills++;
  P.energy = Math.min(100, P.energy + 8);
  const n = e.king ? 10 : 1 + (Math.random() < 0.6 ? 1 : 0);
  for (let i = 0; i < n; i++) spawnDrop('shard', e.pos.x, e.pos.y + 0.8, e.pos.z);
  if (Math.random() < (e.king ? 1 : 0.3)) for (let i = 0; i < (e.king ? 3 : 1); i++) spawnDrop('heart', e.pos.x, e.pos.y + 0.8, e.pos.z);
  if (e.king) {
    Q.kingDead = true;
    toast('史莱姆王被击败了！', 'big');
    flashScreen(0.5); shake(0.7);
    respawns.push({ t: 240, king: true });
  } else respawns.push({ t: 40 + Math.random() * 20 });
  checkQuest();
};

// ------------------------------------------------------------------ player update
function camBasis() {
  const fx_ = -Math.sin(cam.yaw), fz_ = -Math.cos(cam.yaw);
  return { fx: fx_, fz: fz_, rx: Math.cos(cam.yaw), rz: -Math.sin(cam.yaw) };
}

function updatePlayer(dt) {
  if (P.dead) {
    P.deadT += dt;
    if (P.deadT > 2.2) respawnPlayer();
    char.animate(dt, { speed: 0, hurt: true });
    char.root.position.copy(P.pos);
    return;
  }
  const canAct = !D.open && !G.cine && G.state === 'play';
  P.invuln = Math.max(0, P.invuln - dt);
  P.hurtT = Math.max(0, P.hurtT - dt);
  P.swordT = Math.max(0, P.swordT - dt);
  P.swimCd = Math.max(0, P.swimCd - dt);
  P.coyote = Math.max(0, P.coyote - dt);

  let ix = 0, iz = 0;
  if (canAct) {
    if (keys.KeyW) iz += 1; if (keys.KeyS) iz -= 1; if (keys.KeyD) ix += 1; if (keys.KeyA) ix -= 1;
    ix += touch.x; iz += touch.y;
  }
  const il = Math.hypot(ix, iz);
  if (il > 1) { ix /= il; iz /= il; }
  const b = camBasis();
  const dx = b.fx * iz + b.rx * ix, dz = b.fz * iz + b.rz * ix;
  const moving = il > 0.12;

  // stamina
  const wantSprint = canAct && (keys.ShiftLeft || keys.ShiftRight || touch.sprint) && moving;
  P.sprinting = wantSprint && !P.exhausted && P.stamina > 0 && !P.swim && !P.glide;
  if (P.sprinting) { P.stamina -= 16 * dt; P.stRegen = 0.8; }
  else if (P.glide) P.stRegen = 1.0;
  else { P.stRegen -= dt; if (P.stRegen <= 0) P.stamina = Math.min(100, P.stamina + (P.grounded ? 26 : 10) * dt); }
  if (P.stamina <= 0) { P.stamina = 0; P.exhausted = true; }
  if (P.exhausted && P.stamina > 30) P.exhausted = false;

  // attack / special
  if (canAct) {
    if (pressed.KeyJ || pressed.Attack) { if (P.atk) P.atkQueued = true; else startAttack(); }
    if (pressed.KeyQ) startSpecial();
  }
  updateAttack(dt);
  updateSpecial(dt);

  // jump
  if (canAct && (pressed.Space || pressed.Jump) && !P.cast) {
    if (P.swim) { P.vy = 9.5; P.swim = false; P.swimCd = 0.45; audio.play('jump'); P.grounded = false; }
    else if (P.grounded || P.coyote > 0) {
      P.vy = 11.8; P.grounded = false; P.coyote = 0; P.jumps = 1; audio.play('jump');
      particles.burst(P.pos.x, P.pos.y + 0.1, P.pos.z, 6, 2.5, 0xffffff, 0.3, 0.4, 0);
    } else if (P.jumps < 2) {
      P.vy = 10.8; P.jumps = 2; audio.play('jump2');
      fx.ring(P.pos.x, P.pos.y + 0.1, P.pos.z, 1.6, 0xbdf3ff, 0.35);
      particles.burst(P.pos.x, P.pos.y + 0.2, P.pos.z, 14, 4, 0xbdf3ff, 0.35, 0.5, 0);
    }
  }
  const jumpHeld = canAct && (keys.Space || touch.jump);
  P.glide = jumpHeld && !P.grounded && !P.swim && P.vy < -1.5 && P.airT > 0.3 && P.stamina > 3 && !P.atk && !P.cast;

  // horizontal velocity
  let spd = P.swim ? 3.8 : P.sprinting ? 10.5 : 5.6;
  if (P.atk) spd *= 0.3;
  if (P.cast) spd = 0;
  let tvx = dx * spd, tvz = dz * spd;
  if (P.glide) {
    if (moving) P.yaw = lerpAngle(P.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt * 2.4));
    tvx = Math.sin(P.yaw) * 13.5; tvz = Math.cos(P.yaw) * 13.5;
  } else if (moving && !P.atk && !P.cast && P.hurtT <= 0) {
    P.yaw = lerpAngle(P.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt * 15));
  }
  if (P.hurtT > 0) { P.vel.multiplyScalar(Math.exp(-dt * 3)); }
  else if (P.atk) {
    P.vel.x = lerp(P.vel.x, tvx, 1 - Math.exp(-dt * 7)); P.vel.z = lerp(P.vel.z, tvz, 1 - Math.exp(-dt * 7));
  } else {
    const acc = P.grounded ? 16 : P.glide ? 3.5 : 5.5;
    const k = 1 - Math.exp(-acc * dt);
    P.vel.x = lerp(P.vel.x, tvx, k); P.vel.z = lerp(P.vel.z, tvz, k);
  }

  // move with slope / wall tests
  const sx = P.vel.x * dt, sz = P.vel.z * dt;
  const tryMove = (mx, mz) => {
    const nx = P.pos.x + mx, nz = P.pos.z + mz;
    const dist = Math.hypot(mx, mz);
    if (dist < 1e-6) return true;
    const g = world.groundAt(nx, nz, P.pos.y);
    const rise = g - P.pos.y;
    if (rise > dist * 1.3 + (P.grounded ? 0.06 : 0.3)) return false;
    if (Math.hypot(nx, nz) > 350) return false;
    P.pos.x = nx; P.pos.z = nz;
    return true;
  };
  if (!tryMove(sx, sz)) { if (!tryMove(sx, 0)) tryMove(0, sz); }
  world.colliders.resolve(P.pos, 0.42);
  for (const n of npcs) {
    const ddx = P.pos.x - n.pos.x, ddz = P.pos.z - n.pos.z, dd = Math.hypot(ddx, ddz);
    if (dd < 0.9) { P.pos.x = n.pos.x + (ddx / (dd || 1)) * 0.9; P.pos.z = n.pos.z + (ddz / (dd || 1)) * 0.9; }
  }

  // vertical
  const yPrev = P.pos.y;
  const terrainH = world.heightAt(P.pos.x, P.pos.z);
  const g0 = world.groundAt(P.pos.x, P.pos.z, yPrev);
  const onPlat = g0 > terrainH + 0.01;
  const deep = !onPlat && terrainH < -0.8;
  const wasSwim = P.swim;
  if (deep && P.swimCd <= 0 && P.pos.y < 0.5) P.swim = true;
  else if (!deep) P.swim = false;
  if (P.swim) {
    if (!wasSwim) { audio.play('splash'); particles.burst(P.pos.x, 0.2, P.pos.z, 20, 5, 0xbfeaff, 0.4, 0.6, 9); fx.ring(P.pos.x, 0.05, P.pos.z, 2.4, 0xffffff, 0.6); }
    P.vy = 0; P.pos.y = lerp(P.pos.y, -0.38, 1 - Math.exp(-dt * 10)); P.grounded = false; P.jumps = 0; P.glide = false; P.airT = 0;
    if (Math.hypot(P.vel.x, P.vel.z) > 0.8 && Math.random() < dt * 10)
      particles.emit(P.pos.x + (Math.random() - 0.5), 0.05, P.pos.z + (Math.random() - 0.5), 0, 1.5, 0, 0.6, 0.3, 0xffffff, 3, 1);
  } else {
    if (!P.grounded) {
      if (P.glide) {
        P.vy += (-2.4 - P.vy) * (1 - Math.exp(-dt * 5));
        P.stamina -= 8 * dt; P.stRegen = 1.0;
        if (Math.random() < dt * 40)
          particles.emit(P.pos.x + (Math.random() - 0.5) * 2.4, P.pos.y + 1.7, P.pos.z + (Math.random() - 0.5) * 2.4, 0, -0.5, 0, 0.7, 0.3, 0xcff6ff, 0, 1);
      } else P.vy = Math.max(-46, P.vy - 32 * dt);
      P.pos.y += P.vy * dt;
      P.airT += dt;
    }
    const g = world.groundAt(P.pos.x, P.pos.z, yPrev);
    if (P.pos.y <= g + 0.001 && P.vy <= 0.0001) {
      if (!P.grounded && P.airT > 0.12) {
        if (P.vy < -9) {
          audio.play('land');
          particles.burst(P.pos.x, g + 0.1, P.pos.z, 10, 3.5, 0xffffff, 0.35, 0.5, 2);
          if (P.vy < -22) shake(0.25);
        }
        if (g < 0.1 && terrainH < 0.2) { audio.play('splash'); particles.burst(P.pos.x, 0.1, P.pos.z, 16, 5, 0xbfeaff, 0.4, 0.6, 9); }
      }
      P.pos.y = g; P.vy = 0; P.grounded = true; P.jumps = 0; P.airT = 0; P.glide = false;
    } else if (P.grounded) {
      if (P.pos.y - g < 0.45) P.pos.y = g;
      else { P.grounded = false; P.jumps = 1; P.coyote = 0.1; P.airT = 0; }
    }
  }
  if (P.pos.y < -60) { P.pos.set(0, world.heightAt(0, 16), 16); P.vy = 0; }

  // footsteps / dust / wade splashes
  const hsp = Math.hypot(P.vel.x, P.vel.z);
  if (P.grounded && hsp > 1) {
    P.stepD += hsp * dt;
    if (P.stepD > (P.sprinting ? 3.2 : 2.4)) { P.stepD = 0; audio.play('step'); }
    P.dustT -= dt;
    if (P.dustT <= 0 && P.sprinting) {
      P.dustT = 0.07;
      particles.emit(P.pos.x, P.pos.y + 0.1, P.pos.z, (Math.random() - 0.5), 0.8, (Math.random() - 0.5), 0.5, 0.35, 0xffffff, -0.5, 1);
    }
    if (P.pos.y < 0.4 && terrainH < 0.3 && Math.random() < dt * 12)
      particles.emit(P.pos.x + (Math.random() - 0.5) * 0.6, 0.1, P.pos.z + (Math.random() - 0.5) * 0.6, 0, 2.5, 0, 0.5, 0.3, 0xcff0ff, 8, 1);
  }

  // character
  const fwdx = Math.sin(P.yaw), fwdz = Math.cos(P.yaw);
  P.lf = P.vel.x * fwdx + P.vel.z * fwdz;
  P.ls = P.vel.x * fwdz - P.vel.z * fwdx;
  char.setSwordInHand(!!P.atk || !!P.cast || P.swordT > 0);
  char.animate(dt, {
    speed: hsp > 0.4 ? hsp / 9 : 0, air: !P.grounded && !P.swim, vy: P.vy, glide: P.glide, swim: P.swim,
    atk: P.atk ? { t: P.atk.t / P.atk.dur, idx: P.atk.idx } : null, cast: !!P.cast, hurt: P.hurtT > 0, lf: P.lf, ls: P.ls,
  });
  char.root.position.set(P.pos.x, P.pos.y + (P.cast ? 0.5 + Math.sin(P.cast.t * 6) * 0.1 : 0), P.pos.z);
  char.root.rotation.y = P.yaw;
  // invuln blink
  char.root.visible = !(P.invuln > 0 && P.hurtT <= 0 && Math.floor(G.t * 20) % 2 === 0 && P.invuln < 1.0 && false);

  // energy slowly fills with time outside combat
  P.energy = Math.min(100, P.energy + dt * 0.4);

  // world shards
  for (let i = 0; i < world.shards.length; i++) {
    const s = world.shards[i];
    if (s.taken) continue;
    const ddx = s.x - P.pos.x, ddz = s.z - P.pos.z;
    if (ddx * ddx + ddz * ddz < 2.6 * 2.6 && Math.abs(s.y - (P.pos.y + 0.9)) < 2.6) {
      s.taken = true; P.collected++; P.wallet++;
      P.energy = Math.min(100, P.energy + 10);
      audio.play('pickup');
      particles.burst(s.x, s.y, s.z, 30, 6, 0xffe27a, 0.5, 0.9, 1);
      fx.ring(s.x, s.y, s.z, 2.2, 0xffe27a, 0.5);
      toast(`获得星屑碎片  ${P.collected} / ${world.shards.length}`, 'gold');
      checkQuest();
      lastQKey = '';
    }
  }
}

// ------------------------------------------------------------------ interaction
function interact() {
  if (D.open) { advanceDialog(); return; }
  if (G.cine || P.dead) return;
  const n = nearestNPC();
  if (n) {
    n.yaw = Math.atan2(P.pos.x - n.pos.x, P.pos.z - n.pos.z);
    P.yaw = Math.atan2(n.pos.x - P.pos.x, n.pos.z - P.pos.z);
    openDialog(n.def.name, n.def.lines(), n.def.done, n);
  }
}

// ------------------------------------------------------------------ ending
let fwT = 0;
function startEnding() {
  G.cine = { t: 0, shown: false };
  $('prompt').classList.add('hidden');
  audio.play('quest');
  flashScreen(0.8);
}
function updateCine(dt) {
  const c = G.cine;
  c.t += dt;
  const tr = world.greatTree.position;
  const ang = c.t * 0.18 + 1.0;
  const r = 34 - Math.min(c.t, 8) * 0.9;
  const target = tmpV.set(tr.x, tr.y + 22, tr.z);
  camera.position.set(tr.x + Math.cos(ang) * r, tr.y + 10 + c.t * 0.9, tr.z + Math.sin(ang) * r);
  camera.lookAt(target);
  cam.target.set(P.pos.x, P.pos.y + 1.5, P.pos.z);
  fwT -= dt;
  if (fwT <= 0) {
    fwT = 0.25 + Math.random() * 0.25;
    const col = new THREE.Color().setHSL(Math.random(), 0.9, 0.7);
    const fxp = tr.x + (Math.random() - 0.5) * 60, fzp = tr.z + (Math.random() - 0.5) * 60, fyp = tr.y + 28 + Math.random() * 18;
    particles.burst(fxp, fyp, fzp, 70, 15, col, 0.9, 1.8, 3);
    particles.burst(fxp, fyp, fzp, 25, 8, 0xffffff, 0.6, 1.4, 3);
    if (Math.random() < 0.5) audio.play('special');
  }
  for (let i = 0; i < 2; i++)
    particles.emit(tr.x + (Math.random() - 0.5) * 30, tr.y + 30 + Math.random() * 6, tr.z + (Math.random() - 0.5) * 30, 0, -2, 0, 4, 0.5, 0xffc4dc, 0, 0.1);
  if (c.t > 9 && !c.shown) {
    c.shown = true;
    $('endtxt').innerHTML = `星屑碎片 ${P.collected} / ${world.shards.length}　·　击败史莱姆 ${P.kills}<br>樱花飘落的季节，愿你的旅途永远灿烂。<br>—— 星屑物语 · 樱之境 ——`;
    $('ending').classList.add('show');
  }
}
$('endBtn').addEventListener('click', () => {
  $('ending').classList.remove('show');
  G.cine = null;
  Q.stage = 5; lastQKey = ''; renderQuest();
  toast('自由探索模式已开启', 'big');
  P.energy = 100;
});

// ------------------------------------------------------------------ camera
function updateCamera(dt) {
  const head = P.swim ? 0.6 : 1.55;
  const tgt = tmpV.set(P.pos.x, P.pos.y + head + (P.cast ? 0.5 : 0), P.pos.z);
  const k = 1 - Math.exp(-dt * 22);
  cam.target.lerp(tgt, k);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const b = camBasis();
  let dist = cam.dist + (P.glide ? 2.5 : 0);
  const dirx = -b.fx * cp, diry = sp, dirz = -b.fz * cp;
  // keep camera above the ground
  let use = dist;
  for (let s = 1; s <= 8; s++) {
    const d = (dist * s) / 8;
    const x = cam.target.x + dirx * d, y = cam.target.y + diry * d, z = cam.target.z + dirz * d;
    if (y < world.heightAt(x, z) + 0.45) { use = Math.max(1.2, d - dist / 8); break; }
  }
  cam.dist2 = lerp(cam.dist2 ?? use, use, use < (cam.dist2 ?? use) ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 4));
  const d = cam.dist2;
  const sh = 0.55 * Math.min(1, d / 4);
  camera.position.set(cam.target.x + dirx * d + b.rx * sh, cam.target.y + diry * d, cam.target.z + dirz * d + b.rz * sh);
  const gh = world.heightAt(camera.position.x, camera.position.z);
  if (camera.position.y < gh + 0.35) camera.position.y = gh + 0.35;
  camera.lookAt(cam.target.x + b.rx * sh * 0.8, cam.target.y + 0.1, cam.target.z + b.rz * sh * 0.8);
  // fov kick
  const tf = 55 + (P.sprinting ? 9 : 0) + (P.glide ? 10 : 0) + (P.cast ? -8 : 0);
  cam.fov = lerp(cam.fov, tf, 1 - Math.exp(-dt * 5));
  if (Math.abs(camera.fov - cam.fov) > 0.05) { camera.fov = cam.fov; camera.updateProjectionMatrix(); resize_uScale(); }
  // shake
  if (G.shakeAmt > 0.001) {
    camera.position.x += (Math.random() - 0.5) * G.shakeAmt;
    camera.position.y += (Math.random() - 0.5) * G.shakeAmt;
    camera.position.z += (Math.random() - 0.5) * G.shakeAmt;
    G.shakeAmt *= Math.exp(-dt * 9);
  }
}
function resize_uScale() { pointUniforms.uScale.value = (window.innerHeight * PR) / (2 * Math.tan((camera.fov * Math.PI) / 360)); }

// ------------------------------------------------------------------ HUD
let hudT = 0;
function updateHUD(dt) {
  hudT -= dt;
  bannerT -= dt;
  if (bannerT < 0) $('banner').classList.remove('show');
  if (hudT > 0) return;
  hudT = 0.06;
  $('hpfill').style.width = (P.hp / P.maxHp) * 100 + '%';
  $('hpnum').textContent = Math.ceil(P.hp) + '/' + P.maxHp;
  $('stfill').style.width = P.stamina + '%';
  $('stfill').style.filter = P.exhausted ? 'grayscale(.8)' : '';
  $('enfill').style.width = P.energy + '%';
  $('ennum').textContent = P.energy >= 60 ? 'Q!' : Math.floor(P.energy) + '%';
  $('shards').textContent = `${P.wallet}  (${P.collected}/${world.shards.length})`;
  $('clock').textContent = dayNight.clock;
  const reg = world.regionAt(P.pos.x, P.pos.z);
  $('region').textContent = reg.name;
  if (reg.name !== lastRegion) { lastRegion = reg.name; if (G.state === 'play') showBanner(reg.name, reg.en.toUpperCase()); }
  renderQuest();
  // prompt
  const n = nearestNPC();
  if (!D.open && n && !G.cine && !P.dead) {
    $('prompt').classList.remove('hidden');
    $('ptxt').textContent = '交谈 · ' + n.def.name;
  } else $('prompt').classList.add('hidden');
  // boss
  const king = enemies.find((e) => e.king && !e.dead);
  const showBoss = king && Math.hypot(king.pos.x - P.pos.x, king.pos.z - P.pos.z) < 32;
  $('boss').classList.toggle('hidden', !showBoss);
  if (showBoss) $('bossfill').style.width = (king.hp / king.maxHp) * 100 + '%';
  $('under').style.opacity = camera.position.y < -0.05 ? 1 : 0;
  // dialog text
  if (D.open) $('dtext').textContent = D.lines[D.i].slice(0, Math.floor(D.chars));
}
function drawMinimap() {
  const S = 400, R = 110, m = S / (2 * R);
  const c = mmCtx;
  const b = camBasis();
  const px = P.pos.x, pz = P.pos.z;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#8fd0e8'; c.fillRect(0, 0, S, S);
  c.setTransform(m * b.rx, -m * b.fx, m * b.rz, -m * b.fz, S / 2 - m * (px * b.rx + pz * b.rz), S / 2 + m * (px * b.fx + pz * b.fz));
  c.drawImage(mapBase, -400, -400, 800, 800);
  c.setTransform(1, 0, 0, 1, 0, 0);
  const sc = (x, z) => [S / 2 + m * ((x - px) * b.rx + (z - pz) * b.rz), S / 2 - m * ((x - px) * b.fx + (z - pz) * b.fz)];
  const inR = (x, y) => Math.hypot(x - S / 2, y - S / 2) < S / 2 - 8;
  for (const s of world.shards) {
    if (s.taken) continue;
    const [x, y] = sc(s.x, s.z);
    if (!inR(x, y)) continue;
    c.fillStyle = '#ffd030'; c.strokeStyle = '#fff'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x, y - 7); c.lineTo(x + 5, y); c.lineTo(x, y + 7); c.lineTo(x - 5, y); c.closePath(); c.fill(); c.stroke();
  }
  for (const e of enemies) {
    if (e.dead) continue;
    const [x, y] = sc(e.pos.x, e.pos.z);
    if (!inR(x, y)) continue;
    c.fillStyle = e.king ? '#9a3cff' : '#ff4f6f'; c.strokeStyle = '#fff'; c.lineWidth = 2;
    c.beginPath(); c.arc(x, y, e.king ? 9 : 5, 0, 7); c.fill(); c.stroke();
  }
  for (const n of npcs) {
    const [x, y] = sc(n.pos.x, n.pos.z);
    if (!inR(x, y)) continue;
    c.fillStyle = '#ffb0d0'; c.strokeStyle = '#fff'; c.lineWidth = 2.5;
    c.beginPath(); c.arc(x, y, 6, 0, 7); c.fill(); c.stroke();
  }
  // quest target
  const q = questInfo();
  if (q.target) {
    let [x, y] = sc(q.target.x, q.target.z);
    const dx = x - S / 2, dy = y - S / 2, d = Math.hypot(dx, dy), lim = S / 2 - 16;
    const pulse = 1 + Math.sin(G.t * 5) * 0.15;
    if (d > lim) { x = S / 2 + (dx / d) * lim; y = S / 2 + (dy / d) * lim; }
    c.save(); c.translate(x, y); c.scale(pulse, pulse);
    c.fillStyle = '#ff5f9a'; c.strokeStyle = '#fff'; c.lineWidth = 3;
    c.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 6 : 13, a = (i / 10) * 6.283 - 1.57; c.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    c.closePath(); c.fill(); c.stroke(); c.restore();
  }
  // player arrow
  const fdx = Math.sin(P.yaw), fdz = Math.cos(P.yaw);
  const ax = fdx * b.rx + fdz * b.rz, ay = -(fdx * b.fx + fdz * b.fz);
  c.save(); c.translate(S / 2, S / 2); c.rotate(Math.atan2(ax, -ay));
  c.fillStyle = '#fff'; c.strokeStyle = '#d4557f'; c.lineWidth = 4;
  c.beginPath(); c.moveTo(0, -15); c.lineTo(10, 11); c.lineTo(0, 5); c.lineTo(-10, 11); c.closePath(); c.stroke(); c.fill(); c.restore();
}

// ------------------------------------------------------------------ input
function requestLock() {
  if (isTouch || G.noLock) return;
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => { G.noLock = true; }); } catch (e) { G.noLock = true; }
}
document.addEventListener('pointerlockchange', () => {
  const was = G.locked;
  G.locked = document.pointerLockElement === canvas;
  if (was && !G.locked && G.state === 'play' && !G.cine) { G.paused = true; $('pause').classList.remove('hidden'); }
  if (G.locked) { G.paused = false; $('pause').classList.add('hidden'); }
});
document.addEventListener('pointerlockerror', () => { G.noLock = true; });
$('pause').addEventListener('click', () => { G.paused = false; $('pause').classList.add('hidden'); requestLock(); });

window.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
  if (!e.repeat) pressed[e.code] = true;
  keys[e.code] = true;
  if (G.state !== 'play') return;
  if (e.repeat) return;
  if (e.code === 'KeyE') interact();
  if ((e.code === 'Space' || e.code === 'Enter') && D.open) advanceDialog();
  if (e.code === 'KeyH') $('help').classList.toggle('hidden');
  if (e.code === 'KeyM') { audio.setMuted(!audio.muted); toast(audio.muted ? '已静音' : '声音已开启'); }
  if (e.code === 'KeyB') { G.bloomOn = !G.bloomOn; bloom.enabled = G.bloomOn; toast('泛光：' + (G.bloomOn ? '开' : '关')); }
  if (e.code === 'KeyP') { G.paused = !G.paused; $('pause').classList.toggle('hidden', !G.paused); if (document.pointerLockElement) document.exitPointerLock(); }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (G.state !== 'play') return;
  audio.start();
  if (G.cine) return;
  if (D.open) { advanceDialog(); return; }
  if (e.button === 2) { drag = { x: e.clientX, y: e.clientY, right: true }; return; }
  if (e.button === 0) {
    if (!G.locked && !G.noLock && !isTouch) { requestLock(); drag = { x: e.clientX, y: e.clientY, moved: 0 }; return; }
    if (G.locked) pressed.Attack = true;
    else drag = { x: e.clientX, y: e.clientY, moved: 0 };
  }
});
window.addEventListener('mouseup', (e) => {
  if (drag && !drag.right && drag.moved < 6 && e.button === 0 && G.state === 'play' && !G.locked) pressed.Attack = true;
  drag = null;
});
window.addEventListener('mousemove', (e) => {
  if (G.state !== 'play' || G.cine) return;
  if (G.locked) { cam.yaw -= e.movementX * 0.0024; cam.pitch = clamp(cam.pitch + e.movementY * 0.0024, -0.3, 1.3); }
  else if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.right) drag.moved += Math.abs(dx) + Math.abs(dy);
    cam.yaw -= dx * 0.005; cam.pitch = clamp(cam.pitch + dy * 0.005, -0.3, 1.3);
  }
});
window.addEventListener('wheel', (e) => { cam.dist = clamp(cam.dist + Math.sign(e.deltaY) * 0.8, 3, 14); }, { passive: true });

// touch controls
if (isTouch) {
  $('touch').classList.remove('hidden');
  const stick = $('stick'), knob = $('knob');
  let sid = null;
  const setStick = (e) => {
    const r = stick.getBoundingClientRect();
    let x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    const l = Math.hypot(x, y), m = 55;
    if (l > m) { x = (x / l) * m; y = (y / l) * m; }
    knob.style.transform = `translate(${x}px,${y}px)`;
    touch.x = x / m; touch.y = -y / m;
  };
  stick.addEventListener('pointerdown', (e) => { sid = e.pointerId; stick.setPointerCapture(sid); setStick(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === sid) setStick(e); });
  const endStick = (e) => { if (e.pointerId === sid) { sid = null; touch.x = touch.y = 0; knob.style.transform = ''; } };
  stick.addEventListener('pointerup', endStick); stick.addEventListener('pointercancel', endStick);
  const btn = (id, down, up) => {
    const el = $(id);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); audio.start(); down(); });
    const u = () => up && up();
    el.addEventListener('pointerup', u); el.addEventListener('pointercancel', u); el.addEventListener('pointerleave', u);
  };
  btn('tbAtk', () => { pressed.Attack = true; });
  btn('tbJump', () => { pressed.Jump = true; touch.jump = true; }, () => { touch.jump = false; });
  btn('tbSpr', () => { touch.sprint = true; }, () => { touch.sprint = false; });
  btn('tbSp', () => { pressed.KeyQ = true; });
  btn('tbE', () => { interact(); });
  let cid = null, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { cid = e.pointerId; lx = e.clientX; ly = e.clientY; if (D.open) advanceDialog(); } });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && e.pointerId === cid) {
      cam.yaw -= (e.clientX - lx) * 0.006; cam.pitch = clamp(cam.pitch + (e.clientY - ly) * 0.006, -0.3, 1.3);
      lx = e.clientX; ly = e.clientY;
    }
  });
  canvas.addEventListener('pointerup', (e) => { if (e.pointerId === cid) cid = null; });
}
$('dialog').addEventListener('click', () => advanceDialog());

// ------------------------------------------------------------------ main update
const wind = new THREE.Vector3(1.4, 0, 0.5);
let spawnCheck = 0;

function updateWorldFX(dt) {
  dayNight.update(dt, G.timeScale);
  if (keys.BracketRight) dayNight.hour = (dayNight.hour + dt * 2) % 24;
  if (keys.BracketLeft) dayNight.hour = (dayNight.hour - dt * 2 + 24) % 24;
  dayNight.follow(camera, P.pos);
  world.update(dt, G.t, camera, P.pos, dayNight.night, dayNight.sun.position.clone().sub(dayNight.sun.target.position).normalize());
  clouds.update(dt, camera.position, dayNight.night);
  const day = 1 - dayNight.night;
  const sak = Math.exp(-Math.pow(Math.hypot(P.pos.x - POI.shrine.x, P.pos.z - POI.shrine.z) / 110, 2));
  petals.update(dt, G.t, camera.position, wind, clamp(0.12 + sak * 0.9, 0, 1) * (day > 0.1 ? 1 : 0.3));
  petals.mat.color.setScalar(0.35 + 0.65 * day);
  fireflies.update(dt, G.t, P.pos, world.heightAt, dayNight.night);
  fx.update(dt);
  particles.update(dt);
  audio.update(dayNight.night);
}

function updateEnemies(dt) {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const far = Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z);
    e.group.visible = far < 190;
    if (far > 190 && !e.dead && e.state !== 'hop') { continue; }
    const alive = e.update(dt, G.t);
    if (!alive || e.removed) enemies.splice(i, 1);
  }
  for (let i = respawns.length - 1; i >= 0; i--) {
    const r = respawns[i];
    r.t -= dt;
    if (r.t <= 0) {
      if (r.king) {
        spawnSlime(POI.ruins.x + 8, POI.ruins.z + 8, 'king');
        respawns.splice(i, 1);
        continue;
      }
      const sp = world.slimeSpots[Math.floor(Math.random() * world.slimeSpots.length)];
      if (Math.hypot(sp.x - P.pos.x, sp.z - P.pos.z) > 70) { spawnSlime(sp.x, sp.z); respawns.splice(i, 1); }
      else r.t = 5;
    }
  }
}

function update(dt) {
  G.t += dt; TIME.value += dt;
  if (net.api) { net.api.clock = G.t; net.tick(P, G, dt); }
  wind.x = 1.4 + Math.sin(G.t * 0.1) * 0.8; wind.z = 0.5 + Math.cos(G.t * 0.13) * 0.5;
  if (D.open) {
    D.chars += dt * 38;
    D.blip -= dt;
    if (D.blip <= 0 && D.chars < D.lines[D.i].length) { D.blip = 0.07; audio.play('blip'); }
  }
  if (G.cine) updateCine(dt);
  updatePlayer(dt);
  if (!G.cine) updateCamera(dt);
  updateEnemies(dt);
  updateDrops(dt);
  updateNPCs(dt);
  updateWorldFX(dt);
  updateHUD(dt);
  drawMinimap();
  for (const k in pressed) pressed[k] = false;
}

function updateTitle(dt) {
  G.t += dt; TIME.value += dt;
  if (net.api) { net.api.clock = G.t; net.tick(P, G, dt); } // 标题页连线时也要收放状态、让旅伴动起来
  cam.yaw += dt * 0.09;
  cam.pitch = 0.16; cam.dist2 = undefined;
  char.animate(dt, { speed: 0 });
  char.root.position.copy(P.pos);
  char.root.rotation.y = P.yaw;
  const b = camBasis();
  cam.target.set(P.pos.x, P.pos.y + 1.5, P.pos.z);
  camera.position.set(cam.target.x - b.fx * 6.4 + b.rx * 1.2, cam.target.y + 0.3, cam.target.z - b.fz * 6.4 + b.rz * 1.2);
  camera.lookAt(cam.target.x + b.rx * 1.0, cam.target.y + 0.1, cam.target.z + b.rz * 1.0);
  updateNPCs(dt);
  updateWorldFX(dt);
  for (const e of enemies) e.group.visible = false;
}

// ------------------------------------------------------------------ boot
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (G.state === 'loading') return;
  if (G.hitstop > 0) { G.hitstop -= dt; dt *= 0.06; }
  if (G.state === 'title') updateTitle(dt);
  else if (!G.paused) update(dt);
  composer.render();
}

async function boot() {
  const setProg = (p, t) => { $('lfill').style.width = p * 100 + '%'; $('ltxt').textContent = t; };
  setProg(0.02, '点亮天空…');
  await new Promise((r) => setTimeout(r, 30));
  dayNight = new DayNight(scene);
  clouds = new CloudField(scene);
  world = await createWorld(scene, (p, t) => setProg(0.05 + p * 0.85, t));
  setProg(0.92, '召唤村民与史莱姆…');
  await new Promise((r) => setTimeout(r, 10));
  particles = new Particles(scene);
  petals = new Petals(scene);
  fireflies = new Fireflies(scene);
  fx = new FX(scene);
  enemyCtx.world = world; enemyCtx.particles = particles; enemyCtx.audio = audio; enemyCtx.fx = fx; enemyCtx.camera = camera;

  P.pos.y = world.heightAt(P.pos.x, P.pos.z);
  char = buildCharacter({ sword: true, glider: true });
  scene.add(char.root);
  char.root.position.copy(P.pos);
  spawnNPCs();
  for (const s of world.slimeSpots) spawnSlime(s.x, s.z);
  spawnSlime(POI.ruins.x + 8, POI.ruins.z + 8, 'king');

  // altar light beam (visible while the wish quest is active)
  const beamTex = canvasTex(4, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, '#ffd0e8'); g.addColorStop(0.6, '#5a2a46'); g.addColorStop(1, '#000');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.8, 90, 16, 1, true), new THREE.MeshBasicMaterial({ map: beamTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  beam.position.set(world.altar.x, world.heightAt(world.altar.x, world.altar.z) + 45, world.altar.z);
  beam.renderOrder = 3;
  scene.add(beam);
  const oldUpdate = world.update;
  world.update = (...a) => { oldUpdate(...a); beam.visible = Q.stage === 4; beam.rotation.y += 0.01; };

  mapBase = world.bakeMap(512);
  mmCtx = $('minimap').getContext('2d');
  mmCtx.imageSmoothingQuality = 'high';
  renderQuest();
  setProg(1, '准备就绪！');
  await new Promise((r) => setTimeout(r, 250));
  $('loading').classList.add('hidden');
  $('title').classList.remove('hidden');
  G.state = 'title';
  netInit(); // 标题页就要能连线，勿等到开始冒险
  mpSync();
  if (isTouch) $('keys').classList.add('hidden');
  // warm up shaders
  composer.render();
}

// ------------------------------------------------------------------ 多人联机 UI
const NET_TXT = { off: '未连线', connecting: '连接中…', online: '联机中', lost: '重连中…' };
const DEFAULT_SRV = net.url;
let netCount = 0;
function srvUrl(v) {
  if (!v) return DEFAULT_SRV;
  let s = /^wss?:\/\//i.test(v) ? v : ((location.protocol === 'https:' ? 'wss://' : 'ws://') + v.replace(/^\w+:\/\//, ''));
  s = s.replace(/\/+$/, '');
  if (s.split('/').length <= 3) s += '/ws'; // 只填了 host:port 时补端点路径
  return s;
}
let chatHidden = true;
let MP_HINT_DEFAULT = '';
// 联机状态需在标题页与游戏内都可见：曾在标题页无任何反馈，导致“点了没反应”的误判
function mpSync() {
  const playing = G.state === 'play' || G.state === 'cine';
  const active = !!net.profile && net.state !== 'off';
  $('netbar').classList.toggle('hidden', !(playing && active));
  if (playing) { $('mpBox').classList.toggle('hidden', active); return; }
  const btn = $('joinBtn'), hint = $('mpHint');
  if (active) {
    btn.textContent = net.state === 'online' ? '已联机 ✓' : '连线中…';
    hint.innerHTML = net.state === 'online'
      ? '<b>已连线 · 在线 ' + netCount + ' 人</b>　点「开始冒险」进入世界即可与旅伴同行'
      : '正在连接 <b>' + net.url.replace(/^wss?:\/\//, '') + '</b>…　久候未连上请检查端口与安全组';
  } else { btn.textContent = '连线同行'; hint.innerHTML = MP_HINT_DEFAULT; }
}
function netInit() {
  if (net.api) return;
  MP_HINT_DEFAULT = $('mpHint').innerHTML;
  net.init({
    scene, clock: G.t,
    buildCharacter: buildCharacter,
    groundAt: (x, z, f) => world.groundAt(x, z, f),
    onNetState: (s, count) => {
      netCount = count || 0;
      $('nstat').textContent = NET_TXT[s] || s;
      $('nstat').style.color = s === 'online' ? '#2e9a5f' : s === 'connecting' || s === 'lost' ? '#c07a20' : '#7a5aa8';
      $('nonline').textContent = s === 'online' ? '在线 ' + count : '';
      mpSync();
    },
    onChat: (name, m, self) => pushChat((self ? '我' : name) + '：' + m),
    onPeerJoin: (name) => toast(name + ' 来到了樱之境', ''),
    onPeerLeave: (name) => toast(name + ' 离开了', ''),
    onNetErr: (code) => toast(code === 'full' ? '分线已满，正在重试…' : code === 'rate' ? '发送太快，被暂时限制' : '联机异常：' + code, 'gold'),
  });
  const url = new URLSearchParams(location.search).get('srv');
  const nameIn = $('nameIn'), srvIn = $('srvIn');
  nameIn.value = localStorage.getItem('aw.net.name') || ('旅人' + Math.floor(Math.random() * 900 + 100));
  srvIn.value = url || localStorage.getItem('aw.net.srv') || '';
  $('joinBtn').addEventListener('click', () => {
    audio.start();
    const n = nameIn.value.trim().slice(0, 16) || '旅人';
    const s = srvIn.value.trim();
    localStorage.setItem('aw.net.name', n);
    localStorage.setItem('aw.net.srv', s);
    net.url = srvUrl(s);
    net.connect(n, null);
    mpSync();
  });
  $('leaveBtn').addEventListener('click', () => { net.disconnect(); mpSync(); });
  const chat = $('chat'), inp = $('chatIn');
  const showChat = (v) => { chatHidden = !v; chat.classList.toggle('hidden', chatHidden); if (v) inp.focus(); else inp.blur(); };
  $('chToggle').addEventListener('click', () => showChat(chatHidden));
  $('chSend').addEventListener('click', () => sendChat());
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') sendChat(); });
  inp.addEventListener('keyup', (e) => e.stopPropagation());
  function sendChat() {
    const v = inp.value.trim();
    if (!v) return;
    inp.value = '';
    if (net.state === 'online') { net.chat(v); pushChat('我：' + v); }
    else pushChat('（未连线，消息未发送）');
  }
  if (isTouch) $('netbar').style.top = 'auto', $('netbar').style.bottom = '120px';
}
function pushChat(line) {
  const box = $('chat');
  if (!box) return;
  const div = document.createElement('div');
  div.textContent = line;
  box.appendChild(div);
  while (box.children.length > 7) box.removeChild(box.firstChild);
  if (chatHidden && $('hud')) { box.classList.remove('hidden'); clearTimeout(pushChat.t); pushChat.t = setTimeout(() => { if (document.activeElement !== $('chatIn')) box.classList.add('hidden'); }, 6000); }
}

$('startBtn').addEventListener('click', () => {
  audio.start();
  netInit();
  $('title').classList.add('hidden');
  $('hud').classList.remove('hidden');
  G.state = 'play';
  mpSync(); // 须在 state 切到 play 之后，否则联机状态条不会显示
  cam.yaw = 0; cam.pitch = 0.3; cam.dist2 = undefined;
  cam.target.set(P.pos.x, P.pos.y + 1.5, P.pos.z);
  requestLock();
  lastRegion = '';
  toast('WASD 移动 · 空格跳跃 · 左键攻击 · E 互动', '');
  setTimeout(() => toast('先去和村长阿澄聊聊吧（头顶有 ! 的人）', 'gold'), 1200);
  lastQKey = '';
});

window.__game = { P, Q, G, cam, net, get world() { return world; }, get enemies() { return enemies; }, get npcs() { return npcs; }, THREE, scene, camera, renderer, get char() { return char; }, get dayNight() { return dayNight; }, setStage, startEnding };
boot().catch((e) => { console.error(e); $('ltxt').textContent = '加载失败：' + e.message; });
requestAnimationFrame(frame);
