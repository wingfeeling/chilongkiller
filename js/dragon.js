/* ================================================================
   赤龍斬 —— 邪龍模型（中國龍：蛇身、鹿角、長鬚、鬃毛、四爪五趾，無翅膀）
   全部程式產生，不用外部模型檔。
   本地座標：地面 y=0，龍頭面向 +Z；龍頭高約 4.5 公尺，身長約 22 公尺（盤成一團）
   介面：root, update(dt,camPos), setJaw(0~1), roar(), hit(),
         mouthWorld(v), emblemWorld(v), topWorld(v), hitTest(p,r),
         proxies[{c,rw}], state.dying(0~1), dispose()
   ================================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { G, clamp, lerp } from './common.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const cnv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/* ---------------- 貼圖：龍鱗（顏色＋凹凸） ---------------- */
function scaleMaps() {
  const W = 512, H = 512, col = cnv(W, H), hgt = cnv(W, H), cx = col.getContext('2d'), hx = hgt.getContext('2d');
  cx.fillStyle = '#2a0403'; cx.fillRect(0, 0, W, H); hx.fillStyle = '#000'; hx.fillRect(0, 0, W, H);
  const cols = 8, rows = 16, cw = W / cols, rh = H / rows;
  const isBelly = r => r >= 6 && r <= 9;           // v 0.375～0.625：腹部
  // 背、側面的鱗片：從尾往頭畫，靠頭的鱗片壓在後面的上面，鱗片邊緣朝尾巴（+u）
  for (let r = -1; r <= rows; r++) {
    if (isBelly(((r % rows) + rows) % rows)) continue;
    const odd = ((r % 2) + 2) % 2;
    for (let c = cols; c >= -1; c--) {
      const x = (c + odd * 0.5) * cw, y = (r + 0.5) * rh, rx = cw * 0.62, ry = rh * 0.66;
      const dorsal = Math.min(Math.abs(r + 0.5), Math.abs(rows - r - 0.5)) / (rows / 2);   // 0＝背脊，1＝腹側
      const lum = 0.65 + dorsal * 0.45 + (Math.random() - 0.5) * 0.12;
      const g = cx.createRadialGradient(x + rx * 0.25, y, 1, x, y, rx * 1.05);
      g.addColorStop(0, `rgb(${Math.round(225 * lum)},${Math.round(62 * lum)},${Math.round(34 * lum)})`);
      g.addColorStop(0.55, `rgb(${Math.round(150 * lum)},${Math.round(22 * lum)},${Math.round(14 * lum)})`);
      g.addColorStop(1, '#260302');
      cx.fillStyle = g; cx.beginPath(); cx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); cx.fill();
      cx.strokeStyle = 'rgba(255,150,80,.18)'; cx.lineWidth = 1.5; cx.beginPath(); cx.ellipse(x, y, rx * 0.92, ry * 0.9, 0, -Math.PI / 2.4, Math.PI / 2.4); cx.stroke();
      cx.strokeStyle = 'rgba(20,0,0,.85)'; cx.lineWidth = 2; cx.beginPath(); cx.ellipse(x, y, rx, ry, 0, -Math.PI / 2, Math.PI / 2); cx.stroke();
      const h = hx.createRadialGradient(x + rx * 0.35, y, 1, x, y, rx);
      h.addColorStop(0, '#fff'); h.addColorStop(0.7, '#888'); h.addColorStop(1, '#222');
      hx.fillStyle = h; hx.beginPath(); hx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); hx.fill();
      hx.strokeStyle = '#000'; hx.lineWidth = 3; hx.beginPath(); hx.ellipse(x, y, rx, ry, 0, -Math.PI / 2, Math.PI / 2); hx.stroke();
    }
  }
  // 腹甲：一節一節的橫向甲片（暗金）
  const y0 = 6 * rh, y1 = 10 * rh, pn = 6, pw = W / pn;
  for (let c = pn; c >= -1; c--) {
    const x = c * pw;
    const g = cx.createLinearGradient(x, 0, x + pw * 1.1, 0);
    g.addColorStop(0, '#4a2508'); g.addColorStop(0.35, '#b97a2a'); g.addColorStop(0.8, '#d9a650'); g.addColorStop(1, '#5a2c08');
    cx.fillStyle = g; cx.beginPath(); cx.moveTo(x, y0); cx.quadraticCurveTo(x + pw * 1.35, (y0 + y1) / 2, x, y1); cx.lineTo(x - pw * 0.1, y1); cx.lineTo(x - pw * 0.1, y0); cx.fill();
    const h = hx.createLinearGradient(x, 0, x + pw * 1.1, 0); h.addColorStop(0, '#222'); h.addColorStop(0.75, '#ddd'); h.addColorStop(1, '#111');
    hx.fillStyle = h; hx.beginPath(); hx.moveTo(x, y0); hx.quadraticCurveTo(x + pw * 1.35, (y0 + y1) / 2, x, y1); hx.lineTo(x - pw * 0.1, y1); hx.lineTo(x - pw * 0.1, y0); hx.fill();
  }
  // 腹甲與鱗片交界的陰影
  for (const yy of [y0, y1]) { const g = cx.createLinearGradient(0, yy - 10, 0, yy + 10); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(10,0,0,.7)'); g.addColorStop(1, 'rgba(0,0,0,0)'); cx.fillStyle = g; cx.fillRect(0, yy - 10, W, 20); }
  // 細微的雜訊
  const id = cx.getImageData(0, 0, W, H); for (let i = 0; i < id.data.length; i += 4) { const n = (Math.random() - 0.5) * 14; id.data[i] += n; id.data[i + 1] += n * 0.5; id.data[i + 2] += n * 0.4; } cx.putImageData(id, 0, 0);
  // 凹凸 → 法線貼圖
  const hd = hx.getImageData(0, 0, W, H).data, nc = cnv(W, H), nx = nc.getContext('2d'), nd = nx.createImageData(W, H);
  const hh = (x, y) => hd[((((y + H) % H) * W + ((x + W) % W)) * 4)] / 255;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (hh(x + 1, y) - hh(x - 1, y)) * 2.2, dy = (hh(x, y + 1) - hh(x, y - 1)) * 2.2, l = Math.hypot(dx, dy, 1), i = (y * W + x) * 4;
    nd.data[i] = (-dx / l * 0.5 + 0.5) * 255; nd.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; nd.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; nd.data[i + 3] = 255;
  }
  nx.putImageData(nd, 0, 0);
  const map = new THREE.CanvasTexture(col), normalMap = new THREE.CanvasTexture(nc);
  map.colorSpace = THREE.SRGBColorSpace;
  for (const t of [map, normalMap]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; }
  return { map, normalMap };
}

