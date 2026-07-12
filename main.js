'use strict';

// ============================================================
// お絵描き＆塗り絵アプリ 最小プロトタイプ
// 目標：1枚のSVG線画に対して、境界を尊重したバケツ塗りが効くこと。
//
// 設計（CLAUDE.md 準拠）:
//  - 視覚的に2層:  下=colorLayer(色)  上=lineLayer(線画)
//  - 色は colorLayer に書き込む
//  - 境界(壁)の判定は「線画レイヤーのピクセル」を読む → wallMask
//  - Flood Fill は非再帰(スキャンライン+スタック)
//  - devicePixelRatio 対応を最初から
// ============================================================

let currentSvgPath = 'images/fish.svg'; // 現在表示中の塗り絵

const stage       = document.getElementById('stage');
const colorLayer  = document.getElementById('colorLayer');
const lineLayer   = document.getElementById('lineLayer');
const colorCtx    = colorLayer.getContext('2d', { willReadFrequently: true });
const lineCtx     = lineLayer.getContext('2d', { willReadFrequently: true });

// 現在の塗り色（[r,g,b]）
let currentColor = [231, 76, 60]; // 赤

// 現在のどうぐ: 'fill'(バケツ) / 'pen'(ペン) / 'eraser'(けしごむ)
let mode = 'pen';

// ペン・けしごむ共通の太さ（CSS px 基準。実ピクセルでは dpr 倍する）
let strokeWidthCss = 28;

// バケツの模様: 'solid'(べた) / 'dots'(ドット) / 'stripes'(しま) / 'check'(いちまつ)
let currentPattern = 'solid';

// 模様の「インク部分」かどうか（true=現在色, false=白地）。座標は実ピクセル。
function patternInk(x, y) {
  const dpr = window.devicePixelRatio || 1;
  switch (currentPattern) {
    case 'dots': {
      const T = Math.max(6, Math.round(18 * dpr)); // タイル間隔
      const r = T * 0.30;                           // ドット半径
      const cx = (x % T) - T / 2;
      const cy = (y % T) - T / 2;
      return (cx * cx + cy * cy) <= r * r;
    }
    case 'stripes': {
      const S = Math.max(3, Math.round(10 * dpr));  // 縞の幅
      return Math.floor((x + y) / S) % 2 === 0;     // 斜めストライプ
    }
    case 'check': {
      const T = Math.max(4, Math.round(16 * dpr));  // 市松の升目
      return (Math.floor(x / T) + Math.floor(y / T)) % 2 === 0;
    }
    default:
      return true; // solid
  }
}

// ペン用：現在の模様＋色で「くり返しタイル」を作る（隙間は透明）。
// バケツの patternInk と同じ幾何・同じ原点基準なので見た目が揃う。
function buildPatternTile() {
  const dpr = window.devicePixelRatio || 1;
  let period;
  switch (currentPattern) {
    case 'dots':    period = Math.max(6, Math.round(18 * dpr)); break;
    case 'stripes': period = 2 * Math.max(3, Math.round(10 * dpr)); break;
    case 'check':   period = 2 * Math.max(4, Math.round(16 * dpr)); break;
    default: return null; // solid
  }
  const t = document.createElement('canvas');
  t.width = period; t.height = period;
  const tctx = t.getContext('2d');
  const img = tctx.createImageData(period, period);
  const d = img.data;
  const [r, g, b] = currentColor;
  for (let y = 0; y < period; y++) {
    for (let x = 0; x < period; x++) {
      const p = (y * period + x) * 4;
      if (patternInk(x, y)) { d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255; }
      // それ以外は透明（alpha 0 のまま）
    }
  }
  tctx.putImageData(img, 0, 0);
  return t;
}

// キャンバスの実ピクセルサイズ（= CSS px * dpr）
let W = 0;
let H = 0;

// 線画から作る「壁マスク」。wall[y*W + x] = 1 なら壁(線)で塗れない。
let wallMask = null;

// 塗り色を書き込む先の ImageData（colorLayer 用）
let colorImage = null;

// にじませ(dilation)の重複訪問防止。世代スタンプで毎回クリア不要にする。
let seen = null;
let fillGen = 0;

