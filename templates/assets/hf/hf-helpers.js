/* ===========================================================================
 * hf-helpers.js — Channel Video Factory 共通のHF実装ヘルパー(classic script)
 *
 * 目的: エピソードごとに書き直していた汎用部品(素材配置・紙の名札・木札・
 *       吹き出し・章カード・手描き線・光・粒)を常設化し、scene-implementer が
 *       「その回にしかない演出」だけを書けるようにする。
 *
 * 取り込まれ方: このファイルは scaffold-composition.ts が composition 生成時に
 * インライン展開する(HFのコンパイラは外部スクリプトを取り込まず、composition は
 * 単体で完結している必要があるため)。**composition 側の写しを直接編集しない** —
 * 直すのはこのファイルで、直したら該当エピソードを再 scaffold するか差分を反映する。
 *
 * 契約(composition 側):
 *   1. チャンネル様式CSS(assets/hf/<slug>-style.css)を読み込んでおく
 *   2. 本体スクリプトの先頭で hfBind({ tl, A, pal, head }) を1度だけ呼ぶ
 *        tl   … gsap.timeline({paused:true})(必須)
 *        A    … 素材テーブル { key: {p:パス, ar:高さ÷幅, b:[x0,y0,x1,y1] } }(必須)
 *        pal  … 回固有の追加色(任意。基本5色はCSS変数から自動で読む)
 *        head … faceDisc 用の頭部座標 { key:[relX,relY,relR] }(任意)
 *   3. body 先頭で hfDefs() を呼ぶ(#rough / #rough7 フィルタを注入)
 *
 * **composition 側で NS / SH / PAL / HF を再宣言しないこと**(このファイルが持つ)。
 * 決定論のみ: Date.now / Math.random を使わない(ゆらぎは prng(seed))。
 * =========================================================================== */

var NS = "http://www.w3.org/2000/svg";
var SH = "drop-shadow(3px 5px 0 rgba(27,26,23,.18))";
var PAL = {};
var HF = { tl: null, A: {}, HEAD: {} };

function hfBind(o) {
  o = o || {};
  HF.tl = o.tl; HF.A = o.A || {}; HF.HEAD = o.head || {};
  var cs = getComputedStyle(document.documentElement), px = o.varPrefix || "--animal-";
  function v(name, fb) { var s = cs.getPropertyValue(px + name); return (s && s.trim()) || fb; }
  PAL = { paper: v("paper", "#F4F1E7"), ink: v("ink", "#1B1A17"), indigo: v("indigo", "#37416B"),
          red: v("red", "#C6382C"), yellow: v("yellow", "#E7B23A") };
  for (var k in (o.pal || {})) PAL[k] = o.pal[k];
  return PAL;
}

/* 手描きフィルタの注入。図解の線・枠・矢印はすべてこれを通す(裸の直線を出さない) */
function hfDefs(parent) {
  var host = parent || document.getElementById("root") || document.body;
  var sv = document.createElementNS(NS, "svg");
  sv.setAttribute("width", "0"); sv.setAttribute("height", "0");
  sv.setAttribute("aria-hidden", "true"); sv.setAttribute("data-layout-ignore", "");
  sv.style.cssText = "position:absolute;left:0;top:0";
  sv.innerHTML =
    '<defs>' +
    '<filter id="rough" x="-25%" y="-25%" width="150%" height="150%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="3" result="t"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="t" scale="3" xChannelSelector="R" yChannelSelector="G"/></filter>' +
    '<filter id="rough7" x="-25%" y="-25%" width="150%" height="150%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.028" numOctaves="2" seed="9" result="t7"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="t7" scale="7" xChannelSelector="R" yChannelSelector="G"/></filter>' +
    '</defs>';
  host.insertBefore(sv, host.firstChild);
  return sv;
}

/* ------------------------------ 基本ユーティリティ ------------------------------ */

