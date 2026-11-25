/* ================================================================
   赤龍斬 —— 共用工具：灰階、數學、光暈貼圖、
   3D 立體音效（有遠近：近大遠小、左右聲道、遠處多一點回音）、悲壯配樂
   全部用 Web Audio 即時合成，不用外部音檔
   ================================================================ */
import * as THREE from 'three';

/* 全場共用的 uniform：uGray 0＝正常，1＝全灰（死亡時） */
export const U = { gray: { value: 0 } };

/* 讓 three.js 內建材質也跟著 uGray 變灰 */
export function G(mat) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uGray = U.gray;
    sh.fragmentShader = 'uniform float uGray;\n' + sh.fragmentShader.replace(/}\s*$/,
      '  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(dot(gl_FragColor.rgb, vec3(.3,.59,.11))), uGray);\n}');
  };
  mat.customProgramCacheKey = () => 'gray';
  return mat;
}

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/* 圓形光暈貼圖 */
export function glowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,170,70,.55)') {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(0.25, outer); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* ================================================================
   音效引擎
   ================================================================ */
let ac = null, master = null, sfxBus = null, musicBus = null, verb = null, verbIn = null;
let noiseBuf = null, crackleBuf = null, distCurve = null;
export function initAudio() {
  try {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      ac = new AC();
      master = ac.createGain(); master.gain.value = 0.9;
      const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 5;
      master.connect(comp); comp.connect(ac.destination);
      sfxBus = ac.createGain(); sfxBus.connect(master);
      musicBus = ac.createGain(); musicBus.gain.value = 0; musicBus.connect(master);
      // 回音（空曠戶外的尾音）
      verb = ac.createConvolver(); verb.buffer = impulse(2.6, 2.4);
      verbIn = ac.createGain(); verbIn.gain.value = 1; verbIn.connect(verb);
      const vOut = ac.createGain(); vOut.gain.value = 0.55; verb.connect(vOut); vOut.connect(master);
      // 白噪音
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // 火焰劈啪聲：稀疏的爆裂脈衝
      crackleBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const c = crackleBuf.getChannelData(0);
      for (let k = 0; k < 90; k++) {
        const at = Math.floor(Math.random() * (c.length - 2000)), len = 80 + Math.random() * 900, amp = 0.3 + Math.random() * 0.7;
        for (let i = 0; i < len; i++) c[at + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / (len * 0.25));
      }
      // 失真曲線（讓吼聲、爆炸更粗獷）
      distCurve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; distCurve[i] = Math.tanh(x * 3.2); }
    }
    if (ac.state === 'suspended') ac.resume();
    loadSamples();
  } catch {}
}
export const audioReady = () => !!ac && ac.state === 'running';
const ok = audioReady;
function impulse(sec, decay) {
  const n = Math.floor(ac.sampleRate * sec), b = ac.createBuffer(2, n, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay) * (i < 200 ? i / 200 : 1);
  }
  return b;
}