// もどる（元に戻す）用の履歴。色レイヤーのスナップショットを積む。
const undoStack = [];
const MAX_UNDO = 20;

// 読み込んだ SVG 画像
let svgImage = null;
// SVG本来のアスペクト比
let svgW = 400, svgH = 300;

// 壁とみなす暗さのしきい値（0-255 の輝度がこれ以下なら壁）
// 線の黒い芯を壁にする。アンチエイリアスの薄いフチは壁にせず、
// 塗りがフチまで届くことで「白い縁残り」を防ぐ。
const WALL_LUMA = 128;

// ------------------------------------------------------------
// SVG を同一オリジンで読み込んで Image 化（Tainted Canvas 回避）
// ------------------------------------------------------------
async function loadSvg(path) {
  const res = await fetch(path);
  const text = await res.text();

  // viewBox からアスペクト比を拾っておく
  const m = text.match(/viewBox\s*=\s*"([\d.\s]+)"/);
  if (m) {
    const p = m[1].trim().split(/\s+/).map(Number);
    if (p.length === 4) { svgW = p[2]; svgH = p[3]; }
  }

  const blob = new Blob([text], { type: 'image/svg+xml' });
  const url  = URL.createObjectURL(blob);
  const img  = new Image();
  await new Promise((resolve, reject) => {
    img.onload  = resolve;
    img.onerror = reject;
    img.src = url;
  });
  URL.revokeObjectURL(url);
  return img;
}

// ------------------------------------------------------------
// キャンバスのサイズ決定 + SVGラスタライズ + 壁マスク生成
// ------------------------------------------------------------
function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const box = stage.getBoundingClientRect();

  let cssW, cssH;
  if (svgImage) {
    // SVG のアスペクト比を保って stage 内に最大表示
    const scale = Math.min(box.width / svgW, box.height / svgH);
    cssW = Math.floor(svgW * scale);
    cssH = Math.floor(svgH * scale);
  } else {
    // 白紙：stage いっぱいに広げる
    cssW = Math.floor(box.width);
    cssH = Math.floor(box.height);
  }

  // 実ピクセル = CSS px * dpr（タップ座標ズレ・ぼやけ防止）
  W = Math.floor(cssW * dpr);
  H = Math.floor(cssH * dpr);

  for (const cv of [colorLayer, lineLayer]) {
    cv.style.width  = cssW + 'px';
    cv.style.height = cssH + 'px';
    cv.width  = W;
    cv.height = H;
  }

  if (svgImage) {
    // --- 線画を実ピクセル解像度でラスタライズ（オフスクリーン） ---
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const offCtx = off.getContext('2d', { willReadFrequently: true });
    offCtx.drawImage(svgImage, 0, 0, W, H);
    const raster = offCtx.getImageData(0, 0, W, H);
    const src = raster.data;

    // --- 壁マスク & 上に見せる線画レイヤーを同時生成 ---
    wallMask = new Uint8Array(W * H);
    const lineImg = lineCtx.createImageData(W, H);
    const ld = lineImg.data;

    for (let i = 0, p = 0; i < wallMask.length; i++, p += 4) {
      const r = src[p], g = src[p + 1], b = src[p + 2], a = src[p + 3];
      // 背景は白想定。透明部は白として扱う。
      // 輝度（低いほど暗い＝線）
      const luma = a === 0 ? 255 : (0.299 * r + 0.587 * g + 0.114 * b);

      // 壁判定：黒い芯だけを壁にする
      wallMask[i] = luma <= WALL_LUMA ? 1 : 0;

      // 上に見せる線画：黒線を残し、白地は透明に（下の色が透ける）
      // alpha は「暗さ」に比例させてアンチエイリアスを保つ
      ld[p]     = 0;
      ld[p + 1] = 0;
      ld[p + 2] = 0;
      ld[p + 3] = Math.max(0, 255 - luma);
    }
    lineCtx.putImageData(lineImg, 0, 0);
  } else {
    // --- 白紙：壁なし・線画レイヤーは空 ---
    wallMask = new Uint8Array(W * H); // すべて 0（壁なし）
    lineCtx.clearRect(0, 0, W, H);
  }

  // --- 色レイヤーは透明で初期化（下地の白は CSS 背景で見せる） ---
  colorImage = colorCtx.createImageData(W, H);
  colorCtx.putImageData(colorImage, 0, 0);

  // にじませ用の訪問済みマップ
  seen = new Int32Array(W * H);
  fillGen = 0;

  // キャンバスが作り直されたら履歴はリセット（サイズが変わるため）
  undoStack.length = 0;
  refreshUndoBtn();
}

