/* ================================================================
   赤龍斬 —— 實境擴增場域座標系統（第一版）
   1. 環場掃描：深度感測＋平面偵測＋命中測試 → 50 公尺內的粗略方格模型
   2. 手機位置一律用「場域座標」（以掃描起點為原點、重力為下、跟著真實景物固定）
   3. 邪龍、火球、御劍術都在這個座標系裡運算與碰撞
   ================================================================ */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { U, G, clamp, lerp, smooth, glowTexture, initAudio, SFX, setListener, audioReady, BattleMusic, loadedSounds } from './common.js';
import { createDragon } from './dragon.js';

const $ = id => document.getElementById(id);

/* ---------------- 規則數字（都在這裡改） ---------------- */
const RULE = {
  fieldR: 50,            // 塑模範圍：以掃描起點為中心 50 公尺
  fieldTop: 30,          // 地面以上 30 公尺以內
  dragonDist: 10, dragonHP: 720, dragonTurn: 0.55,   // 邪龍：距離（手機深度偵測約 8～10 公尺內較準）、血量、轉身速度（弧度/秒）
  fireEvery: 6, fireFirst: 3, fireForm: 1.3, fireSpeed: 5, fireAccel: 2.5, fireR: 0.5,   // 火球：初速 5 m/s、加速度 2.5 m/s²（10 公尺約 1.5 秒到）
  fireTriple: 0.5, fireSpread: 0.24,   // 邪龍血量低於一半：一次吐三顆，左右各散開約 14 度
  hpStory: 425, hpSkip: 100,   // 看完故事的血量／跳過故事的血量
  userR: 0.35, maxDmg: 50, userMaxDmg: 20,   // maxDmg：劍打龍的最大傷害；userMaxDmg：火球打玩家的最大傷害
  swordSpeed: 3, swordCD: 5, swordDrop: 0.2, swordStick: 3, swordLen: 1.1,
  dragonDmgR: 3.2,       // 劍離標誌中心 0 公尺 → 50 點；3.2 公尺以外 → 最少 3 點
  dragonBarShow: 10, dragonBarHit: 5,
};
const CELL = 0.4, OCC_N = 2.5, SECTORS = 12;

/* ================= 登入 ================= */
let fb = null, user = null;
(async () => {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg) return;
  try {
    const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
    const [app, au] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js')]);
    const a = app.initializeApp(cfg), auth = au.getAuth(a); auth.languageCode = 'zh-TW';
    fb = { au, auth };
    $('fbArea').style.display = 'flex';
    au.onAuthStateChanged(auth, u => { if (u) enterHome({ name: u.displayName || u.email || '斬龍者', fb: true }); });
  } catch (e) { /* 登入服務載入失敗：只留「開始」按鈕 */ }
})();
const AUTH_ERR = {
  'auth/invalid-email': 'Email 格式不對', 'auth/missing-password': '請輸入密碼', 'auth/invalid-credential': 'Email 或密碼不對',
  'auth/email-already-in-use': '這個 Email 已經註冊過了，請直接登入', 'auth/weak-password': '密碼至少要 6 個字元',
  'auth/popup-closed-by-user': '登入視窗被關掉了，再試一次', 'auth/unauthorized-domain': '這個網址還沒加入 Firebase 的授權網域',
  'auth/network-request-failed': '網路連線有問題，請稍後再試',
};
const authErr = e => { $('loginErr').textContent = AUTH_ERR[e.code] || ('登入失敗：' + (e.code || e.message)); };
$('gLogin').onclick = async () => { try { const p = new fb.au.GoogleAuthProvider(); await fb.au.signInWithPopup(fb.auth, p); } catch (e) { authErr(e); } };
$('loginForm').onsubmit = async e => { e.preventDefault(); if (!fb) return; try { await fb.au.signInWithEmailAndPassword(fb.auth, $('email').value.trim(), $('pw').value); } catch (er) { authErr(er); } };
$('eSignup').onclick = async () => { try { await fb.au.createUserWithEmailAndPassword(fb.auth, $('email').value.trim(), $('pw').value); } catch (e) { authErr(e); } };
$('guest').onclick = () => { initAudio(); enterHome({ name: '訪客', fb: false }); };
$('logout').onclick = async () => { if (user?.fb && fb) await fb.au.signOut(fb.auth); user = null; show('loginScr'); };
$('replayStory').onclick = () => { initAudio(); startStory(); };
function show(id) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('show', s.id === id);  document.body.classList.toggle('story', id === 'storyScr'); }
function enterHome(u) { user = u; $('who').textContent = '斬龍者：' + u.name; startStory(); }
function toHome() {
  show('homeScr'); checkMic();
  const hp = S.maxHP;
  $('hpInfo').innerHTML = hp >= RULE.hpStory ? `你的血量：<b>${hp}</b>（已看完故事）` : `你的血量：<b>${hp}</b>（跳過了故事。看完故事，血量會提升為 ${RULE.hpStory}）`;
}

/* ================= 故事開場 ================= */
const STORY_MS = 56000;
const story = { anims: [], raf: 0, on: false, labelT: [] };
/* 故事配樂：管樂合奏《不良思緒漸漸散去》（Bad Thoughts Fade Away），作曲 Peter Bruno，正見網天音網 */
const StoryMusic = (() => {
  const a = $('storyBgm'); let fadeT = 0, want = 0, muted = false;
  a.volume = 0;
  const step = () => {
    clearInterval(fadeT);
    fadeT = setInterval(() => {
      const target = muted ? 0 : want, v = a.volume + clamp(target - a.volume, -0.04, 0.04);
      a.volume = clamp(v, 0, 1);
      if (Math.abs(a.volume - target) < 0.005) { a.volume = target; clearInterval(fadeT); if (target === 0 && want === 0) a.pause(); }
    }, 60);
  };
  return {
    start(vol = 0.85) { want = vol; if (a.paused) { if (a.ended || a.currentTime > a.duration - 1) a.currentTime = 0; a.play().catch(() => {}); } step(); },
    stop() { want = 0; step(); },
    restart() { a.currentTime = 0; this.start(); },
    mute(m) { muted = m; if (!m && want > 0 && a.paused) a.play().catch(() => {}); step(); },
    get playing() { return !a.paused && want > 0; },
  };
})();
function startStory() {
  stopStory(true);
  show('storyScr'); story.on = true;
  $('stEnd').classList.remove('show'); $('skipStory').style.display = '';
  for (const l of document.querySelectorAll('.st-label')) l.classList.remove('show');
  StoryMusic.mute(false); $('muteBtn').setAttribute('aria-pressed', 'false'); $('muteBtn').textContent = '♪ 配樂：開';
  StoryMusic.restart();
  requestAnimationFrame(() => {
    const box = $('crawlBox'), inner = $('crawl'), H = box.clientHeight, h = inner.scrollHeight;
    const a = inner.animate([{ transform: `translateY(${H}px)` }, { transform: `translateY(${Math.round(H * 0.42 - h)}px)` }], { duration: STORY_MS, easing: 'linear', fill: 'forwards' });
    a.onfinish = () => { if (story.on) storyEnd(); };
    // 鏡頭：從右邊（光明的大法弟子）慢慢推到左邊（邪惡的一方），最後停在邪龍和迫害元兇都看得到的位置
    const pan = $('stPan'), maxDx = Math.max(0, pan.offsetWidth - innerWidth);
    const endDx = clamp(pan.offsetWidth * 0.35 - innerWidth / 2, 0, maxDx);
    const b = pan.animate([{ transform: `translateX(${-maxDx}px) scale(1.08)` }, { transform: `translateX(${-endDx}px) scale(1)` }], { duration: STORY_MS * 0.9, easing: 'ease-in-out', fill: 'forwards' });
    story.anims.push(a, b);
    // 圖上的標示，跟著字幕依序出現
    for (const l of document.querySelectorAll('.st-label')) story.labelT.push(setTimeout(() => l.classList.add('show'), STORY_MS * +l.dataset.at));
  });
  storyWarp.start(); storyFx.start();
}
function storyEnd() { $('stEnd').classList.add('show'); $('skipStory').style.display = 'none'; }
function stopStory(keepMusic) {
  story.on = false; for (const a of story.anims) a.cancel(); story.anims.length = 0;
  for (const t of story.labelT) clearTimeout(t); story.labelT.length = 0;
  storyWarp.stop(); storyFx.stop(); if (!keepMusic) StoryMusic.stop();
}
$('skipStory').onclick = () => { S.maxHP = Math.max(S.watched ? RULE.hpStory : RULE.hpSkip, RULE.hpSkip); stopStory(); toHome(); };
$('beginBtn').onclick = () => { initAudio(); S.watched = true; S.maxHP = RULE.hpStory; stopStory(); toHome(); };
$('muteBtn').onclick = () => { initAudio(); const m = $('muteBtn').getAttribute('aria-pressed') !== 'true'; StoryMusic.mute(m); $('muteBtn').setAttribute('aria-pressed', m); $('muteBtn').textContent = m ? '♪ 配樂：關' : '♪ 配樂：開'; if (!m && !StoryMusic.playing && story.on) StoryMusic.start(); };
// 自動登入時沒有點擊，瀏覽器不讓音樂自己播放：第一次碰畫面時補播
$('storyScr').addEventListener('pointerdown', () => { initAudio(); if (story.on && !StoryMusic.playing && $('muteBtn').getAttribute('aria-pressed') !== 'true') StoryMusic.start(); });

/* 故事圖「微微會動」：用 WebGL 把圖局部扭動——邪龍的身體像蛇一樣起伏、龍頭擺動，
   癩蝦蟆精的喉囊鼓動、迫害元兇微微喘息，紅雲飄動、火焰熱浪晃動，右邊的雲與金光緩緩流動 */
