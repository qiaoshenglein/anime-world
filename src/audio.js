// Tiny WebAudio synth: sound effects + procedural pentatonic music box BGM
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.vol = 0.7;
    this.night = 0;
    this.bar = 0;
  }

  // 音量走设置面板，静音是独立开关（两者都改 master gain）
  setVol(v) {
    this.vol = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.vol, this.ctx.currentTime, 0.05);
  }

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.vol;
    this.master.connect(ctx.destination);
    // reverb
    const len = ctx.sampleRate * 2.6;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = ir;
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.55;
    this.verb.connect(this.verbGain).connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = 0.5;
    this.music.connect(this.master);
    this.music.connect(this.verb);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.8;
    this.sfxBus.connect(this.master);
    const vs = ctx.createGain(); vs.gain.value = 0.25; this.sfxBus.connect(vs).connect(this.verb);
    // wind
    const nb = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
    const wind = ctx.createBufferSource();
    wind.buffer = nb; wind.loop = true;
    const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 500; wf.Q.value = 0.6;
    const wg = ctx.createGain(); wg.gain.value = 0.05;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.12;
    const lg = ctx.createGain(); lg.gain.value = 0.035;
    lfo.connect(lg).connect(wg.gain);
    wind.connect(wf).connect(wg).connect(this.master);
    wind.start(); lfo.start();
    this.windGain = wg;
    this.nextT = ctx.currentTime + 0.3;
    this.step = 0;
    this.timer = setInterval(() => this.schedule(), 120);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.vol, this.ctx.currentTime, 0.05);
  }

  // ---------- music
  schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    const chords = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 55, 59, 64], [55, 59, 62, 65]];
    const sd = 0.32 + this.night * 0.08;
    while (this.nextT < ctx.currentTime + 0.6) {
      const s = this.step % 8, bar = Math.floor(this.step / 8) % 4;
      const ch = chords[bar], t = this.nextT;
      if (s === 0) {
        for (const n of ch) this.pad(mtof(n), t, sd * 8.2);
        this.tone(mtof(ch[0] - 12), t, sd * 3.5, 'sine', 0.16, this.music);
      }
      if (s === 4) this.tone(mtof(ch[0] - 12), t, sd * 2.5, 'sine', 0.1, this.music);
      const pat = [0, 2, 1, 3, 2, 3, 1, 2];
      if (Math.random() < 0.7 - this.night * 0.25) {
        const n = ch[pat[s]] + (s % 4 === 3 ? 24 : 12);
        this.bell(mtof(n), t, 0.09 + Math.random() * 0.04);
      }
      this.nextT += sd;
      this.step++;
    }
  }
  pad(f, t, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o2.type = 'sine';
    o.frequency.value = f; o2.frequency.value = f * 2.003;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.035, t + dur * 0.25);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g); o2.connect(g); g.connect(this.music);
    o.start(t); o2.start(t); o.stop(t + dur + 0.1); o2.stop(t + dur + 0.1);
  }
  bell(f, t, vol) {
    const ctx = this.ctx;
    for (const [m, v] of [[1, 1], [2.76, 0.25], [5.4, 0.08]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f * m;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol * v, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 1.4 / m + 0.2);
      o.connect(g); g.connect(this.music);
      o.start(t); o.stop(t + 1.8);
    }
  }
  tone(f, t, dur, type, vol, dest) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // ---------- sfx
  noise(dur, f0, f1, vol, type = 'bandpass', q = 1) {
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(this.sfxBus);
    s.start(t, Math.random() * 2); s.stop(t + dur + 0.05);
  }
  sweep(f0, f1, dur, vol, type = 'sine') {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.sfxBus);
    o.start(t); o.stop(t + dur + 0.05);
  }
  play(name) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    switch (name) {
      case 'jump': this.sweep(320, 720, 0.16, 0.12); break;
      case 'jump2': this.sweep(480, 1000, 0.18, 0.12); this.noise(0.15, 3000, 6000, 0.05, 'highpass'); break;
      case 'slash': this.noise(0.22, 1200, 5200, 0.22, 'bandpass', 1.2); this.sweep(900, 300, 0.12, 0.05, 'triangle'); break;
      case 'hit': this.sweep(220, 60, 0.14, 0.3, 'square'); this.noise(0.1, 2500, 500, 0.2); break;
      case 'hurt': this.sweep(500, 140, 0.3, 0.2, 'sawtooth'); break;
      case 'pickup': [0, 4, 7, 12].forEach((n, i) => this.tone(mtof(84 + n), t + i * 0.055, 0.5, 'sine', 0.12, this.sfxBus)); break;
      case 'heal': [0, 4, 7].forEach((n, i) => this.tone(mtof(72 + n), t + i * 0.08, 0.5, 'triangle', 0.1, this.sfxBus)); break;
      case 'land': this.noise(0.12, 500, 120, 0.2, 'lowpass'); break;
      case 'splash': this.noise(0.35, 1800, 300, 0.22, 'lowpass'); break;
      case 'special': this.sweep(200, 1600, 0.7, 0.2, 'sawtooth'); this.noise(0.9, 400, 6000, 0.18, 'bandpass'); [0, 7, 12, 19].forEach((n, i) => this.tone(mtof(72 + n), t + 0.3 + i * 0.07, 0.8, 'sine', 0.1, this.sfxBus)); break;
      case 'blip': this.tone(mtof(76 + Math.floor(Math.random() * 8)), t, 0.07, 'square', 0.035, this.sfxBus); break;
      case 'quest': [0, 4, 7, 12, 16].forEach((n, i) => this.tone(mtof(69 + n), t + i * 0.1, 0.9, 'triangle', 0.13, this.sfxBus)); break;
      case 'die': this.sweep(600, 80, 0.5, 0.18, 'triangle'); break;
      case 'slime': this.sweep(200, 420, 0.12, 0.1, 'sine'); break;
      case 'step': this.noise(0.05, 4000, 2000, 0.05, 'highpass'); break;
      case 'ui': this.tone(mtof(88), t, 0.12, 'sine', 0.08, this.sfxBus); break;
      // 新系统的反馈音：打卡/升级/烟花/许愿，都走清脆的木琴味，跟原曲同一把调
      case 'unlock': [12, 19, 24].forEach((n, i) => this.tone(mtof(81 + n), t + i * 0.06, 1.1, 'triangle', 0.1, this.sfxBus)); break;
      case 'level': [0, 5, 9, 12, 17].forEach((n, i) => this.tone(mtof(74 + n), t + i * 0.05, 0.7, 'sine', 0.11, this.sfxBus)); break;
      case 'firework': this.noise(0.5, 900, 5200, 0.12, 'bandpass'); [0, 7, 12].forEach((n, i) => this.tone(mtof(90 + n), t + 0.18 + i * 0.05, 1.3, 'sine', 0.07, this.sfxBus)); break;
      case 'wish': [0, 4, 7, 11, 14].forEach((n, i) => this.tone(mtof(84 + n), t + i * 0.11, 1.6, 'sine', 0.09, this.sfxBus)); break;
      // 星屑弹：出手清脆，满蓄多一层泛音，命中收在高频——远弹只用一声轻响，不盖过风声
      case 'charge': this.sweep(420, 900, 0.5, 0.05, 'triangle'); break;
      case 'shot': this.sweep(1500, 520, 0.18, 0.13, 'triangle'); this.noise(0.12, 4200, 1400, 0.06, 'bandpass'); break;
      case 'shotFull': this.sweep(900, 2600, 0.14, 0.1, 'sawtooth'); this.sweep(1700, 620, 0.26, 0.15, 'triangle'); [0, 7, 12].forEach((n, i) => this.tone(mtof(86 + n), t + i * 0.04, 0.5, 'sine', 0.06, this.sfxBus)); break;
      case 'shotHit': this.tone(mtof(96), t, 0.16, 'sine', 0.085, this.sfxBus); this.noise(0.1, 5200, 1800, 0.07, 'highpass'); break;
      case 'shotFar': this.sweep(1100, 500, 0.16, 0.045, 'sine'); break;
    }
  }
  update(night, inWater) {
    this.night = night;
  }
}