// ------------------------------------------------------------
// もどる（元に戻す）
// ------------------------------------------------------------
// 変更の直前に呼び、色レイヤーの現在状態を履歴に積む。
function pushUndo() {
  try {
    undoStack.push(colorCtx.getImageData(0, 0, W, H));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    refreshUndoBtn();
  } catch (_) { /* getImageData 失敗時は履歴を積まない */ }
}

function undo() {
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  colorCtx.putImageData(prev, 0, 0);
  colorImage = prev; // 次のバケツ読み取り用に同期
  refreshUndoBtn();
}

function refreshUndoBtn() {
  if (!undoBtn) return;
  const empty = undoStack.length === 0;
  undoBtn.disabled = empty;
  undoBtn.style.opacity = empty ? '0.35' : '1';
}

// ------------------------------------------------------------
// バケツ塗り：スキャンライン方式の Flood Fill（非再帰）
//   - 塗る対象   : colorImage（色レイヤー）
//   - 境界の判定 : wallMask（線画レイヤー由来）
//   - 既に同色で埋まっている連結領域は再処理しない
// ------------------------------------------------------------
function bucketFill(sx, sy, rgb) {
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;

  const startIdx = sy * W + sx;
  if (wallMask[startIdx]) return; // 線の上を押したら何もしない

  // ペンで描いた分も取り込むため、色レイヤーの現在ピクセルを読み直す
  colorImage = colorCtx.getImageData(0, 0, W, H);
  const data = colorImage.data;
  const [nr, ng, nb] = rgb;

  // 開始ピクセルの現在色（塗り済みなら上書き対象）
  const sp = startIdx * 4;
  const tr = data[sp], tg = data[sp + 1], tb = data[sp + 2], ta = data[sp + 3];

  // 既に同じ色なら何もしない
  if (ta === 255 && tr === nr && tg === ng && tb === nb) return;

  // 変更が確定するので、直前の状態を履歴に積む
  pushUndo();

  // このピクセルが「塗り替え対象の色」かどうか
  const matches = (i) => {
    if (wallMask[i]) return false;       // 壁は不可
    const p = i * 4;
    return data[p]     === tr &&
           data[p + 1] === tg &&
           data[p + 2] === tb &&
           data[p + 3] === ta;
  };

  const paint = (i) => {
    const p = i * 4;
    data[p]     = nr;
    data[p + 1] = ng;
    data[p + 2] = nb;
    data[p + 3] = 255;
  };

  // 本体で塗ったピクセル（にじみ分は含めない）。パターン適用に使う。
  const region = [];

  // 塗った領域のうち「壁に接するピクセル」。線の下へにじませる起点。
  const edge = [];
  const pushIfEdge = (i, x, y) => {
    if ((x > 0     && wallMask[i - 1]) ||
        (x < W - 1 && wallMask[i + 1]) ||
        (y > 0     && wallMask[i - W]) ||
        (y < H - 1 && wallMask[i + W])) {
      edge.push(i);
    }
  };

  // ペン等の「異物」ピクセル判定：壁でも新色でも開始色でもない = ペンの線。
  const isForeign = (j) => {
    if (wallMask[j]) return false;
    const p = j * 4;
    if (data[p] === nr && data[p + 1] === ng && data[p + 2] === nb && data[p + 3] === 255) return false; // 自領域(新色)
    if (data[p] === tr && data[p + 1] === tg && data[p + 2] === tb && data[p + 3] === ta) return false;   // 未塗りの開始色
    return true;
  };

  // 塗った領域のうち「ペンに接するピクセル」。ペンの縁へにじませる起点。
  const penEdge = [];
  const pushIfPenEdge = (i, x, y) => {
    if ((x > 0     && isForeign(i - 1)) ||
        (x < W - 1 && isForeign(i + 1)) ||
        (y > 0     && isForeign(i - W)) ||
        (y < H - 1 && isForeign(i + W))) {
      penEdge.push(i);
    }
  };

  // スキャンライン: [x, y] を積む
  const stack = [[sx, sy]];

  while (stack.length) {
    const [x0, y] = stack.pop();
    let x = x0;

    // 左へ伸ばす
    while (x >= 0 && matches(y * W + x)) x--;
    x++;

    let spanUp = false, spanDown = false;

    // 右へ塗りながら進む
    while (x < W && matches(y * W + x)) {
      const i = y * W + x;
      paint(i);
      region.push(i);
      pushIfEdge(i, x, y);
      pushIfPenEdge(i, x, y);

      // 上の行
      if (y > 0) {
        const up = i - W;
        if (matches(up)) {
          if (!spanUp) { stack.push([x, y - 1]); spanUp = true; }
        } else {
          spanUp = false;
        }
      }
      // 下の行
      if (y < H - 1) {
        const dn = i + W;
        if (matches(dn)) {
          if (!spanDown) { stack.push([x, y + 1]); spanDown = true; }
        } else {
          spanDown = false;
        }
      }
      x++;
    }
  }

  // --- 白フチ対策：塗った色を「線の下」へ数px にじませる ---
  // 壁ピクセルにも色を置くことで、上の半透明な線が白ではなく色に重なる。
  // 黒い芯は不透明なので反対側の領域には透けない。
  const dpr = window.devicePixelRatio || 1;
  const UNDER = Math.max(2, Math.round(dpr * 2.5)); // にじませ幅（px）
  fillGen++;
  let frontier = edge;
  for (let step = 0; step < UNDER && frontier.length; step++) {
    const next = [];
    for (let k = 0; k < frontier.length; k++) {
      const i = frontier[k];
      const x = i % W;
      const y = (i / W) | 0;
      // 4近傍の「壁ピクセル」にだけ色を広げる
      if (x > 0)     tryUnder(i - 1, next);
      if (x < W - 1) tryUnder(i + 1, next);
      if (y > 0)     tryUnder(i - W, next);
      if (y < H - 1) tryUnder(i + W, next);
    }
    frontier = next;
  }

  // --- ペンの丸い跡対策：ペンの半透明な縁(中間色リング)を色で飲み込む ---
  // 壁用より小さい幅にして、ペンの線を食い過ぎないようにする。
  const FRINGE = Math.max(1, Math.round(dpr)); // にじませ幅（px, 約1-2px）
  fillGen++;
  frontier = penEdge;
  for (let step = 0; step < FRINGE && frontier.length; step++) {
    const next = [];
    for (let k = 0; k < frontier.length; k++) {
      const i = frontier[k];
      const x = i % W;
      const y = (i / W) | 0;
      // 4近傍の「壁でないピクセル(=ペンの縁)」へ色を広げる
      if (x > 0)     tryFringe(i - 1, next);
      if (x < W - 1) tryFringe(i + 1, next);
      if (y > 0)     tryFringe(i - W, next);
      if (y < H - 1) tryFringe(i + W, next);
    }
    frontier = next;
  }

  // --- パターン適用：本体領域の「地」の部分を白に置き換える ---
  // にじませ分(edge/penEdge)は単色のまま残し、白フチ・ペン縁対策を保つ。
  if (currentPattern !== 'solid') {
    for (let k = 0; k < region.length; k++) {
      const i = region[k];
      const x = i % W;
      const y = (i / W) | 0;
      if (!patternInk(x, y)) {
        const p = i * 4;
        data[p] = 255; data[p + 1] = 255; data[p + 2] = 255; data[p + 3] = 255;
      }
    }
  }

  colorCtx.putImageData(colorImage, 0, 0);

  function tryUnder(j, next) {
    if (!wallMask[j]) return;      // 壁の下だけに広げる
    if (seen[j] === fillGen) return;
    seen[j] = fillGen;
    paint(j);
    next.push(j);
  }

  function tryFringe(j, next) {
    if (wallMask[j]) return;       // 壁は tryUnder の担当
    if (seen[j] === fillGen) return;
    const p = j * 4;
    // 既に新色なら自領域なのでスキップ
    if (data[p] === nr && data[p + 1] === ng && data[p + 2] === nb && data[p + 3] === 255) return;
    seen[j] = fillGen;
    paint(j);
    next.push(j);
  }
}