const storyWarp = (() => {
  const c = $('stGL'), img = $('stImg');
  let gl = null, prog = null, tex = null, uT = null, raf = 0, t0 = 0, ready = false, W = 0, H = 0;
  const VS = `attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS = `precision mediump float; varying vec2 uv; uniform sampler2D img; uniform float t;
  float box(vec2 q, vec4 r, float f){ return smoothstep(r.x - f, r.x + f, q.x) * smoothstep(r.z + f, r.z - f, q.x) * smoothstep(r.y - f, r.y + f, q.y) * smoothstep(r.w + f, r.w - f, q.y); }
  vec2 rot(vec2 q, vec2 c, float a){ vec2 d = q - c; float s = sin(a), k = cos(a); return c + vec2(k * d.x - s * d.y, s * d.x + k * d.y); }
  void main(){
    vec2 q = uv;
    // 邪龍（左上）：蛇身起伏的波，從頭往尾巴傳
    float md = box(uv, vec4(0.0, 0.0, 0.57, 0.3), 0.06);
    q += md * vec2(sin(uv.y * 22.0 - t * 1.3 + uv.x * 6.0) * 0.0028, sin(uv.x * 16.0 + t * 1.1) * 0.0045);
    // 龍頭：繞著脖子緩緩擺動、上下點頭
    float mh = 1.0 - smoothstep(0.05, 0.16, distance(uv * vec2(1.5, 1.0), vec2(0.39 * 1.5, 0.13)));
    q = mix(q, rot(q, vec2(0.36, 0.24), 0.018 * sin(t * 0.8)) + vec2(0.0, 0.004 * sin(t * 1.15)), mh);
    // 龍爪與紅線：輕輕晃
    float mc = box(uv, vec4(0.1, 0.1, 0.56, 0.42), 0.05) * (1.0 - md * 0.5);
    q.x += mc * sin(t * 0.9 + uv.y * 9.0) * 0.0018;
    // 癩蝦蟆精的喉囊鼓動（左肩上）
    vec2 th = vec2(0.175, 0.37); float mt = 1.0 - smoothstep(0.0, 0.05, distance(uv * vec2(1.5, 1.0), th * vec2(1.5, 1.0)));
    q -= (uv - th) * mt * 0.22 * pow(0.5 + 0.5 * sin(t * 2.6), 3.0);
    // 迫害元兇：喘息
    float mj = box(uv, vec4(0.1, 0.22, 0.42, 0.66), 0.04);
    q.y -= mj * (uv.y - 0.66) * 0.006 * sin(t * 1.2);
    // 紅雲（左上背景）飄動
    float ms = box(uv, vec4(0.0, 0.0, 0.62, 0.22), 0.08);
    q.x += ms * sin(uv.y * 30.0 + t * 0.4) * 0.0012;
    // 地面與火焰的熱浪（左下）
    float mf = box(uv, vec4(0.0, 0.6, 0.55, 1.0), 0.06);
    q += mf * vec2(sin(uv.y * 80.0 - t * 3.2) * 0.0012, sin(uv.x * 60.0 + t * 2.5) * 0.0016);
    // 右上的雲與金光：緩緩流動
    float mg = box(uv, vec4(0.58, 0.0, 1.0, 0.28), 0.06);
    q.x += mg * sin(uv.y * 14.0 + t * 0.35) * 0.003;
    // 大法弟子：衣襬極輕微的晃動
    float mp = box(uv, vec4(0.55, 0.3, 1.0, 0.9), 0.04);
    q.x += mp * sin(uv.y * 40.0 + t * 0.9) * 0.0006;
    vec3 col = texture2D(img, clamp(q, 0.001, 0.999)).rgb;
    // 龍眼、元兇與蝦蟆的紅眼：脈動發光
    float pulse = 0.5 + 0.5 * sin(t * 1.7);
    float eyes = 0.0;
    eyes += 1.0 - smoothstep(0.0, 0.016, distance(uv * vec2(1.5, 1.0), vec2(0.376 * 1.5, 0.119)));
    eyes += 1.0 - smoothstep(0.0, 0.016, distance(uv * vec2(1.5, 1.0), vec2(0.408 * 1.5, 0.125)));
    eyes += 0.6 * (1.0 - smoothstep(0.0, 0.014, distance(uv * vec2(1.5, 1.0), vec2(0.173 * 1.5, 0.303))));
    eyes += 0.6 * (1.0 - smoothstep(0.0, 0.014, distance(uv * vec2(1.5, 1.0), vec2(0.21 * 1.5, 0.305))));
    eyes += 0.6 * (1.0 - smoothstep(0.0, 0.016, distance(uv * vec2(1.5, 1.0), vec2(0.327 * 1.5, 0.338))));
    eyes += 0.6 * (1.0 - smoothstep(0.0, 0.016, distance(uv * vec2(1.5, 1.0), vec2(0.36 * 1.5, 0.355))));
    col += eyes * pulse * vec3(0.55, 0.12, 0.0);
    gl_FragColor = vec4(col, 1.0);
  }`;
  function init() {
    try { gl = c.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false }); } catch {}
    if (!gl) return false;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    try {
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    } catch (e) { gl = null; return false; }
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    uT = gl.getUniformLocation(prog, 't');
    tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return true;
  }
  function upload() {
    if (ready || !img.complete || !img.naturalWidth) return;
    gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img); ready = true;
    c.style.visibility = 'visible';
  }
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    upload(); if (!ready) return;
    const k = Math.min(devicePixelRatio || 1, 1.5), w = Math.round(c.clientWidth * k), h = Math.round(c.clientHeight * k);
    if (w !== W || h !== H) { W = c.width = w; H = c.height = h; gl.viewport(0, 0, W, H); }
    gl.uniform1f(uT, (ts - t0) / 1000); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  return {
    start() { if (!gl && !init()) return; cancelAnimationFrame(raf); t0 = performance.now(); raf = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
})();

/* 故事圖上的光影：右邊的金光與光點，左邊的火星、煙霧、紅色脈動與閃電 */
const storyFx = (() => {
  const c = $('stFx'), x = c.getContext('2d'); let raf = 0, W = 0, H = 0, t0 = 0, flash = 0, nextFlash = 4;
  const motes = [], embers = [];
  function resize() { W = c.width = Math.round(c.clientWidth * Math.min(devicePixelRatio, 1.25)); H = c.height = Math.round(c.clientHeight * Math.min(devicePixelRatio, 1.25)); }
  function seed() {
    motes.length = embers.length = 0;
    for (let i = 0; i < 46; i++) motes.push({ x: 0.54 + Math.random() * 0.46, y: Math.random(), v: 0.006 + Math.random() * 0.012, r: 1 + Math.random() * 2.4, p: Math.random() * 6 });
    for (let i = 0; i < 90; i++) embers.push({ x: Math.random() * 0.55, y: Math.random(), v: 0.02 + Math.random() * 0.05, r: 0.8 + Math.random() * 2, p: Math.random() * 6, w: (Math.random() - 0.5) * 0.01 });
  }
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (c.clientWidth && Math.abs(c.clientWidth * Math.min(devicePixelRatio, 1.25) - W) > 2) resize();
    const t = (ts - t0) / 1000, dt = 1 / 60, s = W / 1536;
    x.clearRect(0, 0, W, H);
    x.globalCompositeOperation = 'lighter';
    // 金色光芒（右上，太陽的位置）
    for (let k = 0; k < 8; k++) {
      const a = Math.PI - (0.35 + k * 0.13) + Math.sin(t * 0.25 + k) * 0.03, len = H * 1.4, wd = 0.035 + 0.02 * Math.sin(t * 0.4 + k * 2);
      const ox = W * 0.91, oy = -H * 0.02;
      const g = x.createLinearGradient(ox, oy, ox + Math.cos(a) * len, oy + Math.sin(a) * len);
      g.addColorStop(0, `rgba(255,236,170,${0.14 + 0.07 * Math.sin(t * 0.6 + k)})`); g.addColorStop(1, 'rgba(255,220,140,0)');
      x.fillStyle = g; x.beginPath(); x.moveTo(ox, oy); x.lineTo(ox + Math.cos(a - wd) * len, oy + Math.sin(a - wd) * len); x.lineTo(ox + Math.cos(a + wd) * len, oy + Math.sin(a + wd) * len); x.fill();
    }
    for (const m of motes) {
      m.y -= m.v * dt; if (m.y < -0.02) { m.y = 1.02; m.x = 0.54 + Math.random() * 0.46; }
      const a = 0.35 + 0.35 * Math.sin(t * 1.5 + m.p), px = (m.x + Math.sin(t * 0.5 + m.p) * 0.006) * W, py = m.y * H;
      const g = x.createRadialGradient(px, py, 0, px, py, m.r * 4 * s * 2); g.addColorStop(0, `rgba(255,240,190,${a})`); g.addColorStop(1, 'rgba(255,220,120,0)');
      x.fillStyle = g; x.fillRect(px - m.r * 8 * s, py - m.r * 8 * s, m.r * 16 * s, m.r * 16 * s);
    }
    // 邪龍的紅色脈動
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.3);
    let g = x.createRadialGradient(W * 0.36, H * 0.16, 0, W * 0.36, H * 0.16, W * 0.28);
    g.addColorStop(0, `rgba(255,40,10,${0.08 + 0.1 * pulse})`); g.addColorStop(1, 'rgba(120,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    // 火星
    for (const e of embers) {
      e.y -= e.v * dt; e.x += e.w * dt + Math.sin(t * 2 + e.p) * 0.0004; if (e.y < -0.02) { e.y = 1.02; e.x = Math.random() * 0.55; }
      const a = 0.5 + 0.5 * Math.sin(t * 7 + e.p * 3), px = e.x * W, py = e.y * H, r = e.r * s * 3;
      x.fillStyle = `rgba(255,${120 + Math.round(80 * a)},40,${0.35 + 0.55 * a})`; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill();
    }
    // 偶爾的紅色閃電光
    if (t > nextFlash) { flash = 1; nextFlash = t + 5 + Math.random() * 6; }
    if (flash > 0.01) { x.fillStyle = `rgba(255,60,30,${flash * 0.22})`; x.fillRect(0, 0, W * 0.58, H * 0.5); flash *= 0.86; }
    x.globalCompositeOperation = 'source-over';
    // 左下的煙霧
    for (let k = 0; k < 4; k++) {
      const px = W * (0.05 + 0.12 * k + 0.03 * Math.sin(t * 0.15 + k)), py = H * (0.9 + 0.03 * Math.sin(t * 0.2 + k * 2));
      g = x.createRadialGradient(px, py, 0, px, py, W * 0.16); g.addColorStop(0, 'rgba(20,4,4,.35)'); g.addColorStop(1, 'rgba(20,4,4,0)');
      x.fillStyle = g; x.fillRect(px - W * 0.16, py - W * 0.16, W * 0.32, W * 0.32);
    }
  }
  return {
    start() { cancelAnimationFrame(raf); resize(); seed(); t0 = performance.now(); nextFlash = 4; raf = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
})();

/* ================= 手機能力檢查 ================= */
const supportEl = $('support');
(async () => {
  if (!window.isSecureContext) { supportEl.textContent = '這個網址不是 HTTPS，AR 無法啟動。'; supportEl.className = 'status bad'; return; }
  if (!navigator.xr) { supportEl.textContent = '這個瀏覽器不支援網頁 AR。請用 Android 手機的 Chrome 開啟，或先用模擬場景試玩。'; supportEl.className = 'status bad'; return; }
  let ok = false; try { ok = await navigator.xr.isSessionSupported('immersive-ar'); } catch {}
  if (!ok) { supportEl.textContent = '目前無法啟動 AR。請確認用 Chrome 開啟，並已更新「Google Play Services for AR」。'; supportEl.className = 'status bad'; return; }
  supportEl.textContent = '這支手機可以使用 AR。'; supportEl.className = 'status ok'; $('arBtn').disabled = false;
})();
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let micPerm = 'unknown';
async function checkMic() {
  if (!SR) { $('micBtn').textContent = '這個瀏覽器不支援語音辨識（可改按畫面上的御劍術）'; $('micBtn').disabled = true; return; }
  try { const p = await navigator.permissions.query({ name: 'microphone' }); micPerm = p.state; p.onchange = () => { micPerm = p.state; showMicPerm(); }; } catch {}
  showMicPerm();
}
function showMicPerm() {
  const b = $('micBtn'); b.disabled = false;
  if (micPerm === 'granted') { b.textContent = '✓ 麥克風已允許'; b.disabled = true; $('micHelp').classList.remove('show'); }
  else if (micPerm === 'denied') b.textContent = '麥克風被封鎖：點這裡重新允許';
  else b.textContent = '允許麥克風（喊「御劍術」用）';
}
/* 跳出瀏覽器的「允許使用麥克風」視窗。要在使用者點按時呼叫；進入 AR 之後瀏覽器不會跳視窗，所以進 AR 前先問 */
async function askMic(showHelp = true) {
  if (!SR || !navigator.mediaDevices?.getUserMedia) return false;
  if (micPerm === 'granted') return true;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop()); micPerm = 'granted'; showMicPerm(); return true;
  } catch (e) {
    let st = 'denied'; try { st = (await navigator.permissions.query({ name: 'microphone' })).state; } catch {}
    micPerm = st; showMicPerm();
    if (showHelp) {
      $('micHelpMsg').textContent = e && e.name === 'NotFoundError' ? '找不到麥克風，請確認手機或電腦有麥克風。'
        : st === 'denied' ? '麥克風先前被拒絕了，瀏覽器不會再自動詢問。請照下面的步驟打開：'
        : '剛剛沒有允許麥克風。請再按一次「重新要求權限」，在跳出的視窗選「允許」。';
      $('micHelp').querySelector('ol').style.display = st === 'denied' ? '' : 'none';
      $('micHelp').classList.add('show');
    }
    return false;
  }
}
$('micBtn').onclick = () => askMic(true);
$('micRetry').onclick = async () => { $('micHelp').classList.remove('show'); if (!(await askMic(true)) && micPerm === 'denied') location.reload(); };
$('micClose').onclick = () => $('micHelp').classList.remove('show');

/* ================= three.js 場景 ================= */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));   // 手機上 1.5 倍就夠清楚，省下很多效能
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.05, 400);
camera.rotation.order = 'YXZ';
scene.add(camera);
{ const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; }
const hemi = new THREE.HemisphereLight(0xffe8d0, 0x302018, 1.1); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.0); sun.position.set(8, 20, 10); scene.add(sun);
addEventListener('resize', () => { if (renderer.xr.isPresenting) return; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

/* 手機（相機）在場域座標中的位置 */
const camWorld = new THREE.Matrix4(), camProj = new THREE.Matrix4(), camProjInv = new THREE.Matrix4();
const camPos = new THREE.Vector3(), camFwd = new THREE.Vector3();
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();

/* ================================================================
   場域模型：0.4 公尺的立體方格，每格記錄「被看到有東西」的次數
   ================================================================ */
const field = {
  cells: new Map(), origin: new THREE.Vector3(), groundY: 0, groundKnown: false, groundSrc: '', ground: [], added: 0,
  key(ix, iy, iz) { return ((ix + 600) * 2048 + (iy + 200)) * 2048 + (iz + 600); },
  clear() { this.cells.clear(); this.groundKnown = false; this.ground.length = 0; this.added = 0; },
  inRange(p) {
    const gy = this.groundKnown ? this.groundY : this.origin.y - 1.5;
    return Math.hypot(p.x - this.origin.x, p.z - this.origin.z) <= RULE.fieldR && p.y < gy + RULE.fieldTop && p.y > gy - 2;
  },
  add(x, y, z, w = 1) {
    if (!this.inRange(tv3.set(x, y, z))) return;
    if (this.groundKnown && y < this.groundY + 0.25) return;      // 地面另外算（整片平面）
    const k = this.key(Math.floor(x / CELL), Math.floor(y / CELL), Math.floor(z / CELL));
    const n = this.cells.get(k) || 0;
    if (n < OCC_N && n + w >= OCC_N) this.added++;
    this.cells.set(k, Math.min(n + w, 30));
  },
  occ(ix, iy, iz) { return (this.cells.get(this.key(ix, iy, iz)) || 0) >= OCC_N; },
  hitSphere(p, r) {          // 半徑 r 的球有沒有碰到模型（含地面）
    if (this.groundKnown && p.y - r < this.groundY) return true;
    const x0 = Math.floor((p.x - r) / CELL), x1 = Math.floor((p.x + r) / CELL), y0 = Math.floor((p.y - r) / CELL), y1 = Math.floor((p.y + r) / CELL), z0 = Math.floor((p.z - r) / CELL), z1 = Math.floor((p.z + r) / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
      if (!this.occ(ix, iy, iz)) continue;
      const cx = clamp(p.x, ix * CELL, ix * CELL + CELL), cy = clamp(p.y, iy * CELL, iy * CELL + CELL), cz = clamp(p.z, iz * CELL, iz * CELL + CELL);
      if ((cx - p.x) ** 2 + (cy - p.y) ** 2 + (cz - p.z) ** 2 <= r * r) return true;
    }
    return false;
  },
  count() { let n = 0; for (const v of this.cells.values()) if (v >= OCC_N) n++; return n; },
  setGround(y, src) {
    if (src === 'est') { if (!this.groundKnown) { this.groundY = y; this.groundKnown = true; this.groundSrc = 'est'; } return; }
    this.ground.push(y); if (this.ground.length > 40) this.ground.shift();
    const s = [...this.ground].sort((a, b) => a - b);
    const g = s[Math.floor(s.length * 0.2)];        // 偏低的那些（桌面不算地面）
    this.groundY = g; this.groundKnown = true; this.groundSrc = src;
  },
};

/* 模型顯示：半透明方塊 + 地上的同心圓 */
const MODEL_MAX = 24000;
const modelMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL * 0.9, CELL * 0.9, CELL * 0.9),
  G(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false })), MODEL_MAX);
modelMesh.frustumCulled = false; modelMesh.count = 0; modelMesh.visible = false; modelMesh.renderOrder = 2;
modelMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MODEL_MAX * 3), 3);
scene.add(modelMesh);
const groundGrid = (() => {
  const pts = [];
  for (let r = 5; r <= RULE.fieldR; r += 5) for (let k = 0; k < 96; k++) {
    const a = k / 96 * Math.PI * 2, b = (k + 1) / 96 * Math.PI * 2;
    pts.push(Math.cos(a) * r, 0, Math.sin(a) * r, Math.cos(b) * r, 0, Math.sin(b) * r);
  }
  for (let k = 0; k < SECTORS; k++) { const a = k / SECTORS * Math.PI * 2; pts.push(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5, Math.cos(a) * RULE.fieldR, 0, Math.sin(a) * RULE.fieldR); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.LineSegments(g, G(new THREE.LineBasicMaterial({ color: 0xf4cf74, transparent: true, opacity: 0.35, depthWrite: false })));
  m.visible = false; scene.add(m); return m;
})();
let modelShow = false, modelT = 0;
const cA = new THREE.Color(0xf4cf74), cB = new THREE.Color(0x7fd0ff), cTmp = new THREE.Color(), mDummy = new THREE.Object3D();
function updateModelMesh() {
  let i = 0;
  for (const [k, v] of field.cells) {
    if (v < OCC_N || i >= MODEL_MAX) continue;
    const iz = (k % 2048) - 600, rest = Math.floor(k / 2048), iy = (rest % 2048) - 200, ix = Math.floor(rest / 2048) - 600;
    mDummy.position.set((ix + 0.5) * CELL, (iy + 0.5) * CELL, (iz + 0.5) * CELL); mDummy.updateMatrix();
    modelMesh.setMatrixAt(i, mDummy.matrix);
    cTmp.copy(cA).lerp(cB, clamp((mDummy.position.y - field.groundY) / 4, 0, 1)); modelMesh.setColorAt(i, cTmp);
    i++;
  }
  modelMesh.count = i; modelMesh.instanceMatrix.needsUpdate = true; if (modelMesh.instanceColor) modelMesh.instanceColor.needsUpdate = true;
  groundGrid.position.set(field.origin.x, field.groundY + 0.01, field.origin.z);
}
function setModelVisible(v) {
  modelShow = v; $('modelBtn').classList.toggle('on', v); $('modelBtn').setAttribute('aria-pressed', v);
}
$('modelBtn').onclick = () => setModelVisible(!modelShow);

/* ================= 掃描進度（羅盤十二格） ================= */
const scan = { dwell: new Float32Array(SECTORS), yaw0: 0, t: 0, done: false, minCells: 60 };
(() => {   // 畫 SVG 扇形
  const g = $('segs'), R0 = 44, R1 = 62, gap = 0.05;
  for (let k = 0; k < SECTORS; k++) {
    const a0 = (k / SECTORS) * Math.PI * 2 - Math.PI / 2 - Math.PI / SECTORS + gap, a1 = a0 + Math.PI * 2 / SECTORS - gap * 2;
    const p = (r, a) => `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${p(R0, a0)} L${p(R1, a0)} A${R1},${R1} 0 0 1 ${p(R1, a1)} L${p(R0, a1)} A${R0},${R0} 0 0 0 ${p(R0, a0)}Z`);
    path.setAttribute('class', 'seg'); g.appendChild(path);
  }
})();
const yawOf = v => Math.atan2(-v.x, -v.z);   // 朝 -Z 為 0，逆時針為正
function resetScan() { scan.dwell.fill(0); scan.t = 0; scan.done = false; scan.yaw0 = yawOf(camFwd); $('scan').classList.remove('done'); }
function updateScan(dt) {
  scan.t += dt;
  const pitch = Math.asin(clamp(camFwd.y, -1, 1));
  let rel = yawOf(camFwd) - scan.yaw0; rel = ((-rel % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);   // 順時針角度
  const sec = Math.floor(((rel + Math.PI / SECTORS) % (Math.PI * 2)) / (Math.PI * 2 / SECTORS));
  if (pitch > -1.0 && pitch < 0.55) scan.dwell[sec] += dt;
  $('needle').setAttribute('transform', `rotate(${(rel * 180 / Math.PI).toFixed(1)})`);
  const segs = $('segs').children; let on = 0;
  for (let k = 0; k < SECTORS; k++) { const lit = scan.dwell[k] > 0.6; segs[k].classList.toggle('on', lit); if (lit) on++; }
  if (!field.groundKnown && scan.t > 8) field.setGround(camPos.y - 1.4, 'est');   // 一直找不到地面：用手機高度估一個
  const cells = field.count();
  const pct = Math.round(70 * Math.min(1, on / 11) + 15 * (field.groundKnown ? 1 : 0) + 15 * Math.min(1, cells / scan.minCells));
  const ok = on >= 11 && field.groundKnown && cells >= scan.minCells;
  $('scanPct').textContent = ok ? 100 : Math.min(99, pct);
  $('scanFacts').textContent = `模型 ${cells} 格・地面${field.groundKnown ? (field.groundSrc === 'est' ? '（估計）' : '已找到') : '尋找中'}・已轉 ${on}/12`;
  if (!ok) {
    $('scanMsg').textContent = !field.groundKnown ? '鏡頭先往下照地面，再慢慢原地轉一圈'
      : on < 11 ? '慢慢原地轉一圈，把四周景物拍進來' : '再多照一下四周的牆、樹、建築物';
  }
  if (ok && !scan.done) {
    scan.done = true; $('scan').classList.add('done'); $('scanMsg').textContent = '場域建模完成。面向你要迎戰的方向';
    $('startBtn').disabled = false; SFX.ready(); vibrate(40);
  }
}

/* ================= 粒子（火花、煙、爆炸） ================= */
const PMAX = 1800;
const parts = { pos: new Float32Array(PMAX * 3), col: new Float32Array(PMAX * 3), size: new Float32Array(PMAX), alpha: new Float32Array(PMAX),
  vel: new Float32Array(PMAX * 3), life: new Float32Array(PMAX), max: new Float32Array(PMAX), s0: new Float32Array(PMAX), s1: new Float32Array(PMAX), drag: new Float32Array(PMAX), grav: new Float32Array(PMAX), n: 0 };
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(parts.pos, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('color', new THREE.BufferAttribute(parts.col, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('size', new THREE.BufferAttribute(parts.size, 1).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('alpha', new THREE.BufferAttribute(parts.alpha, 1).setUsage(THREE.DynamicDrawUsage));
const pUni = { uH: { value: innerHeight }, uGray: U.gray };
const pMesh = new THREE.Points(pGeo, new THREE.ShaderMaterial({
  uniforms: pUni, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
  vertexShader: `attribute float size; attribute float alpha; varying vec3 vC; varying float vA; uniform float uH;
    void main(){ vC=color; vA=alpha; vec4 mv=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mv; gl_PointSize=clamp(size*uH*projectionMatrix[1][1]*.5/max(.05,-mv.z),1.,256.); }`,
  fragmentShader: `varying vec3 vC; varying float vA; uniform float uGray;
    void main(){ float d=length(gl_PointCoord-.5); float a=smoothstep(.5,.0,d)*vA; vec3 c=mix(vC,vec3(dot(vC,vec3(.3,.59,.11))),uGray); gl_FragColor=vec4(c*a,a); }`,
}));
pMesh.frustumCulled = false; pMesh.renderOrder = 10; scene.add(pMesh);
function emit(p, v, color, size0, size1, life, drag = 1, grav = 0) {
  let i = parts.n < PMAX ? parts.n++ : Math.floor(Math.random() * PMAX);
  parts.pos.set([p.x, p.y, p.z], i * 3); parts.vel.set([v.x, v.y, v.z], i * 3);
  parts.col.set([color.r, color.g, color.b], i * 3);
  parts.s0[i] = size0; parts.s1[i] = size1; parts.life[i] = life; parts.max[i] = life; parts.drag[i] = drag; parts.grav[i] = grav;
}
function updateParts(dt) {
  for (let i = 0; i < parts.n; i++) {
    parts.life[i] -= dt;
    if (parts.life[i] <= 0) {   // 用最後一顆補洞
      const j = --parts.n;
      if (i !== j) {
        for (const a of ['pos', 'vel', 'col']) parts[a].copyWithin(i * 3, j * 3, j * 3 + 3);
        for (const a of ['life', 'max', 's0', 's1', 'drag', 'grav']) parts[a][i] = parts[a][j];
        i--;
      }
      continue;
    }
    const k = 1 - parts.life[i] / parts.max[i], dr = Math.exp(-parts.drag[i] * dt);
    parts.vel[i * 3] *= dr; parts.vel[i * 3 + 1] = parts.vel[i * 3 + 1] * dr + parts.grav[i] * dt; parts.vel[i * 3 + 2] *= dr;
    parts.pos[i * 3] += parts.vel[i * 3] * dt; parts.pos[i * 3 + 1] += parts.vel[i * 3 + 1] * dt; parts.pos[i * 3 + 2] += parts.vel[i * 3 + 2] * dt;
    parts.size[i] = lerp(parts.s0[i], parts.s1[i], k); parts.alpha[i] = Math.min(1, (1 - k) * 1.6) * Math.min(1, k * 12 + 0.2);
  }
  pGeo.setDrawRange(0, parts.n);
  for (const a of ['position', 'color', 'size', 'alpha']) pGeo.attributes[a].needsUpdate = true;
}
const C_FIRE = [new THREE.Color(1, 0.75, 0.2), new THREE.Color(1, 0.35, 0.05), new THREE.Color(0.9, 0.12, 0.02)];
const C_GOLD = new THREE.Color(1, 0.82, 0.35), C_WHITE = new THREE.Color(0.85, 0.92, 1), C_SMOKE = new THREE.Color(0.25, 0.08, 0.04);
const rv = (s = 1) => tv2.set((Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s);
function rvSphere(s) { do { rv(1); } while (tv2.lengthSq() > 1); return tv2.multiplyScalar(s); }

/* ================= 爆炸 ================= */
const flashTex = glowTexture();
const booms = [];
function explode(p, scale = 1, color = 0xff7a1a) {
  const spr = new THREE.Sprite(G(new THREE.SpriteMaterial({ map: flashTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
  spr.position.copy(p); spr.renderOrder = 11; scene.add(spr);
  booms.push({ spr, t: 0, scale });
  for (let i = 0; i < 70 * scale; i++) emit(p, rvSphere(7 * scale).clone(), C_FIRE[i % 3], 0.35 * scale, 0.05, 0.4 + Math.random() * 0.5, 3, -2);
  for (let i = 0; i < 18 * scale; i++) emit(p, rvSphere(2 * scale).clone(), C_SMOKE, 0.6 * scale, 1.6 * scale, 1.2 + Math.random() * 0.6, 1.5, 1);
}
function updateBooms(dt) {
  for (let i = booms.length - 1; i >= 0; i--) {
    const b = booms[i]; b.t += dt; const k = b.t / 0.55;
    b.spr.scale.setScalar((0.5 + 3.2 * Math.sqrt(k)) * b.scale); b.spr.material.opacity = 1 - k;
    if (k >= 1) { scene.remove(b.spr); b.spr.material.dispose(); booms.splice(i, 1); }
  }
}

/* ================= 火球 ================= */
const fireMat = new THREE.ShaderMaterial({
  uniforms: { uT: { value: 0 }, uGray: U.gray },
  vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vV; void main(){ vP=position; vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
  fragmentShader: `uniform float uT; uniform float uGray; varying vec3 vP; varying vec3 vN; varying vec3 vV;
    float h(vec3 p){ return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
    float n3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
      return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                 mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
    void main(){ vec3 p=vP*4.; float n=n3(p+vec3(0.,-uT*3.,uT))*.55+n3(p*2.1-vec3(uT*2.))*.3+n3(p*4.3+uT)*.15;
      float fr=pow(1.-max(dot(vN,vV),0.),1.6);
      vec3 c=mix(vec3(1.,.95,.6),vec3(1.,.45,.05),smoothstep(.35,.7,n+fr*.4)); c=mix(c,vec3(.75,.06,.02),smoothstep(.6,.95,n*.6+fr));
      c*=1.6; c=mix(c,vec3(dot(c,vec3(.3,.59,.11))),uGray); gl_FragColor=vec4(c,1.); }`,
});
const fireGeo = new THREE.SphereGeometry(RULE.fireR, 32, 20);
const fireGlowTex = glowTexture('rgba(255,230,160,1)', 'rgba(255,90,20,.6)');
const fireballs = [];
const UP_Y = new THREE.Vector3(0, 1, 0);
function makeFireball(spread = 0) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(fireGeo, fireMat));
  const glow = new THREE.Sprite(G(new THREE.SpriteMaterial({ map: fireGlowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
  glow.scale.setScalar(RULE.fireR * 5.5); g.add(glow);
  g.scale.setScalar(0.01); scene.add(g);
  return { g, state: 'form', t: 0, vel: new THREE.Vector3(), dir: new THREE.Vector3(), minD: 1e9, inZone: false, snd: null, spread };
}
function removeFireball(f) { scene.remove(f.g); f.g.children[1].material.dispose(); f.snd?.stop(); f.snd = null; }
function updateFireballs(dt) {
  for (let i = fireballs.length - 1; i >= 0; i--) {
    const f = fireballs[i]; f.t += dt;
    if (f.state === 'form') {               // 在嘴裡長大，初速為零
      if (!D) { removeFireball(f); fireballs.splice(i, 1); continue; }
      D.dragon.mouthWorld(f.g.position);
      if (f.spread) {                       // 三連發：左右兩顆在嘴邊兩側成形
        tv.copy(camPos).sub(f.g.position).setY(0).normalize();
        f.g.position.x += tv.z * Math.sign(f.spread) * 0.7; f.g.position.z += -tv.x * Math.sign(f.spread) * 0.7;   // 和飛出去的偏轉同一側，三顆一路往外散開
      }
      f.g.scale.setScalar(Math.max(0.01, smooth(0, RULE.fireForm, f.t)));
      if (Math.random() < 0.6) emit(f.g.position, rv(0.8).clone().setY(1.2), C_FIRE[1], 0.3, 0.05, 0.5);
      if (f.t >= RULE.fireForm) {
        f.state = 'fly'; f.t = 0; f.dir.copy(camPos).sub(f.g.position).normalize();
        if (f.spread) f.dir.applyAxisAngle(UP_Y, f.spread);
        f.vel.copy(f.dir).multiplyScalar(RULE.fireSpeed);
        D.dragon.setJaw(0); if (!f.spread) SFX.whoosh(f.g.position); f.snd = SFX.fireLoop(f.g.position);
      }
      continue;
    }
    // 飛行：有初速再加速，朝出手那一刻的使用者位置（三連發的兩側各偏一個角度）
    f.vel.addScaledVector(f.dir, RULE.fireAccel * dt);
    const steps = Math.max(1, Math.ceil(f.vel.length() * dt / 0.15));
    let gone = false;
    for (let s = 0; s < steps && !gone; s++) {
      f.g.position.addScaledVector(f.vel, dt / steps);
      const p = f.g.position, d = p.distanceTo(camPos), RH = RULE.fireR + RULE.userR;
      if (S.phase === 'battle' && d < RH) { f.inZone = true; f.minD = Math.min(f.minD, d); }
      if (f.inZone && (d > f.minD + 0.005 || d < 0.05)) {      // 已經過了最靠近的那一點 → 打中
        if (window.__g) console.log('FB user', f.minD.toFixed(2)); hitUser(f.minD / RH); explode(p, 0.8); SFX.boom(p, 1); gone = true; break;
      }
      if (field.hitSphere(p, RULE.fireR)) { if (window.__g) console.log('FB env', p.toArray().join()); explode(p, 1); SFX.boom(p, 1); gone = true; break; }
      if (!field.inRange(p)) gone = 'fade';
    }
    if (!gone) f.snd?.set(f.g.position, f.vel.length());
    if (!gone && Math.random() < 0.9) for (let k = 0; k < 2; k++) emit(f.g.position, rv(0.6).clone(), C_FIRE[k], 0.45, 0.08, 0.5 + Math.random() * 0.3, 2);
    if (gone) { removeFireball(f); fireballs.splice(i, 1); }
  }
  fireMat.uniforms.uT.value += dt;
}

/* ================= 御劍術：中國古劍（銀白劍身、銅金劍格、玉飾、藍絲纏柄、金色劍穗） ================= */
let swordProto = null;
function buildSword() {
  const g = new THREE.Group();
  const steel = G(new THREE.MeshStandardMaterial({ color: 0xeef3f8, metalness: 1, roughness: 0.14, emissive: 0x1c2836, flatShading: true, side: THREE.DoubleSide }));
  const bronze = G(new THREE.MeshStandardMaterial({ color: 0xd9aa4c, metalness: 1, roughness: 0.28, emissive: 0x3a2600 }));
  const jade = G(new THREE.MeshStandardMaterial({ color: 0x5cc79a, roughness: 0.2, metalness: 0.05, emissive: 0x0f4a30 }));
  const silkTex = (() => { const c = document.createElement('canvas'); c.width = 64; c.height = 128; const x = c.getContext('2d');
    x.fillStyle = '#16244a'; x.fillRect(0, 0, 64, 128); x.strokeStyle = '#2f4a8a'; x.lineWidth = 7;
    for (let k = -8; k < 16; k++) { x.beginPath(); x.moveTo(0, k * 12); x.lineTo(64, k * 12 + 30); x.stroke(); }
    x.strokeStyle = 'rgba(0,0,0,.5)'; x.lineWidth = 2; for (let k = -8; k < 16; k++) { x.beginPath(); x.moveTo(0, k * 12 + 4); x.lineTo(64, k * 12 + 34); x.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2); return t; })();
  const silk = G(new THREE.MeshStandardMaterial({ map: silkTex, roughness: 0.85 }));
  const tasselM = G(new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.75, emissive: 0x3a2800 }));
  // 劍身：菱形斷面（中間有劍脊），往劍尖稍微收窄，最後收成劍鋒
  const L = 0.8, W = 0.072, T = 0.017;
  const st = [0, 0.2, 0.45, 0.7, 0.9].map(k => k * L * 0.93);
  const ring = z => { const k = z / L, w = W / 2 * (1 - 0.16 * k), th = T / 2 * (1 - 0.2 * k); return [[-w, 0, z], [0, th, z], [w, 0, z], [0, -th, z]]; };
  const P = [], push = (...v) => { for (const q of v) P.push(...q); };
  for (let i = 0; i < st.length - 1; i++) { const a = ring(st[i]), b = ring(st[i + 1]); for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4; push(a[k], b[k], b[k2], a[k], b[k2], a[k2]); } }
  { const a = ring(st[st.length - 1]), tip = [0, 0, L]; for (let k = 0; k < 4; k++) push(a[k], tip, a[(k + 1) % 4]); }
  const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); bg.computeVertexNormals();
  g.add(new THREE.Mesh(bg, steel));
  // 劍身上的金字「滅邪」（兩面）
  const c = document.createElement('canvas'); c.width = 96; c.height = 384; const x = c.getContext('2d');
  x.fillStyle = '#f5c542'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '900 80px "Noto Serif TC","Songti TC",serif';
  x.shadowColor = 'rgba(90,50,0,.9)'; x.shadowBlur = 4; x.fillText('滅', 48, 120); x.fillText('邪', 48, 250);
  const tt = new THREE.CanvasTexture(c); tt.colorSpace = THREE.SRGBColorSpace;
  for (const side of [1, -1]) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.026, 0.11), G(new THREE.MeshBasicMaterial({ map: tt, transparent: true, depthWrite: false })));
    pl.position.set(0, side * (T / 2 + 0.0012), 0.12); pl.rotation.set(side > 0 ? -Math.PI / 2 : Math.PI / 2, 0, side > 0 ? Math.PI : 0); g.add(pl);
  }
  // 劍格：中間凸起、兩翼下彎的銅金劍格，兩面鑲玉
  const gs = new THREE.Shape(); const gp = [[-0.078, -0.01], [-0.074, 0.022], [-0.05, 0.012], [-0.024, 0.03], [0, 0.046], [0.024, 0.03], [0.05, 0.012], [0.074, 0.022], [0.078, -0.01], [0.042, -0.022], [0, -0.03], [-0.042, -0.022]];
  gs.moveTo(...gp[0]); for (const q of gp.slice(1)) gs.lineTo(...q); gs.closePath();
  g.add(new THREE.Mesh(new THREE.ExtrudeGeometry(gs, { depth: 0.032, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2 }).rotateX(Math.PI / 2).translate(0, 0.016, 0), bronze));
  for (const sy of [1, -1]) { const j = new THREE.Mesh(new THREE.SphereGeometry(0.016, 14, 10), jade); j.scale.set(1, 0.4, 1); j.position.set(0, sy * 0.021, 0.006); g.add(j); }
  // 劍柄：藍色絲線纏繞
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.19, 14).rotateX(Math.PI / 2), silk); grip.scale.set(1.25, 1, 1); grip.position.z = -0.115; g.add(grip);
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.021, 0.018, 14).rotateX(Math.PI / 2), bronze); ferrule.scale.set(1.25, 1, 1); ferrule.position.z = -0.02; g.add(ferrule);
  // 劍首：圓盤＋玉
  const pom = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.026, 0.024, 20).rotateX(Math.PI / 2), bronze); pom.position.z = -0.22; g.add(pom);
  const pj = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.006, 20).rotateX(Math.PI / 2), jade); pj.position.z = -0.234; g.add(pj);
  // 量長度（不含劍穗），讓整把劍長＝RULE.swordLen，原點在中間
  const box = new THREE.Box3().setFromObject(g), len = box.max.z - box.min.z;
  // 劍穗：金色絲穗，往後飄
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.003, 6, 14), bronze); ring2.position.set(0, -0.01, -0.24); g.add(ring2);
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.07, 6).rotateX(Math.PI / 2), tasselM); cord.position.set(0, -0.02, -0.28); cord.rotation.x = 0.3; g.add(cord);
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.013, 12, 10), jade); bead.position.set(0, -0.03, -0.318); g.add(bead);
  for (let k = 0; k < 10; k++) {
    const a = k / 10 * Math.PI * 2, th = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0015, 0.17, 4).rotateX(Math.PI / 2).translate(0, 0, -0.085), tasselM);
    th.position.set(Math.cos(a) * 0.006, -0.032 + Math.sin(a) * 0.006, -0.328); th.rotation.set(0.35 + Math.sin(a) * 0.12, Math.cos(a) * 0.14, 0); g.add(th);
  }
  // 遠處也看得到的白金色光
  const glow = new THREE.Sprite(G(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,255,245,1)', 'rgba(200,225,255,.45)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
  glow.scale.set(0.75, 0.75, 1); glow.position.z = 0.3; glow.name = 'glow'; g.add(glow);
  const holder = new THREE.Group(); g.position.z = -(box.min.z + box.max.z) / 2; holder.add(g);
  holder.scale.setScalar(RULE.swordLen / len); holder.userData.s0 = RULE.swordLen / len;
  return holder;
}
const swords = [];
let swordReadyAt = 0;
function castSword(src) {
  if (S.phase !== 'battle') return;
  const now = performance.now() / 1000;
  if (now < swordReadyAt) { flashHeard(`御劍術冷卻中（${Math.ceil(swordReadyAt - now)} 秒）`); return; }
  swordReadyAt = now + RULE.swordCD;
  if (!swordProto) swordProto = buildSword();
  const g = swordProto.clone(true);
  const dir = camFwd.clone();
  g.position.copy(camPos).add(tv.set(0, -RULE.swordDrop, 0));   // 手機正下方 20 公分
  g.quaternion.setFromUnitVectors(tv.set(0, 0, 1), dir);
  scene.add(g);
  swords.push({ g, dir, state: 'fly', t: 0, half: RULE.swordLen / 2, stuckOn: null, snd: SFX.swordLoop(g.position) });
  SFX.sword(); vibrate(25);
  toast('御劍術');
  if (src === 'voice') flashHeard('聽到「御劍術」');
}
function updateSwords(dt) {
  for (let i = swords.length - 1; i >= 0; i--) {
    const w = swords[i]; w.t += dt;
    if (w.state === 'fly') {
      const steps = Math.max(1, Math.ceil(RULE.swordSpeed * dt / 0.08));
      let done = false;
      for (let s = 0; s < steps && !done; s++) {
        w.g.position.addScaledVector(w.dir, RULE.swordSpeed * dt / steps);
        const tip = tv.copy(w.g.position).addScaledVector(w.dir, w.half);
        if (D && D.hp > 0 && D.dragon.hitTest(tip, 0.02)) {           // 打中邪龍：插在龍身上
          w.g.position.addScaledVector(w.dir, 0.18);
          D.dragon.root.attach(w.g); w.state = 'stuck'; w.t = 0; w.stuckOn = 'dragon'; w.snd?.stop();
          const em = D.dragon.emblemWorld(tv2), dist = em.distanceTo(tip);
          hitDragon(dist, tip.clone()); done = true;
        } else if (field.hitSphere(tip, 0.04)) {                         // 打中環境：插在上面
          w.g.position.addScaledVector(w.dir, 0.12); w.state = 'stuck'; w.t = 0; w.stuckOn = 'env'; w.snd?.stop();
          SFX.clang(tip); for (let k = 0; k < 16; k++) emit(tip, rvSphere(2.5).clone(), C_GOLD, 0.08, 0.01, 0.4, 3, -4);
          done = true;
        } else if (!field.inRange(tip)) { done = 'gone'; }
      }
      if (done === 'gone') { w.snd?.stop(); scene.remove(w.g); swords.splice(i, 1); continue; }
      if (w.state === 'fly') { w.snd?.set(w.g.position); if (Math.random() < 0.85) emit(w.g.position, rv(0.15).clone(), Math.random() < 0.5 ? C_GOLD : C_WHITE, 0.12, 0.02, 0.6, 2); }
    } else {
      const k = w.t - RULE.swordStick;
      if (k > 0) w.g.scale.setScalar(Math.max(0.001, 1 - k / 0.3) * (w.g.userData.s0 || 1));
      if (k > 0.3) { w.g.parent?.remove(w.g); swords.splice(i, 1); }
    }
  }
  // 按鈕上的冷卻
  const now = performance.now() / 1000, left = Math.max(0, swordReadyAt - now);
  $('swordCd').style.setProperty('--cd', (left / RULE.swordCD).toFixed(3) + 'turn');
  $('swordSec').textContent = left > 0 ? Math.ceil(left) + ' 秒' : '';
  const ready = left <= 0; if (ready !== S.swordWasReady) { $('swordBtn').classList.toggle('ready', ready); if (ready && S.phase === 'battle') SFX.ready(); S.swordWasReady = ready; }
}
$('swordBtn').addEventListener('click', () => { initAudio(); castSword('tap'); });
addEventListener('keydown', e => { if (e.code === 'Space' && S.mode === 'sim') { e.preventDefault(); castSword('key'); } });

/* ================= 邪龍 ================= */
let D = null;    // { dragon, hp, t, nextFire, yaw, barT, sprite }
const barCanvas = document.createElement('canvas'); barCanvas.width = 512; barCanvas.height = 112;
const barTex = new THREE.CanvasTexture(barCanvas); barTex.colorSpace = THREE.SRGBColorSpace;
const barSprite = new THREE.Sprite(G(new THREE.SpriteMaterial({ map: barTex, depthTest: false, depthWrite: false, transparent: true })));
barSprite.scale.set(4.4, 0.96, 1); barSprite.renderOrder = 999; barSprite.visible = false; scene.add(barSprite);
function drawBar(hp, lag) {
  const g = barCanvas.getContext('2d'), W = 512, H = 112;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(13,10,9,.78)'; g.beginPath(); g.roundRect(0, 0, W, H, 10); g.fill();
  g.strokeStyle = '#f4cf74'; g.lineWidth = 3; g.stroke();
  g.font = '900 40px "Noto Serif TC",serif'; g.fillStyle = '#f4cf74'; g.textBaseline = 'middle'; g.fillText('邪龍', 20, 38);
  g.font = '700 36px "Noto Sans TC",sans-serif'; g.fillStyle = '#fff'; g.textAlign = 'right'; g.fillText(`${Math.max(0, Math.ceil(hp))} / ${RULE.dragonHP}`, W - 20, 38); g.textAlign = 'left';
  g.fillStyle = '#2a0b08'; g.fillRect(20, 70, W - 40, 26);
  g.fillStyle = '#ffd8a0'; g.fillRect(20, 70, (W - 40) * clamp(lag / RULE.dragonHP, 0, 1), 26);
  const gr = g.createLinearGradient(0, 70, 0, 96); gr.addColorStop(0, '#ff6a4d'); gr.addColorStop(1, '#a5140f');
  g.fillStyle = gr; g.fillRect(20, 70, (W - 40) * clamp(hp / RULE.dragonHP, 0, 1), 26);
  barTex.needsUpdate = true;
}
const floaters = [];
function floatText(p, txt, color = '#ffe08a') {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d');
  g.font = '900 92px "Noto Sans TC",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = 'rgba(40,0,0,.9)'; g.strokeText(txt, 128, 64); g.fillStyle = color; g.fillText(txt, 128, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(G(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }))); s.renderOrder = 1000;
  s.position.copy(p); s.scale.set(1.3, 0.65, 1); scene.add(s); floaters.push({ s, t: 0 });
}
function updateFloaters(dt) {
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]; f.t += dt; f.s.position.y += dt * 0.9; f.s.material.opacity = 1 - smooth(0.8, 1.5, f.t);
    if (f.t > 1.5) { scene.remove(f.s); f.s.material.map.dispose(); f.s.material.dispose(); floaters.splice(i, 1); }
  }
}
function spawnDragon() {
  const fwd = tv.copy(camFwd).setY(0); if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1); fwd.normalize();
  const dragon = createDragon();
  dragon.root.position.copy(camPos).addScaledVector(fwd, RULE.dragonDist).setY(field.groundY);
  const yaw = Math.atan2(camPos.x - dragon.root.position.x, camPos.z - dragon.root.position.z);
  dragon.root.rotation.y = yaw;
  dragon.root.scale.setScalar(0.001);
  scene.add(dragon.root);
  D = { dragon, hp: RULE.dragonHP, lag: RULE.dragonHP, t: 0, nextFire: RULE.fireFirst, yaw, barT: RULE.dragonBarShow, charging: false, dead: 0 };
  drawBar(D.hp, D.lag);
  // 出場：紅煙與火花
  for (let i = 0; i < 140; i++) emit(tv2.copy(dragon.root.position).add(rv(2.5)).setY(field.groundY + Math.random() * 2), tv3.set((Math.random() - 0.5) * 2, 2 + Math.random() * 4, (Math.random() - 0.5) * 2).clone(), i % 2 ? C_FIRE[2] : C_SMOKE, 0.8, 2.2, 1.5 + Math.random(), 1, 0.5);
  SFX.gong(dragon.root.position); setTimeout(() => { if (D) { D.dragon.roar(); SFX.roar(D.dragon.mouthWorld(tv3), 1.3); } }, 900);
}
function removeDragon() { if (!D) return; scene.remove(D.dragon.root); D.dragon.dispose(); D = null; barSprite.visible = false; }
function updateDragon(dt) {
  if (!D) return;
  D.t += dt;
  const dr = D.dragon, root = dr.root;
  if (D.t < 1.6) root.scale.setScalar(Math.max(0.001, smooth(0, 1.6, D.t)));
  // 原地轉向使用者
  const want = Math.atan2(camPos.x - root.position.x, camPos.z - root.position.z);
  let dy = ((want - D.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  D.yaw += clamp(dy, -RULE.dragonTurn * dt, RULE.dragonTurn * dt);
  root.rotation.y = D.yaw + 0.05 * Math.sin(D.t * 0.6);
  dr.update(dt, camPos);
  // 吐火球：每 12 秒
  if (D.hp > 0 && S.phase === 'battle' && D.t >= D.nextFire) {
    D.nextFire += RULE.fireEvery;
    if (D.hp < RULE.dragonHP * RULE.fireTriple) for (const sp of [-RULE.fireSpread, 0, RULE.fireSpread]) fireballs.push(makeFireball(sp));
    else fireballs.push(makeFireball());
    dr.setJaw(1); SFX.charge(dr.mouthWorld(tv3));
  }
  // 血條
  D.barT -= dt; D.lag = Math.max(D.hp, D.lag - dt * 120);
  barSprite.visible = D.barT > 0 && D.hp > 0 && S.phase === 'battle';
  if (barSprite.visible) { dr.topWorld(barSprite.position); barSprite.material.opacity = Math.min(1, D.barT * 2); drawBar(D.hp, D.lag); }
  // 死亡
  if (D.hp <= 0) {
    D.dead += dt; dr.state.dying = Math.min(1, D.dead / 2.2);
    if (Math.random() < 0.9) for (let k = 0; k < 3; k++) { const q = dr.proxies[Math.floor(Math.random() * dr.proxies.length)]; emit(q.c, tv3.set(0, 2 + Math.random() * 2, 0).clone(), C_FIRE[k], 0.5, 0.1, 1, 1, 1); }
    if (D.dead > 2.6 && S.phase !== 'won') winGame();
  }
}
function hitDragon(dist, at) {
  if (!D || D.hp <= 0) return;
  const k = clamp(1 - dist / RULE.dragonDmgR, 0, 1);
  const dmg = Math.max(3, Math.round(RULE.maxDmg * k));
  D.hp = Math.max(0, D.hp - dmg); D.barT = RULE.dragonBarHit;
  D.dragon.hit(); SFX.stab(at); setTimeout(() => D && SFX.roar(D.dragon.mouthWorld(tv3), 0.7), 150);
  for (let i = 0; i < 30; i++) emit(at, rvSphere(3).clone(), i % 2 ? C_GOLD : C_FIRE[2], 0.18, 0.02, 0.6, 2.5, -3);
  floatText(at.clone().add(tv3.set(0, 0.6, 0)), '-' + dmg, k > 0.7 ? '#ffffff' : '#ffe08a');
  if (D.hp <= 0) { SFX.roar(D.dragon.mouthWorld(tv3), 1.6); for (const f of fireballs) removeFireball(f); fireballs.length = 0; }
}

/* ================= 使用者血量 ================= */
function hitUser(ratio) {                                // ratio：0＝正中手機，1＝擦邊
  if (S.phase !== 'battle') return;
  const dmg = clamp(Math.round(RULE.userMaxDmg * (1 - ratio)), 1, RULE.userMaxDmg);
  S.hp = Math.max(0, S.hp - dmg);
  renderHP(dmg);
  const h = $('hurt'); h.getAnimations().forEach(a => a.cancel());
  h.animate([{ opacity: clamp(0.5 + dmg / 30, 0.5, 1) }, { opacity: 0 }], { duration: 900 + dmg * 25, easing: 'ease-out' });
  SFX.hurt(); vibrate([60, 40, 90]);
  if (S.hp <= 0) dieGame();
}
function renderHP(dmg) {
  const k = S.hp / S.maxHP;
  $('hpNum').textContent = S.hp; $('hpBar').setAttribute('aria-valuemax', S.maxHP); $('hpFill').style.transform = `scaleX(${k})`; $('hpLag').style.transform = `scaleX(${k})`;
  $('hpBar').setAttribute('aria-valuenow', S.hp);
  if (dmg) { const e = $('hpDmg'); e.textContent = '-' + dmg; e.classList.remove('pop'); void e.offsetWidth; e.classList.add('pop'); }
}

/* ================= 遊戲狀態 ================= */
const S = { mode: 'none', phase: 'none', hp: RULE.hpSkip, maxHP: RULE.hpSkip, watched: false, swordWasReady: true, grayTarget: 0 };
function setPhase(p) {
  const prevPhase = S.phase; S.phase = p;
  if (p === 'battle') BattleMusic.start(); else BattleMusic.stop(p === 'won' ? 3 : 1.5);   // 戰鬥配樂
  // 結束畫面：小聲循環播放開場故事的配樂；離開結束畫面就停
  if (p === 'won') { $('storyBgm').loop = true; $('storyBgm').currentTime = 0; StoryMusic.start(0.3); } else if (prevPhase === 'won') StoryMusic.stop();
  document.body.classList.toggle('playing', p !== 'none');
  $('scan').style.display = p === 'scan' || p === 'ready' ? '' : 'none';
  $('startBtn').style.display = p === 'scan' || p === 'ready' ? '' : 'none';
  $('hud').style.display = p === 'battle' || p === 'dead' ? 'block' : 'none';
  $('skill').style.display = p === 'battle' ? 'flex' : 'none';
  $('mic').style.display = p === 'battle' && SR ? 'flex' : 'none';
  $('dead').classList.toggle('show', p === 'dead');
  $('won').classList.toggle('show', p === 'won');
  groundGrid.visible = p === 'scan' || p === 'ready' || modelShow;
}
$('startBtn').addEventListener('click', () => {
  if (!scan.done) return;
  initAudio();
  S.hp = S.maxHP; renderHP(0); swordReadyAt = 0;
  setPhase('battle'); setModelVisible(false);
  spawnDragon(); toast('赤龍斬行動開始');
  startVoice();
});
function clearBattle() {
  removeDragon();
  for (const f of fireballs) removeFireball(f); fireballs.length = 0;
  for (const w of swords) { w.snd?.stop(); w.g.parent?.remove(w.g); } swords.length = 0;
  parts.n = 0;
}
function dieGame() { setPhase('dead'); S.grayTarget = 1; stopVoice(); for (const f of fireballs) removeFireball(f); fireballs.length = 0; }
function winGame() { setPhase('won'); stopVoice(); SFX.gong(null, 1.2); removeDragon(); }
function backToStart() {       // 「再一回合」：回到建模完成、按鈕亮起的畫面（模型保留，不用重掃）
  clearBattle(); S.grayTarget = 0; U.gray.value = 0; S.hp = S.maxHP; renderHP(0);
  setPhase('ready'); $('startBtn').disabled = !scan.done;
}
$('again').addEventListener('click', backToStart);

/* ---------- 小提示 ---------- */
function toast(t) { const e = $('toast'); e.textContent = t; e.classList.remove('show'); void e.offsetWidth; e.classList.add('show'); }
let heardT = 0;
function flashHeard(t) { const e = $('heard'); e.textContent = t; e.classList.add('show'); clearTimeout(heardT); heardT = setTimeout(() => e.classList.remove('show'), 1800); }
const vibrate = p => { try { navigator.vibrate?.(p); } catch {} };

/* ================= 語音「御劍術」 ================= */
let rec = null, voiceOn = false, lastVoice = 0;
const SPELL = /御[劍剑見见建鑒鉴]|[玉預预遇欲育浴喻][劍剑見见建][術术數数書书樹树]|[劍剑][術术]/;
const HEAL = /[法發发][輪轮論论倫伦崙仑][大達达][法發发][好號号郝]|法[輪轮論论]大法/;     // 密技：喊「法輪大法好」血量加滿
let lastHeal = 0;
function secretHeal() {
  if (S.phase !== 'battle' || performance.now() - lastHeal < 2500) return;
  lastHeal = performance.now(); S.hp = S.maxHP; renderHP(0);
  const h = $('heal'); h.getAnimations().forEach(a => a.cancel()); h.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: 1600, easing: 'ease-out' });
  toast('法輪大法好'); flashHeard('血量已加滿'); SFX.heal(); vibrate([30, 60, 30]);
}
function startVoice() {
  if (!SR || voiceOn) return;
  voiceOn = true; $('mic').classList.add('on'); $('micTxt').textContent = '語音：聆聽中'; $('mic').setAttribute('aria-pressed', 'true');
  listen();
}
function listen() {
  if (!voiceOn) return;
  try {
    rec = new SR(); rec.lang = 'zh-TW'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 4;
    rec.onresult = ev => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) for (let k = 0; k < ev.results[i].length; k++) {
        const txt = ev.results[i][k].transcript.replace(/\s/g, '');
        if (HEAL.test(txt)) { secretHeal(); return; }
        if (SPELL.test(txt) && performance.now() - lastVoice > 1500) { lastVoice = performance.now(); castSword('voice'); return; }
      }
    };
    rec.onerror = ev => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { stopVoice(); $('micTxt').textContent = '語音：沒有麥克風權限（點這裡允許）'; micPerm = 'unknown'; }
    };
    rec.onend = () => { if (voiceOn) setTimeout(listen, 250); };
    rec.start();
  } catch { setTimeout(listen, 1000); }
}
function stopVoice() { voiceOn = false; try { rec?.stop(); } catch {} rec = null; $('mic').classList.remove('on'); $('micTxt').textContent = '語音：關'; $('mic').setAttribute('aria-pressed', 'false'); }
$('mic').addEventListener('click', async () => { initAudio(); if (voiceOn) return stopVoice(); if (micPerm !== 'granted' && !(await askMic(!session))) return; startVoice(); });

/* ================================================================
   模擬場景（電腦／iPhone 試玩用）：一個假的戶外廣場
   掃描方式跟真的一樣：從鏡頭打出一排射線，打到的點加進場域模型
   ================================================================ */
const sim = { group: new THREE.Group(), yaw: 0, pitch: 0, keys: {}, stick: { x: 0, y: 0 }, targets: [] };
function buildSim() {
  if (sim.built) return; sim.built = true;
  const g = sim.group; scene.add(g); g.visible = false;
  // 天空
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, uniforms: { uGray: U.gray },
    vertexShader: 'varying vec3 vP; void main(){ vP=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec3 vP; uniform float uGray; void main(){ float h=vP.y; vec3 c=mix(vec3(.55,.2,.12),vec3(.08,.06,.12),smoothstep(0.,.6,h)); c=mix(vec3(.9,.45,.2),c,smoothstep(-.02,.18,h)); c=mix(c,vec3(dot(c,vec3(.3,.59,.11))),uGray); gl_FragColor=vec4(c,1.); }' }));
  sky.userData.noScan = true; g.add(sky);
  // 地面（石板）
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  x.fillStyle = '#5a504a'; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { x.fillStyle = `hsl(20,8%,${30 + Math.random() * 10}%)`; x.fillRect(i * 64 + 2, j * 64 + 2, 60, 60); }
  const gt = new THREE.CanvasTexture(c); gt.wrapS = gt.wrapT = THREE.RepeatWrapping; gt.repeat.set(60, 60); gt.colorSpace = THREE.SRGBColorSpace;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2), G(new THREE.MeshStandardMaterial({ map: gt, color: 0x9a8f88, roughness: 0.95 })));
  ground.userData.ground = true; g.add(ground);
  const wallM = G(new THREE.MeshStandardMaterial({ color: 0x6d5f57, roughness: 0.85 })), roofM = G(new THREE.MeshStandardMaterial({ color: 0x3a2a24, roughness: 0.8 }));
  const box = (w, h, d, px, pz, m = wallM, py = h / 2) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(px, py, pz); g.add(b); sim.targets.push(b); return b; };
  // 遠處建築（龍的方向 -Z 前方 10 公尺保持空曠）
  for (const [w, h, d, px, pz] of [[14, 9, 8, -24, -38], [10, 14, 10, 4, -44], [16, 7, 8, 26, -34], [8, 11, 12, 38, -6], [10, 8, 18, 36, 20], [18, 10, 8, 6, 36], [12, 12, 10, -24, 30], [8, 9, 16, -38, -4]]) {
    box(w, h, d, px, pz); box(w + 0.6, 0.6, d + 0.6, px, pz, roofM, h + 0.3);
  }
  // 近處：矮牆、樹、石燈
  box(6, 1.1, 0.4, 8, -6); box(0.4, 1.1, 5, -7, 4); box(1.2, 0.5, 0.5, -3, -9);
  const trunk = G(new THREE.MeshStandardMaterial({ color: 0x3b2618 })), leaf = G(new THREE.MeshStandardMaterial({ color: 0x24402a, roughness: 0.9 }));
  for (const [px, pz, s] of [[-9, -12, 1.2], [11, -15, 1], [-13, 8, 1.4], [14, 6, 1.1], [-5, 14, 1], [3, 12, 0.9], [-18, -20, 1.5], [19, -22, 1.3]]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * s, 0.25 * s, 3 * s, 8), trunk); t.position.set(px, 1.5 * s, pz); g.add(t); sim.targets.push(t);
    const l = new THREE.Mesh(new THREE.ConeGeometry(1.6 * s, 4 * s, 9), leaf); l.position.set(px, 4.4 * s, pz); g.add(l); sim.targets.push(l);
  }
  sim.targets.push(ground);
  sim.ray = new THREE.Raycaster(); sim.ray.far = 60;
  g.updateMatrixWorld(true);   // 第一幀還沒渲染前就要掃描，位置要先算好
}
function simScan() {           // 模擬「深度感測」：畫面上 10×7 個點
  const ray = sim.ray;
  for (let j = 0; j < 7; j++) for (let i = 0; i < 10; i++) {
    const u = (i + Math.random()) / 10 * 2 - 1, v = (j + Math.random()) / 7 * 2 - 1;
    ray.setFromCamera(tv.set(u, v), camera);
    const h = ray.intersectObjects(sim.targets, false)[0];
    if (!h) continue;
    if (h.object.userData.ground) { if (!field.groundKnown || Math.random() < 0.02) field.setGround(h.point.y, 'plane'); continue; }
    field.add(h.point.x, h.point.y, h.point.z, 1.3);
  }
}
function updateSimCamera(dt) {
  const k = sim.keys, f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0) - sim.stick.y, r = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0) + sim.stick.x;
  const sp = 2.2 * dt;
  camera.position.x += (-Math.sin(sim.yaw) * f + Math.cos(sim.yaw) * r) * sp;
  camera.position.z += (-Math.cos(sim.yaw) * f - Math.sin(sim.yaw) * r) * sp;
  camera.position.y = 1.45 + Math.sin(performance.now() / 300) * 0.01 * Math.min(1, Math.abs(f) + Math.abs(r));
  camera.rotation.set(sim.pitch, sim.yaw, 0);
  camera.updateMatrixWorld();
}
addEventListener('keydown', e => { sim.keys[e.code] = true; });
addEventListener('keyup', e => { sim.keys[e.code] = false; });
{
  let drag = null;
  canvas.addEventListener('pointerdown', e => { if (S.mode !== 'sim') return; drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    sim.yaw -= (e.clientX - drag.x) * 0.005; sim.pitch = clamp(sim.pitch - (e.clientY - drag.y) * 0.004, -1.2, 1.0);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  const st = $('stick'), knob = st.firstElementChild; let sid = null;
  st.addEventListener('pointerdown', e => { sid = e.pointerId; st.setPointerCapture(sid); move(e); });
  st.addEventListener('pointermove', e => { if (e.pointerId === sid) move(e); });
  const end = () => { sid = null; sim.stick.x = sim.stick.y = 0; knob.style.transform = ''; };
  st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
  function move(e) {
    const r = st.getBoundingClientRect(); let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    sim.stick.x = x; sim.stick.y = y; knob.style.transform = `translate(${x * 36}px,${y * 36}px)`;
  }
}

/* ================= 進入模式 ================= */
function enterPlay(mode) {
  S.mode = mode; clearBattle(); field.clear(); S.grayTarget = 0; U.gray.value = 0;
  $('startBtn').disabled = true; setModelVisible(false);
  $('overlay').style.display = 'block'; show('none');
  const simMode = mode === 'sim';
  $('stick').style.display = simMode && matchMedia('(pointer:coarse)').matches ? 'block' : 'none';
  $('simHelp').style.display = simMode ? 'block' : 'none';
  setPhase('scan');
  prewarm();
}
/* 預先把龍、劍的材質編譯好，龍出場、第一次出劍時就不會卡一下 */
let warmed = false;
function prewarm() {
  if (warmed) return; warmed = true;
  const d = createDragon(); if (!swordProto) swordProto = buildSword();
  const sw = swordProto.clone(true), fb = makeFireball();
  const hold = new THREE.Group(); hold.add(d.root, sw); hold.scale.setScalar(1e-4); camera.add(hold); hold.position.set(0, 0, -2);
  fb.g.scale.setScalar(1e-4); camera.add(fb.g);
  try { renderer.compile(scene, camera); } catch {}
  setTimeout(() => { camera.remove(hold, fb.g); d.dispose(); fb.g.children[1].material.dispose(); }, 600);
}
$('simBtn').addEventListener('click', () => {
  initAudio(); if (SR && micPerm !== 'granted') askMic(false); buildSim(); sim.group.visible = true;
  sim.yaw = 0; sim.pitch = -0.15; camera.position.set(0, 1.45, 0); camera.fov = 65; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  updateSimCamera(0); camFwd.set(0, 0, -1);
  canvas.style.display = 'block';
  enterPlay('sim');
  field.origin.set(0, 0, 0); resetScan(); scan.minCells = 60;
});

/* ---------- AR（WebXR） ---------- */
let session = null, refSpace = null, hitSource = null, depthOn = false, glBinding = null, camOn = false, frameN = 0;
$('arBtn').addEventListener('click', async () => {
  initAudio();
  if (SR && micPerm !== 'granted') await askMic(false);   // 進 AR 前先跳出麥克風權限視窗
  const base = { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'plane-detection', 'camera-access', 'anchors'], domOverlay: { root: $('overlay') } };
  $('overlay').style.display = 'block';
  try {
    try {
      session = await navigator.xr.requestSession('immersive-ar', { ...base, optionalFeatures: [...base.optionalFeatures, 'depth-sensing'],
        depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] } });
    } catch { session = await navigator.xr.requestSession('immersive-ar', base); }
  } catch (err) {
    $('overlay').style.display = 'none'; supportEl.textContent = 'AR 啟動失敗：' + (err.message || err) + '。請確認已允許相機權限。'; supportEl.className = 'status bad'; return;
  }
  let feats = []; try { feats = [...(session.enabledFeatures || [])]; } catch {}
  depthOn = feats.length ? feats.includes('depth-sensing') : true;
  camOn = feats.includes('camera-access') && typeof XRWebGLBinding !== 'undefined';
  session.addEventListener('end', onSessionEnd);
  await renderer.xr.setSession(session);
  refSpace = renderer.xr.getReferenceSpace();
  if (camOn) { try { glBinding = new XRWebGLBinding(session, renderer.getContext()); } catch { camOn = false; } }
  const viewer = await session.requestReferenceSpace('viewer');
  try { hitSource = await session.requestHitTestSource({ space: viewer, entityTypes: ['plane', 'point'] }); }
  catch { hitSource = await session.requestHitTestSource({ space: viewer }); }
  canvas.style.display = 'block'; if (sim.built) sim.group.visible = false;
  enterPlay('xr');
  scan.minCells = depthOn ? 60 : 20; S.needOrigin = true;
});
function onSessionEnd() { session = null; hitSource = null; glBinding = null; depthOn = false; goHome(); if (storyAfterExit) { storyAfterExit = false; startStory(); } }
$('exitBtn').addEventListener('click', () => { if (session) session.end(); else goHome(); });
/* 法輪功大事記：
   1. 有些網站主機會替網頁加上「沙箱」限制（window.origin 會變成 'null'），
      從沙箱網頁開出去的新分頁也會被鎖住，文章網頁的程式不能跑，就會一直轉圈。
   2. AR 模式還開著時，相機佔住畫面，新分頁也出不來。
   這兩種情況都改成「在同一個分頁打開」（AR 先關掉）；其他情況照常開新分頁。 */
for (const el of document.querySelectorAll('a.ext')) el.addEventListener('click', e => {
  const sandboxed = window.origin === 'null';
  if (!session && !sandboxed) return;
  e.preventDefault();
  const url = e.currentTarget.href; let gone = false;
  const go = () => { if (gone) return; gone = true; location.href = url; };
  if (!session) { go(); return; }
  session.addEventListener('end', () => setTimeout(go, 50), { once: true });
  session.end().catch(go);
  setTimeout(go, 1500);
});
/* 失敗畫面「再看一次故事」：先離開 AR／模擬場景，再從頭播故事 */
let storyAfterExit = false;
$('againStory').addEventListener('click', () => {
  initAudio();
  if (session) { storyAfterExit = true; session.end().catch(() => { if (storyAfterExit) { storyAfterExit = false; goHome(); startStory(); } }); }
  else { goHome(); startStory(); }
});
function goHome() {
  clearBattle(); stopVoice(); S.mode = 'none'; setPhase('none'); U.gray.value = 0;
  $('overlay').style.display = 'none'; canvas.style.display = 'none'; if (sim.built) sim.group.visible = false;
  modelMesh.visible = false; groundGrid.visible = false;
  camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
  show(user ? 'homeScr' : 'loginScr');
}

/* 深度感測 → 場域模型（每 3 幀取樣一次，20×15 個點） */
function sampleDepth(frame, view) {
  let di = null; try { di = frame.getDepthInformation(view); } catch { depthOn = false; return; }
  if (!di) return;
  const C = 20, R = 15, jx = Math.random(), jy = Math.random();
  for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) {
    const u = (i + jx) / C, v = (j + jy) / R;
    let d = 0; try { d = di.getDepthInMeters(u, v); } catch {}
    if (!(d > 0.6 && d < 12)) continue;
    tv.set(u * 2 - 1, 1 - v * 2, 0.5).applyMatrix4(camProjInv);
    tv.multiplyScalar(d / -tv.z).applyMatrix4(camWorld);
    field.add(tv.x, tv.y, tv.z, d < 6 ? 1 : 0.6);
  }
}
/* 平面偵測：地面 → 場域的地面高度；牆面、桌面 → 填進模型 */
const planeSeen = new WeakMap(), _pm = new THREE.Matrix4(), _pq = new THREE.Quaternion(), _pp = new THREE.Vector3(), _pu = new THREE.Vector3();
function ingestPlanes(frame) {
  const planes = frame.detectedPlanes; if (!planes || !planes.size) return;
  for (const pl of planes) {
    const seen = planeSeen.get(pl); if (seen && seen === pl.lastChangedTime) continue;
    let pose = null; try { pose = frame.getPose(pl.planeSpace, refSpace); } catch {}
    if (!pose || !pl.polygon || pl.polygon.length < 3) continue;
    planeSeen.set(pl, pl.lastChangedTime);
    const o = pose.transform.orientation, t = pose.transform.position;
    _pq.set(o.x, o.y, o.z, o.w); _pm.compose(_pp.set(t.x, t.y, t.z), _pq, _pu.set(1, 1, 1));
    const upY = _pu.set(0, 1, 0).applyQuaternion(_pq).y;
    const poly = pl.polygon.map(q => new THREE.Vector3(q.x, q.y, q.z));
    if (upY > 0.93 && t.y < camPos.y - 0.7) { field.setGround(t.y, 'plane'); continue; }   // 地面
    // 其他平面：在多邊形範圍內每 0.4 公尺放一點
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const q of poly) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
    for (let x = x0; x <= x1; x += CELL) for (let z = z0; z <= z1; z += CELL) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside; }
      if (!inside) continue;
      tv.set(x, 0, z).applyMatrix4(_pm); field.add(tv.x, tv.y, tv.z, 3);
    }
  }
}
/* 相機灰階（死亡時）：camera-access 可用時把鏡頭畫面變灰 */
const camTexture = new THREE.Texture();
const grayQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { map: { value: camTexture }, uGray: U.gray }, depthTest: false, depthWrite: false,
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }',
  fragmentShader: 'uniform sampler2D map; uniform float uGray; varying vec2 vUv; void main(){ vec3 c=texture2D(map,vUv).rgb; float l=dot(c,vec3(.299,.587,.114)); gl_FragColor=vec4(mix(c,vec3(l)*.8,uGray),uGray); }',
  transparent: true,
}));
grayQuad.frustumCulled = false; grayQuad.renderOrder = -1000; grayQuad.visible = false; scene.add(grayQuad);

function xrFrame(frame) {
  const pose = frame.getViewerPose(refSpace); if (!pose) return false;
  const view = pose.views[0];
  camWorld.fromArray(view.transform.matrix); camProj.fromArray(view.projectionMatrix); camProjInv.copy(camProj).invert();
  camPos.setFromMatrixPosition(camWorld); camFwd.set(0, 0, -1).transformDirection(camWorld);
  if (S.needOrigin) { S.needOrigin = false; field.origin.copy(camPos); resetScan(); }
  frameN++;
  const scanning = S.phase === 'scan' || S.phase === 'ready' || frameN % 4 === 0;    // 戰鬥中也慢慢補模型
  if (depthOn && scanning && frameN % 3 === 0) sampleDepth(frame, view);
  if (frameN % 10 === 0) ingestPlanes(frame);
  if (hitSource) {
    const hr = frame.getHitTestResults(hitSource);
    if (hr.length) {
      const p = hr[0].getPose(refSpace);
      if (p) {
        const t = p.transform.position, o = p.transform.orientation;
        const upY = _pu.set(0, 1, 0).applyQuaternion(_pq.set(o.x, o.y, o.z, o.w)).y;
        if (upY > 0.9 && t.y < camPos.y - 0.7) field.setGround(t.y, 'plane'); else field.add(t.x, t.y, t.z, 1.2);
      }
    }
  }
  // 死亡時的灰階鏡頭畫面
  grayQuad.visible = false;
  if (glBinding && U.gray.value > 0.01 && view.camera) {
    let tex = null; try { tex = glBinding.getCameraImage(view.camera); } catch {}
    if (tex) { const pr = renderer.properties.get(camTexture); pr.__webglTexture = tex; pr.__webglInit = true; grayQuad.visible = true; }
  }
  pUni.uH.value = session?.renderState?.baseLayer?.framebufferHeight || innerHeight;
  return true;
}

/* ================= 每一幀 ================= */
let lastT = 0;
renderer.setAnimationLoop((t, frame) => {
  const dt = Math.min(0.1, (t - lastT) / 1000 || 0.016) * (S.timeScale || 1); lastT = t;   // 上限 0.1 秒：手機偶爾掉幀時，遊戲時間不會跟著變慢
  if (S.mode === 'none') return;
  if (S.mode === 'xr') { if (!frame || !xrFrame(frame)) { renderer.render(scene, camera); return; } }
  else if (S.mode === 'sim') {
    updateSimCamera(dt);
    camWorld.copy(camera.matrixWorld); camPos.setFromMatrixPosition(camWorld); camFwd.set(0, 0, -1).transformDirection(camWorld);
    if (S.phase === 'scan' || S.phase === 'ready' || Math.random() < 0.25) simScan();
    pUni.uH.value = renderer.domElement.height;
  }
  if (S.phase === 'scan' || S.phase === 'ready') updateScan(dt);
  modelT -= dt;
  const showM = modelShow || S.phase === 'scan' || S.phase === 'ready';
  modelMesh.visible = showM; groundGrid.visible = showM;
  if (showM && modelT <= 0) { modelT = 0.4; updateModelMesh(); }
  setListener(camPos, camFwd, tv.set(0, 1, 0).transformDirection(camWorld));
  updateDragon(dt); updateFireballs(dt); updateSwords(dt); updateParts(dt); updateBooms(dt); updateFloaters(dt);
  U.gray.value = lerp(U.gray.value, S.grayTarget, 1 - Math.exp(-dt * 3));
  renderer.render(scene, camera);
});

if (new URLSearchParams(location.search).has('debug')) window.__g = { BattleMusic, loadedSounds, S, sim, scan, field, camera, castSword, secretHeal, hitUser, renderer, scene, updateDragon, get D() { return D; }, fireballs, swords, hitUser };
