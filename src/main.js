import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { clamp, lerp, lerpAngle, sstep, makeRng } from './noise.js';
import { TIME, canvasTex, toon } from './materials.js';
import { DayNight, CloudField } from './sky.js';
import { createWorld, POI, SEA } from './world.js';
import { buildCharacter } from './character.js';
import { Particles, Petals, Fireflies, Rain, Meteors, pointUniforms } from './particles.js';
import { AudioSys } from './audio.js';
import { FX } from './fx.js';
import { Slime } from './enemies.js';
import { net, EMOTES, iconSprite, textSprite, defaultLook, GESTURE_DUR } from './net.js';

const $ = (id) => document.getElementById(id);
// ?touch=1 可强制启用触摸布局，便于在桌面端验证移动端控件
const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0 || new URLSearchParams(location.search).has('touch');

// ------------------------------------------------------------------ renderer
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
const PR = Math.min(window.devicePixelRatio || 1, 1.75);

// ------------------------------------------------------------------ 舒适与画质设置
// 晕动症是这个项目的硬约束：镜头震动与「冲刺时视野被拉开」都能单独归零，
// 并且必须在标题页就调得动 —— 都进世界了才想起有开关，人已经晕了。
const SET_DEF = { shake: 0.3, kick: 1, fov: 55, look: 1, steer: 1, petals: 1, fire: 1, vol: 0.7, res: 1, shadow: 1, bloom: 1, weather: 1 };
function loadSet() {
  const o = { ...SET_DEF };
  try {
    const j = JSON.parse(localStorage.getItem('aw.settings') || '{}');
    for (const k in o) if (j && typeof j[k] === 'number' && isFinite(j[k])) o[k] = j[k];
  } catch (e) {} // 隐私模式/脏数据：用默认值，绝不因此开不了游戏
  return o;
}
const SET = loadSet();
const saveSet = () => { try { localStorage.setItem('aw.settings', JSON.stringify(SET)); } catch (e) {} };
const pxr = () => Math.max(0.55, PR * SET.res);

renderer.setPixelRatio(pxr());
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
  renderer.setPixelRatio(pxr());
  renderer.setSize(w, h, false);
  composer.setPixelRatio(pxr());
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointUniforms.uScale.value = (h * pxr()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
window.addEventListener('resize', () => { resize(); layoutTouchHud(); });
resize();

// ------------------------------------------------------------------ state
const G = { state: 'loading', t: 0, hitstop: 0, shakeAmt: 0, locked: false, noLock: false, cursor: false, cine: null, timeScale: 1, bloomOn: true };
// 光标模式：指针自由（可点 UI/聊天），靠屏幕边缘缓慢转向；转向速率在此平滑，避免突兀
const steer = { yaw: 0, pitch: 0, curYaw: 0, curPitch: 0, overUi: false };
const audio = new AudioSys();
const P = {
  pos: new THREE.Vector3(0, 0, 16), vel: new THREE.Vector3(), vy: 0, yaw: Math.PI,
  grounded: true, airT: 0, jumps: 0, glide: false, swim: false, swimCd: 0, coyote: 0,
  hp: 100, maxHp: 100, stamina: 100, exhausted: false, stRegen: 0, energy: 0,
  atk: null, combo: 0, comboT: 0, cast: null, hurtT: 0, invuln: 0, dead: false, deadT: 0, swordT: 0, dmgBonus: 0,
  jumpV: 11.8, jump2V: 10.8, maxJumps: 2, glideDrain: 8, gest: null,
  shot: null, shotDmg: 2, shotRange: 20, chargeT: 0.85,
  sprinting: false, stepD: 0, dustT: 0, lf: 0, ls: 0, wallet: 0, collected: 0, kills: 0, atkQueued: false,
};
const Q = { stage: 0, k0: 0, kingDead: false, upgraded: false };
const cam = { yaw: 0.0, pitch: 0.32, dist: 7.6, target: new THREE.Vector3(), pos: new THREE.Vector3(), fov: 55 };

const keys = {}, pressed = {};
const touch = { x: 0, y: 0, sprint: false, jump: false, shot: false };

let world, dayNight, clouds, char, particles, petals, fireflies, fx, rain, meteors;
let npcs = [], enemies = [], drops = [], respawns = [], deer = [], shots = [], shrooms = null;
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
  // 阶段推进要经服务端认可才生效：本地跳格、回退都会被视为无效（防改存档瞬移剧情）
  if (net.world && net.world.stage < s) net.quest({ st: s });
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
    done: () => { if (!Q.upgraded && P.wallet >= 10) { P.wallet -= 10; Q.upgraded = true; applyGrowth(); net.quest({ up: 1 }); audio.play('special'); toast('攻击力提升！（伤害 +1）', 'gold'); flashScreen(0.3); } },
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
function hurtPlayer(dmg, from, by) {
  if (P.invuln > 0 || P.dead || P.cast) return;
  dmg = Math.max(1, Math.round(dmg) || 1); // 网络来源的数值必须兜底，否则 NaN 会污染血量
  P.hp -= dmg;
  P.invuln = 1.0; P.hurtT = 0.3;
  const dx = P.pos.x - from.x, dz = P.pos.z - from.z, l = Math.hypot(dx, dz) || 1;
  P.vel.set((dx / l) * 10, 0, (dz / l) * 10);
  if (P.grounded) { P.vy = 5.5; P.grounded = false; }
  P.atk = null;
  cancelCharge();
  char.flash = 1;
  audio.play('hurt');
  dmgNumber(playerHead(), '-' + dmg, 'me');
  $('vig').style.opacity = 1; setTimeout(() => ($('vig').style.opacity = 0), 220);
  shake(0.35); G.hitstop = 0.06;
  if (P.hp <= 0) killPlayer(by);
}
function killPlayer(by) {
  P.hp = 0; P.dead = true; P.deadT = 0; P.atk = null; P.glide = false;
  $('fade').style.transition = 'opacity 1.2s'; $('fade').style.opacity = 1;
  toast(by ? '在与 ' + by + ' 的切磋中倒下了……对方并没有见血，只是扶你起来' : '你倒下了……', '');
}
function respawnPlayer() {
  P.dead = false; P.hp = P.maxHp; P.pos.set(0, world.heightAt(0, 16), 16); P.vel.set(0, 0, 0); P.vy = 0; P.invuln = 2;
  P.stamina = 100; P.exhausted = false; P.yaw = Math.PI;
  for (const e of enemies) if (!e.dead) e.state = 'idle';
  net.died();
  $('fade').style.opacity = 0;
  toast('在村庄的长椅上醒来了……', '');
}

function startAttack() {
  if (P.atk || P.cast || P.shot || P.dead || D.open || G.cine) return;
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
          if (e.king) net.kingHit(dmg);
          else tideReport(dmg, e);
          P.energy = Math.min(100, P.energy + (died ? 10 : 6));
          any = true;
        }
      }
    }
    if (pvpOn && net.state === 'online') {
      // 切磋：仅对同样开启切磋的旅伴生效，伤害由服务端校验后回传，双方各自扣血
      for (const r of net.remotes.values()) {
        if (!r.pvp) continue;
        const rx = r.gx - P.pos.x, rz = r.gz - P.pos.z, d = Math.hypot(rx, rz);
        if (d > 2.9 || Math.abs(r.gy - P.pos.y) > 3) continue;
        const dot = (rx * fx_ + rz * fz_) / (d || 1);
        if (dot <= 0.2 && d >= 1.3) continue;
        const crit = Math.random() < 0.15;
        net.hit(r.id, Math.max(1, (1 + (a.idx === 2 ? 1 : 0) + P.dmgBonus) * (crit ? 2 : 1)));
        any = true;
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
        if (e.king) net.kingHit(3 + P.dmgBonus);
        else tideReport(3 + P.dmgBonus, e);
      }
    }
  }
  if (c.t > 0.95) P.cast = null;
}

// ------------------------------------------------------------------ 星屑弹（远程攻击）
// 长按 R 把星屑聚到剑尖，松手才放出去。这里刻意不震屏、不顿帧：远程攻击的反馈
// 全部交给光弹本身与它的尾迹，镜头保持静止——玩得久了不晕比打击感更值钱。
const SHOT_SPEED = 30, SHOT_CD = 0.32, SHOT_HITS = [1, 1, 2, 3];
let boltGeo = null, boltMat = null, shotCdT = 0;
// 弹体共用一份几何与材质，从不 dispose：一秒最多几发，建一次就够用到关服
function boltMesh() {
  if (!boltGeo) {
    boltGeo = new THREE.OctahedronGeometry(0.26, 0);
    boltGeo.scale(1, 1.5, 1);
    boltMat = toon(0xe8f8ff, { emissive: 0x7fd8ff, emissiveIntensity: 1.4 });
  }
  const m = new THREE.Mesh(boltGeo, boltMat);
  m.castShadow = false;
  return m;
}
// 索敌取「视线方向上最近」而不是「距离最近」：只认镜头前方约 57° 以内的目标，
// 身后有怪不会让你突然转体一百八十度，瞄准的手感仍然是自己的
function shotTarget(yaw, range) {
  const ax = Math.sin(yaw), az = Math.cos(yaw);
  let best = null, score = Infinity;
  for (const e of enemies) {
    if (e.dead) continue;
    const ex = e.pos.x - P.pos.x, ez = e.pos.z - P.pos.z, d = Math.hypot(ex, ez);
    if (d > range || d < 0.5) continue;
    const dot = (ex * ax + ez * az) / d;
    if (dot < 0.55) continue;
    const s = d * (1.7 - dot);
    if (s < score) { score = s; best = e; }
  }
  return best;
}
function startCharge() {
  if (P.shot || P.atk || P.cast || P.dead || P.swim || D.open || G.cine) return;
  if (G.t < shotCdT || P.stamina < 8) { audio.play('blip'); return; }
  P.shot = { t: 0, c: 0 };
  $('charge').classList.remove('hidden');
  audio.play('charge');
}
function cancelCharge() {
  if (!P.shot) return;
  P.shot = null;
  $('charge').classList.add('hidden');
}
function releaseCharge() {
  if (!P.shot) return;
  const c = P.shot.c;
  cancelCharge();
  fireShot(c);
}
function fireShot(c) {
  const full = c > 0.9;
  const cost = Math.min(6 + 6 * c, P.stamina);
  if (cost < 3) { audio.play('blip'); return; }   // 蓄到一半被冲刺掏空：给一声，别让人对着空气按住不放
  P.stamina = Math.max(0, P.stamina - cost);
  shotCdT = G.t + SHOT_CD;
  let yaw = P.yaw;
  const tg = shotTarget(yaw, P.shotRange);
  if (tg) {
    yaw = Math.atan2(tg.pos.x - P.pos.x, tg.pos.z - P.pos.z);
    P.yaw = yaw;
  }
  const crit = Math.random() < 0.1 + 0.2 * c;
  const dmg = Math.max(1, (P.shotDmg + Math.round(c * 2)) * (crit ? 2 : 1));
  const m = boltMesh();
  m.position.set(P.pos.x + Math.sin(yaw) * 0.62, P.pos.y + 1.15, P.pos.z + Math.cos(yaw) * 0.62);
  m.scale.setScalar(full ? 1.35 : 0.85);
  scene.add(m);
  shots.push({
    m, vx: Math.sin(yaw) * SHOT_SPEED, vz: Math.cos(yaw) * SHOT_SPEED, tg: tg || null,
    dmg, crit, life: P.shotRange / SHOT_SPEED + 0.2, done: [], maxHits: full ? SHOT_HITS[GR.gear.shot] : 1,
  });
  P.swordT = 3;
  particles.burst(m.position.x, m.position.y, m.position.z, full ? 24 : 10, 4.5, full ? 0xffe8a0 : 0xbfeaff, 0.3, 0.45, 1);
  if (full) {
    fx.ring(P.pos.x, P.pos.y + 1.05, P.pos.z, 2.6, 0xffe8a0, 0.4);
    particles.burst(P.pos.x + Math.sin(yaw) * 0.6, P.pos.y + 1.15, P.pos.z + Math.cos(yaw) * 0.6, 14, 7, 0xffd45e, 0.25, 0.4, 1);
  }
  audio.play(full ? 'shotFull' : 'shot');
  net.bolt(c, yaw);
}
// 同伴放的那一发：只借服务端的坐标与朝向演一遍，伤害仍然归放的人自己算
function peerBolt(d) {
  const r = net.remotes.get(d.id);
  if (!r) return;
  const full = (d.c || 0) > 0.9;
  const m = boltMesh();
  m.position.set(r.gx + Math.sin(d.Y) * 0.62, r.gy + 1.15, r.gz + Math.cos(d.Y) * 0.62);
  m.scale.setScalar(full ? 1.35 : 0.85);
  scene.add(m);
  shots.push({
    m, vx: Math.sin(d.Y) * SHOT_SPEED, vz: Math.cos(d.Y) * SHOT_SPEED, tg: null,
    dmg: 0, crit: false, life: 20 / SHOT_SPEED + 0.2, done: [], maxHits: 0, peer: true,
  });
  particles.burst(m.position.x, m.position.y, m.position.z, full ? 14 : 6, 3.5, full ? 0xffe8a0 : 0xbfeaff, 0.3, 0.4, 1);
  audio.play('shotFar');
}
function boltHit(b, e) {
  const ey = e.pos.y + 0.62 * e.scale;
  const dx = e.pos.x - b.m.position.x, dz = e.pos.z - b.m.position.z;
  const dy = ey - b.m.position.y, d = Math.hypot(dx, dy, dz) || 1;
  b.done.push(e);
  const died = e.hit(b.dmg, dx / d, dz / d);
  dmgNumber(tmpV.set(e.pos.x, ey + 0.8 * e.scale, e.pos.z), b.dmg, b.crit ? 'crit' : '');
  particles.burst(e.pos.x, ey, e.pos.z, 16, 6, b.crit ? 0xffe8a0 : 0xdff4ff, 0.3, 0.5, 2);
  fx.ring(e.pos.x, ey, e.pos.z, 1.5, 0xbfeaff, 0.3);
  if (e.king) net.kingHit(b.dmg);
  else tideReport(b.dmg, e);
  P.energy = Math.min(100, P.energy + (died ? 8 : 4));
  audio.play('shotHit');
}
function updateShots(dt) {
  for (let i = shots.length - 1; i >= 0; i--) {
    const b = shots[i];
    b.life -= dt;
    // 软追踪：每帧只把速度掰向目标一点点，看得见的直线弹道不会被改成自瞄
    if (b.tg && !b.tg.dead) {
      const tx = b.tg.pos.x - b.m.position.x, tz = b.tg.pos.z - b.m.position.z, d = Math.hypot(tx, tz);
      if (d < P.shotRange + 6) {
        const k = 1 - Math.exp(-dt * 3.4);
        b.vx = lerp(b.vx, (tx / d) * SHOT_SPEED, k);
        b.vz = lerp(b.vz, (tz / d) * SHOT_SPEED, k);
      } else b.tg = null;
    }
    b.m.position.x += b.vx * dt;
    b.m.position.z += b.vz * dt;
    b.m.position.y -= 1.6 * dt; // 极轻的下坠：远弹会擦到地面，而不是永远平飞
    b.m.rotation.y += dt * 7;
    b.m.rotation.x += dt * 5;
    particles.emit(b.m.position.x, b.m.position.y, b.m.position.z, (Math.random() - 0.5) * 0.7, 0.4, (Math.random() - 0.5) * 0.7,
      0.35, 0.22, b.maxHits > 1 ? 0xffe8a0 : 0xaee6ff, 0, 1.2);
    let gone = b.life <= 0;
    if (!gone && b.m.position.y < world.heightAt(b.m.position.x, b.m.position.z) + 0.12) {
      particles.burst(b.m.position.x, b.m.position.y, b.m.position.z, 8, 3, 0xdff4ff, 0.25, 0.4, 4);
      gone = true;
    }
    if (!gone && !b.peer) {
      for (const e of enemies) {
        if (e.dead || b.done.includes(e)) continue;
        const ey = e.pos.y + 0.62 * e.scale;
        const dx = e.pos.x - b.m.position.x, dy = ey - b.m.position.y, dz = e.pos.z - b.m.position.z;
        if (Math.hypot(dx, dy, dz) > e.radius + 0.55) continue;
        boltHit(b, e);
        if (b.done.length >= b.maxHits) { gone = true; break; }
      }
    }
    if (gone) {
      scene.remove(b.m);
      shots.splice(i, 1);
    }
  }
}