// ------------------------------------------------------------
// タップ座標 → キャンバス実ピクセル座標
// ------------------------------------------------------------
function toPixel(clientX, clientY) {
  const [x, y] = toPixelF(clientX, clientY);
  return [Math.floor(x), Math.floor(y)];
}

// 実ピクセル座標（小数）。ペンの滑らかな描画用。
function toPixelF(clientX, clientY) {
  const rect = lineLayer.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width  * W;
  const y = (clientY - rect.top)  / rect.height * H;
  return [x, y];
}

// ------------------------------------------------------------
// 入力（タッチ / マウス）: モードで分岐
// ------------------------------------------------------------
let drawing = false;
let lastX = 0, lastY = 0;

function isDrawMode() {
  return mode === 'pen' || mode === 'eraser';
}

function strokeWidth() {
  return strokeWidthCss * (window.devicePixelRatio || 1);
}

// このストロークで使う模様パターン（solid や けしごむ の時は null）
let strokePattern = null;

// ストローク開始時に一度だけ模様パターンを用意する（毎moveの再生成を避ける）
function prepareStroke() {
  if (mode === 'pen' && currentPattern !== 'solid') {
    const tile = buildPatternTile();
    strokePattern = tile ? colorCtx.createPattern(tile, 'repeat') : null;
  } else {
    strokePattern = null;
  }
}