/* ---------- 聽者（手機）位置：每一幀由遊戲更新 ---------- */
const L = { x: 0, y: 0, z: 0 };
export function setListener(pos, fwd, up) {
  if (!ac) return;
  L.x = pos.x; L.y = pos.y; L.z = pos.z;
  const l = ac.listener, t = ac.currentTime;
  if (l.positionX) {
    l.positionX.setTargetAtTime(pos.x, t, 0.02); l.positionY.setTargetAtTime(pos.y, t, 0.02); l.positionZ.setTargetAtTime(pos.z, t, 0.02);
    l.forwardX.setTargetAtTime(fwd.x, t, 0.02); l.forwardY.setTargetAtTime(fwd.y, t, 0.02); l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
    l.upX.setTargetAtTime(up.x, t, 0.02); l.upY.setTargetAtTime(up.y, t, 0.02); l.upZ.setTargetAtTime(up.z, t, 0.02);
  } else { l.setPosition(pos.x, pos.y, pos.z); l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
}

/* ---------- 一個「發聲點」：放在 3D 空間某處，距離越遠越小聲 ----------
   ref：這個距離以內是全音量；roll：衰減快慢 */
function voice(pos, { ref = 1.5, roll = 1.1, wet = null } = {}) {
  const input = ac.createGain();
  if (!pos) { input.connect(sfxBus); const s = ac.createGain(); s.gain.value = wet ?? 0.12; input.connect(s); s.connect(verbIn); return { input, set() {}, end() {} }; }
  const p = ac.createPanner();
  p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = ref; p.rolloffFactor = roll; p.maxDistance = 200;
  const send = ac.createGain();
  input.connect(p); p.connect(sfxBus); input.connect(send); send.connect(verbIn);
  const set = (q, smoothT = 0) => {
    const t = ac.currentTime;
    if (p.positionX) {
      if (smoothT) { p.positionX.setTargetAtTime(q.x, t, smoothT); p.positionY.setTargetAtTime(q.y, t, smoothT); p.positionZ.setTargetAtTime(q.z, t, smoothT); }
      else { p.positionX.setValueAtTime(q.x, t); p.positionY.setValueAtTime(q.y, t); p.positionZ.setValueAtTime(q.z, t); }
    } else p.setPosition(q.x, q.y, q.z);
    // 越遠，回音比例越高（聽起來更遠）；但回音本身也會跟著距離變小
    const d = Math.hypot(q.x - L.x, q.y - L.y, q.z - L.z);
    const dry = ref / (ref + roll * Math.max(0, d - ref));
    send.gain.setTargetAtTime(wet ?? clamp(0.06 + d / 40, 0.06, 0.45) * Math.max(0.25, dry * 1.6), t, 0.05);
  };
  set(pos);
  return { input, set, end(at) { setTimeout(() => { try { input.disconnect(); p.disconnect(); send.disconnect(); } catch {} }, Math.max(0, (at - ac.currentTime) * 1000) + 300); } };
}

/* ---------- 基本音源 ---------- */
function env(g, t, a, peak, dec, curve = 'exp') {
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
  else { g.gain.setValueAtTime(peak, t + a + dec * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); }
}
function noise(out, t, dur, type, f0, f1, peak, a = 0.01, q = 1, buf = noiseBuf) {
  const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = ac.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + a + dur);
  const g = ac.createGain(); env(g, t, a, peak, dur); s.connect(f); f.connect(g); g.connect(out);
  s.start(t, Math.random() * 1.5); s.stop(t + a + dur + 0.05); return t + a + dur;
}
function tone(out, t, type, f0, f1, dur, peak, a = 0.005) {
  const o = ac.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + a + dur);
  const g = ac.createGain(); env(g, t, a, peak, dur); o.connect(g); g.connect(out); o.start(t); o.stop(t + a + dur + 0.05); return t + a + dur;
}
function shaper(out, amount = 1) { const w = ac.createWaveShaper(); w.curve = distCurve; w.oversample = '2x'; const g = ac.createGain(); g.gain.value = amount; w.connect(g); g.connect(out); return w; }