/* シード付きPRNG(Math.random は決定論レンダーで禁止) */
function prng(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function scene(id) { return document.getElementById(id); }
function mk(tag, cls, parent) { var e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; }
function css(e, o) { for (var k in o) e.style[k] = o[k]; return e; }
function paper(c) { return mk("div", "paper-bg", c); }
function grain(c) { return mk("div", "grain", c); }
function ovf(e) { e.setAttribute("data-layout-allow-overflow", ""); return e; }
function S(p, tag, at) { var e = document.createElementNS(NS, tag); for (var k in at) e.setAttribute(k, at[k]); p.appendChild(e); return e; }
function svgl(c, z) {
  var s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 1920 1080");
  s.setAttribute("preserveAspectRatio", "none");
  s.setAttribute("class", "svgl");
  s.setAttribute("data-layout-ignore", "");
  if (z != null) s.style.zIndex = z;
  c.appendChild(s); return s;
}
function fx(o) {
  var f = [];
  if (o.blur) f.push("blur(" + o.blur + "px)");
  if (o.bright != null) f.push("brightness(" + o.bright + ")");
  if (o.sat != null) f.push("saturate(" + o.sat + ")");
  if (o.hue != null) f.push("hue-rotate(" + o.hue + "deg)");
  if (o.sepia) f.push("sepia(" + o.sepia + ")");
  if (o.shadow) f.push(SH);
  return f.join(" ");
}

/* ------------------------------ 素材の配置 ------------------------------ */

/* 全画面の舞台。o={blur,bright,sat,op,z,scale,translateY}
   scale/translateY は「カメラを動かすclipで画面の縁が空かないように」寄せるためのもの。 */
function stage(c, key, o) {
  o = o || {}; var a = HF.A[key];
  if (!a) throw new Error("stage: unknown asset key " + key);
  var i = mk("img", "bg", c); i.src = a.p; i.decoding = "async";
  var f = fx(o); if (f) i.style.filter = f;
  if (o.op != null) i.style.opacity = o.op;
  if (o.z != null) i.style.zIndex = o.z;
  var tr = [];
  if (o.scale) tr.push("scale(" + o.scale + ")");
  if (o.translateY) tr.push("translateY(" + o.translateY + ")");
  if (tr.length) i.style.transform = tr.join(" ");
  return i;
}

/* 舞台素材の上下端に「描かれていない帯」がある場合の寄せ。
   全clip同じ倍率・同じオフセットで敷けば、章をまたいでも画角が揃う。 */
function stageFit(c, key, o) {
  o = o || {};
  var i = stage(c, key, o);
  i.style.transform = "scale(" + (o.fit || 1.5) + ") translateY(" + (o.shift || "-10%") + ")";
  return i;
}

/* 素材を「見える大きさ・見える中心」で置く(透過素材の余白を無視して構図を取る)。
   o={vw|ew, cx, cy|ty|by, lx|left|top, rot, flip, z, op, blur, bright, sat, hue, sepia,
      shadow, cropTop, origin, over}
   戻り値の img には __b={left,top,ew,eh,vw,vh,cx,cy} が付く。 */
function pic(c, key, o) {
  var a = HF.A[key];
  if (!a) throw new Error("pic: unknown asset key " + key);
  var bw = a.b[2] - a.b[0], bh = a.b[3] - a.b[1];
  var ew = (o.vw != null) ? o.vw / bw : o.ew, eh = ew * a.ar;
  var i = mk("img", "sp", c); i.src = a.p; i.decoding = "async";
  var left = (o.cx != null) ? o.cx - ew * (a.b[0] + a.b[2]) / 2
           : (o.lx != null ? o.lx - ew * a.b[0] : (o.left || 0));
  var top;
  if (o.cy != null) top = o.cy - eh * (a.b[1] + a.b[3]) / 2;
  else if (o.ty != null) top = o.ty - eh * a.b[1];
  else if (o.by != null) top = o.by - eh * a.b[3];
  else top = o.top || 0;
  css(i, { width: ew + "px", height: eh + "px", left: left + "px", top: top + "px" });
  var f = fx(o); if (f) i.style.filter = f;
  if (o.op != null) i.style.opacity = o.op;
  if (o.z != null) i.style.zIndex = o.z;
  if (o.origin) i.style.transformOrigin = o.origin;
  if (o.cropTop) i.style.clipPath = "inset(" + (o.cropTop * 100) + "% 0 0 0)";
  var tr = []; if (o.rot) tr.push("rotate(" + o.rot + "deg)"); if (o.flip) tr.push("scaleX(-1)");
  if (tr.length) i.style.transform = tr.join(" ");
  if (o.over) ovf(i);
  i.__b = { left: left, top: top, ew: ew, eh: eh, vw: ew * bw, vh: eh * bh,
            cx: left + ew * (a.b[0] + a.b[2]) / 2, cy: top + eh * (a.b[1] + a.b[3]) / 2 };
  return i;
}

/* 素材の顔だけを丸く抜いて紙の縁で囲む(比較図の名札など)。
   HF.HEAD[key]=[relX,relY,relR] が要る(hfBind の head で渡す)。 */
function faceDisc(parent, key, cx, cy, r, z) {
  var h = HF.HEAD[key];
  if (!h) throw new Error("faceDisc: no head coords for " + key);
  var win = mk("div", null, parent);
  css(win, { position: "absolute", left: (cx - r) + "px", top: (cy - r) + "px",
    width: (2 * r) + "px", height: (2 * r) + "px", borderRadius: "50%", overflow: "hidden",
    background: PAL.paper, border: "6px solid " + PAL.ink, boxSizing: "border-box",
    zIndex: (z || 9), filter: SH });
  var ew = r * 0.86 / h[2], eh = ew * HF.A[key].ar;
  var i = ovf(mk("img", null, win)); i.src = HF.A[key].p;
  css(i, { position: "absolute", width: ew + "px", height: eh + "px",
    left: (r - 6 - h[0] * ew) + "px", top: (r - 6 - h[1] * eh) + "px", objectFit: "contain" });
  win.__img = i; return win;
}

/* ------------------------------ 光・空気 ------------------------------ */

/* 紙地のヴィネット(上下から紙が被さって「紙に載った絵」にする) */
function vignette(c, t, b) {
  var a = mk("div", "vig", c); css(a, { top: "0px", height: (t || 90) + "px" });
  var d = mk("div", "vig", c); css(d, { bottom: "0px", height: (b || 120) + "px" });
  return [a, d];
}
/* 上方からの光(radial-gradient を screen で落とす) */
function skyGlow(c, o) {
  o = o || {}; var d = mk("div", "glow", c);
  d.style.background = "radial-gradient(ellipse at " + (o.at || "25% 0%") + ", rgba(231,178,58," + (o.a || 0.45) + "), transparent 60%)";
  if (o.z != null) d.style.zIndex = o.z;
  return d;
}
/* 木漏れ日・窓明かりの斜め帯 */
function shafts(c, o) {
  o = o || {}; var n = o.n || 2, r = prng(o.seed || 7), out = [];
  for (var k = 0; k < n; k++) {
    var w = (o.w || 44) + Math.floor(r() * 22);
    var x = (o.x0 != null ? o.x0 : 180) + k * (o.gap || 420) + Math.floor(r() * 120);
    var d = mk("div", "shaft", c);
    css(d, { left: x + "px", top: "-300px", width: w + "px", height: "1700px",
      opacity: (o.op != null ? o.op : 0.25),
      background: "linear-gradient(180deg, rgba(231,178,58,.85), rgba(231,178,58,.05))",
      filter: "blur(8px)", transform: "rotate(" + (o.rot || 16) + "deg)" });
    ovf(d); out.push(d);
  }
  return out;
}
/* 降る光の粒(MotionPath の緩い弧・決定論) */
function motes(c, g, o) {
  o = o || {}; var n = o.n || 14, r = prng(o.seed || 3), out = [];
  for (var k = 0; k < n; k++) {
    var sz = 8 + Math.floor(r() * 9);
    var x = (o.x0 != null ? o.x0 : 140) + r() * (o.w || 1640);
    var y = (o.y0 != null ? o.y0 : -40) + r() * 120;
    var d = mk("div", "mote", c);
    css(d, { left: x + "px", top: y + "px", width: sz + "px", height: sz + "px",
      background: o.color || PAL.yellow, filter: "blur(4px)", opacity: "0" });
    ovf(d);
    var dur = (o.dur || 2.4) * (0.75 + r() * 0.5), dx = (r() - 0.5) * 260, fall = o.fall || 900;
    HF.tl.fromTo(d, { opacity: 0 }, { opacity: 0.85, duration: 0.3 }, g + k * 0.09);
    HF.tl.to(d, { motionPath: { path: [{ x: 0, y: 0 }, { x: dx * 0.4, y: fall * 0.45 }, { x: dx, y: fall }], curviness: 1.4 },
      duration: dur, ease: "sine.in" }, g + k * 0.09);
    HF.tl.to(d, { opacity: 0, duration: 0.4 }, g + k * 0.09 + dur - 0.4);
    out.push(d);
  }
  return out;
}

/* ------------------------------ 紙・札・吹き出し ------------------------------ */

/* 紙の名札・注記カード。o={x(中心),y(上端),w,h,fs,color,bgc,z} */
function plate(c, text, o) {
  var w = o.w || 260, h = o.h || 70;
  var root = mk("div", "plate", c);
  css(root, { left: (o.x - w / 2) + "px", top: o.y + "px", width: w + "px", height: h + "px" });
  if (o.z != null) root.style.zIndex = o.z;
  var bg = mk("div", "plate-bg", root); if (o.bgc) bg.style.background = o.bgc;
  var tx = mk("div", "plate-tx diagram-text", root); tx.textContent = text;
  css(tx, { fontSize: (o.fs || 32) + "px" }); if (o.color) tx.style.color = o.color;
  root.__bg = bg; root.__tx = tx; root.__cx = o.x; root.__cy = o.y + h / 2; root.__w = w; root.__h = h;
  return root;
}

/* 木札(全編同一意匠)。o={x(中心),y(上端),w,h,fs,stake,z,rot} */
function placard(c, text, o) {
  var w = o.w || 480, h = o.h || 130;
  var root = mk("div", "placard", c);
  css(root, { left: (o.x - w / 2) + "px", top: o.y + "px", width: w + "px", height: h + "px" });
  if (o.z != null) root.style.zIndex = o.z;
  if (o.rot) root.style.transform = "rotate(" + o.rot + "deg)";
  if (o.stake) {
    var st = ovf(mk("div", "stake", root));
    css(st, { left: (w / 2 - 20) + "px", top: (h - 6) + "px", width: "40px", height: "160px" });
    root.__stake = st;
  }
  var bd = mk("div", "pl-board", root);
  css(mk("div", "pl-g", root), { top: Math.round(h * 0.26) + "px" });
  css(mk("div", "pl-g", root), { top: Math.round(h * 0.7) + "px" });
  var pin = mk("div", "pl-pin", root); mk("i", null, pin);
  var tx = mk("div", "pl-tx", root); tx.textContent = text; css(tx, { fontSize: (o.fs || 40) + "px" });
  root.__board = bd; root.__tx = tx; root.__pin = pin;
  root.__w = w; root.__h = h; root.__cx = o.x; root.__cy = o.y + h / 2;
  return root;
}

/* 着地後の減衰揺れ(札を刺した・物を置いたときに必ず入れる) */
function settle(el, t, amp) {
  var a = amp || 3;
  HF.tl.to(el, { rotation: a, duration: 0.12, ease: "sine.out" }, t);
  HF.tl.to(el, { rotation: -a * 0.55, duration: 0.14, ease: "sine.inOut" }, t + 0.12);
  HF.tl.to(el, { rotation: 0, duration: 0.16, ease: "sine.inOut" }, t + 0.26);
}

/* 吹き出し(必ず y<82%)。o={x(中心),y(上端),w,tail,shout,z} */
function bubble(c, text, o) {
  var w = o.w || 430;
  var wrap = mk("div", "bw", c);
  css(wrap, { left: (o.x - w / 2) + "px", top: o.y + "px", width: w + "px" });
  if (o.z != null) wrap.style.zIndex = o.z;
  var b = mk("div", "speech-bubble" + (o.tail === "right" ? " tail-right" : "") + (o.shout ? " shout" : ""), wrap);
  b.textContent = text; wrap.__b = b; return wrap;
}

/* 横に張った紙の帯(= 時間の軌道)。端が画鋲留め・巻き癖の縞つき */
function paperTape(c, o) {
  var x = o.x != null ? o.x : 120, y = o.y, w = o.w || 1680, h = o.h || 96;
  var root = ovf(mk("div", null, c));
  css(root, { position: "absolute", left: x + "px", top: y + "px", width: w + "px", height: h + "px",
    zIndex: (o.z || 8), filter: SH, transform: "rotate(" + (o.rot || 0) + "deg)" });
  var bd = mk("div", null, root);
  css(bd, { position: "absolute", inset: "0px", background: PAL.paper, border: "5px solid " + PAL.ink,
    boxSizing: "border-box", borderRadius: "6px 10px 7px 9px", filter: "url(#rough)" });
  css(mk("div", null, root), { position: "absolute", inset: "6px", mixBlendMode: "multiply", opacity: "0.5",
    background: "repeating-linear-gradient(90deg, rgba(140,120,84,.22) 0 3px, rgba(140,120,84,0) 3px 34px)" });
  [[10, 10], [w - 30, 10]].forEach(function (p) {
    var pin = mk("div", "pin", root); css(pin, { left: p[0] + "px", top: p[1] + "px", zIndex: "5" }); mk("i", null, pin);
  });
  root.__board = bd; return root;
}

/* 方眼(罫線)の面。裸の線を出さないため薄く敷く用途 */
function gridBox(p, o) {
  var d = mk("div", null, p), st = o.step || 24, col = o.color || "rgba(55,65,107,.28)";
  css(d, { position: "absolute", left: (o.x - o.w / 2) + "px", top: (o.y - o.h / 2) + "px",
    width: o.w + "px", height: o.h + "px",
    backgroundImage: "repeating-linear-gradient(90deg," + col + " 0 1.6px,transparent 1.6px " + st + "px)," +
                     "repeating-linear-gradient(0deg," + col + " 0 1.6px,transparent 1.6px " + st + "px)",
    zIndex: (o.z != null ? o.z : 4) });
  if (o.op != null) d.style.opacity = o.op;
  return ovf(d);
}

/* 章カード(全枚共通の入り方)。下から紙が1枚めくれ上がって見出しが載る。 */
function chapterCard(c, kicker, title, g, D, stageKey) {
  paper(c); if (stageKey) stage(c, stageKey, { op: 0.18, blur: 2 });
  var wrap = mk("div", "cc-wrap", c);
  var card = mk("div", "chapter-card cc-sheet", wrap);
  card.innerHTML = '<div class="kicker"></div><div class="title"></div><div class="underline"></div>';
  card.querySelector(".kicker").textContent = kicker;
  card.querySelector(".title").textContent = title;
  var ul = card.querySelector(".underline"); ul.style.filter = "url(#rough)";
  css(card, { transformOrigin: "50% 100%" });
  HF.tl.fromTo(card, { rotationX: -85, opacity: 0.2 }, { rotationX: 0, opacity: 1, duration: 0.42, ease: "power3.out" }, g);
  HF.tl.fromTo(ul, { scaleX: 0, transformOrigin: "0% 50%" }, { scaleX: 1, duration: 0.3, ease: "power2.out" }, g + 0.16);
  HF.tl.fromTo(card.querySelector(".title"), { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" }, g + 0.12);
  HF.tl.to(wrap, { y: -1240, duration: 0.3, ease: "power2.in" }, g + D - 0.3);
  grain(c); return card;
}

/* ------------------------------ 手描きの線・記号 ------------------------------ */

/* SVG 線を「手で引く」(stroke-dashoffset)。len は概算でよい */
function draw(el, len, t, dur, ease) {
  el.style.strokeDasharray = len; el.style.strokeDashoffset = len;
  HF.tl.to(el, { strokeDashoffset: 0, duration: dur, ease: ease || "power2.out" }, t);
  return el;
}
/* 指示線 + 端の小丸(名札から対象へ) */
function pointer(sv, x1, y1, x2, y2, t, dur) {
  var l = S(sv, "line", { x1: x1, y1: y1, x2: x2, y2: y2, stroke: PAL.ink,
    "stroke-width": 5, "stroke-linecap": "round", filter: "url(#rough)" });
  draw(l, Math.hypot(x2 - x1, y2 - y1), t, dur || 0.3);
  var dot = S(sv, "circle", { cx: x2, cy: y2, r: 7, fill: PAL.ink, opacity: 0 });
  HF.tl.to(dot, { opacity: 1, duration: 0.12 }, t + (dur || 0.3));
  return { l: l, dot: dot };
}
/* 紙を切り抜いた矢印(ink の塗り + paper の縁取り + 平たい影) */
function cutArrow(c, pts, o) {
  o = o || {}; var sv = o.sv || svgl(c, o.z || 8);
  var g = S(sv, "g", { filter: "url(#rough) " + SH });
  var p = S(g, "path", { d: pts, fill: o.fill || PAL.ink, stroke: PAL.paper,
    "stroke-width": o.sw || 5, "stroke-linejoin": "round" });
  return { g: g, p: p, sv: sv };
}
/* 不定形の斑(裸の丸を出さないための共通部品) */
function blob(sv, cx, cy, r, seed, o) {
  o = o || {}; var rd = prng(seed), n = 7, pts = [];
  for (var k = 0; k < n; k++) {
    var a = k / n * Math.PI * 2, rr = r * (0.72 + rd() * 0.5);
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.86]);
  }
  var d = "M " + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
  for (var j = 1; j <= n; j++) {
    var p = pts[j % n], q = pts[(j + 1) % n];
    d += " Q " + p[0].toFixed(1) + " " + p[1].toFixed(1) + " " + ((p[0] + q[0]) / 2).toFixed(1) + " " + ((p[1] + q[1]) / 2).toFixed(1);
  }
  d += " Z";
  return S(sv, "path", { d: d, fill: o.fill || PAL.indigo, "fill-opacity": o.op != null ? o.op : 0.5,
    stroke: PAL.ink, "stroke-width": o.sw || 2, filter: "url(#rough)" });
}
/* 手描きの小さな×(黒丸で数を示さないための共通部品)。r は prng の関数を渡す */
function xMark(sv, x, y, r) {
  var s = 8 + r() * 4, rot = (r() - 0.5) * 20;
  var gg = S(sv, "g", { opacity: 0, filter: "url(#rough)" });
  S(gg, "line", { x1: x - s, y1: y - s, x2: x + s, y2: y + s, stroke: PAL.ink, "stroke-width": 5, "stroke-linecap": "round" });
  S(gg, "line", { x1: x + s, y1: y - s, x2: x - s, y2: y + s, stroke: PAL.ink, "stroke-width": 5, "stroke-linecap": "round" });
  S(gg, "circle", { cx: x + s + 8, cy: y + s + 6, r: 3, fill: PAL.ink, opacity: 0.7 });
  gg.__x = x; gg.__y = y; gg.__rot = rot; return gg;
}
/* 押し印のように置く(押された側が沈む) */
function stamp(el, t, d) {
  HF.tl.fromTo(el, { opacity: 0, scale: 1.7, rotation: el.__rot || 0, transformOrigin: (el.__x || 0) + "px " + (el.__y || 0) + "px" },
    { opacity: 1, scale: 1, rotation: el.__rot || 0, duration: d || 0.12, ease: "back.in(1.8)" }, t);
}
/* 緩い揺れ(決定論・有限回。repeat:-1 は禁止) */
function sway(el, g, D, o) {
  o = o || {}; var dur = o.dur || 1.3, n = Math.max(1, Math.floor(D / dur));
  HF.tl.fromTo(el, { rotation: -(o.rot || 2.4) }, { rotation: (o.rot || 2.4), duration: dur,
    ease: "sine.inOut", yoyo: true, repeat: Math.max(0, n - 1) }, g);
  if (o.origin) el.style.transformOrigin = o.origin;
  return el;
}

/* ------------------------------ 組み立て ------------------------------ */

/* SCENES を時刻順に構築する。未実装 clip には fallback(c,id,g,D) が呼ばれる。 */
function hfBuild(SCENES, fallback) {
  var built = 0, missing = [];
  document.querySelectorAll(".clip.scene").forEach(function (el) {
    var id = el.id, g = parseFloat(el.dataset.start), D = parseFloat(el.dataset.duration);
    if (typeof SCENES[id] === "function") { SCENES[id](g, D); built++; }
    else { missing.push(id); if (fallback) fallback(el, id, g, D); }
  });
  return { built: built, missing: missing };
}

/* 字幕の入り(全行共通)。timing.json から生成済みの .subtitle 要素に当てる */
function hfSubtitles(sel) {
  document.querySelectorAll(sel || ".subtitle.clip").forEach(function (el) {
    var t = parseFloat(el.dataset.start);
    HF.tl.fromTo(el.querySelector(".sub-inner"), { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" }, t);
  });
}