enemyCtx.scene = scene;
enemyCtx.player = P;
enemyCtx.hurtPlayer = hurtPlayer;
enemyCtx.canHurt = () => P.invuln <= 0 && !P.dead;
enemyCtx.shake = shake;
enemyCtx.holdKill = (e) => e.king && net.state === 'online' && !!net.world && net.world.kingAlive;
enemyCtx.onKill = (e) => {
  P.kills++;
  P.energy = Math.min(100, P.energy + 8);
  const n = e.king ? 10 : 1 + (Math.random() < 0.6 ? 1 : 0);
  for (let i = 0; i < n; i++) spawnDrop('shard', e.pos.x, e.pos.y + 0.8, e.pos.z);
  if (Math.random() < (e.king ? 1 : 0.3)) for (let i = 0; i < (e.king ? 3 : 1); i++) spawnDrop('heart', e.pos.x, e.pos.y + 0.8, e.pos.z);
  if (e.king) {
    Q.kingDead = true;
    markFeat('feat_king');
    toast('史莱姆王被击败了！', 'big');
    flashScreen(0.5); shake(0.7);
    respawns.push({ t: 240, king: true });
  } else if (!e.tide) respawns.push({ t: 40 + Math.random() * 20 }); // 潮水自会按波次补，不必再排一次常规刷新
  checkQuest();
};

// ------------------------------------------------------------------ player update
function camBasis() {
  const fx_ = -Math.sin(cam.yaw), fz_ = -Math.cos(cam.yaw);
  return { fx: fx_, fz: fz_, rx: Math.cos(cam.yaw), rz: -Math.sin(cam.yaw) };
}

function updatePlayer(dt) {
  if (P.gest) { P.gest.t += dt; if (P.gest.t >= (GESTURE_DUR[P.gest.k] || 1.4)) P.gest = null; }
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
    // 蓄力是「按住」的：键盘 R 与触屏按钮共用一份，松手立刻放出去
    if (keys.KeyR || touch.shot) { if (!P.shot) startCharge(); }
    else if (P.shot) releaseCharge();
  } else if (P.shot) cancelCharge();
  if (P.shot) {
    P.shot.t += dt;
    const c = Math.min(1, P.shot.t / P.chargeT);
    P.shot.c = c;
    const b0 = camBasis();
    P.yaw = lerpAngle(P.yaw, Math.atan2(b0.fx, b0.fz), 1 - Math.exp(-dt * 7));
    const el = $('chargefill');
    el.style.width = (c * 100).toFixed(1) + '%';
    $('charge').classList.toggle('full', c > 0.9);
    if (c >= 1 && !P.shot.sparks) {
      P.shot.sparks = true;
      fx.ring(P.pos.x, P.pos.y + 1.1, P.pos.z, 1.9, 0xffe8a0, 0.45);
    }
  }
  updateAttack(dt);
  updateSpecial(dt);

  // jump
  if (canAct && (pressed.Space || pressed.Jump) && !P.cast) {
    if (P.swim) { P.vy = 9.5; P.swim = false; P.swimCd = 0.45; audio.play('jump'); P.grounded = false; }
    else if (P.grounded || P.coyote > 0) {
      P.vy = P.jumpV; P.grounded = false; P.coyote = 0; P.jumps = 1; audio.play('jump');
      particles.burst(P.pos.x, P.pos.y + 0.1, P.pos.z, 6, 2.5, 0xffffff, 0.3, 0.4, 0);
    } else if (P.jumps < P.maxJumps) {
      P.vy = P.jump2V; P.jumps++; audio.play('jump2');
      fx.ring(P.pos.x, P.pos.y + 0.1, P.pos.z, 1.6, 0xbdf3ff, 0.35);
      particles.burst(P.pos.x, P.pos.y + 0.2, P.pos.z, 14, 4, 0xbdf3ff, 0.35, 0.5, 0);
    }
  }
  const jumpHeld = canAct && (keys.Space || touch.jump);
  P.glide = jumpHeld && !P.grounded && !P.swim && P.vy < -1.5 && P.airT > 0.3 && P.stamina > 3 && !P.atk && !P.cast;

  // horizontal velocity
  let spd = P.swim ? 3.8 : P.sprinting ? 10.5 : 5.6;
  if (P.atk) spd *= 0.3;
  if (P.shot) spd *= 0.62;
  if (P.cast) spd = 0;
  let tvx = dx * spd, tvz = dz * spd;
  if (P.glide) {
    if (moving) P.yaw = lerpAngle(P.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt * 2.4));
    tvx = Math.sin(P.yaw) * 13.5; tvz = Math.cos(P.yaw) * 13.5;
  } else if (moving && !P.atk && !P.cast && !P.shot && P.hurtT <= 0) {
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
        P.stamina -= P.glideDrain * WX_GLIDE_MUL[playWeather()] * dt; P.stRegen = 1.0;
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
    gesture: P.gest && !P.swim && !P.glide && !P.atk && !P.cast ? P.gest.k : null,
    gestureAmt: P.gest ? Math.sin(Math.PI * Math.min(1, P.gest.t / (GESTURE_DUR[P.gest.k] || 1.4))) : 0,
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
    // 同一条分线上被别人（或上一次的自己）采过的碎片不再存在：服务端按整数坐标去重
    if (net.state === 'online' && net.shardTaken(s.x, s.z)) { s.taken = true; continue; }
    const ddx = s.x - P.pos.x, ddz = s.z - P.pos.z;
    if (ddx * ddx + ddz * ddz < 2.6 * 2.6 && Math.abs(s.y - (P.pos.y + 0.9)) < 2.6) {
      s.taken = true; P.collected++; P.wallet++;
      const sg = WX_SHARD_GEM[playWeather()];   // 这条线的天好，星屑就多给一点：有身份时由世界那样加，单机时记在这台设备上
      net.take(s.x, s.z);
      if (!serverGrowth()) gainGem(sg);
      P.energy = Math.min(100, P.energy + 10);
      audio.play('pickup');
      particles.burst(s.x, s.y, s.z, 30, 6, 0xffe27a, 0.5, 0.9, 1);
      fx.ring(s.x, s.y, s.z, 2.2, 0xffe27a, 0.5);
      toast(`获得星屑碎片  ${P.collected} / ${world.shards.length}` + (sg > 1 ? '　·　' + WEATHER_NAME[playWeather()] + '里更润 ✦+' + sg : ''), 'gold');
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
    return;
  }
  boardInteract(); // 没有人在跟前说话时，E 用来读/写脚下的石碑
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
  // 愿望由服务端记账：同一条分线上的人能看到「已有 N 人在此许愿」
  const wg = WX_WISH_GEM[playWeather()];   // 流星夜多给两枚：联机时世界加，单机时记在这台设备上
  if (!serverGrowth()) gainGem(wg);
  net.quest({ st: 5, wi: (net.world ? net.world.wish + 1 : 1) });
  markFeat('feat_wish');
  if (wg > 0) {
    toast('流星夜的心愿被多听了一句：✦+' + wg, 'gold');
    fx.ring(P.pos.x, P.pos.y + 0.4, P.pos.z, 5, 0xffd45e, 0.9);
    particles.burst(P.pos.x, P.pos.y + 2, P.pos.z, 40, 8, 0xffd45e, 0.6, 1.2, 1);
  }
  toast('自由探索模式已开启', 'big');
  P.energy = 100;
});

// ------------------------------------------------------------------ 世界生机：分线天气 · 烟花 · 野生动物
// 天气属于脚下这条分线：谁在这儿就看见这儿的雨。联机时由服务端按时辰轮转、随快照下发，
// 客户端没有改天气的入口（否则总有人想替别人把太阳关掉）；单机时世界自己慢慢换。
// 设置里那个「分线天气」开关能把它整片归零成晴空——有人 just 想要安静，这条得说得上话。
const WEATHER_NAME = ['晴', '樱吹雪', '细雨', '薄雾', '流星夜'];
const WEATHER_TUNE = [
  { petal: 1, wind: 1, fire: 1, rain: 0, meteor: 0, fog: 560 },
  { petal: 2.4, wind: 1.9, fire: 1, rain: 0, meteor: 0, fog: 560 },
  { petal: 0.5, wind: 1.3, fire: 0.5, rain: 1, meteor: 0, fog: 380 },
  { petal: 0.8, wind: 0.5, fire: 0.8, rain: 0.16, meteor: 0, fog: 215 },
  { petal: 0.9, wind: 0.9, fire: 1.8, rain: 0, meteor: 1, fog: 640 },
];
const WX_KEYS = ['petal', 'wind', 'fire', 'rain', 'meteor', 'fog'];
const WX = { code: 0, petal: 1, wind: 1, fire: 1, rain: 0, meteor: 0, fog: 560, localT: 150, told: -1 };
const wwind = new THREE.Vector3();
const weatherCode = () => (SET.weather > 0.5 ? (net.state === 'online' && net.world ? clamp(net.world.weather | 0, 0, WEATHER_TUNE.length - 1) : WX.code) : 0);
// 天不只换风景，也换规则。这四个表与 server/weather.js 同口径（界面接线测试守着两边不许分叉）。
// 它们只看脚下这条线实际的天，不看「分线天气」那个开关——舒适开关管的是眼睛，不该改账本与手感。
const WX_SHARD_GEM = [1, 1, 2, 1, 1];
const WX_WISH_GEM = [0, 0, 0, 0, 2];
const WX_GLIDE_MUL = [1, 0.55, 1, 1, 1];
const WX_DEER_FLEE = [9, 9, 9, 3.2, 9];
const WX_HINT = ['寻常的一天', '花瓣托住滑翔，能飞得更久', '雨里的星屑更润：一枚给两撇星尘', '白鹿不怕人了，跟着它走能捡到东西', '此刻在树下许愿，世界多给两枚星尘'];
const playWeather = () => (net.state === 'online' && net.world ? clamp(net.world.weather | 0, 0, WEATHER_TUNE.length - 1) : WX.code);
function updateWeather(dt) {
  if (net.state !== 'online' || !net.world) {   // 没有服务端下发就自己换：单机也该看得见一场雨
    WX.localT -= dt;
    if (WX.localT <= 0) { WX.localT = 150 + Math.random() * 160; WX.code = 1 + Math.floor(Math.random() * (WEATHER_TUNE.length - 1)); }
  }
  const t = WEATHER_TUNE[weatherCode()];
  const k = 1 - Math.exp(-dt * 0.5);            // 变天要慢慢来，一帧到位的切换最伤眼睛
  for (const key of WX_KEYS) WX[key] += (t[key] - WX[key]) * k;
  if (scene.fog) scene.fog.far = WX.fog;
  const c = weatherCode();
  if (WX.told >= 0 && c !== WX.told && G.state === 'play' && !G.cine) toast(WEATHER_NAME[c] + '落到了这条分线上：' + WX_HINT[c], '');
  WX.told = c;
}

// 烟花是给同线所有人看的：本地先响，服务端八秒一朵替你把关，别让有人把天空点成爆竹厂
const FW_COL = [0xffd45e, 0xff8fb8, 0x9fe8ff, 0xb8ff9a, 0xffb06f, 0xd8b8ff];
let fwSeen = 0;    // 放过几朵：合奏那一声到底响没响，测试要能看见
function launchFirework(x, z) {
  fwSeen++;
  const y = world.heightAt(x, z) + 14 + Math.random() * 10;
  const col = FW_COL[(Math.random() * FW_COL.length) | 0];
  particles.burst(x, y, z, 110, 7.5, col, 0.55, 1.5, 4.5);
  particles.burst(x, y, z, 20, 2.2, 0xffffff, 0.3, 0.7, 2);
  fx.ring(x, y, z, 9, col, 1);
  audio.play('firework');
}
let myFwT = -9;
function throwFirework() {
  if (G.cine || P.dead) return;
  if (G.t - myFwT < 2.5) return;   // 本地也上一道闸：连点只会把粒子池挤满，服务端那朵早被冷却掉了
  myFwT = G.t;
  launchFirework(P.pos.x + (Math.random() - 0.5) * 8, P.pos.z + (Math.random() - 0.5) * 8);
  if (net.firework(P.pos.x, P.pos.z)) toast('你点着一朵烟花，同伴也会看见', '');
  else toast('没连线，这朵烟花只照亮了你一个人', '');
}
function celebrate(n = 3) {
  for (let i = 0; i < n; i++) setTimeout(() => launchFirework(P.pos.x + (Math.random() - 0.5) * 40, P.pos.z + (Math.random() - 0.5) * 40), i * 360);
  if (net.state === 'online') net.firework(P.pos.x, P.pos.z);
}