// ペン/けしごむのストローク設定。けしごむは destination-out で透明に消す。
function applyStrokeStyle() {
  colorCtx.lineWidth = strokeWidth();
  colorCtx.lineCap   = 'round';
  colorCtx.lineJoin  = 'round';
  if (mode === 'eraser') {
    colorCtx.globalCompositeOperation = 'destination-out';
    colorCtx.strokeStyle = 'rgba(0,0,0,1)';
    colorCtx.fillStyle   = 'rgba(0,0,0,1)';
  } else {
    colorCtx.globalCompositeOperation = 'source-over';
    if (strokePattern) {
      colorCtx.strokeStyle = strokePattern;
      colorCtx.fillStyle   = strokePattern;
    } else {
      const [r, g, b] = currentColor;
      colorCtx.strokeStyle = `rgb(${r},${g},${b})`;
      colorCtx.fillStyle   = `rgb(${r},${g},${b})`;
    }
  }
}

lineLayer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (mode === 'fill') {
    const [px, py] = toPixel(e.clientX, e.clientY);
    bucketFill(px, py, currentColor);
    return;
  }
  // ペン/けしごむ: 描き始め（点を1つ打つ）
  // 1ストローク＝1手として、描き始めの直前を履歴に積む
  pushUndo();
  lineLayer.setPointerCapture(e.pointerId);
  drawing = true;
  const [x, y] = toPixelF(e.clientX, e.clientY);
  lastX = x; lastY = y;
  prepareStroke();      // 模様パターンを用意（このストローク中は固定）
  applyStrokeStyle();
  colorCtx.beginPath();
  colorCtx.arc(x, y, strokeWidth() / 2, 0, Math.PI * 2);
  colorCtx.fill();
}, { passive: false });

lineLayer.addEventListener('pointermove', (e) => {
  if (!drawing || !isDrawMode()) return;
  e.preventDefault();
  const [x, y] = toPixelF(e.clientX, e.clientY);
  applyStrokeStyle();
  colorCtx.beginPath();
  colorCtx.moveTo(lastX, lastY);
  colorCtx.lineTo(x, y);
  colorCtx.stroke();
  lastX = x; lastY = y;
}, { passive: false });

function endStroke(e) {
  if (!drawing) return;
  drawing = false;
  colorCtx.globalCompositeOperation = 'source-over'; // 念のため戻す
  try { lineLayer.releasePointerCapture(e.pointerId); } catch (_) {}
}
lineLayer.addEventListener('pointerup', endStroke);
lineLayer.addEventListener('pointercancel', endStroke);

// 誤ジェスチャ封じ込め（保険）
document.addEventListener('gesturestart', (e) => e.preventDefault());   // ピンチ拡大
document.addEventListener('touchmove', (e) => {
  // スライダー操作・オーバーレイ内スクロールは許可（それ以外はスクロール等を抑止）
  if (e.target.closest && e.target.closest('#size, #picker, #saveModal')) return;
  e.preventDefault();
}, { passive: false });