/* ---------- 錄好的音檔（真實音效／戰鬥配樂）：有就用音檔，沒有就退回即時合成 ---------- */
const SAMPLE_FILES = {
  fireLaunch: 'audio/sfx/fire-launch.mp3', fireLoop: 'audio/sfx/fire-loop.mp3', boom: 'audio/sfx/explosion.mp3',
  sword: 'audio/sfx/sword-draw.mp3', swordLoop: 'audio/sfx/sword-fly.mp3',
  battle: 'audio/battle-wuxia.mp3',
};
const BUF = {}; export const loadedSounds = () => Object.keys(BUF); let loading = false;
function loadSamples() {
  if (loading || !ac) return; loading = true;
  for (const [k, url] of Object.entries(SAMPLE_FILES)) {
    fetch(url).then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status))
      .then(a => new Promise((res, rej) => ac.decodeAudioData(a, res, rej)))
      .then(b => { BUF[k] = b; if (k === 'battle' && BattleMusic.want) BattleMusic.start(); })
      .catch(() => {});
  }
}
// 在 3D 位置播放一個音檔；loop＝持續音（跟著物體移動），回傳 { set(pos), stop() }
function sample(name, pos, { ref = 2, roll = 1.1, gain = 1, loop = false, rate = 1, wet = null, fadeIn = 0 } = {}) {
  const b = BUF[name]; if (!b) return null;
  const t = ac.currentTime, vc = voice(pos, { ref, roll, wet });
  const s = ac.createBufferSource(); s.buffer = b; s.loop = loop; s.playbackRate.value = rate * (0.96 + Math.random() * 0.08);
  const g = ac.createGain(); g.gain.value = gain;
  if (fadeIn) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + fadeIn); }
  s.connect(g); g.connect(vc.input); s.start(t, loop ? Math.random() * b.duration * 0.5 : 0);
  let alive = true;
  if (!loop) vc.end(t + b.duration / s.playbackRate.value + 0.1);
  return {
    set(q, k = 0.03) { if (alive) vc.set(q, k); },
    stop(f = 0.15) { if (!alive) return; alive = false; const e = ac.currentTime; g.gain.cancelScheduledValues(e); g.gain.setValueAtTime(Math.max(0.0002, g.gain.value), e); g.gain.exponentialRampToValueAtTime(0.0001, e + f); s.stop(e + f + 0.05); vc.end(e + f); },
    rate: s.playbackRate,
  };
}

/* ---------- 戰鬥配樂：原創武俠風（笛子、琵琶、二胡、弦樂、戰鼓），無縫循環 ---------- */
const BATTLE_LOOP_START = 5.42;   // 前奏只播一次，之後從這裡循環
export const BattleMusic = {
  want: false, src: null, gain: null, vol: 0.55,
  start() {
    this.want = true; if (!ac || this.src || !BUF.battle) return;
    const t = ac.currentTime, s = ac.createBufferSource(), g = ac.createGain();
    s.buffer = BUF.battle; s.loop = true; s.loopStart = BATTLE_LOOP_START; s.loopEnd = BUF.battle.duration;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(this.vol, t + 1.5);
    s.connect(g); g.connect(master); s.start(t); this.src = s; this.gain = g;
  },
  stop(fade = 2) {
    this.want = false; if (!this.src) return;
    const t = ac.currentTime, s = this.src, g = this.gain; this.src = this.gain = null;
    g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(0.0002, g.gain.value), t); g.gain.exponentialRampToValueAtTime(0.0001, t + fade); s.stop(t + fade + 0.1);
  },
  get playing() { return !!this.src; },
};

/* ================================================================
   音效
   pos：THREE.Vector3（在場景中的位置）；不給＝貼在耳邊
   ================================================================ */