// 白鹿与夜光菌不进任何人的账本：它们是这个世界自己的动静，纯单机也照样撞见。
// 鹿在清晨与黄昏出没，靠近就走开；菌子只在夜里亮起来，白天只是几把小伞。
function makeDeer(x, z) {
  const g = new THREE.Group();
  const hide = toon(0xf7f5ff), dark = toon(0xd6d2ea);
  const put = (geo, mat, px, py, pz, rot) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    g.add(m);
    return m;
  };
  put(new THREE.CapsuleGeometry(0.34, 0.85, 6, 12), hide, 0, 1.18, 0, [0, 0, Math.PI / 2]);
  put(new THREE.CapsuleGeometry(0.13, 0.5, 4, 8), hide, 0, 1.64, 0.6, [0.6, 0, 0]);
  put(new THREE.SphereGeometry(0.2, 12, 10), hide, 0, 1.88, 0.88);
  put(new THREE.SphereGeometry(0.07, 8, 6), dark, 0, 1.84, 1.06);
  for (const s of [1, -1]) {
    put(new THREE.ConeGeometry(0.05, 0.4, 5), hide, s * 0.13, 2.2, 0.82, [-0.35, 0, s * 0.35]);
    put(new THREE.ConeGeometry(0.035, 0.16, 5), hide, s * 0.24, 2.32, 0.78, [0, 0, s * 1.1]);
    put(new THREE.ConeGeometry(0.07, 0.16, 5), dark, s * 0.16, 2.06, 0.7, [0, 0, s * 0.5]);
  }
  const legs = [];
  for (const [sx, sz] of [[0.19, 0.36], [-0.19, 0.36], [0.19, -0.36], [-0.19, -0.36]]) legs.push(put(new THREE.CylinderGeometry(0.06, 0.045, 1.05, 6), dark, sx, 0.56, sz));
  g.position.set(x, world.heightAt(x, z), z);
  scene.add(g);
  return { root: g, legs, hx: x, hz: z, tx: x, tz: z, sp: 0, flee: 0, rest: Math.random() * 5 };
}
function spawnLife() {
  deer = [];
  for (const [home, n] of [[POI.forest, 2], [POI.meadow, 2]]) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283 + home.x * 0.01, r = 24 + i * 10;
      const x = home.x + Math.cos(a) * r, z = home.z + Math.sin(a) * r;
      const d = makeDeer(x, z);
      d.hx = x; d.hz = z;
      deer.push(d);
    }
  }
  const rng = makeRng(23);
  const n = 64;
  const mat = new THREE.MeshBasicMaterial({ color: 0x8ff2d0, transparent: true, opacity: 0.15, fog: true });
  const mesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.17, 0.3, 7), mat, n);
  mesh.frustumCulled = false;
  const dum = new THREE.Object3D();
  for (let i = 0; i < n; i++) {
    const a = rng() * 6.283, r = 20 + rng() * 74;
    const x = POI.forest.x + Math.cos(a) * r, z = POI.forest.z + Math.sin(a) * r;
    dum.position.set(x, world.heightAt(x, z) + 0.14, z);
    dum.rotation.set(0, rng() * 6.283, (rng() - 0.5) * 0.3);
    dum.scale.setScalar(0.7 + rng() * 0.9);
    dum.updateMatrix();
    mesh.setMatrixAt(i, dum.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  shrooms = { mesh, mat };
}
function nearestShard(x, z, r) {
  let best = null, bd = r;
  for (const s of world.shards) {
    if (s.taken || (net.state === 'online' && net.shardTaken(s.x, s.z))) continue;
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
function updateLife(dt) {
  const hour = dayNight.hour, night = dayNight.night, pw = playWeather();
  const fleeR = WX_DEER_FLEE[pw], guiding = fleeR < 5;   // 雾里鹿看不清人，也就不急着躲——顺便替人带路
  for (const d of deer) {
    const dx = d.root.position.x - P.pos.x, dz = d.root.position.z - P.pos.z, dist = Math.hypot(dx, dz);
    d.root.visible = dist < 80;
    if (!d.root.visible) continue;
    d.flee = dist < fleeR ? 2.4 : Math.max(0, d.flee - dt);
    d.guideT = Math.max(0, (d.guideT || 0) - dt);
    d.rest -= dt;
    if (d.flee > 0) { d.tx = d.root.position.x + (dx / (dist || 1)) * 26; d.tz = d.root.position.z + (dz / (dist || 1)) * 26; }
    else if (d.guideT > 0 && d.gx != null) { d.tx = d.gx; d.tz = d.gz; }
    else if (d.rest <= 0 || Math.hypot(d.tx - d.root.position.x, d.tz - d.root.position.z) < 2) {
      const s = guiding ? nearestShard(d.root.position.x, d.root.position.z, 70) : null;
      if (s) { d.gx = s.x; d.gz = s.z; d.guideT = 7; d.tx = s.x; d.tz = s.z; }
      else {
        const a = Math.random() * 6.283, r = 10 + Math.random() * 26;
        d.tx = d.hx + Math.cos(a) * r; d.tz = d.hz + Math.sin(a) * r;
        d.rest = 3 + Math.random() * 7;
      }
    }
    const mx = d.tx - d.root.position.x, mz = d.tz - d.root.position.z, md = Math.hypot(mx, mz);
    const want = night > 0.6 ? 0 : d.flee > 0 ? 7.5 : 2.1;
    if (md > 1.4 && want > 0) {
      d.root.position.x += (mx / md) * want * dt;
      d.root.position.z += (mz / md) * want * dt;
      d.root.rotation.y = lerpAngle(d.root.rotation.y, Math.atan2(mx, mz), 1 - Math.exp(-dt * 3));
      d.sp = want;
    } else d.sp = Math.max(0, d.sp - dt * 5);
    d.root.position.y = world.heightAt(d.root.position.x, d.root.position.z);
    for (let i = 0; i < 4; i++) d.legs[i].rotation.x = Math.sin(G.t * (1.6 + d.sp * 1.9) + i * 1.6) * Math.min(0.5, d.sp * 0.1);
  }
  if (shrooms) {
    const on = night > 0.35 ? (night - 0.35) / 0.65 : 0;
    shrooms.mat.opacity = 0.1 + on * 0.85;   // 白天的菌子只是淡到快看不见，而不是凭空消失
    shrooms.mesh.visible = on > 0.02;
  }
}

// ------------------------------------------------------------------ camera
function updateCamera(dt) {
  if (G.cursor) {
    // 边缘转向速率渐进（起停都平滑），指针停在界面控件上时不转
    const kk = 1 - Math.exp(-dt * 8);
    const ty = steer.overUi ? 0 : steer.yaw, tp = steer.overUi ? 0 : steer.pitch;
    steer.curYaw = lerp(steer.curYaw, ty, kk);
    steer.curPitch = lerp(steer.curPitch, tp, kk);
    if (Math.abs(steer.curYaw) > 0.004) cam.yaw -= steer.curYaw * dt;
    if (Math.abs(steer.curPitch) > 0.004) cam.pitch = clamp(cam.pitch + steer.curPitch * dt, -0.3, 1.3);
  }
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
  // fov kick：冲刺/滑翔时把视野拉开是爽点，但对容易晕的人是灾难，所以按设置缩放
  const tf = SET.fov + SET.kick * ((P.sprinting ? 9 : 0) + (P.glide ? 10 : 0) + (P.cast ? -8 : 0));
  cam.fov = lerp(cam.fov, tf, 1 - Math.exp(-dt * 5));
  if (Math.abs(camera.fov - cam.fov) > 0.05) { camera.fov = cam.fov; camera.updateProjectionMatrix(); resize_uScale(); }
  // shake
  if (G.shakeAmt > 0.001 && SET.shake > 0.01) {
    const amp = G.shakeAmt * SET.shake;
    camera.position.x += (Math.random() - 0.5) * amp;
    camera.position.y += (Math.random() - 0.5) * amp;
    camera.position.z += (Math.random() - 0.5) * amp;
  }
  if (G.shakeAmt > 0) G.shakeAmt *= Math.exp(-dt * 9);
}
function resize_uScale() { pointUniforms.uScale.value = (window.innerHeight * pxr()) / (2 * Math.tan((camera.fov * Math.PI) / 360)); }

// ------------------------------------------------------------------ 设置面板（舒适与画质）
const pct = (v) => Math.round(v * 100) + '%';
const SET_ROWS = [
  ['shake', '镜头震动', 0, 1, 0.05, pct, '受击与爆发时的画面抖动'],
  ['kick', '视野摆动', 0, 1.5, 0.1, pct, '冲刺、滑翔时把视野拉开'],
  ['fov', '基准视野', 45, 75, 1, (v) => Math.round(v) + '°', '越大越开阔，也越容易晕'],
  ['look', '鼠标灵敏度', 0.3, 2, 0.05, pct, '锁定指针时转视角的速度'],
  ['steer', '边缘转向', 0.3, 2, 0.05, pct, '光标模式贴住屏幕边缘转向'],
  ['petals', '花瓣密度', 0, 1.5, 0.1, pct, '樱吹雪的量'],
  ['fire', '萤火虫', 0, 1.5, 0.1, pct, '夜里浮空的光点'],
  ['res', '渲染精度', 0.55, 1.25, 0.05, pct, '画面卡就调低，省电省显卡'],
  ['vol', '音量', 0, 1, 0.05, pct, '音乐与音效'],
];
const SET_TOGGLES = [['shadow', '阴影'], ['bloom', '泛光'], ['weather', '分线天气']];
// 预设是「一次点到位」：有人不想读九行滑杆，只想知道按哪个
const SET_PRESETS = {
  sick: { shake: 0, kick: 0.25, fov: 62, look: 0.7, steer: 0.7, petals: 0.5, fire: 0.7 },
  lite: { res: 0.7, shadow: 0, bloom: 0, petals: 0.4, fire: 0.4 },
  def: { ...SET_DEF },
};
let setBuilt = false, setShown = false;
function applySet() {
  if (dayNight) dayNight.sun.castShadow = SET.shadow > 0.5;
  bloom.enabled = G.bloomOn && SET.bloom > 0.5;
  audio.setVol(SET.vol);
  cam.fov = camera.fov = SET.fov; // 标题页不跑镜头插值，得直接把基准视野定了
  camera.updateProjectionMatrix();
  resize(); // 视野与渲染精度都在这里生效
}
function setBadge(key, badge) {
  const row = SET_ROWS.find((r) => r[0] === key);
  badge.textContent = row ? row[5](SET[key]) : '';
}
function buildSetPanel() {
  if (setBuilt) return;
  setBuilt = true;
  const box = $('setRows');
  for (const [key, name, min, max, step, fmt, tip] of SET_ROWS) {
    const row = document.createElement('div');
    row.className = 'srow';
    const lb = document.createElement('label');
    lb.textContent = name;
    lb.title = tip;
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = SET[key];
    inp.dataset.key = key;
    const bd = document.createElement('b');
    bd.textContent = fmt(SET[key]);
    inp.addEventListener('input', () => {
      SET[key] = Number(inp.value);
      bd.textContent = fmt(SET[key]);
      saveSet();
      applySet();
    });
    inp.addEventListener('keydown', (e) => e.stopPropagation()); // 调滑杆不该触发游戏快捷键
    row.append(lb, inp, bd);
    box.appendChild(row);
  }
  const tg = document.createElement('div');
  tg.className = 'srow';
  const tl = document.createElement('label');
  tl.textContent = '开关';
  tg.appendChild(tl);
  for (const [key, name] of SET_TOGGLES) {
    const b = document.createElement('button');
    b.className = 'stog' + (SET[key] > 0.5 ? ' on' : '');
    b.textContent = name + '：' + (SET[key] > 0.5 ? '开' : '关');
    b.dataset.tog = key;
    b.addEventListener('click', () => {
      SET[key] = SET[key] > 0.5 ? 0 : 1;
      b.className = 'stog' + (SET[key] > 0.5 ? ' on' : '');
      b.textContent = name + '：' + (SET[key] > 0.5 ? '开' : '关');
      saveSet();
      applySet();
      audio.play('ui');
    });
    tg.appendChild(b);
  }
  box.appendChild(tg);
}
function syncSetPanel() {
  for (const inp of $('setRows').querySelectorAll('input[type=range]')) {
    inp.value = SET[inp.dataset.key];
    setBadge(inp.dataset.key, inp.nextElementSibling);
  }
  for (const b of $('setRows').querySelectorAll('[data-tog]')) {
    const key = b.dataset.tog, name = (SET_TOGGLES.find((t) => t[0] === key) || [])[1] || key;
    b.className = 'stog' + (SET[key] > 0.5 ? ' on' : '');
    b.textContent = name + '：' + (SET[key] > 0.5 ? '开' : '关');
  }
}
function setToggle(force) {
  setShown = force === undefined ? !setShown : !!force;
  const el = $('set');
  if (!el) return;
  el.classList.toggle('hidden', !setShown);
  if (setShown) { buildSetPanel(); syncSetPanel(); }
}
function setPreset(name) {
  const p = SET_PRESETS[name];
  if (!p) return;
  for (const k in p) if (k in SET) SET[k] = p[k];
  saveSet();
  applySet();
  syncSetPanel();
  toast(name === 'sick' ? '已切到「容易晕」：镜头不再抖动，视野摆动也收小了'
    : name === 'lite' ? '已切到「省电」：关掉阴影泛光、降低渲染精度' : '设置已回到默认', 'gold');
  audio.play('ui');
}
function settingsInit() {
  $('setBtn').addEventListener('click', () => { audio.start(); setToggle(); });
  $('setBarBtn').addEventListener('click', () => { audio.start(); setToggle(); });
  $('setClose').addEventListener('click', () => setToggle(false));
  for (const b of $('setPresets').querySelectorAll('[data-preset]')) b.addEventListener('click', () => setPreset(b.dataset.preset));
  applySet();
}

// ------------------------------------------------------------------ 旅人之书：星尘成长 · 景点图鉴 · 衣橱
// 星尘是这个世界给你的回执：采一枚碎片、和王交手、踏上没去过的地方，都会积下一枚。
// 有身份时余额与等级都记在世界那一边，纯单机时记在这台设备上；两边最后都汇进 applyGrowth()，
// 所以跳多高、滑多久、剑有多重，断线和连线上是同一套手感，不会分叉。
const GEAR_DEF = {
  vit: { name: '体魄', max: 3, cost: [4, 9, 16], desc: ['生命上限 125', '生命上限 150', '生命上限 175'] },
  jump: { name: '弹跳', max: 3, cost: [3, 8, 15], desc: ['起跳更有力', '空中的第二跳更有力', '落地前还能再跳一次'] },
  glide: { name: '滑翔', max: 3, cost: [3, 7, 13], desc: ['滑翔耗体力 -18%', '滑翔耗体力 -35%', '滑翔耗体力 -50%'] },
  dmg: { name: '剑伤', max: 3, cost: [5, 11, 20], desc: ['挥剑伤害 +1', '挥剑伤害 +2', '挥剑伤害 +3'] },
  shot: { name: '星射', max: 3, cost: [4, 10, 18], desc: ['星屑弹伤害 +1', '蓄力更快，满蓄可穿透两个目标', '伤害再 +1，满蓄可穿透三个目标'] },
};
const GEAR_KEYS = ['vit', 'jump', 'glide', 'dmg', 'shot'];
const GLIDE_MUL = [1, 0.82, 0.65, 0.5];
const STAMP_GEM_LOCAL = 2;
const GR = { gem: 0, gear: { vit: 0, jump: 0, glide: 0, dmg: 0, shot: 0 } };
const devLedger = { gem: 0, gear: { vit: 0, jump: 0, glide: 0, dmg: 0, shot: 0 } }; // 绑号那一次要上交的「设备旧账」快照
const COD = [];            // 设备上记下的去过之处；有身份时以世界那份为准
let growthMigrated = false, claimQuiet = false, spendWait = null, prevKingAlive = null, prevTideAlive = null;

function loadGrowth() {
  let j = null;
  try { j = JSON.parse(localStorage.getItem('aw.growth') || 'null'); } catch (e) {}
  if (!j || typeof j !== 'object') return;
  growthMigrated = !!j.mig;
  const gear = j.gear && typeof j.gear === 'object' ? j.gear : {};
  for (const k of GEAR_KEYS) {
    const lv = clamp(gear[k] | 0, 0, GEAR_DEF[k].max);
    GR.gear[k] = lv; devLedger.gear[k] = lv;
  }
  GR.gem = devLedger.gem = Math.max(0, j.gem | 0);
  if (Array.isArray(j.stamps)) for (const s of j.stamps) if (typeof s === 'string' && !COD.includes(s)) COD.push(s);
}
function saveGrowth() {
  try {
    localStorage.setItem('aw.growth', JSON.stringify({ gem: GR.gem, gear: GR.gear, stamps: COD, mig: growthMigrated ? 1 : 0 }));
  } catch (e) {}
}
const serverGrowth = () => net.state === 'online' && !!net.me?.a;
const gearSpec = () => net.gearSpec || GEAR_DEF;
const stampKeys = () => (serverGrowth() ? (net.prog?.codex?.stamps || []) : COD);
const hasStamp = (k) => stampKeys().includes(k);
const stampCount = () => stampKeys().length;

function applyGrowth() {
  const g = GR.gear;
  const oldMax = P.maxHp;
  P.maxHp = 100 + 25 * g.vit;
  if (P.maxHp > oldMax) P.hp = Math.min(P.maxHp, P.hp + (P.maxHp - oldMax)); // 升级当场就把多出来的血补给玩家
  P.hp = Math.min(P.hp, P.maxHp);
  P.jumpV = 11.8 + 0.7 * g.jump;
  P.jump2V = 10.8 + 0.9 * Math.max(0, g.jump - 1);
  P.maxJumps = 2 + (g.jump >= 3 ? 1 : 0);
  P.glideDrain = 8 * GLIDE_MUL[g.glide];
  P.dmgBonus = g.dmg + (Q.upgraded ? 1 : 0);
  P.shotDmg = 2 + g.shot;
  P.shotRange = 20 + 3 * g.shot;
  P.chargeT = 0.85 - 0.09 * g.shot;
}
function gainGem(n) {
  if (!(n > 0)) return;
  GR.gem += n;
  saveGrowth();
  if (bookShown && bookTab === 'gear') renderBook();
}
function levelUpGlow(k, lv) {
  const sp = gearSpec()[k] || GEAR_DEF[k];
  toast(sp.name + '升至第 ' + lv + ' 级：' + ((sp.desc && sp.desc[lv - 1]) || ''), 'gold');
  audio.play('level');
  flashScreen(0.2);
  fx.ring(P.pos.x, P.pos.y + 0.2, P.pos.z, 2.2, 0xffd45e, 0.5);
  particles.burst(P.pos.x, P.pos.y + 1, P.pos.z, 26, 4, 0xffd45e, 0.5, 0.8, 0);
}
function spendGrowth(k) {
  const sp = gearSpec()[k] || GEAR_DEF[k];
  const lv = GR.gear[k] | 0;
  const cost = sp.cost && sp.cost[lv];
  if (lv >= sp.max || cost == null) return;
  if (GR.gem < cost) { toast('星尘还差 ' + (cost - GR.gem) + ' 枚——采碎片、打卡、与王交手都会给', ''); audio.play('blip'); return; }
  if (serverGrowth()) { spendWait = { k, lv }; net.spend(k); } // 扣不扣得动，由记账的那边说了算
  else {
    GR.gem -= cost; GR.gear[k] = lv + 1;
    saveGrowth(); applyGrowth(); levelUpGlow(k, lv + 1);
  }
  renderBook();
}
// 世界把账本推回来时（welcome 全量 / pr 增量）：先对齐，再决定要不要庆祝
function syncGrowthFromServer(pr, quiet) {
  if (!pr) return;
  const before = GR.gear;
  const gear = pr.gear && typeof pr.gear === 'object' ? pr.gear : {};
  GR.gem = Math.max(0, pr.gem | 0);
  const spec = gearSpec();
  const next = {};
  for (const k of GEAR_KEYS) next[k] = clamp(gear[k] | 0, 0, (spec[k] || GEAR_DEF[k]).max);
  GR.gear = next;
  saveGrowth();
  applyGrowth();
  if (!quiet) for (const k of GEAR_KEYS) if (GR.gear[k] > (before[k] | 0)) levelUpGlow(k, GR.gear[k]);
  if (spendWait && !quiet) {
    if (GR.gear[spendWait.k] === spendWait.lv) { toast('这一步世界没有认：星尘不够，或已经练到顶', ''); audio.play('blip'); }
    spendWait = null;
  }
  renderBook();
}
// 第一次有身份时，把这台设备上攒下的星尘与等级认领过去；世界那边已经有账就让账本说话
function maybeClaimLedger() {
  if (!serverGrowth() || growthMigrated || !net.prog) return;
  const pr = net.prog;
  if ((pr.gem | 0) !== 0 || Object.keys(pr.gear || {}).length) { growthMigrated = true; saveGrowth(); return; }
  if (devLedger.gem > 0 || COD.length || GEAR_KEYS.some((k) => devLedger.gear[k] > 0)) {
    claimQuiet = true;
    net.claimGrowth(devLedger.gem, devLedger.gear, COD);
    growthMigrated = true;
    saveGrowth();
  }
}

// 景点与成就都写成「页」，图鉴只认键；键是稳定的，改名字、挪位置都不会让谁的旧页失效
const PLACE_KEYS = ['village', 'shrine', 'lake', 'peaks', 'forest', 'meadow', 'ruins', 'altar', 'pier', 'summit', 'isle1', 'isle2', 'isle3'];
const FEATS = [
  ['feat_king', '王座倾覆', '与同伴一起打倒了史莱姆王'],
  ['feat_shards', '满天星屑', '找齐了散落世间的每一枚碎片'],
  ['feat_wish', '树下之愿', '在樱花神树下发过一个愿'],
  ['feat_words', '第一句留言', '在石碑上刻下想对旅伴说的话'],
  ['feat_tide', '潮水退去', '和同伴一起压下了一波史莱姆潮'],
  ['feat_duet', '合奏', '和同伴在同一处做出同一个动作'],
  ['feat_traveller', '旅行家', '踏遍了图鉴上所有的位置'],
];
const FEAT_KEYS = FEATS.map((f) => f[0]);
function markCodex(key, name) {
  if (hasStamp(key)) return;
  if (!COD.includes(key)) COD.push(key);
  if (serverGrowth()) net.codex(key); // 世界记账后会用 pr 回灌，本地这份只在单机时算账
  else gainGem(STAMP_GEM_LOCAL);
  saveGrowth();
  if (name) { toast('✦ ' + name, 'gold'); audio.play('unlock'); }
  if (FEAT_KEYS.includes(key)) celebrate(key === 'feat_traveller' ? 5 : 3); // 每完成一件值得记住的事，天上就响一声
  if (key === 'feat_king' || PLACE_KEYS.includes(key)) checkTraveller();
  renderBook();
}
function markFeat(key) {
  const f = FEATS.find((x) => x[0] === key);
  if (f) markCodex(f[0], '成就 · ' + f[1]);
}
function checkTraveller() {
  if (PLACE_KEYS.every((k) => hasStamp(k))) markFeat('feat_traveller');
}
let STAMPS_CACHE = null, STAMPS_WORLD = null, stampT = 0;
function stampSpots() {
  if (!world) return [];
  if (STAMPS_CACHE && STAMPS_WORLD === world) return STAMPS_CACHE;
  const a = [];
  const reg = (key, p, name, line) => a.push({ key, name, line, x: p.x, z: p.z, r: 26 });
  reg('village', POI.village, '始源之村', '风车下第一缕炊烟');
  reg('shrine', POI.shrine, '樱花之丘', '神树落下的花瓣');
  reg('lake', POI.lake, '镜湖', '水面映着整座山');
  reg('peaks', POI.peaks, '雾岚山脉', '云从脚边跑过去');
  reg('forest', POI.forest, '低语之森', '树在讲很久以前的事');
  reg('meadow', POI.meadow, '繁花草甸', '风把花香推得很远');
  reg('ruins', POI.ruins, '古代遗迹', '石柱间还留着王的呼吸');
  a.push({ key: 'altar', name: '神树之下', line: '有人在这里许过愿', x: world.altar.x, z: world.altar.z, r: 15 });
  a.push({ key: 'pier', name: '湖心码头', line: '船缆在风里轻响', x: world.pier.x, z: world.pier.z, r: 13 });
  a.push({ key: 'summit', name: '雾岚之巅', line: '整个世界都在下面', x: world.peak.x, z: world.peak.z, r: 18 });
  const cn = ['一', '二', '三'];
  (world.islands || []).forEach((isl, i) => a.push({ key: 'isle' + (i + 1), name: '浮空岛 ' + (cn[i] || i + 1), line: '要飞起来才够得到的地方', x: isl.x, z: isl.z, r: Math.max(8, isl.r - 1) }));
  STAMPS_CACHE = a; STAMPS_WORLD = world;
  return a;
}
function updateStamps(dt) {
  stampT -= dt;
  if (stampT > 0) return;
  stampT = 0.4;
  for (const s of stampSpots()) {
    if (hasStamp(s.key)) continue;
    if (Math.hypot(P.pos.x - s.x, P.pos.z - s.z) < s.r) markCodex(s.key, '图鉴新页 · ' + s.name);
  }
  if (P.collected >= world.shards.length && world.shards.length) markFeat('feat_shards');
}

// 外观：颜色 + 发型 + 两件套饰，跟着账号走；同线的旅伴当场就能看见
const W_COLS = {
  hair: [0xff9ec8, 0x7fd4ff, 0xc49aff, 0xffc06a, 0x6affd4, 0xff7fa8, 0xf6f2ff, 0x8f6ad8],
  eye: [0x3fd3e8, 0xffb86f, 0x8be36a, 0xff7fa8, 0xffd36b, 0xa87bff, 0x6fd8ff],
  top: [0xfdfbff, 0xfff4e0, 0xf2e8ff, 0xffe9f2, 0xe8fff6, 0x2a3270],
  skirt: [0x2a3270, 0x274a6d, 0x3a2a60, 0x6d2a4a, 0x2a5a50, 0x8f2a4a],
  accent: [0xe03a4e, 0x3fa9e0, 0xb58cff, 0xffb86f, 0x40e0b0, 0xffd45e],
  scarf: [0xff9240, 0xff6fa8, 0x6fd8ff, 0xa8ff9a, 0xffd0e8, 0xffffff],
};
const W_COL_NAME = { hair: '发色', eye: '瞳色', top: '上衣', skirt: '裙子', accent: '饰色', scarf: '围巾' };
const W_STYLE = [['twin', '双马尾'], ['pony', '单马尾'], ['short', '短发'], ['long', '长发'], ['bun', '丸子头']];
const W_ACC = [['hat', '旅人帽', 1], ['apron', '水彩围裙', 3], ['ears', '狐耳', 6], ['staff', '星杖', 10], ['halo', '环光', 15]];
let LK = defaultLook('旅人');
function initLook(seed) {
  let s = null;
  try { s = JSON.parse(localStorage.getItem('aw.look') || 'null'); } catch (e) {}
  LK = (s && typeof s === 'object' && typeof s.hair === 'number') ? s : defaultLook(seed);
  if (typeof LK.style !== 'string') LK.style = 'twin';
  if (!Array.isArray(LK.acc)) LK.acc = [];
}
function saveLookLocal() {
  try { localStorage.setItem('aw.look', JSON.stringify(LK)); } catch (e) {}
}
function adoptLook(look) {
  if (!look || typeof look !== 'object') return;
  for (const k of Object.keys(W_COLS)) if (typeof look[k] === 'number') LK[k] = look[k];
  if (typeof look.style === 'string') LK.style = look.style;
  if (Array.isArray(look.acc)) LK.acc = look.acc.slice(0, 2);
  saveLookLocal();
  rebuildChar();
}
function setLookPart(part, val) {
  if (part === 'acc') {
    const need = (W_ACC.find((x) => x[0] === val) || [])[2] || 0;
    if (stampCount() < need) { toast('还差 ' + (need - stampCount()) + ' 页图鉴才能戴上「' + val + '」', ''); audio.play('blip'); return; }
    const i = LK.acc.indexOf(val);
    if (i >= 0) LK.acc.splice(i, 1);
    else if (LK.acc.length >= 2) { toast('身上最多戴两件套饰，先摘一件吧', ''); audio.play('blip'); return; }
    else LK.acc.push(val);
  } else LK[part] = val;
  saveLookLocal();
  rebuildChar();
  net.setLook(LK);
  renderBook();
  audio.play('ui');
}
function rebuildChar() {
  const old = char;
  char = buildCharacter({ ...LK, sword: true, glider: true });
  scene.add(char.root);
  char.root.position.copy(P.pos);
  char.root.rotation.y = P.yaw;
  if (old) {
    scene.remove(old.root);
    old.mats?.forEach?.((m) => m.dispose());
  }
}

// ---------------------------------------------------------------- 面板
let bookShown = false, bookTab = 'gear';
function mkEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function renderBook() {
  if (!bookShown) return;
  const body = $('bookBody');
  body.textContent = '';
  $('bookGem').textContent = '✦ 星尘 ' + GR.gem + ' 枚　·　图鉴 ' + stampCount() + ' 页　·　' +
    (serverGrowth() ? '由世界记账' : '记在这台设备上');
  if (bookTab === 'gear') {
    const spec = gearSpec();
    for (const k of GEAR_KEYS) {
      const sp = spec[k] || GEAR_DEF[k];
      const lv = GR.gear[k] | 0;
      const maxed = lv >= sp.max;
      const cost = sp.cost && sp.cost[lv];
      const row = mkEl('div', 'gearrow' + (maxed ? ' max' : ''));
      row.appendChild(mkEl('b', '', sp.name));
      const pips = mkEl('div', 'pips');
      for (let i = 0; i < sp.max; i++) pips.appendChild(mkEl('i', i < lv ? 'on' : ''));
      row.appendChild(pips);
      row.appendChild(mkEl('span', '', maxed ? '已练到顶：' + (sp.desc[sp.max - 1] || '') : '下一级 · ' + (sp.desc[lv] || '')));
      const b = mkEl('button', '', maxed ? '满级' : cost + ' ✦');
      b.title = sp.name + '：' + (sp.desc.join(' / '));
      b.disabled = maxed || GR.gem < cost;
      b.addEventListener('click', () => spendGrowth(k));
      row.appendChild(b);
      body.appendChild(row);
    }
    $('bookHint').textContent = serverGrowth()
      ? '星尘由世界替你保管，换一台设备登录还是这些。采一枚碎片得 1 星，刻一页景点得 2 星，与史莱姆王交手每跳得 4 星，和同伴压下一波史莱姆潮再得 5 星。'
      : '现在还没有身份，星尘只记在这台设备上。在「档案」里绑个密码，这份成长就能跟着你走。';
  } else if (bookTab === 'stamps') {
    const g = mkEl('div', 'stamps');
    for (const s of stampSpots()) {
      const got = hasStamp(s.key);
      const d = mkEl('div', got ? 'got' : '');
      d.appendChild(document.createTextNode(got ? '✦ ' + s.name : '？？？'));
      d.appendChild(mkEl('em', '', got ? s.line : '还未到过这里'));
      g.appendChild(d);
    }
    body.appendChild(g);
    const h = mkEl('div', '', '成就');
    h.style.cssText = 'font-size:11.5px;font-weight:900;color:#5a4a7a;margin:4px 0 2px';
    body.appendChild(h);
    const g2 = mkEl('div', 'stamps');
    for (const [key, name, line] of FEATS) {
      const got = hasStamp(key);
      const d = mkEl('div', got ? 'got' : '');
      d.appendChild(document.createTextNode((got ? '✦ ' : '· ') + name));
      d.appendChild(mkEl('em', '', line));
      g2.appendChild(d);
    }
    body.appendChild(g2);
    $('bookHint').textContent = '走近一处地方就会自动记下这一页。凑齐页数能在衣橱里换到更特别的身上的东西。';
  } else {
    for (const part of Object.keys(W_COLS)) {
      const row = mkEl('div', 'gearrow');
      row.appendChild(mkEl('b', '', W_COL_NAME[part]));
      const sw = mkEl('div', 'swatches');
      for (const c of W_COLS[part]) {
        const dot = mkEl('i', LK[part] === c ? 'on' : '');
        dot.style.background = '#' + c.toString(16).padStart(6, '0');
        dot.addEventListener('click', () => setLookPart(part, c));
        sw.appendChild(dot);
      }
      row.appendChild(sw);
      body.appendChild(row);
    }
    const srow = mkEl('div', 'gearrow');
    srow.appendChild(mkEl('b', '', '发型'));
    const sw = mkEl('div', 'wardrobe');
    sw.style.flex = '1';
    for (const [key, name] of W_STYLE) {
      const b = mkEl('button', LK.style === key ? 'on' : '', name);
      b.addEventListener('click', () => setLookPart('style', key));
      sw.appendChild(b);
    }
    srow.appendChild(sw);
    body.appendChild(srow);
    const arow = mkEl('div', 'wardrobe');
    for (const [key, name, need] of W_ACC) {
      const on = LK.acc.includes(key);
      const b = mkEl('button', on ? 'on' : '', name);
      b.appendChild(mkEl('em', '', stampCount() >= need ? (on ? '已戴上（再点取下）' : '点击戴上') : '集齐 ' + need + ' 页图鉴解锁'));
      b.disabled = stampCount() < need && !on;
      b.addEventListener('click', () => setLookPart('acc', key));
      arow.appendChild(b);
    }
    body.appendChild(arow);
    $('bookHint').textContent = '身上的颜色与饰物会跟着账号走：换台设备登录，旅伴们照样认得你。';
  }
}
function bookToggle(force, tab) {
  bookShown = force === undefined ? !bookShown : !!force;
  if (typeof tab === 'string') bookTab = tab;
  const el = $('book');
  if (!el) return;
  el.classList.toggle('hidden', !bookShown);
  for (const b of $('bookTabs').querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === bookTab);
  if (bookShown) renderBook();
}
function bookInit() {
  $('bookBtn').addEventListener('click', () => { audio.start(); bookToggle(); });
  $('bookTitleBtn').addEventListener('click', () => { audio.start(); bookToggle(); });
  $('bookClose').addEventListener('click', () => bookToggle(false));
  for (const b of $('bookTabs').querySelectorAll('[data-tab]')) b.addEventListener('click', () => { bookTab = b.dataset.tab; bookToggle(true, bookTab); audio.play('ui'); });
}
loadGrowth();
applyGrowth();


// ------------------------------------------------------------------ HUD
let hudT = 0, mapT = 0;
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
  $('shards').textContent = `${P.wallet}  (${P.collected}/${world.shards.length}) · 星尘 ${GR.gem}`;
  $('clock').textContent = dayNight.clock;
  $('wx').textContent = WEATHER_NAME[weatherCode()];
  const reg = world.regionAt(P.pos.x, P.pos.z);
  $('region').textContent = reg.name;
  if (reg.name !== lastRegion) { lastRegion = reg.name; if (G.state === 'play') showBanner(reg.name, reg.en.toUpperCase()); }
  renderQuest();
  // prompt
  const n = nearestNPC();
  const bt = n ? null : boardTouch();
  if (!D.open && n && !G.cine && !P.dead) {
    $('prompt').classList.remove('hidden');
    $('ptxt').textContent = '交谈 · ' + n.def.name;
  } else if (bt && !D.open && !G.cine && !P.dead) {
    $('prompt').classList.remove('hidden');
    $('ptxt').textContent = bt.mine ? '改写 · 你的留言' : '点心 · ' + bt.b.by + ' 的留言';
  } else $('prompt').classList.add('hidden');
  // boss
  const king = enemies.find((e) => e.king && !e.dead);
  const showBoss = king && Math.hypot(king.pos.x - P.pos.x, king.pos.z - P.pos.z) < 32;
  $('boss').classList.toggle('hidden', !showBoss);
  if (showBoss) $('bossfill').style.width = (king.hp / king.maxHp) * 100 + '%';
  // 潮：整条分线共用一根池子条，谁打的都算在这条线上
  const tw = net.world, showTide = tideOn();
  $('tide').classList.toggle('hidden', !showTide);
  if (showTide) {
    const left = Math.max(0, tw.tideHp), max = tw.tideMax || 1;
    $('tidefill').style.width = Math.max(0, Math.min(100, (left / max) * 100)) + '%';
    $('tidetxt').textContent = '史莱姆潮 · 第 ' + (tw.tideRound + 1) + ' 波 · 池 ' + left + '/' + max;
  }
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
  // 锁定的旅伴：虚线指向 TA，出圈时钉在边缘当指路标
  const pr = palTarget();
  if (pr) {
    let [x, y] = sc(pr.gx, pr.gz);
    const gx = x - S / 2, gy = y - S / 2, gd = Math.hypot(gx, gy), lim = S / 2 - 20;
    const inside = gd <= lim;
    if (!inside && gd > 0) { x = S / 2 + (gx / gd) * lim; y = S / 2 + (gy / gd) * lim; }
    c.save();
    c.strokeStyle = 'rgba(224,160,32,.9)'; c.lineWidth = 3; c.setLineDash([7, 6]); c.lineDashOffset = -G.t * 14;
    c.beginPath(); c.moveTo(S / 2, S / 2); c.lineTo(x, y); c.stroke();
    c.setLineDash([]);
    c.fillStyle = '#e0a020'; c.strokeStyle = '#fff'; c.lineWidth = 3;
    c.beginPath(); c.arc(x, y, inside ? 8 : 11, 0, 7); c.fill(); c.stroke();
    c.restore();
  }
  // 玩家标点：同伴的呼叫在地图上同样可见
  drawPingsOnMap(c, S, m, sc, inR);
  // player arrow
  const fdx = Math.sin(P.yaw), fdz = Math.cos(P.yaw);
  const ax = fdx * b.rx + fdz * b.rz, ay = -(fdx * b.fx + fdz * b.fz);
  c.save(); c.translate(S / 2, S / 2); c.rotate(Math.atan2(ax, -ay));
  c.fillStyle = '#fff'; c.strokeStyle = '#d4557f'; c.lineWidth = 4;
  c.beginPath(); c.moveTo(0, -15); c.lineTo(10, 11); c.lineTo(0, 5); c.lineTo(-10, 11); c.closePath(); c.stroke(); c.fill(); c.restore();
}
// 点小地图 = 在那个位置发出呼叫标点。指针锁定时事件不会落到界面元素上，故只在光标模式/触屏下生效
function initMapPing() {
  const cv = $('minimap');
  cv.addEventListener('click', (e) => {
    if (G.state !== 'play' || G.locked || G.cine || D.open) return;
    const r = cv.getBoundingClientRect();
    const S = 400, R = 110, m = S / (2 * R);
    const sx = ((e.clientX - r.left) / r.width) * S, sy = ((e.clientY - r.top) / r.height) * S;
    if (Math.hypot(sx - S / 2, sy - S / 2) > S / 2 - 8) return;
    const b = camBasis();
    const det = b.rx * b.fz - b.rz * b.fx;
    const u = (sx - S / 2) / m, v = (S / 2 - sy) / m;
    const X = (u * b.fz - v * b.rz) / det, Z = (b.rx * v - u * b.fx) / det;
    if (Math.hypot(X, Z) > 100) { toast('标点太远了，点在离自己近一些的地方', ''); return; }
    sendPing(P.pos.x + X, P.pos.z + Z);
  });
}

// ------------------------------------------------------------------ input
function requestLock() {
  if (isTouch || G.noLock || G.cursor) return;
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => { G.noLock = true; setCursor(true); }); } catch (e) { G.noLock = true; setCursor(true); }
}
// 光标模式开关：不再暂停游戏，失去锁定时直接切换为可点击的光标模式
function setCursor(on, quiet) {
  if (isTouch) return;
  G.cursor = !!on;
  canvas.style.cursor = G.cursor ? 'default' : 'none';
  if (G.cursor) { if (document.pointerLockElement) document.exitPointerLock(); steer.yaw = steer.pitch = steer.curYaw = steer.curPitch = 0; }
  else requestLock();
  syncModeBtn();
  if (!quiet) toast(G.cursor ? '光标模式：可自由点击界面 · 移到屏幕边缘转视角 · Tab 返回锁定' : '已锁定鼠标：WASD 移动，鼠标转视角', '');
}
document.addEventListener('pointerlockchange', () => {
  G.locked = document.pointerLockElement === canvas;
  if (!G.locked && G.state === 'play' && !G.cine && !G.cursor) setCursor(true, true); // 无暂停：解锁即光标模式，世界继续运行
});
document.addEventListener('pointerlockerror', () => { G.noLock = true; });

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
  if (e.code === 'KeyB') { G.bloomOn = !G.bloomOn; bloom.enabled = G.bloomOn && SET.bloom > 0.5; toast('泛光：' + (G.bloomOn ? '开' : '关')); }
  if (e.code === 'Tab') setCursor(!G.cursor);
  if (e.code === 'KeyG') sendPing(P.pos.x, P.pos.z); // 在自己的位置做标点呼叫同伴
  if (e.code === 'KeyV') startBoardWrite();          // 在脚下刻一句留言
  if (e.code === 'KeyF') throwFirework();            // 放一朵给同线的人看的烟花
  if (e.code === 'KeyP') acctToggle();               // 旅人档案：身份与绑定
  if (e.code === 'KeyO') setToggle();                // 舒适与画质
  if (e.code === 'KeyN') bookToggle();               // 旅人之书：成长 · 图鉴 · 衣橱
  if (e.code === 'Escape' && acctShown) acctToggle(false);
  if (e.code === 'Escape' && setShown) setToggle(false);
  if (e.code === 'Escape' && bookShown) bookToggle(false);
  const emap = { Digit1: 'wave', Digit2: 'heart', Digit3: 'up', Digit4: 'spark', Digit5: 'bow', Digit6: 'dance' };
  if (emap[e.code]) doEmote(emap[e.code]);
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
    if (!G.locked && !G.cursor && !G.noLock && !isTouch) { requestLock(); drag = { x: e.clientX, y: e.clientY, moved: 0 }; return; }
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
  if (G.locked) { cam.yaw -= e.movementX * 0.0024 * SET.look; cam.pitch = clamp(cam.pitch + e.movementY * 0.0024 * SET.look, -0.3, 1.3); }
  else if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.right) drag.moved += Math.abs(dx) + Math.abs(dy);
    cam.yaw -= dx * 0.005; cam.pitch = clamp(cam.pitch + dy * 0.005, -0.3, 1.3);
  }
  // 光标模式的边缘转向：越靠近边缘转得越快，中央有大片死区；指针停在界面控件上不转向
  steer.overUi = e.target !== canvas;
  if (G.cursor && !drag) {
    const ZX = 0.1, ZY = 0.09; // 边缘触发带（占屏幕比例）
    const nx = e.clientX / innerWidth, ny = e.clientY / innerHeight;
    const dzx = nx < ZX ? 1 - nx / ZX : nx > 1 - ZX ? 1 - (1 - nx) / ZX : 0;
    const dzy = ny < ZY ? 1 - ny / ZY : ny > 1 - ZY ? 1 - (1 - ny) / ZY : 0;
    steer.yaw = (nx < 0.5 ? -1 : 1) * (dzx > 0 ? dzx : 0) * 1.35 * SET.steer; // 符号与拖动一致：左边缘=向左转
    steer.pitch = (ny < 0.5 ? -1 : 1) * (dzy > 0 ? dzy : 0) * 0.55 * SET.steer;
    if (dzx <= 0) steer.yaw = 0;
    if (dzy <= 0) steer.pitch = 0;
  } else if (!drag) { steer.yaw = steer.pitch = 0; }
});
window.addEventListener('wheel', (e) => { cam.dist = clamp(cam.dist + Math.sign(e.deltaY) * 0.8, 3, 14); }, { passive: true });