// ダブルタップ拡大の抑止（iOS Safari は user-scalable=no を無視するため JS で止める）
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 350) e.preventDefault(); // 連続タップの2回目を無効化
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());

// ------------------------------------------------------------
// パレット
// ------------------------------------------------------------
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

document.querySelectorAll('.swatch').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    document.querySelectorAll('.swatch').forEach(b => b.classList.remove('is-selected'));
    btn.classList.add('is-selected');
    currentColor = hexToRgb(btn.dataset.color);
  });
});

// ------------------------------------------------------------
// もよう選択（バケツの模様）
// ------------------------------------------------------------
document.querySelectorAll('.pat').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    document.querySelectorAll('.pat').forEach(b => b.classList.remove('is-selected'));
    btn.classList.add('is-selected');
    currentPattern = btn.dataset.pattern;
  });
});

// ------------------------------------------------------------
// どうぐ切替（ぬり / ペン / けしごむ）。※ data-mode を持つボタンだけ
// ------------------------------------------------------------
document.querySelectorAll('.tool[data-mode]').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    document.querySelectorAll('.tool[data-mode]').forEach(b => b.classList.remove('is-selected'));
    btn.classList.add('is-selected');
    mode = btn.dataset.mode;
  });
});

// ------------------------------------------------------------
// もどる（元に戻す）ボタン
// ------------------------------------------------------------
const undoBtn = document.getElementById('undoBtn');
undoBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  undo();
});
refreshUndoBtn();

// ------------------------------------------------------------
// ふとさスライダー（ペン・けしごむ共通）
// ------------------------------------------------------------
const sizeRange = document.getElementById('sizeRange');
sizeRange.addEventListener('input', () => {
  strokeWidthCss = Number(sizeRange.value);
});

// ------------------------------------------------------------
// え えらび（SVG画像選択）。一覧は images/list.json から動的生成。
// images/ にSVGを追加 → list.json を更新すればピッカーに出る。
// （ローカル開発サーバーは list.json を自動生成するので追加のみでOK）
// ------------------------------------------------------------
const picker      = document.getElementById('picker');
const pickerPanel = picker.querySelector('.picker-panel');
const pickBtn     = document.getElementById('pickBtn');

// 最初の1枚を選ぶまでは true にならない（起動時の選択画面制御）
let started = false;

// list.json が無い/読めない時のフォールバック
const FALLBACK_IMAGES = ['fish.svg', 'car.svg', 'star.svg', 'flower.svg'];

pickBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  picker.hidden = false;
});

// 背景（パネル外）タップで閉じる。ただし最初の選択前は閉じさせない。
picker.addEventListener('pointerdown', (e) => {
  if (e.target === picker && started) picker.hidden = true;
});

// images/list.json を読む（配列。要素はファイル名 or {file} オブジェクト）
async function loadImageList() {
  try {
    const res = await fetch('images/list.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('list.json ' + res.status);
    const arr = await res.json();
    const files = arr
      .map(x => (typeof x === 'string' ? x : x && x.file))
      .filter(f => typeof f === 'string' && f.toLowerCase().endsWith('.svg'));
    return files.length ? files : FALLBACK_IMAGES;
  } catch (err) {
    console.warn('images/list.json を読めませんでした。既定リストを使用:', err);
    return FALLBACK_IMAGES;
  }
}

// ピッカーのボタンを一覧から生成
function buildPicker(files) {
  pickerPanel.innerHTML = '';

  // 先頭に「しろ紙」（線画なしの白紙）タイル
  const blankBtn = document.createElement('button');
  blankBtn.className = 'pick pick--blank';
  blankBtn.dataset.src = '';
  blankBtn.setAttribute('aria-label', 'しろ紙');
  blankBtn.textContent = 'しろ紙';
  if (currentSvgPath === null) blankBtn.classList.add('is-selected');
  blankBtn.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    pickerPanel.querySelectorAll('.pick').forEach(b => b.classList.remove('is-selected'));
    blankBtn.classList.add('is-selected');
    picker.hidden = true;
    started = true;
    if (currentSvgPath !== null) {
      currentSvgPath = null;
      await switchImage(null);
    }
  });
  pickerPanel.appendChild(blankBtn);

  for (const file of files) {
    const src = 'images/' + file;
    const btn = document.createElement('button');
    btn.className = 'pick';
    btn.dataset.src = src;
    btn.setAttribute('aria-label', file.replace(/\.svg$/i, ''));
    if (src === currentSvgPath) btn.classList.add('is-selected');

    const img = document.createElement('img');
    img.src = src;
    img.alt = file;
    btn.appendChild(img);

    btn.addEventListener('pointerdown', async (e) => {
      e.preventDefault();
      pickerPanel.querySelectorAll('.pick').forEach(b => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
      picker.hidden = true;
      started = true;
      if (src !== currentSvgPath) {
        currentSvgPath = src;
        await switchImage(src);
      }
    });

    pickerPanel.appendChild(btn);
  }
}