export const SFX = {
  /* 邪龍吼叫：低沉的喉音＋撕裂的氣聲，母音從「嗚」張開到「啊」 */
  roar(pos, v = 1) {
    if (!ok()) return; const t = ac.currentTime + 0.02, dur = 1.5 + 0.9 * v;
    const vc = voice(pos, { ref: 4, roll: 1 });
    const grit = shaper(vc.input, 0.55 * Math.min(1.4, v));
    const f1 = ac.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 3; f1.frequency.setValueAtTime(280, t); f1.frequency.linearRampToValueAtTime(700, t + dur * 0.35); f1.frequency.linearRampToValueAtTime(380, t + dur);
    const f2 = ac.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 4; f2.frequency.setValueAtTime(650, t); f2.frequency.linearRampToValueAtTime(1250, t + dur * 0.35); f2.frequency.linearRampToValueAtTime(800, t + dur);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    const mix = ac.createGain(); env(mix, t, 0.18, 1, dur, 'hold');
    f1.connect(lp); f2.connect(lp); lp.connect(mix); mix.connect(grit);
    const trem = ac.createGain(); trem.gain.value = 0.6; trem.connect(f1); trem.connect(f2);
    const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 31; lg.gain.value = 0.4; lfo.connect(lg); lg.connect(trem.gain);
    for (const [base, det] of [[58, 0], [58, 7], [87, -5], [116, 4]]) {
      const o = ac.createOscillator(); o.type = 'sawtooth'; o.detune.value = det * 10;
      o.frequency.setValueAtTime(base * 0.8, t); o.frequency.linearRampToValueAtTime(base * 1.35, t + dur * 0.3); o.frequency.exponentialRampToValueAtTime(base * 0.62, t + dur);
      o.connect(trem); o.start(t); o.stop(t + dur + 0.3);
    }
    lfo.start(t); lfo.stop(t + dur + 0.3);
    // 氣聲與嘶啞
    noise(vc.input, t, dur, 'bandpass', 900, 420, 0.55 * Math.min(1.4, v), 0.15, 1.2);
    noise(grit, t + 0.05, dur * 0.8, 'lowpass', 500, 150, 0.4, 0.2, 0.7);
    // 胸腔共鳴
    tone(vc.input, t, 'sine', 48, 38, dur, 0.55 * Math.min(1.4, v), 0.25);
    vc.end(t + dur + 0.4);
  },
  /* 嘴裡蓄火：低頻轟鳴越來越亮，夾雜劈啪聲 */
  charge(pos) {
    if (!ok()) return; const t = ac.currentTime, vc = voice(pos, { ref: 3, roll: 1 });
    noise(vc.input, t, 1.3, 'lowpass', 180, 2200, 0.55, 0.9, 1.5);
    noise(vc.input, t, 1.3, 'highpass', 1500, 2500, 0.35, 0.8, 0.7, crackleBuf);
    tone(vc.input, t, 'sawtooth', 45, 90, 1.3, 0.12, 0.9);
    vc.end(t + 2.4);
  },
  /* 火球飛行：持續的火焰呼嘯＋劈啪，會跟著火球移動。回傳 { set(pos), stop() } */
  fireLoop(pos) {
    if (!ok()) return null;
    { const s = sample('fireLoop', pos, { ref: 1.6, roll: 1.25, gain: 1, loop: true, fadeIn: 0.2 });
      if (s) return { set(q, speed = 0) { s.set(q); s.rate.setTargetAtTime(0.9 + Math.min(0.35, speed * 0.03), ac.currentTime, 0.1); }, stop() { s.stop(0.15); } }; } const t = ac.currentTime, vc = voice(pos, { ref: 1.6, roll: 1.25 });
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1, t + 0.25); g.connect(vc.input);
    const roarS = ac.createBufferSource(); roarS.buffer = noiseBuf; roarS.loop = true;
    const rf = ac.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 650; rf.Q.value = 2;
    const rg = ac.createGain(); rg.gain.value = 0.7; roarS.connect(rf); rf.connect(rg); rg.connect(g);
    const flick = ac.createOscillator(), fg = ac.createGain(); flick.frequency.value = 7; fg.gain.value = 0.25; flick.connect(fg); fg.connect(rg.gain);
    const cr = ac.createBufferSource(); cr.buffer = crackleBuf; cr.loop = true;
    const cf = ac.createBiquadFilter(); cf.type = 'highpass'; cf.frequency.value = 1200;
    const cg = ac.createGain(); cg.gain.value = 0.55; cr.connect(cf); cf.connect(cg); cg.connect(g);
    const hiss = ac.createBufferSource(); hiss.buffer = noiseBuf; hiss.loop = true;
    const hf = ac.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 2600; hf.Q.value = 0.8;
    const hg = ac.createGain(); hg.gain.value = 0.12; hiss.connect(hf); hf.connect(hg); hg.connect(g);
    for (const s of [roarS, flick, cr, hiss]) s.start(t, s.buffer ? Math.random() : 0);
    let alive = true;
    return {
      set(q, speed = 0) { if (!alive) return; vc.set(q, 0.03); rf.frequency.setTargetAtTime(650 + speed * 110, ac.currentTime, 0.1); },
      stop() {
        if (!alive) return; alive = false; const e = ac.currentTime;
        g.gain.cancelScheduledValues(e); g.gain.setValueAtTime(Math.max(0.0002, g.gain.value), e); g.gain.exponentialRampToValueAtTime(0.0001, e + 0.15);
        for (const s of [roarS, flick, cr, hiss]) s.stop(e + 0.2);
        vc.end(e + 0.2);
      },
    };
  },
  /* 火球出口：一陣噴射的呼聲 */
  whoosh(pos) {
    if (!ok()) return; if (sample('fireLaunch', pos, { ref: 3, roll: 1, gain: 1 })) return; const t = ac.currentTime, vc = voice(pos, { ref: 3, roll: 1 });
    noise(vc.input, t, 0.8, 'bandpass', 250, 1600, 0.7, 0.04, 1.1);
    noise(vc.input, t, 0.5, 'lowpass', 900, 120, 0.5, 0.01, 0.8);
    tone(vc.input, t, 'sine', 90, 45, 0.5, 0.4, 0.01);
    vc.end(t + 1.2);
  },
  /* 爆炸：低頻衝擊＋碎裂劈啪＋長尾音 */
  boom(pos, v = 1) {
    if (!ok()) return; if (sample('boom', pos, { ref: 2.5, roll: 1.05, gain: v })) return; const t = ac.currentTime, vc = voice(pos, { ref: 2.5, roll: 1.05 });
    const grit = shaper(vc.input, 0.7 * v);
    tone(grit, t, 'sine', 95, 28, 0.9, 1.0 * v, 0.004);
    tone(vc.input, t, 'triangle', 60, 25, 1.2, 0.6 * v, 0.004);
    noise(grit, t, 1.6, 'lowpass', 4200, 70, 1.0 * v, 0.003, 0.8);
    noise(vc.input, t + 0.03, 1.3, 'highpass', 1600, 700, 0.55 * v, 0.01, 0.7, crackleBuf);
    noise(vc.input, t + 0.15, 2.2, 'lowpass', 600, 60, 0.35 * v, 0.3, 0.6);
    vc.end(t + 2.8);
  },
  /* 御劍術出手：金屬出鞘的清亮「鏘——」＋破空聲（在手機旁邊，最大聲） */
  sword(pos) {
    if (!ok()) return; if (sample('sword', pos || null, { ref: 1, roll: 1, gain: 1, wet: 0.2 })) return; const t = ac.currentTime, vc = voice(pos || null, { ref: 1, roll: 1, wet: 0.2 });
    for (const [f, p, d] of [[2093, 0.16, 1.4], [3136, 0.11, 1.1], [4186, 0.08, 0.9], [5274, 0.05, 0.7], [1318, 0.09, 1.6]])
      tone(vc.input, t + 0.02, 'sine', f * 0.985, f, d, p, 0.003);
    noise(vc.input, t, 0.12, 'highpass', 5000, 3000, 0.45, 0.002, 0.7);           // 出鞘摩擦
    noise(vc.input, t + 0.05, 0.6, 'bandpass', 500, 3800, 0.5, 0.06, 2.5);        // 破空
    tone(vc.input, t, 'sine', 160, 70, 0.4, 0.25, 0.02);
    vc.end(t + 2);
  },
  /* 劍在空中飛：細細的劍鳴，跟著劍移動，越飛越遠越小聲。回傳 { set(pos), stop() } */
  swordLoop(pos) {
    if (!ok()) return null;
    { const s = sample('swordLoop', pos, { ref: 1, roll: 1.4, gain: 0.9, loop: true, fadeIn: 0.12 }); if (s) return { set(q) { s.set(q); }, stop() { s.stop(0.1); } }; } const t = ac.currentTime, vc = voice(pos, { ref: 1, roll: 1.4 });
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.15); g.connect(vc.input);
    const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 9;
    s.connect(f); f.connect(g);
    const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = 2350; const og = ac.createGain(); og.gain.value = 0.05; o.connect(og); og.connect(g);
    const vib = ac.createOscillator(), vg = ac.createGain(); vib.frequency.value = 9; vg.gain.value = 40; vib.connect(vg); vg.connect(o.frequency); vg.connect(f.frequency);
    s.start(t); o.start(t); vib.start(t);
    let alive = true;
    return {
      set(q) { if (alive) vc.set(q, 0.03); },
      stop() { if (!alive) return; alive = false; const e = ac.currentTime; g.gain.cancelScheduledValues(e); g.gain.setValueAtTime(Math.max(0.0002, g.gain.value), e); g.gain.exponentialRampToValueAtTime(0.0001, e + 0.1); for (const x of [s, o, vib]) x.stop(e + 0.15); vc.end(e + 0.15); },
    };
  },
  /* 劍刺中龍 */
  stab(pos) {
    if (!ok()) return; const t = ac.currentTime, vc = voice(pos, { ref: 3, roll: 1 });
    noise(vc.input, t, 0.25, 'bandpass', 1800, 400, 0.8, 0.002, 1.5);
    tone(vc.input, t, 'sine', 130, 50, 0.3, 0.7, 0.002);
    for (const [f, p] of [[1760, 0.12], [2640, 0.07]]) tone(vc.input, t, 'sine', f, f * 0.99, 0.6, p, 0.002);
    vc.end(t + 1);
  },
  /* 劍插進牆、樹 */
  clang(pos) {
    if (!ok()) return; const t = ac.currentTime, vc = voice(pos, { ref: 2, roll: 1.1 });
    for (const [f, p] of [[1240, 0.3], [1870, 0.18], [2630, 0.12], [3720, 0.07]]) tone(vc.input, t, 'triangle', f, f * 0.985, 0.9, p, 0.001);
    noise(vc.input, t, 0.08, 'highpass', 3000, 3000, 0.4, 0.001, 0.7);
    vc.end(t + 1.3);
  },
  /* 大鑼（龍出場、勝利） */
  gong(pos, v = 1) {
    if (!ok()) return; const t = ac.currentTime, vc = voice(pos || null, { ref: 4, roll: 1, wet: pos ? null : 0.35 });
    for (const [f, p] of [[98, 0.45], [147, 0.3], [196, 0.18], [233, 0.16], [311, 0.1], [415, 0.06]]) tone(vc.input, t, 'sine', f * 1.01, f * 0.985, 3.6, p * v, 0.012);
    noise(vc.input, t, 0.5, 'lowpass', 1200, 200, 0.25 * v, 0.005);
    vc.end(t + 4);
  },
  hurt() { if (!ok()) return; const t = ac.currentTime, vc = voice(null, { wet: 0.08 }); tone(vc.input, t, 'sawtooth', 200, 70, 0.35, 0.3); noise(vc.input, t, 0.35, 'lowpass', 1400, 200, 0.5); vc.end(t + 0.6); },
  ready() { if (!ok()) return; const t = ac.currentTime, vc = voice(null, { wet: 0.2 }); tone(vc.input, t, 'sine', 880, 880, 0.18, 0.16); tone(vc.input, t + 0.1, 'sine', 1320, 1320, 0.3, 0.13); vc.end(t + 0.7); },
  /* 密技回血：清亮的鐘聲上行 */
  heal() {
    if (!ok()) return; const t = ac.currentTime, vc = voice(null, { wet: 0.45 });
    [523, 659, 784, 1047, 1319].forEach((f, i) => { tone(vc.input, t + i * 0.09, 'sine', f, f, 1.6, 0.14, 0.005); tone(vc.input, t + i * 0.09, 'sine', f * 2.01, f * 2.01, 0.8, 0.04, 0.005); });
    noise(vc.input, t, 1.2, 'highpass', 6000, 9000, 0.06, 0.3, 0.5);
    vc.end(t + 2.6);
  },
};