// touch controls
// 网页全屏：Android/桌面走 Fullscreen API，iOS Safari 不支持元素全屏，给出可操作提示
function fsElem() { return document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement || null; }
function initFullscreen() {
  const el = $('fsBtn');
  if (!el) return;
  const label = () => { el.textContent = fsElem() ? '退出' : '全屏'; };
  document.addEventListener('fullscreenchange', label);
  document.addEventListener('webkitfullscreenchange', label);
  const hint = () => {
    toast('此浏览器不支持网页全屏', 'gold');
    setTimeout(() => toast('iPhone：分享 → 添加到主屏幕，再从图标进入即全屏', ''), 900);
  };
  el.addEventListener('click', (e) => {
    e.preventDefault();
    audio.start();
    try {
      if (fsElem()) {
        const ex = document.exitFullscreen || document.webkitExitFullscreen;
        ex ? ex.call(document) : hint();
      } else {
        const root = document.documentElement;
        const req = root.requestFullscreen || root.webkitRequestFullscreen || root.webkitRequestFullScreen;
        if (!req) return hint();
        Promise.resolve(req.call(root, { navigationUI: 'hide' })).then(label).catch(hint);
      }
    } catch { hint(); }
    setTimeout(resize, 260); // 尺寸变化在部分内核上不会派发 resize
  });
  label();
}
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
  btn('tbShot', () => { touch.shot = true; }, () => { touch.shot = false; });
  btn('tbE', () => { interact(); });
  initFullscreen();
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
  updateWeather(dt);
  dayNight.update(dt, G.timeScale);
  if (keys.BracketRight) dayNight.hour = (dayNight.hour + dt * 2) % 24;
  if (keys.BracketLeft) dayNight.hour = (dayNight.hour - dt * 2 + 24) % 24;
  dayNight.follow(camera, P.pos);
  world.update(dt, G.t, camera, P.pos, dayNight.night, dayNight.sun.position.clone().sub(dayNight.sun.target.position).normalize());
  clouds.update(dt, camera.position, dayNight.night);
  const day = 1 - dayNight.night;
  const sak = Math.exp(-Math.pow(Math.hypot(P.pos.x - POI.shrine.x, P.pos.z - POI.shrine.z) / 110, 2));
  wwind.copy(wind).multiplyScalar(WX.wind);
  petals.update(dt, G.t, camera.position, wwind, clamp(0.12 + sak * 0.9, 0, 1) * (day > 0.1 ? 1 : 0.3) * SET.petals * WX.petal);
  petals.mat.color.setScalar(0.35 + 0.65 * day);
  fireflies.update(dt, G.t, P.pos, world.heightAt, dayNight.night * SET.fire * WX.fire);
  rain.update(dt, G.t, camera.position, wwind, WX.rain);
  meteors.update(dt, G.t, camera.position, WX.meteor * (0.25 + dayNight.night));
  updateLife(dt);
  fx.update(dt);
  particles.update(dt);
  audio.update(dayNight.night);
}

