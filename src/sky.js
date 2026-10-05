import * as THREE from 'three';
import { sstep, lerp, makeRng } from './noise.js';
import { toon } from './materials.js';

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position,1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // always at far plane
}`;

const SKY_FS = /* glsl */ `
varying vec3 vDir;
uniform vec3 uTop, uHor, uSunDir, uSunCol, uGlow;
uniform float uTime, uNight;
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float h31(vec3 p){ p=fract(p*vec3(.1031,.1030,.0973)); p+=dot(p,p.yxz+33.33); return fract((p.x+p.y)*p.z); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float s=0.,a=.5; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  float h = clamp(d.y,0.,1.);
  vec3 col = mix(uHor, uTop, pow(h,.5));
  if(d.y<0.) col = uHor;
  float sd = max(dot(d,uSunDir),0.);
  col += uGlow*(pow(sd,5.)*.5 + pow(sd,36.)*.6);
  col = mix(col, uSunCol*1.4, smoothstep(.9991,.9995,sd)*(1.-uNight));
  float md = max(dot(d,-uSunDir),0.);
  col = mix(col, vec3(1.,.97,.85), smoothstep(.9984,.9988,md)*uNight);
  col += vec3(.5,.6,1.)*pow(md,40.)*.25*uNight;
  if(uNight>.02 && d.y>0.){
    float s = h31(floor(d*170.));
    float tw = .6+.4*sin(uTime*2.+s*60.);
    col += vec3(1.,.95,.9)*step(.9955,s)*tw*uNight*smoothstep(0.,.25,d.y);
  }
  if(d.y>0.){
    vec2 uv = d.xz/(d.y+.14)*.85 + vec2(uTime*.008, uTime*.003);
    float n = fbm(uv*1.25);
    float c = smoothstep(.54,.575,n);
    float n2 = fbm(uv*1.25 - uSunDir.xz*.5);
    float sh = smoothstep(.54,.60,n2);
    vec3 lit = mix(vec3(1.0,.995,.98), vec3(1.0,.9,.85), pow(sd,3.)*.6);
    vec3 shade = vec3(.70,.76,.95);
    vec3 cc = mix(lit, shade, sh*.85);
    cc = mix(cc*vec3(.22,.25,.42), cc, 1.-uNight);
    cc += uGlow*.35*(1.-sh)*pow(sd,2.);
    col = mix(col, cc, c*smoothstep(0.,.22,d.y)*.96);
  }
  gl_FragColor = vec4(col,1.);
}`;

export class SkyDome {
  constructor() {
    this.uniforms = {
      uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() }, uTime: { value: 0 }, uNight: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: SKY_VS, fragmentShader: SKY_FS,
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 20), mat);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
  }
}

const PAL = {
  night: { top: 0x070c2e, hor: 0x1e2c66, sun: 0x8ea6ff, sunI: 0.9, hs: 0x5366c0, hg: 0x1c2048, hI: 1.0, fog: 0x1e2c66 },
  day: { top: 0x2f8cff, hor: 0xbfe9ff, sun: 0xfff1d8, sunI: 2.9, hs: 0xd4ecff, hg: 0x8ed06a, hI: 1.6, fog: 0xcbeaff },
  dusk: { top: 0x5a4ad0, hor: 0xff9a7c, sun: 0xffa868, sunI: 2.4, hs: 0xe8b6dc, hg: 0x8a6aa0, hI: 1.3, fog: 0xf0aa98 },
};
for (const k in PAL) for (const f of ['top', 'hor', 'sun', 'hs', 'hg', 'fog']) PAL[k][f] = new THREE.Color(PAL[k][f]);

export class DayNight {
  constructor(scene) {
    this.hour = 9.0;
    this.sky = new SkyDome();
    scene.add(this.sky.mesh);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = true;
    const sc = this.sun.shadow;
    sc.mapSize.set(2048, 2048);
    sc.camera.left = -55; sc.camera.right = 55; sc.camera.top = 55; sc.camera.bottom = -55;
    sc.camera.near = 10; sc.camera.far = 360;
    sc.bias = -0.0004; sc.normalBias = 0.35;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x88cc66, 1.5);
    scene.add(this.hemi);
    scene.fog = new THREE.Fog(0xcbeaff, 90, 560);
    this.scene = scene;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.night = 0;
    this.elev = 1;
    this._c = new THREE.Color();
    this.apply();
  }

  mixCol(out, f, dayness, dusk) {
    out.copy(PAL.night[f]).lerp(PAL.day[f], dayness).lerp(PAL.dusk[f], dusk * 0.85);
    return out;
  }

  apply() {
    const ang = ((this.hour - 6) / 12) * Math.PI;
    const sd = this.sunDir.set(Math.cos(ang) * 0.9, Math.sin(ang), 0.35).normalize();
    const e = sd.y;
    this.elev = e;
    const dayness = sstep(-0.12, 0.35, e);
    const dusk = Math.exp(-Math.pow(e / 0.24, 2));
    this.night = 1 - sstep(-0.18, 0.12, e);
    const U = this.sky.uniforms;
    this.mixCol(U.uTop.value, 'top', dayness, dusk);
    this.mixCol(U.uHor.value, 'hor', dayness, dusk);
    U.uSunDir.value.copy(sd);
    U.uSunCol.value.copy(PAL.day.sun);
    U.uGlow.value.set(1.0, 0.55, 0.3).multiplyScalar(dusk * 1.1);
    U.uNight.value = this.night;
    this.scene.fog.color.copy(U.uHor.value);
    // key light swaps between sun and moon around the horizon, fading through 0
    const useSun = e > 0;
    this.sun.position.copy(sd).multiplyScalar(useSun ? 1 : -1);
    this.mixCol(this.sun.color, 'sun', dayness, dusk);
    const sunI = lerp(PAL.night.sunI, PAL.day.sunI, dayness) * (1 + dusk * -0.1);
    this.sun.intensity = sunI * sstep(0, 0.09, Math.abs(e)) * (useSun ? 1 : 0.6);
    this.mixCol(this.hemi.color, 'hs', dayness, dusk);
    this.mixCol(this.hemi.groundColor, 'hg', dayness, dusk);
    this.hemi.intensity = lerp(PAL.night.hI, PAL.day.hI, dayness);
  }

  update(dt, timeScale = 1) {
    this.hour = (this.hour + (dt * timeScale * 24) / 720) % 24;
    this.sky.uniforms.uTime.value += dt;
    this.apply();
  }

  follow(camera, target) {
    this.sky.mesh.position.copy(camera.position);
    const s = this.sun;
    const L = this.sunDir.clone().multiplyScalar(this.elev > 0 ? 1 : -1).normalize();
    // snap the shadow frustum to texel increments in light space to stop shimmering
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), L).normalize();
    const up = new THREE.Vector3().crossVectors(L, right);
    const q = (110 / 2048) * 6;
    const tr = target.dot(right), tu = target.dot(up);
    const snapped = target.clone()
      .addScaledVector(right, Math.round(tr / q) * q - tr)
      .addScaledVector(up, Math.round(tu / q) * q - tu);
    s.target.position.copy(snapped);
    s.position.copy(snapped).addScaledVector(L, 150);
  }

  get clock() {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

// chunky toon clouds that drift around the player
export class CloudField {
  constructor(scene) {
    this.group = new THREE.Group();
    const rng = makeRng(99);
    this.mat = toon(0xffffff, { emissive: 0x9aa6d8, emissiveIntensity: 0.55, fog: true });
    const geo = new THREE.IcosahedronGeometry(1, 2);
    this.items = [];
    for (let i = 0; i < 22; i++) {
      const g = new THREE.Group();
      const n = 4 + Math.floor(rng() * 4);
      for (let k = 0; k < n; k++) {
        const m = new THREE.Mesh(geo, this.mat);
        const s = 9 + rng() * 11;
        m.scale.set(s * 1.3, s * 0.75, s);
        m.position.set((k - n / 2) * 11 + rng() * 5, rng() * 5, (rng() - 0.5) * 9);
        g.add(m);
      }
      const a = rng() * Math.PI * 2, r = 100 + rng() * 480;
      g.position.set(Math.cos(a) * r, 115 + rng() * 60, Math.sin(a) * r);
      g.rotation.y = rng() * 6;
      this.group.add(g);
      this.items.push(g);
    }
    scene.add(this.group);
  }
  update(dt, center, night) {
    for (const g of this.items) {
      g.position.x += dt * 2.2;
      const dx = g.position.x - center.x;
      if (dx > 600) g.position.x -= 1200;
      const dz = g.position.z - center.z;
      if (dz > 600) g.position.z -= 1200;
      if (dz < -600) g.position.z += 1200;
    }
    this.mat.emissiveIntensity = lerp(0.55, 0.05, night);
  }
}