/* ================================================================
   悲壯配樂：D 小調五聲音階，二胡般的主旋律＋弦樂＋戰鼓＋大鑼
   66 拍／分，16 小節一輪（約 58 秒），之後循環
   ================================================================ */
const BPM = 66, BEAT = 60 / BPM;
const N = n => 440 * Math.pow(2, (n - 69) / 12);
// 主旋律 [音高(MIDI), 拍數]；null＝休止
const MEL = [
  [[69, 2], [67, 1], [65, 1]], [[62, 3], [null, 1]], [[65, 1], [67, 1], [69, 1.5], [72, 0.5]], [[69, 4]],
  [[74, 2], [72, 1], [69, 1]], [[67, 1.5], [69, 0.5], [65, 2]], [[67, 1], [65, 1], [62, 1], [60, 1]], [[62, 4]],
  [[69, 1], [72, 1], [74, 2]], [[77, 1.5], [76, 0.5], [74, 2]], [[72, 1], [74, 1], [69, 1], [67, 1]], [[69, 4]],
  [[74, 1.5], [77, 0.5], [79, 2]], [[77, 1], [74, 1], [72, 1], [69, 1]], [[67, 1], [69, 1], [65, 1], [64, 1]], [[62, 4]],
];
const CH = { Dm: [50, 57, 62, 65], Bb: [46, 53, 58, 62], F: [41, 53, 57, 60], C: [48, 55, 60, 64], Gm: [43, 55, 58, 62], A: [45, 57, 61, 64] };
const PROG = ['Dm', 'Dm', 'Bb', 'F', 'Dm', 'Bb', 'C', 'Dm', 'Dm', 'Bb', 'F', 'C', 'Gm', 'Bb', 'A', 'Dm'];