// 联机时史莱姆王属于整条分线：血量以服务端为准，死也由服务端判定。
// 本地每跳伤害只负责数字与受击表现，所以要把权威血量盖回去，避免「我先打死、别人还在打」。
function syncKing() {
  const w = net.world;
  if (!w || net.state !== 'online') return;
  const king = enemies.find((e) => e.king && !e.dead);
  if (!w.kingAlive) { if (king) king.hit(0, 0, 0); return; }
  if (!king) { spawnSlime(POI.ruins.x + 8, POI.ruins.z + 8, 'king'); return; }
  king.maxHp = w.kingMax || king.maxHp;
  king.hp = Math.max(0, w.kingHp);
}
// 史莱姆潮：池子是这条分线共用的，但潮水得从每个人脚边涌起来才看得见。
// 所以本地只负责「补几只、什么时候不再补」，能不能打空这一波由服务端说了算。
const TIDE_ALIVE = 5;
let tideWas = false;
const tideOn = () => net.state === 'online' && !!net.world && net.world.tideAlive;
function spawnTideSlime() {
  const a = Math.random() * 6.28, r = 9 + Math.random() * 6;
  const x = clamp(P.pos.x + Math.cos(a) * r, -400, 400), z = clamp(P.pos.z + Math.sin(a) * r, -400, 400);
  const e = spawnSlime(x, z, 'tide');
  e.home.x = x; e.home.z = z;
  particles.burst(x, e.pos.y + 0.5, z, 12, 4, 0x4fd8c4, 0.3, 0.6, 2);
  return e;
}
function syncTide() {
  if (!tideOn()) {
    // 波退了就把散落的潮水当成普通史莱姆：它们还站在这儿，只是不再往池子里记账
    if (tideWas) { tideWas = false; for (const e of enemies) if (e.tide && !e.dead) e.tide = false; }
    return;
  }
  tideWas = true;
  let n = 0;
  for (const e of enemies) if (!e.dead && e.tide) n++;
  for (let i = n; i < TIDE_ALIVE; i++) spawnTideSlime();
}
// 潮水的一跳要进池子：本地照常掉血、照常出数字，池子的账由服务端夹
function tideReport(dmg, e) {
  if (!e.tide || !tideOn()) return;
  net.tideHit(dmg);
}
function updateEnemies(dt) {
  syncKing();
  syncTide();
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
        // 联机时服务端可能已经先把王复活并同步过来，别刷出第二只
        if (!enemies.some((e) => e.king && !e.dead)) spawnSlime(POI.ruins.x + 8, POI.ruins.z + 8, 'king');
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
  updateShots(dt);
  updateDrops(dt);
  updateNPCs(dt);
  updateWorldFX(dt);
  updatePings(dt);
  updatePals(dt);
  updateBoards(dt);
  updateStamps(dt);
  if (myBubble) {
    myBubbleT -= dt;
    myBubble.position.set(P.pos.x, P.pos.y + 2.75 + Math.sin(G.t * 2.6) * 0.06, P.pos.z);
    if (myBubbleT <= 0) { scene.remove(myBubble); myBubble.material.map.dispose(); myBubble.material.dispose(); myBubble = null; }
  }
  updateHUD(dt);
  // 小地图是 400×400 的 2D 合成，软件渲染下一个点位要 20ms+：按 15Hz 画就够顺，也把主线程还给操作
  mapT -= dt;
  if (mapT <= 0) { mapT = 1 / 15; drawMinimap(); }
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
  else update(dt);
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
  rain = new Rain(scene);
  meteors = new Meteors(scene);
  fx = new FX(scene);
  enemyCtx.world = world; enemyCtx.particles = particles; enemyCtx.audio = audio; enemyCtx.fx = fx; enemyCtx.camera = camera;

  P.pos.y = world.heightAt(P.pos.x, P.pos.z);
  char = buildCharacter({ sword: true, glider: true });
  scene.add(char.root);
  char.root.position.copy(P.pos);
  spawnNPCs();
  spawnLife();
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
  settingsInit(); // 舒适设置在标题页就得调：进世界之后再晕就晚了
  mpSync();
  if (isTouch) $('keys').classList.add('hidden');
  // warm up shaders
  composer.render();
}