/* ---------------- 胸前標誌：中共黨徽（鎌刀與鎚子） ---------------- */
export function drawEmblem(x, S = 512) {
  // 不要外圈：只有鎌刀與鎚子本身，背景透明，直接印在鱗片上
  const c = S / 2, k = S / 512;
  const gold = x.createLinearGradient(0, 60 * k, 0, 450 * k); gold.addColorStop(0, '#fff3b0'); gold.addColorStop(0.45, '#f5c542'); gold.addColorStop(1, '#c98a12');
  x.save(); x.translate(c, c + 8 * k); x.scale(k, k);
  x.shadowColor = 'rgba(40,0,0,.85)'; x.shadowBlur = 6; x.shadowOffsetY = 3;
  x.fillStyle = gold; x.strokeStyle = '#7a4a05'; x.lineWidth = 3; x.lineJoin = 'round';
  // 鎌刀：刀身從左下的刀柄出發，往上繞過頂部，彎到右側，刀尖朝左
  x.beginPath();
  x.arc(4, -14, 150, Math.PI * 0.78, Math.PI * 2.2, false);         // 外緣
  x.arc(-18, -34, 118, Math.PI * 2.26, Math.PI * 0.86, true);       // 內緣
  x.closePath(); x.fill(); x.stroke();
  // 鎌刀柄（往左下）
  x.save(); x.translate(-104, 88); x.rotate(Math.PI * 0.27);
  x.beginPath(); x.roundRect(-16, -8, 32, 96, 10); x.fill(); x.stroke(); x.restore();
  // 鎚子：鎚柄從右下往左上，鎚頭在左上
  x.save(); x.rotate(Math.PI / 4);
  x.beginPath(); x.roundRect(-70, -14, 230, 28, 8); x.fill(); x.stroke();          // 鎚柄
  x.beginPath(); x.moveTo(-120, -54); x.lineTo(-62, -54); x.lineTo(-62, 54); x.lineTo(-120, 54); x.lineTo(-128, 30); x.lineTo(-128, -30); x.closePath(); x.fill(); x.stroke();   // 鎚頭
  x.restore();
  x.restore();
}
function emblemTexture() {
  const c = cnv(512, 512); drawEmblem(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

/* ---------------- 共用材質（只建一次，之後每條龍共用，不會卡頓） ---------------- */
let SH = null;
function shared() {
  if (SH) return SH;
  const { map, normalMap } = scaleMaps();
  const hMap = map.clone(), hNorm = normalMap.clone(); hMap.repeat.set(3, 2); hNorm.repeat.set(3, 2); hMap.needsUpdate = hNorm.needsUpdate = true;
  map.repeat.set(14, 1); normalMap.repeat.set(14, 1);
  const em = emblemTexture();
  // 身體專用的鱗片材質：黨徽直接「印」在胸口的鱗片上（鱗片的凹凸、光澤照樣透出來）
  const EMU = { uEmTex: { value: em }, uEmC: { value: new THREE.Vector3() }, uEmX: { value: new THREE.Vector3(1, 0, 0) }, uEmY: { value: new THREE.Vector3(0, 1, 0) },
    uEmN: { value: new THREE.Vector3(0, 0, 1) }, uEmR: { value: 0.5 }, uEmGlow: { value: 0.35 } };
  const bodySkin = new THREE.MeshStandardMaterial({ map, normalMap, normalScale: new THREE.Vector2(1.3, 1.3), roughness: 0.38, metalness: 0.22, emissive: 0x1a0200 });
  const emblemHook = sh => {
    Object.assign(sh.uniforms, EMU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vBodyP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBodyP = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vBodyP; uniform sampler2D uEmTex; uniform vec3 uEmC, uEmX, uEmY, uEmN; uniform float uEmR, uEmGlow;
vec4 emblemAt() {
  vec3 d = vBodyP - uEmC; float dep = dot(d, uEmN);
  vec2 q = vec2(dot(d, uEmX), dot(d, uEmY)) / (2.0 * uEmR) + 0.5;
  if (dep < 0.0 || q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return vec4(0.0);
  vec4 c = texture2D(uEmTex, q); c.a *= smoothstep(0.0, 0.25, dep / uEmR); return c;
}`).replace('#include <map_fragment>', `#include <map_fragment>
vec4 emC = emblemAt();
float scl = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
vec3 emS = mix(emC.rgb, emC.rgb * emC.rgb * 1.25, 0.6);   // 金色更飽和，不要泛白
diffuseColor.rgb = mix(diffuseColor.rgb, emS * clamp(0.5 + scl * 1.8, 0.55, 1.05), emC.a * 0.95);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += emC.rgb * emC.a * uEmGlow;`);
  };
  G(bodySkin);                                   // 先掛上「死亡變灰」的處理，再把印黨徽的處理接在前面
  const grayHook = bodySkin.onBeforeCompile;
  bodySkin.onBeforeCompile = sh => { emblemHook(sh); grayHook(sh); };
  bodySkin.customProgramCacheKey = () => 'gray-emblem';
  SH = {
    bodySkin, EMU,
    skin: G(new THREE.MeshStandardMaterial({ map, normalMap, normalScale: new THREE.Vector2(1.3, 1.3), roughness: 0.38, metalness: 0.22, emissive: 0x1a0200 })),
    head: G(new THREE.MeshStandardMaterial({ map: hMap, normalMap: hNorm, normalScale: new THREE.Vector2(1, 1), roughness: 0.4, metalness: 0.2, emissive: 0x1a0200 })),
    mane: G(new THREE.MeshStandardMaterial({ color: 0x8a1410, roughness: 0.75, metalness: 0.05, emissive: 0x220000, side: THREE.DoubleSide })),
    fin: G(new THREE.MeshStandardMaterial({ color: 0x6e0c09, roughness: 0.55, metalness: 0.1, emissive: 0x1a0000, side: THREE.DoubleSide })),
    horn: G(new THREE.MeshStandardMaterial({ color: 0x7a5a32, roughness: 0.45, metalness: 0.25 })),
    claw: G(new THREE.MeshStandardMaterial({ color: 0x1e1612, roughness: 0.3, metalness: 0.5 })),
    tooth: G(new THREE.MeshStandardMaterial({ color: 0xf0e4c4, roughness: 0.35 })),
    eye: G(new THREE.MeshStandardMaterial({ color: 0xc81008, emissive: 0xff1800, emissiveIntensity: 1.6, roughness: 0.2 })),
    iris: G(new THREE.MeshStandardMaterial({ color: 0xffd040, emissive: 0xffb020, emissiveIntensity: 3, roughness: 0.1 })),
    socket: G(new THREE.MeshStandardMaterial({ color: 0x120202, roughness: 0.9 })),
    pupil: G(new THREE.MeshBasicMaterial({ color: 0x050000 })),
    mouth: G(new THREE.MeshStandardMaterial({ color: 0x3a0303, emissive: 0xff3000, emissiveIntensity: 0.3, roughness: 0.6 })),
    tongue: G(new THREE.MeshStandardMaterial({ color: 0x8a1018, roughness: 0.5 })),
    whisker: G(new THREE.MeshStandardMaterial({ color: 0xa8322a, roughness: 0.5, metalness: 0.2, emissive: 0x200000 })),
    emblem: G(new THREE.MeshStandardMaterial({ map: em, emissiveMap: em, emissive: 0xffffff, emissiveIntensity: 0.75, roughness: 0.3, metalness: 0.35 })),
    gold: G(new THREE.MeshStandardMaterial({ color: 0xf0c048, roughness: 0.25, metalness: 1, emissive: 0x4a3000 })),
  };
  SH.flash = [SH.skin, SH.bodySkin, SH.head, SH.mane, SH.fin, SH.whisker];
  return SH;
}

/* ---------------- 幾何小工具 ---------------- */
// 沿曲線、由粗到細的管子（角、鬚、爪、鬃毛都用它）
function taperTube(pts, r0, r1, seg = 14, rad = 8, pw = 1) {
  const curve = new THREE.CatmullRomCurve3(pts), fr = curve.computeFrenetFrames(seg, false);
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const s = i / seg, p = curve.getPointAt(s), n = fr.normals[i], b = fr.binormals[i], r = lerp(r0, r1, Math.pow(s, pw));
    for (let j = 0; j <= rad; j++) {
      const a = j / rad * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      pos.push(p.x + r * (ca * n.x + sa * b.x), p.y + r * (ca * n.y + sa * b.y), p.z + r * (ca * n.z + sa * b.z)); uv.push(s, j / rad);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < rad; j++) { const a = i * (rad + 1) + j, b2 = a + rad + 1; idx.push(a, b2, a + 1, b2, b2 + 1, a + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  g.computeVertexNormals(); return g;
}
// 火焰狀的一縷鬃毛（沿 +Z 伸出，往 +Y 捲）
function strandGeo(len, curl, r0) {
  const g = taperTube([V(0, 0, 0), V(0, curl * 0.25, len * 0.33), V(0, curl * 0.7, len * 0.66), V(0, curl * 1.5, len)], r0, r0 * 0.06, 10, 6, 0.8);
  g.scale(1, 0.42, 1); g.computeVertexNormals(); return g;
}

// 杏仁形（兩端尖）的眼睛：上緣較平、下緣較彎，兩個眼角是尖的，不是橢圓
function almondGeo(w, hTop, hBot, d, nu = 28, nv = 10) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu * 2 - 1, env = Math.pow(1 - u * u, 1.15);       // 往兩端收成尖角
    for (let j = 0; j <= nv; j++) {
      const v = j / nv * 2 - 1, h = v > 0 ? hTop : hBot;
      pos.push(u * w, v * h * env, d * Math.pow(1 - u * u, 0.5) * Math.sqrt(Math.max(0, 1 - v * v))); uv.push(i / nu, j / nv);
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const a = i * (nv + 1) + j, b = a + nv + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); return g;
}

/* ================================================================ */
export function createDragon() {
  const M = shared();
  const own = [];                         // 這條龍自己的幾何（dispose 用）
  const Geo = g => { own.push(g); return g; };
  const root = new THREE.Group(); root.name = 'dragon';
  const body = new THREE.Group(); root.add(body);
  const sph = Geo(new THREE.SphereGeometry(1, 28, 18));
  const cone = Geo(new THREE.ConeGeometry(1, 1, 10).translate(0, 0.5, 0));
  const ball = (parent, mat, x, y, z, sx, sy = sx, sz = sx, ry = 0, rx = 0) => { const m = new THREE.Mesh(sph, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.rotation.set(rx, ry, 0); parent.add(m); return m; };
  const strands = [Geo(strandGeo(1, 0.25, 0.09)), Geo(strandGeo(1, -0.2, 0.08)), Geo(strandGeo(1, 0.45, 0.1))];
  const strand = (parent, mat, p, len, yaw, pitch, roll = 0, k = 0) => {
    const m = new THREE.Mesh(strands[k % 3], mat); m.position.copy(p); m.scale.setScalar(len); m.rotation.set(pitch, yaw, roll, 'YXZ'); parent.add(m); return m;
  };

  /* ---------------- 頭 ---------------- */
  const head = new THREE.Group(); head.rotation.order = 'YXZ'; body.add(head);
  const HS = 1.35; head.scale.setScalar(HS);
  const almondG = Geo(almondGeo(0.14, 0.042, 0.058, 0.07)), socketG = Geo(almondGeo(0.172, 0.06, 0.078, 0.055));
  const HEAD_BASE = V(0, 4.95, 1.45);
  ball(head, M.head, 0, 0.12, 0.35, 0.5, 0.46, 0.62);                 // 顱
  ball(head, M.head, 0, 0.04, 1.05, 0.34, 0.25, 0.74);                // 上顎
  ball(head, M.head, 0, 0.24, 0.95, 0.2, 0.13, 0.62);                 // 鼻樑
  ball(head, M.head, 0, 0.12, 1.62, 0.25, 0.14, 0.19);                // 鼻頭（壓低，不擋住眼睛）
  for (const sx of [-1, 1]) {
    { const n = ball(head, M.socket, sx * 0.12, 0.15, 1.77, 0.045, 0.026, 0.03); n.rotation.z = -sx * 0.5; }   // 鼻孔（小而斜，不會看起來像一對卡通眼睛）
    ball(head, M.head, sx * 0.36, -0.02, 0.5, 0.22, 0.26, 0.32);      // 腮
    // 眉骨：壓得很低、內側往下斜（怒目），半蓋住眼睛
    { const b = ball(head, M.head, sx * 0.28, 0.37, 0.86, 0.21, 0.075, 0.26, sx * 0.25); b.rotation.z = sx * 0.5; }
    { const b = ball(head, M.head, sx * 0.2, 0.33, 1.02, 0.1, 0.05, 0.12, sx * 0.2); b.rotation.z = sx * 0.6; }   // 眉頭的肉稜
    ball(head, M.head, sx * 0.2, 0.34, 1.3, 0.1, 0.09, 0.22, sx * 0.2); // 鼻上的肉瘤
    // 眼睛：細長、往上斜吊的血紅眼睛，中心熾熱的金色虹膜＋細如針的直立瞳孔（凶狠，不呆）
    const ed = V(sx * 0.32, 0.08, 1).normalize();
    const ec = V(sx * 0.3, 0.27, 0.9);
    const eyeG = new THREE.Group(); eyeG.position.copy(ec); eyeG.scale.setScalar(1.35); eyeG.rotation.set(0, Math.atan2(ed.x, ed.z), sx * 0.4); head.add(eyeG);
    { const s = new THREE.Mesh(socketG, M.socket); s.position.z = -0.012; eyeG.add(s); }   // 深色眼窩（杏仁形，眼角尖）
    eyeG.add(new THREE.Mesh(almondG, M.eye));                          // 血紅眼白（杏仁形，兩端尖）
    ball(eyeG, M.iris, 0.012, -0.004, 0.066, 0.036, 0.034, 0.024);   // 熾熱虹膜（小一點，讓尖尖的血紅眼角露出來）
    ball(eyeG, M.pupil, 0.012, -0.004, 0.086, 0.006, 0.036, 0.01);            // 針狀瞳孔
    // 鹿角（主幹＋兩個分叉）
    const a0 = V(sx * 0.22, 0.48, 0.32);
    const main = [a0, a0.clone().add(V(sx * 0.1, 0.35, -0.18)), a0.clone().add(V(sx * 0.22, 0.72, -0.55)), a0.clone().add(V(sx * 0.34, 0.95, -1.0)), a0.clone().add(V(sx * 0.4, 1.05, -1.4))];
    head.add(new THREE.Mesh(Geo(taperTube(main, 0.075, 0.018, 16, 8)), M.horn));
    head.add(new THREE.Mesh(Geo(taperTube([main[1], main[1].clone().add(V(sx * 0.06, 0.25, 0.12)), main[1].clone().add(V(sx * 0.1, 0.45, 0.1))], 0.042, 0.012, 8, 6)), M.horn));
    head.add(new THREE.Mesh(Geo(taperTube([main[2], main[2].clone().add(V(sx * 0.1, 0.25, 0.05)), main[2].clone().add(V(sx * 0.14, 0.42, -0.02))], 0.038, 0.01, 8, 6)), M.horn));
    head.add(new THREE.Mesh(Geo(taperTube([main[3], main[3].clone().add(V(sx * 0.16, 0.18, 0.02)), main[3].clone().add(V(sx * 0.26, 0.28, -0.04))], 0.03, 0.008, 8, 6)), M.horn));
    // 上排牙齒與獠牙
    for (let k = 0; k < 6; k++) { const t = new THREE.Mesh(cone, M.tooth); t.position.set(sx * (0.25 - k * 0.012), -0.12, 0.78 + k * 0.13); t.scale.set(0.025, 0.11, 0.025); t.rotation.x = Math.PI; head.add(t); }
    const fang = new THREE.Mesh(cone, M.tooth); fang.position.set(sx * 0.22, -0.1, 1.5); fang.scale.set(0.045, 0.26, 0.045); fang.rotation.set(Math.PI - 0.1, 0, 0); head.add(fang);
    // 鬃毛：從腮、後腦往後飄的火焰狀毛
    for (let k = 0; k < 9; k++) {
      const p = V(sx * (0.32 + Math.random() * 0.12), 0.38 - k * 0.09, 0.42 - k * 0.04);
      strand(head, M.mane, p, 0.75 + Math.random() * 0.45, sx * (2.5 + k * 0.05) + (Math.random() - 0.5) * 0.3, -0.25 + k * 0.08, 0, k);
    }
    // 腮邊的鰭狀毛
    for (let k = 0; k < 3; k++) strand(head, M.fin, V(sx * 0.48, 0.05 - k * 0.1, 0.55), 0.5 - k * 0.08, sx * 1.9, -0.3 + k * 0.25, 0, k);
  }
  // 頭頂往後的鬃毛
  for (let k = 0; k < 7; k++) strand(head, M.mane, V((Math.random() - 0.5) * 0.3, 0.55 - k * 0.03, 0.2 - k * 0.12), 0.9 + Math.random() * 0.4, Math.PI + (Math.random() - 0.5) * 0.6, -0.5 + k * 0.05, 0, k);
  ball(head, M.mouth, 0, -0.14, 1.0, 0.27, 0.1, 0.62);                // 口腔
  // 龍鬚：兩條長鬚，會飄動
  const whiskers = [];
  for (const sx of [-1, 1]) {
    const w = new THREE.Group(); w.position.set(sx * 0.3, 0.02, 1.48); head.add(w);
    w.add(new THREE.Mesh(Geo(taperTube([V(0, 0, 0), V(sx * 0.4, 0.06, 0.1), V(sx * 1.0, -0.15, -0.2), V(sx * 1.5, -0.55, -0.75), V(sx * 1.75, -1.05, -1.25), V(sx * 1.8, -1.5, -1.6)], 0.032, 0.006, 26, 6)), M.whisker));
    whiskers.push({ w, sx });
  }
  // 下顎（會張開）
  const jaw = new THREE.Group(); jaw.position.set(0, -0.12, 0.42); head.add(jaw);
  ball(jaw, M.head, 0, -0.12, 0.6, 0.3, 0.12, 0.66);
  ball(jaw, M.tongue, 0, -0.02, 0.55, 0.13, 0.035, 0.45);
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 5; k++) { const t = new THREE.Mesh(cone, M.tooth); t.position.set(sx * (0.22 - k * 0.012), -0.03, 0.45 + k * 0.14); t.scale.set(0.024, 0.1, 0.024); jaw.add(t); }
    const f = new THREE.Mesh(cone, M.tooth); f.position.set(sx * 0.2, -0.03, 1.08); f.scale.set(0.04, 0.2, 0.04); jaw.add(f);
  }
  // 龍鬚下巴的鬍鬚
  for (let k = 0; k < 7; k++) strand(jaw, M.mane, V((k - 3) * 0.06, -0.2, 0.5 + Math.abs(k - 3) * -0.04), 0.4 + Math.random() * 0.15, Math.PI + (k - 3) * 0.16, 0.75, 0, k);
  const MOUTH = V(0, -0.18, 1.6);

  /* ---------------- 身體（蛇身，每一幀重新計算形狀） ---------------- */
  // 身體的控制點（龍頭之後）：胸口直立面向前方，身體在後面盤一圈，尾巴從左邊翹起
  const BASE = [V(0, 3.55, 0.75), V(0, 2.7, 0.65), V(0, 1.85, 0.25), V(0.35, 1.3, -0.8), V(1.6, 1.45, -1.9), V(2.5, 2.4, -3.1),
    V(1.8, 3.55, -4.3), V(-0.3, 4.0, -4.6), V(-2.3, 3.3, -3.9), V(-2.9, 2.1, -2.6), V(-2.5, 1.2, -1.3), V(-3.3, 0.95, -0.1), V(-4.0, 1.6, 0.5), V(-4.3, 2.4, 0.35)].map(v => v.add(V(0, 0.4, 0)));
  const CP = [V(), V(), ...BASE.map(v => v.clone())];
  const curve = new THREE.CatmullRomCurve3(CP, false, 'centripetal');
  const NS = 120, NR = 22;
  const RAD = [[0, 0.4], [0.06, 0.55], [0.12, 0.7], [0.3, 0.62], [0.55, 0.48], [0.78, 0.3], [0.93, 0.13], [1, 0.05]];
  const radAt = s => { for (let i = 1; i < RAD.length; i++) if (s <= RAD[i][0]) { const [a, ra] = RAD[i - 1], [b, rb] = RAD[i], k = (s - a) / (b - a); return lerp(ra, rb, k * k * (3 - 2 * k)); } return 0.05; };
  const bGeo = Geo(new THREE.BufferGeometry());
  const bPos = new Float32Array(NS * (NR + 1) * 3), bNor = new Float32Array(NS * (NR + 1) * 3), bUv = new Float32Array(NS * (NR + 1) * 2), bIdx = [];
  for (let i = 0; i < NS - 1; i++) for (let j = 0; j < NR; j++) { const a = i * (NR + 1) + j, b = a + NR + 1; bIdx.push(a, b, a + 1, b, b + 1, a + 1); }
  bGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3).setUsage(THREE.DynamicDrawUsage));
  bGeo.setAttribute('normal', new THREE.BufferAttribute(bNor, 3).setUsage(THREE.DynamicDrawUsage));
  bGeo.setAttribute('uv', new THREE.BufferAttribute(bUv, 2)); bGeo.setIndex(bIdx);
  const bodyMesh = new THREE.Mesh(bGeo, M.bodySkin); bodyMesh.frustumCulled = false; body.add(bodyMesh);
  // 每個取樣點的框架：位置、切線（往尾）、背（D）、側（S）、半徑
  const SP = Array.from({ length: NS }, () => ({ p: V(), t: V(), d: V(), s: V(), r: 0 }));

  // 背鰭（一整排，用 InstancedMesh 一次畫）
  const finShape = new THREE.Shape(); finShape.moveTo(0, 0); finShape.quadraticCurveTo(0.05, 0.5, 0.42, 0.78); finShape.quadraticCurveTo(0.3, 0.35, 0.62, 0); finShape.closePath();
  const finGeo = Geo(new THREE.ExtrudeGeometry(finShape, { depth: 0.03, bevelEnabled: false }).translate(-0.1, -0.05, -0.015));
  const FIN_N = 46, fins = new THREE.InstancedMesh(finGeo, M.fin, FIN_N); fins.frustumCulled = false; body.add(fins);
  // 尾巴末端的火焰狀尾鬃
  const tailTuft = new THREE.Group(); body.add(tailTuft);
  for (let k = 0; k < 9; k++) strand(tailTuft, k % 3 ? M.mane : M.fin, V(0, 0, -0.1), 0.9 + Math.random() * 0.5, (k - 4) * 0.22, -0.2 + (k % 3) * 0.25, 0, k);
  // 四條腿：鷹爪五趾，手肘有火焰狀的毛
  const legGeo = Geo(taperTube([V(0, 0, 0), V(0.3, -0.25, -0.12), V(0.42, -0.6, -0.18), V(0.5, -0.95, 0.08), V(0.52, -1.08, 0.2)], 0.24, 0.1, 18, 10));
  const clawGeos = [-2, -1, 0, 1, 2].map(i => Geo(taperTube([V(0, 0, 0), V(i * 0.07, -0.12, 0.06), V(i * 0.1, -0.28, 0.12), V(i * 0.11, -0.38, 0.26), V(i * 0.1, -0.4, 0.36)], i === -2 ? 0.035 : 0.045, 0.006, 10, 6, 0.7)));
  const legs = [];
  for (const [s, sx] of [[0.135, 1], [0.135, -1], [0.47, 1], [0.47, -1]]) {
    const g = new THREE.Group(); g.matrixAutoUpdate = false; body.add(g);
    const inner = new THREE.Group(); g.add(inner);
    inner.add(new THREE.Mesh(legGeo, M.skin));
    const foot = new THREE.Group(); foot.position.set(0.52, -1.1, 0.2); inner.add(foot);
    ball(foot, M.head, 0, 0, 0, 0.13, 0.1, 0.15);
    clawGeos.forEach((cg, i) => { const c = new THREE.Mesh(cg, M.claw); c.position.set((i - 2) * 0.04, -0.04, 0.05); foot.add(c); });
    for (let k = 0; k < 4; k++) strand(inner, M.mane, V(0.42, -0.55, -0.2), 0.45 + k * 0.08, Math.PI + 0.25 * (k - 1.5), -0.6 + k * 0.2, 0, k);
    legs.push({ g, inner, s, sx });
  }

  /* ---------------- 胸前黨徽（打中這裡傷害最大） ---------------- */
  const emblem = new THREE.Group(); emblem.matrixAutoUpdate = false; body.add(emblem);
  // 不再是一塊牌子：圖案由身體材質直接印在鱗片上，這個空的 Group 只用來標記胸口的位置（傷害判定用）
  let sEm = 0.1;

  /* ---------------- 合併不會各自動的零件（減少繪製次數，手機跑得更順） ---------------- */
  function bake(group, skip = []) {
    group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert(), byMat = new Map(), dead = [];
    group.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh) return;
      for (let q = o; q && q !== group; q = q.parent) if (skip.includes(q)) return;
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      if (!byMat.has(o.material)) byMat.set(o.material, []); byMat.get(o.material).push(g); dead.push(o);
    });
    for (const o of dead) o.parent.remove(o);
    for (const [m, gs] of byMat) { const mg = mergeGeometries(gs); for (const x of gs) x.dispose(); if (mg) { own.push(mg); group.add(new THREE.Mesh(mg, m)); } }
  }
  bake(head, [jaw, ...whiskers.map(w => w.w)]); bake(jaw); bake(tailTuft);
  for (const L of legs) bake(L.inner);

  /* ---------------- 碰撞用的球（劍打中判定） ---------------- */
  const proxies = [];
  const spineProx = [];
  for (let i = 2; i < NS - 4; i += 5) { const q = { c: V(), rw: 0, i }; proxies.push(q); spineProx.push(q); }
  const headProx = [[V(0, 0.12, 0.35), 0.58], [V(0, 0.05, 1.15), 0.42], [V(0, 0.1, 1.6), 0.26]].map(([l, r]) => { const q = { c: V(), rw: r * HS, local: l, r: r * HS }; proxies.push(q); return q; });
  const legProx = legs.map(L => { const q = { c: V(), rw: 0.3, L }; proxies.push(q); return q; });

  /* ---------------- 動作 ---------------- */
  const state = { dying: 0 };
  let t = 0, jawTarget = 0, jawNow = 0, roarT = 0, hitT = 0, yaw = 0, pitch = 0.2;
  const m4 = new THREE.Matrix4(), mInv = new THREE.Matrix4(), _v = V(), _w = V(), _u = V(), _q = new THREE.Quaternion(), _s = V(), _one = V(1, 1, 1), REF = V(0, 0.4, -1).normalize();
  const tmpM = new THREE.Matrix4(), xA = V(), yA = V(), zA = V();
  for (const m of M.flash) m.emissive.setRGB(0.1, 0.01, 0);

  const cum = new Float32Array(NS);
  function buildBody() {
    // 先取樣位置，再自己算長度與切線（比內建的等弧長取樣快很多）
    for (let i = 0; i < NS; i++) { curve.getPoint(i / (NS - 1), SP[i].p); if (i) cum[i] = cum[i - 1] + SP[i].p.distanceTo(SP[i - 1].p); }
    const total = cum[NS - 1];
    let prevD = null;
    for (let i = 0; i < NS; i++) {
      const s = cum[i] / total, f = SP[i];
      f.t.subVectors(SP[Math.min(NS - 1, i + 1)].p, SP[Math.max(0, i - 1)].p).normalize(); f.u = s;
      // 平行移動的框架（避免身體扭麻花）
      if (!prevD) f.d.copy(REF).addScaledVector(f.t, -REF.dot(f.t)).normalize();
      else f.d.copy(prevD).addScaledVector(f.t, -prevD.dot(f.t)).normalize();
      f.s.crossVectors(f.d, f.t).normalize(); prevD = f.d;
      f.r = radAt(s) * (1 + 0.025 * Math.sin(t * 1.6 - s * 6));
      for (let j = 0; j <= NR; j++) {
        const a = j / NR * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), o = (i * (NR + 1) + j) * 3;
        // 腹部稍微扁平
        const flat = ca < 0 ? 0.85 : 1;
        const nx = ca * f.d.x + sa * f.s.x, ny = ca * f.d.y + sa * f.s.y, nz = ca * f.d.z + sa * f.s.z;
        const rr = f.r * (ca < 0 ? lerp(1, flat, -ca) : 1);
        bPos[o] = f.p.x + nx * rr; bPos[o + 1] = f.p.y + ny * rr; bPos[o + 2] = f.p.z + nz * rr;
        bNor[o] = nx; bNor[o + 1] = ny; bNor[o + 2] = nz;
        const ou = (i * (NR + 1) + j) * 2; bUv[ou] = s; bUv[ou + 1] = j / NR;
      }
    }
    bGeo.attributes.position.needsUpdate = true; bGeo.attributes.normal.needsUpdate = true;
  }
  const frameAt = s => { let lo = 0, hi = NS - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (SP[m].u < s) lo = m; else hi = m; } return SP[hi]; };

  function update(dt, camPos) {
    t += dt;
    const die = state.dying;
    root.updateMatrix(); body.updateMatrix();
    m4.multiplyMatrices(root.matrix, body.matrix); mInv.copy(m4).invert();
    // 頭：看向使用者
    roarT = Math.max(0, roarT - dt);
    const roarK = roarT > 0 ? Math.sin(Math.min(1, (2.0 - roarT) / 2.0) * Math.PI) : 0;
    head.position.copy(HEAD_BASE).add(_v.set(Math.sin(t * 0.7) * 0.08, Math.sin(t * 0.9) * 0.1, Math.sin(t * 0.5) * 0.05));
    if (camPos) {
      _v.copy(camPos).applyMatrix4(mInv);
      const dx = _v.x - head.position.x, dz = _v.z - head.position.z, hz = Math.hypot(dx, dz);
      const wy = clamp(Math.atan2(dx, dz), -0.75, 0.75), wp = clamp(Math.atan2(head.position.y + 0.1 - _v.y, Math.max(0.5, hz)), -0.3, 0.6);
      yaw = lerp(yaw, wy, 1 - Math.exp(-dt * 2.5)); pitch = lerp(pitch, wp, 1 - Math.exp(-dt * 2.5));
    }
    head.rotation.set(pitch - roarK * 0.55 + hitT * 0.3 + die * 0.9, yaw, Math.sin(t * 0.6) * 0.05);
    if (die > 0) { head.position.y = lerp(head.position.y, 1.0, die); head.position.x += die * 0.6; }
    head.updateMatrix();
    // 下顎
    const jawWant = Math.max(jawTarget, roarK * 1.1, 0.06 + 0.04 * Math.sin(t * 2.1), die * 0.7);
    jawNow = lerp(jawNow, jawWant, 1 - Math.exp(-dt * 8)); jaw.rotation.x = jawNow * 0.62;
    M.mouth.emissiveIntensity = 0.3 + jawTarget * 3.5 + roarK * 1.2;
    for (const { w, sx } of whiskers) w.rotation.set(Math.sin(t * 1.3 + sx) * 0.12, Math.sin(t * 0.9 + sx * 2) * 0.15, sx * Math.sin(t * 1.1) * 0.1);
    // 脖子接在頭後面
    CP[0].set(0, -0.1, -0.05).applyMatrix4(head.matrix);
    _w.set(0, -0.35, -1).transformDirection(head.matrix);
    CP[1].copy(CP[0]).addScaledVector(_w, 0.65);
    // 身體：像蛇一樣緩緩起伏（越往尾巴擺動越大）
    for (let k = 0; k < BASE.length; k++) {
      const b = BASE[k], c = CP[k + 2], a = k < 2 ? 0.03 : 0.07 + 0.028 * (k - 2), ph = t * 1.05 - k * 0.75;
      c.set(b.x + a * Math.sin(ph), b.y + a * 0.7 * Math.cos(ph * 0.85), b.z + a * 0.5 * Math.sin(ph * 0.7));
      if (die > 0) { c.y = lerp(c.y, 0.45 + 0.15 * Math.sin(k), die); c.x += die * 0.4; }
    }
    if (die > 0) { CP[1].y = lerp(CP[1].y, 1.2, die); }
    buildBody();
    // 背鰭
    for (let k = 0; k < FIN_N; k++) {
      const f = frameAt(0.03 + k / FIN_N * 0.9), sc = clamp(f.r * 1.5, 0.12, 0.95) * (1 + 0.08 * Math.sin(t * 3 + k));
      _v.copy(f.p).addScaledVector(f.d, f.r * 0.82);
      xA.copy(f.t); yA.copy(f.d); zA.copy(f.s).negate();
      tmpM.makeBasis(xA, yA, zA).scale(_s.set(sc, sc, sc)).setPosition(_v); fins.setMatrixAt(k, tmpM);
    }
    fins.instanceMatrix.needsUpdate = true;
    // 尾鬃
    { const f = SP[NS - 1]; tmpM.makeBasis(_v.copy(f.s), _w.copy(f.d), _u.copy(f.t)).setPosition(f.p); tailTuft.matrix.copy(tmpM); tailTuft.matrixAutoUpdate = false; tailTuft.matrixWorldNeedsUpdate = true; }
    // 腿
    for (const L of legs) {
      const f = frameAt(L.s); _v.copy(f.p).addScaledVector(f.s, L.sx * f.r * 0.7).addScaledVector(f.d, -f.r * 0.25);
      xA.copy(f.s).multiplyScalar(L.sx); yA.copy(f.d); zA.copy(f.t).negate();
      L.g.matrix.makeBasis(xA, yA, zA).setPosition(_v); L.g.matrixWorldNeedsUpdate = true;
      L.inner.rotation.set(Math.sin(t * 1.2 + L.s * 9) * 0.12 - die * 0.6, 0, Math.sin(t * 0.9 + L.sx) * 0.08);
    }
    // 黨徽：印在胸口腹面，圖案上方朝龍頭（把投影的中心與方向交給身體材質）
    { const f = frameAt(sEm), E = M.EMU;
      E.uEmC.value.copy(f.p); E.uEmX.value.copy(f.s).negate(); E.uEmY.value.copy(f.t).negate(); E.uEmN.value.copy(f.d).negate(); E.uEmR.value = Math.min(0.56, f.r * 0.88);
      _v.copy(f.p).addScaledVector(f.d, -f.r * 0.92);
      xA.copy(f.s).negate(); yA.copy(f.t).negate(); zA.copy(f.d).negate();
      emblem.matrix.makeBasis(xA, yA, zA).setPosition(_v); emblem.matrixWorldNeedsUpdate = true; }
    // 受傷閃光
    hitT = Math.max(0, hitT - dt * 3);
    const glow = 0.1 + die * 0.5;
    for (const m of M.flash) m.emissive.setRGB(glow + hitT * 1.1, 0.01 + hitT * 0.85, hitT * 0.5);
    M.EMU.uEmGlow.value = (0.3 + 0.15 * Math.sin(t * 4) + hitT * 0.8) * (1 - die * 0.7);
    M.eye.emissiveIntensity = die > 0 ? 1.6 * (1 - die) : 1.6 + roarK * 1.5 + 0.3 * Math.sin(t * 2.3);
    M.iris.emissiveIntensity = die > 0 ? 3 * (1 - die) : 3 + roarK * 2.5;
    body.rotation.z = die * 0.25;
    root.updateMatrixWorld(true);
    updateProxies();
  }
  function updateProxies() {
    root.getWorldScale(_s); const sc = _s.x, bm = body.matrixWorld;
    for (const q of spineProx) { const f = SP[q.i]; q.c.copy(f.p).applyMatrix4(bm); q.rw = f.r * 1.08 * sc; }
    for (const q of headProx) { head.localToWorld(q.c.copy(q.local)); q.rw = q.r * sc; }
    for (const q of legProx) { q.L.inner.localToWorld(q.c.set(0.42, -0.6, -0.1)); q.rw = 0.32 * sc; }
  }

  // 先算一次形狀，找出胸口（第 3 個身體控制點）在哪裡，黨徽就放那裡
  update(0, null);
  { let best = 1e9; for (let i = 0; i < NS; i++) { const d = SP[i].p.distanceTo(BASE[1]); if (d < best) { best = d; sEm = SP[i].u; } } }
  update(0, null);

  return {
    root, proxies, state, update,
    setJaw(v) { jawTarget = clamp(v, 0, 1); },
    roar() { roarT = 2.0; },
    hit() { hitT = 1; },
    mouthWorld(v) { return head.localToWorld(v.copy(MOUTH)); },
    emblemWorld(v) { return emblem.localToWorld(v.set(0, 0, 0)); },
    topWorld(v) { return head.localToWorld(v.set(0, 1.55, 0)); },
    hitTest(p, r = 0) { for (const q of proxies) if (q.c.distanceTo(p) <= q.rw + r) return true; return false; },
    dispose() { for (const g of own) g.dispose(); },
  };
}