// ------------------------------------------------------------
// ほぞん（作品をPNGで保存）
//  色レイヤー(白地) + 線画レイヤー を合成して書き出す。
//  iPad Safari では共有シート経由で「写真に保存」できる。
// ------------------------------------------------------------
const saveBtn      = document.getElementById('saveBtn');
const saveModal    = document.getElementById('saveModal');
const saveImg      = document.getElementById('saveImg');
const saveDownload = document.getElementById('saveDownload');
const saveClose    = document.getElementById('saveClose');

function timestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `oekaki-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

// 2層 + 白い下地を1枚に合成して dataURL(PNG) を返す（同期処理）
function mergedDataURL() {
  const merged = document.createElement('canvas');
  merged.width = W; merged.height = H;
  const mctx = merged.getContext('2d');
  mctx.fillStyle = '#ffffff';
  mctx.fillRect(0, 0, W, H);
  mctx.drawImage(colorLayer, 0, 0);
  mctx.drawImage(lineLayer, 0, 0);
  return merged.toDataURL('image/png');
}

// dataURL → Blob（同期）
function dataURLtoBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function saveArtwork() {
  const name = timestampName();
  // 画像生成は同期で行い、ユーザー操作の有効性を保つ（共有API対策）
  const dataUrl = mergedDataURL();

  // 共有シートが使える環境（HTTPS/localhost）：写真に保存できる
  if (navigator.canShare) {
    const file = new File([dataURLtoBlob(dataUrl)], name, { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch((err) => {
        if (err && err.name === 'AbortError') return; // キャンセル
        openSaveModal(dataUrl, name);                 // 失敗時はプレビューへ
      });
      return;
    }
  }

  // フォールバック：プレビュー表示（iPadは長押し→写真に追加 / PCはダウンロード）
  openSaveModal(dataUrl, name);
}

function openSaveModal(dataUrl, name) {
  saveImg.src = dataUrl;
  saveDownload.href = dataUrl;
  saveDownload.download = name;
  saveModal.hidden = false;
}

saveBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try {
    saveArtwork();
  } catch (err) {
    console.error('保存に失敗:', err);
    alert('保存に失敗しました。');
  }
});

saveClose.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  saveModal.hidden = true;
});
saveModal.addEventListener('pointerdown', (e) => {
  if (e.target === saveModal) saveModal.hidden = true; // 背景タップで閉じる
});

// ------------------------------------------------------------
// 起動 / 画像切替
// ------------------------------------------------------------
async function switchImage(path) {
  if (path === null) {
    svgImage = null;                // 白紙（線画なし）
  } else {
    svgImage = await loadSvg(path); // svgImage, svgW, svgH を更新
  }
  setupCanvas();                    // ラスタライズ・壁マスク再生成・塗りリセット
}

// 回転・リサイズ時は作り直し（塗りはリセットされる最小仕様）
// ※ 最初の1枚を選ぶ前は何も作らない
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!started) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(setupCanvas, 200);
});

async function start() {
  const files = await loadImageList();
  currentSvgPath = undefined;   // まだ何も選んでいない
  buildPicker(files);
  picker.hidden = false;        // 起動時に「どのえで あそぶ？」の選択画面を出す
}

start().catch((err) => {
  console.error('初期化に失敗:', err);
  alert('画像リストの読み込みに失敗しました。ローカルサーバー経由で開いてください。');
});