// ------------------------------------------------------------------ 玩家互动：表情 / 标点呼叫 / 切磋
const EMOTE_TXT = { wave: '你招了招手', heart: '你比了个心', up: '你竖起了大拇指', spark: '你撒出一把星屑', bow: '你认认真真鞠了一躬', dance: '你踩着谁也听不见的拍子跳了起来' };
const EMOTE_PEER = { wave: '向你招招手', heart: '向你比了个心', up: '为你竖起大拇指', spark: '撒出一把星屑', bow: '向你鞠了一躬', dance: '在你身边跳起舞' };
// 合奏的说法：两个人同一处做同一个动作时那句「回响」怎么讲。判定在服务端（三秒内、九米内、
// 不同账号、每人一段冷却），这里只负责把它讲成人话——DUET_NEAR 要和服务端的 DUET_DIST 一致。
const DUET_TXT = { wave: '朝彼此招了招手', heart: '同时比了个心', up: '同时竖起了大拇指', spark: '撒出同一把星屑', bow: '互相深深鞠了一躬', dance: '跳到同一个拍子上' };
const DUET_NEAR = 9;
let duetHinted = false;
let myBubble = null, myBubbleT = 0;
let pvpOn = false;
const pings = []; // {x,z,t,mesh,mine,name}

function showMyBubble(sprite, ttl) {
  if (myBubble) { scene.remove(myBubble); myBubble.material.map.dispose(); myBubble.material.dispose(); }
  myBubble = sprite; myBubbleT = ttl;
  sprite.position.set(P.pos.x, P.pos.y + 2.75, P.pos.z);
  scene.add(sprite);
}
function hintDuet() {
  if (duetHinted || net.state !== 'online') return;
  for (const r of net.remotes.values()) {
    if (Math.hypot(r.gx - P.pos.x, r.gz - P.pos.z) > DUET_NEAR) continue;
    duetHinted = true;
    toast('身旁有人 · 三秒内做同一个动作就能合奏一声', '');
    return;
  }
}
function doEmote(kind) {
  if (G.cine || P.dead) return;
  if (!EMOTES[kind]) return;
  net.emote(kind);
  showMyBubble(iconSprite(EMOTES[kind]), 1.8);
  if (GESTURE_DUR[kind]) P.gest = { k: kind, t: 0 }; // 鞠躬与起舞要真的动起身来，不止顶上一个图标
  particles.burst(P.pos.x, P.pos.y + 1.5, P.pos.z, 10, 1.8, 0xffd8ea, 0.5, 0.7, 0.4);
  audio.play('blip');
  toast(EMOTE_TXT[kind], '');
  hintDuet();
}
function togglePvp() {
  pvpOn = !pvpOn;
  net.pvp(pvpOn);
  syncModeBtn();
  toast(pvpOn ? '切磋开启：只有同样开启的旅伴才会互相造成伤害' : '切磋关闭：你的攻击对旅伴无效', 'gold');
}
function sendPing(x, z) {
  if (G.state !== 'play') return;
  const mine = localStorage.getItem('aw.net.name') || '你';
  addPing(x, z, mine, true);
  if (!net.ping(x, z)) toast('未连线，这个标点只有自己可见', '');
  else toast('已向同伴发出呼叫', 'gold');
}
function addPing(x, z, name, mine) {
  const y = world ? world.groundAt(x, z, 1000) + 2.2 : 2;
  const mesh = makeMarker(mine ? '★' : '!', mine ? '#e0a020' : '#ff6fa8'); // ★/! 都是老字形的安全字符，避免部分系统渲染成豆腐块
  mesh.position.set(x, y, z);
  scene.add(mesh);
  pings.push({ x, z, y, t: 0, mesh, mine, name });
  while (pings.length > 8) { const old = pings.shift(); scene.remove(old.mesh); old.mesh.material.map.dispose(); old.mesh.material.dispose(); }
  if (!mine) {
    const d = Math.round(Math.hypot(x - P.pos.x, z - P.pos.z));
    toast(name + ' 在约 ' + d + ' 米外呼叫', 'gold');
    audio.play('blip');
    particles.burst(x, y - 1.4, z, 14, 3, 0xff9ac8, 0.4, 0.8, 0.3);
  }
}
function updatePings(dt) {
  for (let i = pings.length - 1; i >= 0; i--) {
    const g = pings[i];
    g.t += dt;
    g.mesh.position.y = g.y + Math.sin(g.t * 2.6) * 0.18;
    const k = g.t > 20 ? 1 - (g.t - 20) / 5 : 1;
    g.mesh.material.opacity = Math.max(0, k);
    const s = 0.7 + Math.sin(g.t * 4) * 0.06;
    g.mesh.scale.set(s, s, 1);
    if (g.t > 25) {
      scene.remove(g.mesh); g.mesh.material.map.dispose(); g.mesh.material.dispose();
      pings.splice(i, 1);
    }
  }
}
function drawPingsOnMap(mm, S, m, sc, inR) {
  for (const g of pings) {
    const [x, y] = sc(g.x, g.z);
    if (!inR(x, y)) continue;
    const a = g.t > 20 ? Math.max(0, 1 - (g.t - 20) / 5) : 1;
    mm.globalAlpha = a;
    mm.strokeStyle = '#fff'; mm.lineWidth = 3;
    mm.beginPath(); mm.arc(x, y, 9 + Math.sin(g.t * 4) * 2, 0, 7); mm.stroke();
    mm.fillStyle = g.mine ? '#ffd36b' : '#ff6fa8';
    mm.beginPath(); mm.arc(x, y, 4.5, 0, 7); mm.fill();
    mm.globalAlpha = 1;
  }
}
// 光标模式 / 切磋 / 表情按钮的文字状态
function syncModeBtn() {
  const mb = $('modeBtn'), pb = $('pvBtn');
  if (!mb || !pb) return;
  mb.textContent = G.cursor ? '锁定' : '光标';
  mb.classList.toggle('on', G.cursor);
  pb.textContent = pvpOn ? '切磋中' : '切磋';
  pb.classList.toggle('on', pvpOn);
}