function erhu(t, midi, dur, prevMidi, loud) {
  const f = N(midi), o = ac.createOscillator(), o2 = ac.createOscillator(); o.type = 'sawtooth'; o2.type = 'sawtooth'; o2.detune.value = 6;
  // 滑音：從上一個音滑進來
  const from = prevMidi ? N(prevMidi) : f * 0.97;
  for (const x of [o, o2]) { x.frequency.setValueAtTime(from, t); x.frequency.exponentialRampToValueAtTime(f, t + Math.min(0.14, dur * 0.3)); }
  // 揉弦（顫音）：音拉長後才慢慢出來
  const vib = ac.createOscillator(), vg = ac.createGain(); vib.frequency.value = 5.6;
  vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(0.6, dur * 0.6));
  vib.connect(vg); vg.connect(o.frequency); vg.connect(o2.frequency);
  const body = ac.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 1050; body.Q.value = 1.4; body.gain.value = 9;
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.5;
  const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 260;
  const g = ac.createGain(), peak = 0.085 * loud;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.09);
  g.gain.linearRampToValueAtTime(peak * 1.15, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
  o.connect(body); o2.connect(body); body.connect(hp); hp.connect(lp); lp.connect(g); g.connect(musicBus);
  const s = ac.createGain(); s.gain.value = 0.55; g.connect(s); s.connect(verbIn);
  // 弓毛摩擦聲
  const bow = ac.createBufferSource(); bow.buffer = noiseBuf; const bf = ac.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = f * 3; bf.Q.value = 6;
  const bg = ac.createGain(); env(bg, t, 0.04, 0.02 * loud, dur); bow.connect(bf); bf.connect(bg); bg.connect(musicBus);
  for (const x of [o, o2, vib]) { x.start(t); x.stop(t + dur + 0.2); }
  bow.start(t, Math.random()); bow.stop(t + dur + 0.2);
}
function strings(t, notes, dur, loud) {
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900 + 500 * loud; lp.Q.value = 0.3;
  const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05 * loud, t + dur * 0.4); g.gain.setValueAtTime(0.05 * loud, t + dur * 0.75); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.6);
  lp.connect(g); g.connect(musicBus); const s = ac.createGain(); s.gain.value = 0.8; g.connect(s); s.connect(verbIn);
  for (const n of notes) for (const d of [-8, 8]) {
    const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = N(n); o.detune.value = d; o.connect(lp); o.start(t); o.stop(t + dur + 0.7);
  }
  // 大提琴根音
  const b = ac.createOscillator(); b.type = 'triangle'; b.frequency.value = N(notes[0] - 12);
  const bg = ac.createGain(); env(bg, t, 0.3, 0.12 * loud, dur + 0.3, 'hold'); b.connect(bg); bg.connect(musicBus); b.start(t); b.stop(t + dur + 0.8);
}
function drum(t, v) {        // 戰鼓
  const o = ac.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.35);
  const g = ac.createGain(); env(g, t, 0.004, 0.55 * v, 0.7); o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + 0.8);
  const s = ac.createGain(); s.gain.value = 0.5; g.connect(s); s.connect(verbIn);
  noise(musicBus, t, 0.18, 'lowpass', 1600, 200, 0.18 * v, 0.002, 0.7);
}
function mGong(t, v) {
  for (const [f, p] of [[73, 0.3], [110, 0.2], [147, 0.14], [196, 0.09], [277, 0.06]]) {
    const o = ac.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(f * 1.01, t); o.frequency.exponentialRampToValueAtTime(f * 0.98, t + 5);
    const g = ac.createGain(); env(g, t, 0.02, p * v, 5); o.connect(g); g.connect(musicBus); const s = ac.createGain(); s.gain.value = 0.7; g.connect(s); s.connect(verbIn); o.start(t); o.stop(t + 5.2);
  }
}
let mus = null;
function schedBar(bar, t) {
  const b = bar % 16, loop = Math.floor(bar / 16), loud = b < 8 ? 0.75 : b < 12 ? 0.95 : 1.15;
  strings(t, CH[PROG[b]], BEAT * 4, loud);
  // 主旋律（第一輪前兩小節只有弦樂鋪底，讓字幕先出來）
  if (!(loop === 0 && b < 2)) {
    let at = t, prev = mus.prev;
    for (const [m, d] of MEL[b]) { if (m) { erhu(at, m + (b >= 12 ? 0 : 0), d * BEAT, prev, loud); prev = m; } at += d * BEAT; }
    mus.prev = prev;
  }
  // 戰鼓：前半每小節一下，後半兩下，第 12 小節尾滾奏
  drum(t, 0.7 * loud); if (b >= 8) drum(t + BEAT * 2, 0.55 * loud);
  if (b === 11) for (let k = 0; k < 6; k++) drum(t + BEAT * 3 + k * BEAT / 6, 0.25 + k * 0.08);
  if (b === 0 || b === 12) mGong(t, b === 12 ? 1.2 : 0.9);
}
export const Music = {
  start() {
    if (!ok() || mus) return;
    musicBus.gain.cancelScheduledValues(ac.currentTime); musicBus.gain.setValueAtTime(0.0001, ac.currentTime); musicBus.gain.exponentialRampToValueAtTime(0.9, ac.currentTime + 2);
    mus = { bar: 0, next: ac.currentTime + 0.15, prev: null };
    const tick = () => { if (!mus) return; while (mus.next < ac.currentTime + 1.2) { schedBar(mus.bar, mus.next); mus.bar++; mus.next += BEAT * 4; } };
    tick(); mus.timer = setInterval(tick, 250);
  },
  stop(fade = 2.5) {
    if (!mus || !ac) return; clearInterval(mus.timer); mus = null;
    const t = ac.currentTime; musicBus.gain.cancelScheduledValues(t); musicBus.gain.setValueAtTime(Math.max(0.0002, musicBus.gain.value), t); musicBus.gain.exponentialRampToValueAtTime(0.0001, t + fade);
  },
  get playing() { return !!mus; },
  mute(m) { if (ac) master.gain.setTargetAtTime(m ? 0 : 0.9, ac.currentTime, 0.1); },
};