// ------------------------------------------------------------------ 旅伴面板
// 世界有 800 米宽，光靠“同屏”找不到人；这里给出方向（与小地图同基准）和距离，点一下锁定为同行目标
const PAL_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
let palLock = null, palT = 0, palKey = '', palShown = false;
function palBearing(dx, dz) {
  const b = camBasis();
  const ax = dx * b.rx + dz * b.rz, ay = -(dx * b.fx + dz * b.fz);
  const a = Math.atan2(ax, -ay); // 0 = 屏幕正上方，顺时针
  return PAL_ARROWS[Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
}
function updatePals(dt) {
  const box = $('pals'), list = $('palList');
  if (!box || !list) return;
  const on = G.state === 'play' && !G.cine && net.state === 'online' && net.remotes.size > 0;
  if (on !== palShown) { palShown = on; box.classList.toggle('hidden', !on); layoutTouchHud(); }
  if (!on) return;
  const arr = [...net.remotes.values()];
  const key = arr.map((r) => r.id).join(',') + '|' + palLock;
  if (key !== palKey) {
    palKey = key;
    list.textContent = '';
    for (const r of arr) {
      const row = document.createElement('div');
      row.className = 'pal' + (r.id === palLock ? ' on' : '') + (r.acct && myMutes.has(r.acct) ? ' mute' : '');
      row.dataset.id = r.id;
      row.innerHTML = '<s></s><i></i><b></b><em></em>';
      row.querySelector('b').textContent = r.name;
      row.querySelector('s').classList.toggle('hit', !!r.pvp);
      // 只有对方有身份时才给屏蔽/举报：匿名的临时连接既屏蔽不了也无从追责
      if (r.acct && net.me?.a) {
        const mu = document.createElement('u');
        mu.className = 'pa' + (myMutes.has(r.acct) ? ' on' : '');
        mu.dataset.act = 'mute';
        mu.textContent = myMutes.has(r.acct) ? '🔇' : '🔊';
        mu.title = myMutes.has(r.acct) ? '取消屏蔽' : '屏蔽 TA 的说话与动作';
        const rp = document.createElement('u');
        rp.className = 'pa';
        rp.dataset.act = 'report';
        rp.textContent = '⚑';
        rp.title = '举报';
        row.appendChild(mu); row.appendChild(rp);
      }
      list.appendChild(row);
    }
  }
  palT -= dt;
  if (palT > 0) return;
  palT = 0.2;
  if (netCount !== net.remotes.size + 1) mpSync(); // 名单变动后在线人数要跟上
  for (const row of list.children) {
    const r = net.remote(row.dataset.id);
    if (!r) continue;
    const dx = r.gx - P.pos.x, dz = r.gz - P.pos.z, dd = Math.hypot(dx, dz);
    row.querySelector('i').textContent = palBearing(dx, dz);
    row.querySelector('em').textContent = Math.round(dd) + 'm';
    if (r.id === palLock && dd < 7) { // 追上了就别再指着同伴的背
      palLock = null; palKey = '';
      toast('追上 ' + r.name + ' 了', 'gold');
      audio.play('blip');
    }
  }
}
function palTarget() { return palLock ? net.remote(palLock) : null; }
function palClick(e) {
  const act = e.target && e.target.dataset ? e.target.dataset.act : null;
  if (act) {
    const row = e.target.closest ? e.target.closest('.pal') : null;
    const r = row && net.remote(row.dataset.id);
    if (!r) return;
    if (act === 'mute') palMute(r); else palReport(r);
    return;
  }
  const row = e.target && e.target.closest ? e.target.closest('.pal') : null;
  if (!row) return;
  palLock = palLock === row.dataset.id ? null : row.dataset.id;
  palKey = '';
  const r = palTarget();
  if (r) {
    toast('已锁定 ' + r.name + '：小地图上的橙色虚线指向 TA', 'gold');
    audio.play('blip');
  } else toast('已取消锁定', '');
  layoutTouchHud();
}

// ------------------------------------------------------------------ 留言石碑
// 一人一块、一句话：主人走开也留在原地，路过的人读到、可以点心。异步的同游痕迹，不需要凑时间。
const boardMeshes = new Map(); // pid -> {post, plaque, text}
const BOARD_SEE = 20, BOARD_TOUCH = 4.2;
let boardMode = false, boardT = 0, openInput = null, closeInput = null, chatPh = '';
function makeStele(mine) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.5, 0.22), new THREE.MeshLambertMaterial({ color: mine ? 0xa88fd0 : 0x8f88a8 }));
  body.position.y = 0.75;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.16, 0.34), new THREE.MeshLambertMaterial({ color: 0xe8dcf2 }));
  cap.position.y = 1.58;
  g.add(body, cap);
  return g;
}
function killPlaque(m) {
  if (!m.plaque) return;
  scene.remove(m.plaque); m.plaque.material.map.dispose(); m.plaque.material.dispose(); m.plaque = null;
}
function dropBoard(m) {
  scene.remove(m.post);
  for (const o of m.post.children) o.geometry.dispose();
  killPlaque(m);
}
const boardLabel = (b) => b.s + (b.l ? ' ♥' + b.l : ''); // ♥ 是老字形，本机不会糊成方块
function updateBoards(dt) {
  boardT -= dt;
  if (boardT > 0) return;
  boardT = 0.1;
  if (!world || !net.boards) return;
  for (const [id, b] of net.boards) {
    let m = boardMeshes.get(id);
    if (!m) { m = { post: makeStele(net.isMineBoard(id)), plaque: null, text: '' }; boardMeshes.set(id, m); scene.add(m.post); }
    // 落点取服务端记录的位置（已按十分位存下），本地浮点尾巴不做整数吸附
    const gx = Math.round(b.x * 10) / 10, gz = Math.round(b.z * 10) / 10;
    const gy = world.groundAt(gx, gz, 1000);
    m.post.position.set(gx, gy, gz);
    m.post.rotation.y = (b.x + b.z) * 0.07;
    const label = boardLabel(b);
    if (m.text !== label) { m.text = label; killPlaque(m); } // 文本或点赞数变了，重做贴图
    const d = Math.hypot(gx - P.pos.x, gz - P.pos.z);
    if (d < BOARD_SEE) {
      if (!m.plaque) {
        m.plaque = textSprite(label, { bg: 'rgba(255,255,255,.93)', fg: '#3b2a5a', font: '700 27px "Noto Sans SC","Microsoft YaHei",sans-serif', h: 44 });
        scene.add(m.plaque);
      }
      m.plaque.position.set(gx, gy + 2.2 + Math.sin(G.t * 1.6 + b.x) * 0.05, gz);
      m.plaque.material.opacity = clamp((BOARD_SEE - d) / 4, 0, 1);
    } else killPlaque(m);
  }
  for (const [id, m] of boardMeshes) if (!net.boards.has(id)) { dropBoard(m); boardMeshes.delete(id); }
}
// 脚下这块碑是谁的：别人的→点心；自己的→改写/收回
function boardTouch() {
  if (G.cine || P.dead || net.state !== 'online') return null;
  let best = null, bd = BOARD_TOUCH;
  for (const b of net.boards.values()) {
    const d = Math.hypot(b.x - P.pos.x, b.z - P.pos.z);
    if (d < bd) { bd = d; best = b; }
  }
  if (!best) return null;
  return { b: best, mine: net.isMineBoard(best.p) };
}
function startBoardWrite() {
  if (net.state !== 'online') { toast('要先连上旅伴才能留下留言', 'gold'); return; }
  if (openInput) {
    boardMode = true;
    openInput('刻一句留言（≤24 字，留空则收回石碑）');
    pushChat('（正在刻留言：Enter 落下，Esc 取消）');
  }
}
function submitBoard(text) {
  if (!text) {
    if (net.myBoard()) { net.boardClear(); toast('你收回了这块留言', ''); }
    return;
  }
  if (!net.board(P.pos.x, P.pos.z, text)) { toast('未连线，留言没有刻上', 'gold'); return; }
  audio.play('blip');
  particles.burst(P.pos.x, P.pos.y + 0.6, P.pos.z, 16, 2.4, 0xd8b8ff, 0.5, 0.9, -0.4);
  const mine = net.myBoard(), move = mine && Math.hypot(mine.x - P.pos.x, mine.z - P.pos.z) > 6;
  toast(move ? '你把石碑挪到了这里：' + text : '留言已刻下：' + text, 'gold');
  // 服务端会静默拒绝（8 秒冷却 / 与别人的石碑重叠），没回灌就当失败提示出来
  setTimeout(() => {
    if (net.myBoard()?.s === text) markFeat('feat_words');
    else toast('这块石碑旁边太挤，或你刚刻过（8 秒一次）', 'gold');
  }, 1200);
}
function boardInteract() {
  const t = boardTouch();
  if (!t) return false;
  if (t.mine) { startBoardWrite(); return true; }
  net.boardLike(t.b.p);
  const gy = world ? world.groundAt(t.b.x, t.b.z, 1000) : 0;
  particles.burst(t.b.x, gy + 1.8, t.b.z, 12, 2, 0xff9ac8, 0.4, 0.8, -0.2);
  audio.play('blip');
  toast('你为 ' + t.b.by + ' 的留言点了一颗心', 'gold');
  return true;
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
  const playing = G.state === 'play';
  const active = !!net.profile && net.state !== 'off';
  $('netbar').classList.toggle('hidden', !(playing && active));
  if (!playing || !active) acctToggle(false); // 掉线/退出时档案面板跟着收起，别留一张空表
  if (playing) {
    // 在线人数/分线以联机层当前状态为准：名单变动只会广播给同线玩家，
    // 单独依赖 onNetState 会让「在线 N」停在旧值
    if (active && net.state === 'online') netCount = net.remotes.size + 1;
    $('nonline').textContent = net.state === 'online' ? '在线 ' + netCount : '';
    $('nlane').textContent = net.state === 'online' && net.lane ? '・' + (net.lane + 1) + '线' : '';
    $('mpBox').classList.toggle('hidden', active);
    layoutTouchHud();
    return;
  }
  const btn = $('joinBtn'), hint = $('mpHint');
  if (active) {
    btn.textContent = net.state === 'online' ? '已联机 ✓' : '连线中…';
    hint.innerHTML = net.state === 'online'
      ? '<b>已连线 · 在线 ' + netCount + ' 人</b>　点「开始冒险」进入世界即可与旅伴同行'
      : '正在连接 <b>' + net.url.replace(/^wss?:\/\//, '') + '</b>…　久候未连上请检查端口与安全组';
  } else { btn.textContent = '连线同行'; hint.innerHTML = MP_HINT_DEFAULT; }
}
// 触摸端 HUD 左列排布：按真实尺寸依次下排，避免与状态面板/摇杆重叠（须在 HUD 可见后调用）
// netbar 会折行、表情行与旅伴面板可开可关，高度都不固定，所以整列按实测高度堆叠
function layoutTouchHud() {
  if (G.state !== 'play') return;
  const nb = $('netbar');
  if (!nb) return;
  if (isTouch) nb.style.top = Math.round($('stats').getBoundingClientRect().bottom) + 8 + 'px';
  const nbB = Math.round(nb.getBoundingClientRect().bottom);
  let y = nbB + 6;
  const shown = (el) => el && !el.classList.contains('hidden');
  const er = $('emoteRow'), pl = $('pals');
  if (shown(er)) { er.style.top = y + 'px'; y += Math.round(er.getBoundingClientRect().height) + 6; }
  if (shown(pl)) pl.style.top = y + 'px';
  if (isTouch) {
    const cw = $('chatwrap');
    cw.style.top = y + 4 + 'px'; cw.style.bottom = 'auto'; cw.style.width = 'min(300px,52vw)';
  }
}
// ------------------------------------------------------------------ 旅人档案（账号）
// 什么都不用注册：连上线就自动有一个游客号，进度当场开始落库。
// 想换设备再补一个昵称 + 密码；不绑定也不影响游玩，只是这段旅程留在这台设备上。
let acctShown = false, reportMode = false, reportTarget = null;
const myMutes = new Set();
function acctToggle(force) {
  acctShown = force === undefined ? !acctShown : !!force;
  const el = $('acct');
  if (!el) return;
  el.classList.toggle('hidden', !acctShown);
  if (acctShown) { renderAcct(); if (!isTouch) $('acctName').focus(); }
}
function renderAcct() {
  const line = $('acctLine'), stats = $('acctStats');
  if (!line || !stats) return;
  const m = net.me, w = net.world, pr = net.prog || {}, rec = net.record || {};
  if (!m) {
    line.textContent = net.state === 'connecting' ? '正在连线……' : '还没连上旅伴。点「连线同行」，系统会悄悄为你开一个游客号。';
    stats.textContent = '';
    return;
  }
  line.textContent = (m.n || '无名旅人') + '　' +
    (m.bound ? '已绑定密码：换设备凭昵称与密码就能找回' : '游客号：建议绑一个密码，换设备才找得回') +
    (net.lane ? '　·　你在 ' + (net.lane + 1) + ' 线' : '');
  stats.textContent = '碎片 ' + (pr.shards | 0) + ' 枚　·　击败 ' + (pr.kills | 0) + ' 只　·　出发 ' + (pr.plays | 0) + ' 次' +
    (pr.deaths ? '　·　倒下 ' + pr.deaths + ' 次' : '') +
    '\n今日切磋 ' + (rec.hits | 0) + ' 次' + (rec.wins ? '　·　胜过 ' + rec.wins + ' 场' : '') +
    (w ? '\n这条分线：任务第 ' + w.stage + ' 章　·　' + (w.kingAlive ? '史莱姆王还在游荡' : '史莱姆王已被击败') + '　·　' + (w.wish | 0) + ' 人许过愿' : '') +
    '\n星尘 ' + GR.gem + ' 枚　·　图鉴 ' + stampCount() + ' 页　·　练成 ' + GEAR_KEYS.reduce((n, k) => n + (GR.gear[k] | 0), 0) + ' 级';
  const nm = $('acctName'), pw = $('acctPass');
  if (nm && !nm.value) nm.value = m.n || '';
  if (pw) pw.disabled = !!m.bound;
  const bind = $('bindBtn');
  if (bind) bind.textContent = m.bound ? '已绑定' : '绑定';
}
function acctBind() {
  const n = $('acctName').value.trim(), p = $('acctPass').value;
  const btn = $('bindBtn');
  btn.textContent = '绑定中…';
  net.bind(n, p).then((j) => {
    if (j.err === 'taken') { btn.textContent = '名字有人用了'; toast('这个名字已经被别的旅人占用了', 'gold'); }
    else if (j.err === 'weak') { btn.textContent = '密码太短'; toast('密码至少 6 位', 'gold'); }
    else if (j.err === 'name') { btn.textContent = '昵称不合适'; toast('昵称只能用常见文字，16 字以内', 'gold'); }
    else if (j.err) { btn.textContent = '再试一次'; toast(j.err === 'offline' ? '这里没有可连的后端，进度只能留在本机' : '绑定失败：' + j.err, 'gold'); }
    else { toast('已绑定：' + j.n + '，记住昵称与密码', 'big'); audio.play('blip'); }
    renderAcct();
  });
}
function acctLogin() {
  const n = $('acctName').value.trim(), p = $('acctPass').value;
  const btn = $('loginBtn');
  btn.textContent = '登录中…';
  net.logIn(n, p).then((j) => {
    if (j.err === 'locked') { btn.textContent = '先歇一会儿'; toast('试得太多次了，' + (j.retry || 60) + ' 秒后再试', 'gold'); }
    else if (j.err === 'banned') { btn.textContent = '登录'; toast('这个账号被封禁中', 'gold'); }
    else if (j.err) { btn.textContent = '登录'; toast(j.err === 'bad' ? '昵称或密码不对' : j.err === 'offline' ? '这里没有可连的后端' : '登录失败', 'gold'); }
    else { toast('欢迎回来，' + (j.n || '旅人'), 'big'); audio.play('blip'); renderAcct(); }
  });
}
function acctLogout() {
  net.logOut().then(() => { toast('已退出：这段旅程留在原账号里，随时可凭昵称密码回来', ''); renderAcct(); });
}
// 静音/举报：静音只挡住说话、动作、呼叫与留言，TA 依然走在同一个世界里
function palMute(r) {
  if (!net.me?.a) { toast('要先连上旅伴才能屏蔽', 'gold'); return; }
  if (!r.acct) { toast('这位旅人没有身份记录，屏蔽不了（也无从追责）', ''); return; }
  const on = !myMutes.has(r.acct);
  net.mute(r.acct, on);
  if (on) myMutes.add(r.acct); else myMutes.delete(r.acct);
  palKey = '';
  toast(on ? '已屏蔽 ' + r.name + ' 的说话与动作' : '已解除屏蔽 ' + r.name, on ? '' : 'gold');
}
function palReport(r) {
  if (!r.acct) { toast('这位旅人没有身份记录，无法举报', ''); return; }
  reportTarget = r;
  reportMode = true;
  openInput('举报 ' + r.name + '：写下发生了什么（Enter 提交 · Esc 取消）');
}
function submitReport(text) {
  const r = reportTarget;
  reportTarget = null;
  if (!r) return;
  net.report(r.acct, text || '不当行为');
  toast('已提交举报，会有旅人管理人来看', '');
}

// ------------------------------------------------------------------ 世界进度同步
// 本地照常预测，结论以服务端为准：重连后接着上次的旅程走，别人推进的剧情也会流到自己眼里
function applyWelcome(d) {
  const pr = net.prog, w = net.world;
  if (d.look) adoptLook(d.look); // 衣服跟着账号走：换设备登录也该是这一身
  if (pr) {
    P.collected = Math.max(P.collected, pr.shards | 0);
    P.kills = Math.max(P.kills, pr.kills | 0);
  }
  for (const s of world.shards) if (!s.taken && net.shardTaken(s.x, s.z)) s.taken = true;
  if (w) {
    if (w.stage > Q.stage) Q.stage = w.stage;
    Q.k0 = Math.min(Math.max(Q.k0, w.k0 | 0), P.kills);
    Q.upgraded = Q.upgraded || w.upgraded;
    applyGrowth();
  }
  if (serverGrowth()) syncGrowthFromServer(pr, true); // 全量对齐要安静：旧等级不值得再跳一次toast
  maybeClaimLedger();
  lastQKey = '';
  renderQuest();
  renderAcct();
  mpSync();
  syncKing();
  prevKingAlive = w ? w.kingAlive : null; // 进线时王是否还活着只是「现状」，不该算成自己打倒的
  prevTideAlive = w ? w.tideAlive : null; // 潮同理：进线时正在打的那一波不该白报一次「涌上来了」
  if (G.state === 'play' && d.me) toast('旅程已同步：碎片 ' + ((d.prog && d.prog.shards) | 0) + ' 枚', '');
  checkQuest();
}
function applyWorldMsg(w) {
  if (!w) return;
  if (prevKingAlive === true && !w.kingAlive) markFeat('feat_king'); // 只有亲眼看着王倒下才算这一页
  prevKingAlive = w.kingAlive;
  if (w.stage > Q.stage) {
    Q.stage = w.stage;
    if (G.state === 'play' && !G.cine) toast('同伴推进了任务：' + questInfo().t, 'gold'); // 同一条分线共用一份剧情进度
  }
  Q.upgraded = Q.upgraded || w.upgraded;
  if (prevTideAlive === false && w.tideAlive && G.state === 'play' && !G.cine) {
    toast('史莱姆潮涌上来了！这一波的池子要这条分线一起打空', 'big');
    audio.play('quest');
  }
  prevTideAlive = w.tideAlive;
  syncKing();
  lastQKey = '';
  renderQuest();
  renderAcct(); // 面板随时可能是下一帧就被打开的，别让它显示旧数字
}
function shardGone(s) {
  for (const s2 of world.shards) if (!s2.taken && net.shardTaken(s2.x, s2.z)) { s2.taken = true; }
  if (s.n && s.n !== (net.me?.n || net.profile?.n) && G.state === 'play') toast(s.n + ' 采到了一枚星屑碎片', '');
  lastQKey = '';
  renderQuest();
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
      $('nlane').textContent = s === 'online' && net.lane ? '・' + (net.lane + 1) + '线' : '';
      renderAcct();
      mpSync();
    },
    onChat: (name, m, self) => pushChat((self ? '我' : name) + '：' + m),
    onPeerJoin: (name) => toast(name + ' 来到了樱之境', ''),
    onPeerLeave: (name, id) => {
      if (id && id === palLock) { palLock = null; palKey = ''; }
      toast(name + ' 离开了', '');
    },
    onNetErr: (code) => toast(code === 'full' ? '分线已满，正在重试…'
      : code === 'rate' ? '发送太快，被暂时限制'
        : code === 'banned' ? '你被暂时请出了这片世界，稍后再来吧' : '联机异常：' + code, 'gold'),
    onWelcome: (d) => applyWelcome(d),
    onWorld: (w) => applyWorldMsg(w),
    onProg: (p) => { syncGrowthFromServer(p, claimQuiet); claimQuiet = false; renderAcct(); },
    onShardTaken: (s) => shardGone(s),
    onPeerEmote: (kind, name, r) => {
      if (r && Math.hypot(r.gx - P.pos.x, r.gz - P.pos.z) > 18) return; // 远处的动作不打扰
      toast(name + ' ' + (EMOTE_PEER[kind] || '做了个动作'), '');
    },
    // 合奏是这条分线自己响的一声：烟花落在两个人站的地方，星尘早由服务端记进账本了
    onDuet: (e) => {
      if (G.state !== 'play') return;
      launchFirework(e.x, e.z);
      fx.ring(e.x, world.heightAt(e.x, e.z) + 2.4, e.z, 4.5, 0xffd8ea, 0.7);
      const mine = e.a === net.pid || e.b === net.pid;
      const who = e.a === net.pid ? e.nb : e.b === net.pid ? e.na : '';
      if (mine) {
        toast('合奏 · 你和 ' + who + (DUET_TXT[e.e] || '做了同一个动作') + '　✦+' + e.g, 'gold');
        markFeat('feat_duet');
      } else if (e.na && e.nb) toast(e.na + ' 与 ' + e.nb + ' ' + (DUET_TXT[e.e] || '同时做了个动作'), '');
    },
    onPeerPvp: (on, name) => {
      if (G.state === 'play') toast(name + (on ? ' 开启了切磋，你的攻击对他有效' : ' 关闭了切磋'), 'gold');
    },
    onPlayerHit: (h) => hurtPlayer(h.dmg, h.from, h.by),
    onPeerHit: (v, dmg) => {
      particles.burst(v.gx, v.gy + 1.4, v.gz, dmg > 0 ? 9 : 14, 2.4, dmg > 0 ? 0xffe8a0 : 0xff9ac8, 0.4, 0.8, 0.4);
      if (dmg > 0) dmgNumber(new THREE.Vector3(v.gx, v.gy + 1.9, v.gz), dmg, dmg >= 4 ? 'crit' : '');
    },
    onPing: (g) => { if (G.state === 'play') addPing(g.x, g.z, g.name, false); },
    onFirework: (f) => { launchFirework(f.x, f.z); if (G.state === 'play') toast(f.name + ' 放了一朵烟花', ''); },
    onPeerBolt: (b) => { if (G.state === 'play') peerBolt(b); },
    // 池子见底是这条分线共同的成果：烟花给全线放，成就只记「参与过」的人
    onTideDone: (e) => {
      if (G.state !== 'play') return;
      const n = net.remotes.size + 1;
      toast('第 ' + e.round + ' 波史莱姆潮被压下去了 · 同行 ' + n + ' 人 · 各 +' + e.gem + ' 星尘', 'gold');
      markFeat('feat_tide');
      celebrate(4);
    },
  });
  const url = new URLSearchParams(location.search).get('srv');
  const nameIn = $('nameIn'), srvIn = $('srvIn');
  nameIn.value = localStorage.getItem('aw.net.name') || ('旅人' + Math.floor(Math.random() * 900 + 100));
  srvIn.value = url || localStorage.getItem('aw.net.srv') || '';
  initLook(nameIn.value); // 没存过外观就按名字发一套配色，旅伴之间不会撞衫
  rebuildChar();
  bookInit();
  $('joinBtn').addEventListener('click', () => {
    audio.start();
    const n = nameIn.value.trim().slice(0, 16) || '旅人';
    const s = srvIn.value.trim();
    localStorage.setItem('aw.net.name', n);
    localStorage.setItem('aw.net.srv', s);
    net.url = srvUrl(s);
    // 凭据要先就位（游客号也是现开的），否则这次握手带不上 cookie，这一段旅程就不落库
    (net.acct ? Promise.resolve() : net.whoAmI()).then(() => net.connect(n, LK));
    mpSync();
  });
  $('leaveBtn').addEventListener('click', () => { net.disconnect(); mpSync(); });
  // 互动胶囊栏：动作面板 / 切磋开关 / 就地呼叫 / 光标模式
  const emRow = $('emoteRow');
  $('emBtn').addEventListener('click', () => {
    audio.start();
    emRow.classList.toggle('hidden');
    if (!emRow.classList.contains('hidden')) layoutTouchHud();
  });
  for (const b of emRow.querySelectorAll('[data-em]')) b.addEventListener('click', () => doEmote(b.dataset.em));
  $('palList').addEventListener('click', palClick); // 点旅伴 = 锁定/取消锁定同行目标
  $('pvBtn').addEventListener('click', () => { audio.start(); togglePvp(); });
  $('pgBtn').addEventListener('click', () => { audio.start(); sendPing(P.pos.x, P.pos.z); });
  $('fwBtn').addEventListener('click', () => { audio.start(); throwFirework(); });   // 触屏玩家也要点得着烟花
  $('bdBtn').addEventListener('click', () => { audio.start(); startBoardWrite(); }); // 在脚下刻一句留言
  $('modeBtn').addEventListener('click', () => setCursor(!G.cursor));
  if (isTouch) $('modeBtn').style.display = 'none'; // 触摸端没有指针锁定，无需光标模式
  initMapPing();
  syncModeBtn();
  const chat = $('chat'), inp = $('chatIn');
  chatPh = inp.placeholder;
  const showChat = (v) => { chatHidden = !v; chat.classList.toggle('hidden', chatHidden); if (v) inp.focus(); else inp.blur(); };
  // 输入框身兼数职：平时聊天，刻留言、写举报时借用同一个输入路径（含移动端软键盘）
  openInput = (ph) => { chatHidden = false; chat.classList.remove('hidden'); inp.placeholder = ph; inp.focus(); };
  closeInput = () => { boardMode = false; reportMode = false; inp.placeholder = chatPh; inp.blur(); if (!isTouch) showChat(false); };
  $('chToggle').addEventListener('click', () => showChat(chatHidden));
  $('chSend').addEventListener('click', () => sendChat());
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') sendChat(); else if (e.key === 'Escape') closeInput(); });
  inp.addEventListener('keyup', (e) => e.stopPropagation());
  function sendChat() {
    const v = inp.value.trim();
    inp.value = '';
    if (boardMode) { closeInput(); submitBoard(v); return; }
    if (reportMode) { closeInput(); submitReport(v); return; }
    if (!v) return;
    if (net.state === 'online') { net.chat(v); pushChat('我：' + v); }
    else pushChat('（未连线，消息未发送）');
  }
  // 档案面板：我是谁、走过多远、要不要把这段旅程绑定成可登录的账号
  $('acctBtn').addEventListener('click', () => { audio.start(); acctToggle(); });
  $('acctClose').addEventListener('click', () => acctToggle(false));
  $('bindBtn').addEventListener('click', acctBind);
  $('loginBtn').addEventListener('click', acctLogin);
  $('logoutBtn').addEventListener('click', acctLogout);
  for (const id of ['acctName', 'acctPass']) {
    const el = $(id);
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') (net.me && net.me.bound ? acctBind : acctLogin)();
    });
    el.addEventListener('keyup', (e) => e.stopPropagation());
  }
  // 页面一开就悄悄开好游客号：等玩家点「连线同行」时凭据已经就位，第一段旅程也不会白走
  net.whoAmI().then((j) => {
    // 屏蔽名单跟着账号走：重来时按钮得显示真实状态，而不是全部「未屏蔽」
    for (const u of (j && j.mutes) || []) myMutes.add(u);
    renderAcct();
  });
}
function pushChat(line) {
  const box = $('chat');
  if (!box) return;
  const div = document.createElement('div');
  div.textContent = line;
  box.appendChild(div);
  while (box.children.length > 7) box.removeChild(box.firstChild);
  // 桌面端来消息自动展开；触摸端不自动展开，以免面板盖住摇杆，由玩家主动点 💬
  if (chatHidden && !isTouch && $('hud')) { box.classList.remove('hidden'); clearTimeout(pushChat.t); pushChat.t = setTimeout(() => { if (document.activeElement !== $('chatIn')) box.classList.add('hidden'); }, 6000); }
}

$('startBtn').addEventListener('click', () => {
  audio.start();
  netInit();
  $('title').classList.add('hidden');
  $('hud').classList.remove('hidden');
  G.state = 'play';
  layoutTouchHud(); // HUD 此时才可见，左列排布要按真实尺寸计算
  mpSync(); // 须在 state 切到 play 之后，否则联机状态条不会显示
  cam.yaw = 0; cam.pitch = 0.3; cam.dist2 = undefined;
  cam.target.set(P.pos.x, P.pos.y + 1.5, P.pos.z);
  requestLock();
  lastRegion = '';
  toast('WASD 移动 · 空格跳跃 · 左键攻击 · 长按 R 星屑弹 · E 互动', '');
  setTimeout(() => toast('先去和村长阿澄聊聊吧（头顶有 ! 的人）', 'gold'), 1200);
  lastQKey = '';
});

window.__game = { P, Q, G, cam, net, fw: launchFirework, get fwSeen() { return fwSeen; }, get world() { return world; }, get enemies() { return enemies; }, get npcs() { return npcs; }, get shots() { return shots; }, THREE, scene, camera, renderer, get char() { return char; }, get dayNight() { return dayNight; }, get GR() { return GR; }, get LK() { return LK; }, get COD() { return COD; }, get deer() { return deer; }, get shrooms() { return shrooms; }, get particles() { return particles; }, setStage, startEnding, bookToggle, spawn: (x, z, kind) => spawnSlime(x, z, kind),
  // 无头浏览器里 rAF 会被虚拟时间预算掐停：留一步手动推进，测试才不靠运气
  step: (dt = 1 / 60) => { if (G.state === 'play') update(dt); else if (G.state === 'title') updateTitle(dt); } };
boot().catch((e) => { console.error(e); $('ltxt').textContent = '加载失败：' + e.message; });
requestAnimationFrame(frame);
