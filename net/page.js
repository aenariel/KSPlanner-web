/* Banner network page: isometric map (game / KSMapper orientation), HQ, forced and excluded
   outposts, enemy banners and HQs, targets, results. */
"use strict";
const $ = (id) => document.getElementById(id);
const M = 1200;
let world = null, base = null, staticLabels = [], smap = null, outposts = [], zoneMask = null;
let hq = null;                 // [x, y] lower-left tile of the Badland HQ
let own = { tag: "", banners: [] };   // current network from the CSV
let forced = [], excluded = [];       // outpost anchors [x, y]
let enemies = [];              // { type: "banner" | "hq", x, y, src: "csv" | "map" }
let results = [], sel = -1, current = null;
let mode = "view";
const view = { cu: 600, cv: 600, s: 0.6 };
const cv = $("map"), g = cv.getContext("2d");
const C45 = Math.SQRT1_2;

const ZONES = [
  { name: "Plains", r: [300, 300, 899, 899], line: "rgba(40,110,40,0.7)" },
  { name: "Fertile", r: [450, 450, 749, 749], line: "rgba(20,90,20,0.8)" },
  { name: "Ruins", r: [552, 552, 647, 647], line: "rgba(130,80,20,0.8)" },
  { name: "Forbidden", r: [586, 586, 613, 613], line: "rgba(120,20,30,0.9)" },
];
const zoneAt = (x, y) => { let z = "Badlands"; for (const q of ZONES) if (x >= q.r[0] && x <= q.r[2] && y >= q.r[1] && y <= q.r[3]) z = q.name; return z; };
// map themes: mid-tone ground, or a dark one (KSMapper-like); the choice is kept in this browser
const THEMES = {
  light: {
    zone: { Badlands: [181, 182, 156], Plains: [158, 174, 134], Fertile: [134, 160, 114], Ruins: [172, 152, 124], Forbidden: [160, 128, 128] },
    terrain: { 1: [112, 102, 90], 2: [96, 132, 170], 3: [96, 132, 170], 4: [110, 140, 96] },
    node: { bread: [222, 186, 70], wood: [52, 110, 48], stone: [204, 204, 204], iron: [150, 80, 50] },
    zoneLine: { Plains: "rgba(25,55,20,.75)", Fertile: "rgba(15,45,12,.85)", Ruins: "rgba(90,55,20,.85)", Forbidden: "rgba(110,20,30,.9)" },
    text: "rgba(22,26,30,.92)", soft: "rgba(20,25,30,.85)", grid: "rgba(0,0,0,.12)", void: "#0b0d10",
  },
  dark: {
    zone: { Badlands: [44, 56, 40], Plains: [36, 64, 34], Fertile: [26, 58, 28], Ruins: [72, 52, 32], Forbidden: [74, 26, 34] },
    terrain: { 1: [86, 78, 70], 2: [38, 70, 108], 3: [38, 70, 108], 4: [40, 72, 40] },
    node: { bread: [206, 168, 56], wood: [96, 168, 84], stone: [168, 168, 168], iron: [176, 98, 62] },
    zoneLine: { Plains: "rgba(170,215,150,.55)", Fertile: "rgba(150,220,140,.6)", Ruins: "rgba(220,170,110,.7)", Forbidden: "rgba(230,110,120,.8)" },
    text: "rgba(222,226,230,.9)", soft: "rgba(214,220,226,.85)", grid: "rgba(255,255,255,.07)", void: "#07080a",
  },
};
// structures coloured by family, as in KSMapper (both levels of an outpost share the colour)
const STRUCT_COL = { "Builder's Guild": "#a04000", Armory: "#9a7d0a", "Scholar's": "#1a5276", Arsenal: "#880e4f", Forager: "#1e8449", Harvest: "#117a65", "Drill Camp": "#5d6d7e", Frontier: "#6e2c0c", Fortress: "#922b21", Sanctuary: "#6c3483" };
const structCol = (name) => STRUCT_COL[String(name || "").replace(/ \d+$/, "")] || "#922b21";
let theme = (() => { try { const t = localStorage.getItem("ksplanner-map-theme"); if (t === "light" || t === "dark") return t; } catch (e) {} return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; })();
const TH = () => THEMES[theme];
/* The fixed map (ground, lakes, mountains, nodes, structures) painted once per theme. */
function paintBase(sm) {
  const T = TH();
  base = base || document.createElement("canvas");
  base.width = M; base.height = M;
  const bg = base.getContext("2d");
  const img = bg.createImageData(M, M);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const t = world.terrain[y * M + x];
    const z = zoneAt(x, y);
    // 5 and up are structures' footprints and no-build zones (drawn with their own tint and outline)
    const c0 = t === 0 || t >= 5 ? T.zone[z] : (T.terrain[t] || T.zone[z]);
    let c = c0;
    // the castle (Ruins and the centre) is empty ground in the game: the decor and rocks in the data are left out
    if (z === "Ruins" || z === "Forbidden") c = T.zone[z];
    const o = (y * M + x) * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  for (const n of sm.nodes) {
    const c = T.node[n.type] || [90, 60, 40];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const o = ((n.y + dy) * M + n.x + dx) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
    }
  }
  bg.putImageData(img, 0, 0);
  for (const s of sm.structures) {
    const col = structCol(s.name);
    bg.fillStyle = col;
    bg.fillRect(s.x, s.y, s.size, s.size);
    const fx = Math.round(s.x + s.size / 2 - s.forbidden_zone / 2), fy = Math.round(s.y + s.size / 2 - s.forbidden_zone / 2);
    bg.fillStyle = col + (s.city_exempt ? "18" : "30");
    bg.fillRect(fx, fy, s.forbidden_zone, s.forbidden_zone);
  }
}
/* Zone borders and no-build zone outlines: thin lines on the tile edges, drawn each frame (world mode),
   so no row of tiles changes colour and it is clear which zone a tile is in. */
function drawMapLines() {
  const T = TH();
  for (const z of ZONES) rect(z.r[0], z.r[1], z.r[2] - z.r[0] + 1, z.r[3] - z.r[1] + 1, null, T.zoneLine[z.name], 1.5);
  if (!smap) return;
  for (const s of smap.structures) {
    const fx = Math.round(s.x + s.size / 2 - s.forbidden_zone / 2), fy = Math.round(s.y + s.size / 2 - s.forbidden_zone / 2);
    rect(fx, fy, s.forbidden_zone, s.forbidden_zone, null, structCol(s.name) + (s.city_exempt ? "90" : "e0"), 1.2);
  }
}
function setTheme(t) {
  theme = t;
  try { localStorage.setItem("ksplanner-map-theme", t); } catch (e) {}
  const b = document.getElementById("theme");
  if (b) b.textContent = t === "dark" ? "Light" : "Dark";
  if (world && smap) { paintBase(smap); draw(); }
}
const key = (p) => p[0] + "," + p[1];

async function init() {
  try {
    let sm = null;
    for (const src of ["static_map.json", "../static_map.json", "../../data/static_map.json"]) {
      try { const res = await fetch(src); if (res.ok) { sm = await res.json(); break; } } catch (e) {}
    }
    if (!sm) throw new Error("map data not found");
    smap = sm;
    world = Hive.buildWorld(sm);
    paintBase(sm);
    zoneMask = new Uint8Array(M * M);
    for (const s of sm.structures) {
      const fx = Math.round(s.x + s.size / 2 - s.forbidden_zone / 2), fy = Math.round(s.y + s.size / 2 - s.forbidden_zone / 2);
      if (Net.KINDS.includes(s.name)) {
        outposts.push({ name: s.name, x: s.x, y: s.y, size: s.size, fx, fy, fz: s.forbidden_zone });
        for (let y = fy; y < fy + s.forbidden_zone; y++) for (let x = fx; x < fx + s.forbidden_zone; x++) zoneMask[y * M + x] = 1;
      }
    }
    staticLabels = [];
    for (const s of sm.structures) staticLabels.push({ u: s.x + s.size / 2, v: s.y + s.size / 2, text: s.name || s.category, sub: s.x + "," + s.y, min: 1.5, big: true });
    for (const n of sm.nodes) staticLabels.push({ u: n.x + 1, v: n.y + 1, text: n.type[0].toUpperCase() + n.type.slice(1), sub: n.x + "," + n.y, min: 9 });
    $("loadmsg").textContent = "";
    loadState();
    if (hq) { view.cu = hq[0] + 1.5; view.cv = hq[1] + 1.5; view.s = 1.2; }
    refreshAll();
  } catch (e) {
    $("loadmsg").innerHTML = '<span class="err">Could not load the map data: ' + e.message + "</span>";
  }
}

// ---------------------------------------------------------------- view (isometric: +x up-right, +y up-left)
const dpr = () => window.devicePixelRatio || 1;
function mat() {
  const k = view.s * dpr();
  const a = k * C45, b = -k * C45, c = -k * C45, d = -k * C45;
  const e = cv.width / 2 - (a * view.cu + c * view.cv), f = cv.height / 2 - (b * view.cu + d * view.cv);
  return { a, b, c, d, e, f };
}
function toScreen(u, v) { const m = mat(); return [m.a * u + m.c * v + m.e, m.b * u + m.d * v + m.f]; }
function toWorld(px, py) {
  const m = mat(), X = px * dpr() - m.e, Y = py * dpr() - m.f, det = m.a * m.d - m.b * m.c;
  return [(m.d * X - m.c * Y) / det, (-m.b * X + m.a * Y) / det];
}
function tileAt(px, py) { const [u, v] = toWorld(px, py); return [Math.floor(u), Math.floor(v)]; }
function worldMode() { const m = mat(); g.setTransform(m.a, m.b, m.c, m.d, m.e, m.f); }
function screenMode() { g.setTransform(1, 0, 0, 1, 0, 0); }
function rect(x, y, w, h, fill, stroke, lw) {
  if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, h); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = (lw || 1.2) / view.s; g.strokeRect(x, y, w, h); }
}
function resize() {
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr()); cv.height = Math.round(r.height * dpr());
  draw();
}

const enemySq = (e) => (e.type === "hq" ? [e.x - 6, e.y - 6, 15] : [e.x - 3, e.y - 3, 7]);
function enemyMask() {
  const m = new Uint8Array(M * M);
  for (const e of enemies) {
    const [x0, y0, w] = enemySq(e);
    for (let y = Math.max(0, y0); y < Math.min(M, y0 + w); y++) for (let x = Math.max(0, x0); x < Math.min(M, x0 + w); x++) m[y * M + x] = 1;
  }
  return m;
}
let enMask = null;

/* The network on the map: the selected result, or the CSV's current network. */
/* The network on the map. With a result: its banners, each marked kept (already in the CSV's network)
   or new, plus the CSV's banners it takes down. Without one (or with "show the current network"):
   the CSV's network, all kept. */
function shown() {
  const d = results[sel];
  if ((!d || $("showcur").checked) && own.banners.length) {
    const c = current;
    return { banners: own.banners, empty: c ? c.emptyFlags : null, captured: c ? c.captured : [], outposts: c ? c.outposts : [], isCurrent: true,
      kept: own.banners.map(() => true), removed: [] };
  }
  if (!d) return null;
  if (!d._kept) {
    const have = new Set(own.banners.map(key)), mine = new Set(d.design.map(key));
    d._kept = d.design.map((b) => have.has(key(b)));
    d._removed = own.banners.filter((b) => !mine.has(key(b)));
  }
  return { banners: d.design, empty: d.emptyFlags, captured: d.captured, outposts: d.outposts, kept: d._kept, removed: d._removed };
}
// colours: green = already built (CSV), yellow = new, faded red = in the CSV but taken down;
// light shade = captures resources, strong shade = empty (as in the exported CSV)
const COL = { kept: "#8fe08f", keptEmpty: "#2f9e44", fresh: "#ffe680", freshEmpty: "#f1c40f", removed: "rgba(231,120,120,.75)" };
const SHADE = { kept: "rgba(90,200,100,.38)", fresh: "rgba(245,180,40,.42)", removed: "rgba(231,90,90,.28)" };
function territoryOf(banners) {
  const s = new Set();
  if (!hq) return s;
  const sq = (x0, y0, x1, y1) => { for (let y = Math.max(0, y0); y <= Math.min(M - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(M - 1, x1); x++) { const c = y * M + x; if (!zoneMask[c] && !(enMask && enMask[c])) s.add(c); } };
  sq(hq[0] - 6, hq[1] - 6, hq[0] + 8, hq[1] + 8);
  for (const [x, y] of banners) sq(x - 3, y - 3, x + 3, y + 3);
  return s;
}
let terrCache = { ref: null, set: null };
/* Territory split three ways: the HQ's and the kept banners' (green), what only new banners hold
   (yellow), what only taken-down banners held (faded red). */
function territories(net) {
  const keptB = [], newB = [];
  net.banners.forEach((b, i) => (net.kept[i] ? keptB : newB).push(b));
  const kept = territoryOf(keptB);
  const fresh = new Set(), gone = new Set();
  for (const c of territoryOf(newB)) if (!kept.has(c)) fresh.add(c);
  if (net.removed.length) {
    const all = territoryOf(net.banners);
    const sq = (x0, y0, x1, y1) => { for (let y = Math.max(0, y0); y <= Math.min(M - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(M - 1, x1); x++) { const c = y * M + x; if (!zoneMask[c] && !(enMask && enMask[c]) && !all.has(c)) gone.add(c); } };
    for (const [x, y] of net.removed) sq(x - 3, y - 3, x + 3, y + 3);
  }
  return { kept, fresh, gone };
}

function draw() {
  if (!cv.width) return;
  screenMode();
  g.fillStyle = TH().void; g.fillRect(0, 0, cv.width, cv.height);
  if (!base) return;
  worldMode();
  g.imageSmoothingEnabled = false;
  g.drawImage(base, 0, 0);
  drawMapLines();
  const px = view.s * dpr();
  const net = shown();
  // enemy ground
  for (const e of enemies) { const [x0, y0, w] = enemySq(e); rect(x0, y0, w, w, "rgba(231,76,60,.28)", null); }
  if (net) {
    if (terrCache.ref !== net.banners || terrCache.n !== net.removed.length) terrCache = { ref: net.banners, n: net.removed.length, set: territories(net) };
    const paint = (set, col) => { g.fillStyle = col; for (const c of set) if (!world.terrain[c]) g.fillRect(c % M, (c / M) | 0, 1, 1); };
    paint(terrCache.set.gone, SHADE.removed);
    paint(terrCache.set.fresh, SHADE.fresh);
    paint(terrCache.set.kept, SHADE.kept);
  }
  // outposts: forced / excluded / reached
  const reached = new Set(net ? net.outposts.map((o) => o.x + "," + o.y) : []);
  const fset = new Set(forced.map(key)), xset = new Set(excluded.map(key));
  for (const o of outposts) {
    const k = o.x + "," + o.y;
    if (reached.has(k)) { const col = structCol(o.name); rect(o.fx, o.fy, o.fz, o.fz, col + "70", col, 2); }
    if (fset.has(k)) { rect(o.fx, o.fy, o.fz, o.fz, "rgba(39,174,96,.25)", "#27ae60", 3); rect(o.x, o.y, o.size, o.size, "#27ae60", "#fff", 2); }
    if (xset.has(k)) {
      rect(o.fx, o.fy, o.fz, o.fz, "rgba(60,60,60,.25)", "#ff3b30", 3);
      g.strokeStyle = "#ff3b30"; g.lineWidth = 3 / view.s; g.beginPath();
      g.moveTo(o.fx, o.fy); g.lineTo(o.fx + o.fz, o.fy + o.fz); g.moveTo(o.fx + o.fz, o.fy); g.lineTo(o.fx, o.fy + o.fz); g.stroke();
    }
  }
  const edge = px >= 6 ? "rgba(0,0,0,.5)" : null;
  if (net) for (const [x, y] of net.captured) rect(x, y, 2, 2, null, "#fff", 2);
  // banners as tile squares (as in the hive generator), grown at low zoom so the network still reads
  const sz = Math.max(1, 4 * dpr() / px), off = (sz - 1) / 2;
  const sq = (x, y, fill, ring) => {
    g.fillStyle = fill; g.fillRect(x - off, y - off, sz, sz);
    g.strokeStyle = ring || "rgba(0,0,0,.55)"; g.lineWidth = (ring ? 2 : 1) * dpr() / px; g.strokeRect(x - off, y - off, sz, sz);
  };
  if (net) {
    for (const [x, y] of net.removed) sq(x, y, COL.removed, "rgba(120,30,30,.6)");
    net.banners.forEach(([x, y], i) => {
      const empty = net.empty && net.empty[i];
      sq(x, y, net.kept[i] ? (empty ? COL.keptEmpty : COL.kept) : (empty ? COL.freshEmpty : COL.fresh));
    });
  }
  for (const e of enemies) if (e.type === "banner") sq(e.x, e.y, "#c0392b", "#641e16");
  for (const e of enemies) if (e.type === "hq") rect(e.x, e.y, 3, 3, "#c0392b", "#641e16");
  if (hq) { rect(hq[0] - 6, hq[1] - 6, 15, 15, null, "rgba(142,68,173,.9)", 2); rect(hq[0], hq[1], 3, 3, "#8e44ad", "#4a235a"); }
  if (px >= 10) {
    const corners = [[0, 0], [cv.width / dpr(), 0], [0, cv.height / dpr()], [cv.width / dpr(), cv.height / dpr()]].map(([a, b]) => toWorld(a, b));
    const u0 = Math.floor(Math.min(...corners.map((c) => c[0]))), u1 = Math.ceil(Math.max(...corners.map((c) => c[0])));
    const v0 = Math.floor(Math.min(...corners.map((c) => c[1]))), v1 = Math.ceil(Math.max(...corners.map((c) => c[1])));
    g.strokeStyle = TH().grid; g.lineWidth = 1 / px;
    g.beginPath();
    for (let u = u0; u <= u1; u++) { g.moveTo(u, v0); g.lineTo(u, v1); }
    for (let v = v0; v <= v1; v++) { g.moveTo(u0, v); g.lineTo(u1, v); }
    g.stroke();
  }
  screenMode();
  drawLabels(px);
}
function coordAt(x, y, px) {
  if (px < 8 * dpr()) return;
  const [a, b] = toScreen(x, y);
  g.font = Math.round(Math.min(11 * dpr(), Math.max(8 * dpr(), px * 0.32))) + "px system-ui";
  g.textAlign = "center"; g.textBaseline = "top";
  g.fillStyle = TH().text;
  g.fillText(x + "," + y, a, b + 1 * dpr());
}
function nameAt(u, v, t, size) {
  const [a, b] = toScreen(u, v);
  g.font = "600 " + Math.round(size) + "px system-ui";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = "rgba(0,0,0,.6)"; g.shadowBlur = 3 * dpr(); g.fillStyle = "#fff";
  g.fillText(t, a, b);
  g.shadowBlur = 0; g.shadowColor = "transparent";
}
function drawLabels(px) {
  const corners = [[0, 0], [cv.width / dpr(), 0], [0, cv.height / dpr()], [cv.width / dpr(), cv.height / dpr()]].map(([a, b]) => toWorld(a, b));
  const u0 = Math.min(...corners.map((c) => c[0])) - 4, u1 = Math.max(...corners.map((c) => c[0])) + 4;
  const v0 = Math.min(...corners.map((c) => c[1])) - 4, v1 = Math.max(...corners.map((c) => c[1])) + 4;
  const D = dpr();
  for (const L of staticLabels) {
    if (px < L.min * D || L.u < u0 || L.u > u1 || L.v < v0 || L.v > v1) continue;
    nameAt(L.u, L.v, L.text, Math.min(12 * D, Math.max(9 * D, px * 0.45)));
    if (L.sub) { const [x, y] = L.sub.split(",").map(Number); coordAt(x, y, L.big ? Math.max(px, 8 * D) : px); }
  }
  if (hq) { nameAt(hq[0] + 1.5, hq[1] + 1.5, "HQ", Math.max(10 * D, Math.min(14 * D, px * 0.9))); coordAt(hq[0], hq[1], Math.max(px, 8 * D)); }
  const net = shown();
  if (net && px >= 26 * D) for (const b of net.banners) coordAt(b[0], b[1], px);
}

/* What stands on a tile, for the line under the map. */
function describeAt(x, y) {
  const inBox = (bx, by, w) => x >= bx && x < bx + w && y >= by && y < by + w;
  const out = [];
  const net = shown();
  if (hq && inBox(hq[0], hq[1], 3)) out.push("Your HQ " + key(hq));
  if (net) {
    net.banners.forEach(([bx, by], i) => {
      if (bx !== x || by !== y) return;
      const what = net.isCurrent ? "Current banner" : (net.kept[i] ? "Banner already built (kept)" : "New banner") + ", " + (i + 1) + " in build order";
      out.push(what + (net.empty ? ", " + (net.empty[i] ? "empty" : "captures resources") : ""));
    });
    for (const [bx, by] of net.removed) if (bx === x && by === y) out.push("Banner already built, taken down in this network");
  }
  for (const e of enemies) {
    if (e.type === "hq" ? inBox(e.x, e.y, 3) : (e.x === x && e.y === y)) out.push("Enemy " + (e.type === "hq" ? "HQ " : "banner ") + key([e.x, e.y]) + (e.src === "csv" ? " (from the CSV)" : ""));
  }
  if (enMask && enMask[y * M + x] && !out.some((t) => t.startsWith("Enemy"))) out.push("enemy territory");
  for (const o of outposts) {
    if (!inBox(o.fx, o.fy, o.fz)) continue;
    const k = o.x + "," + o.y;
    const st = forced.some((p) => key(p) === k) ? "forced" : excluded.some((p) => key(p) === k) ? "excluded" : "";
    out.push(o.name + " " + k + (st ? " (" + st + ")" : "") + (net && net.outposts.some((q) => q.x === o.x && q.y === o.y) ? ", reached" : ""));
  }
  if (smap) {
    for (const n of smap.nodes) if (inBox(n.x, n.y, 2)) out.push(n.type[0].toUpperCase() + n.type.slice(1) + " node " + n.x + "," + n.y + (net && net.captured.some((c) => c[0] === n.x && c[1] === n.y) ? ", captured" : ""));
  }
  if (!out.length && x >= 0 && y >= 0 && x < M && y < M) {
    const t = world.terrain[y * M + x];
    if (t === 1) out.push("Mountain"); else if (t === 2 || t === 3) out.push("Lake"); else if (t >= 5) out.push("Blocked ground");
  }
  return out.join("; ");
}

// ---------------------------------------------------------------- interaction
let drag = null;
cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, cu: view.cu, cv: view.cv, moved: false }; });
cv.addEventListener("pointermove", (e) => {
  const r = cv.getBoundingClientRect();
  const [tx, ty] = tileAt(e.clientX - r.left, e.clientY - r.top);
  const what = world ? describeAt(tx, ty) : "";
  $("hover").textContent = "X " + tx + "  Y " + ty + "  " + zoneAt(tx, ty) + (what ? "  ·  " + what : "");
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved) {
    const k = view.s;
    view.cu = drag.cu - (dx - dy) / (2 * k * C45);
    view.cv = drag.cv - (-dx - dy) / (2 * k * C45);
    draw();
  }
});
cv.addEventListener("pointerup", (e) => {
  if (drag && !drag.moved && world) {
    const r = cv.getBoundingClientRect();
    const [tx, ty] = tileAt(e.clientX - r.left, e.clientY - r.top);
    clickTile(tx, ty);
  }
  drag = null;
});
cv.addEventListener("wheel", (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
function zoomAt(px, py, f) {
  const [u, v] = toWorld(px, py);
  view.s = Math.max(0.3, Math.min(40, view.s * f));
  const [u2, v2] = toWorld(px, py);
  view.cu += u - u2; view.cv += v - v2; draw();
}
$("zin").onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.5); };
$("theme").onclick = () => setTheme(theme === "dark" ? "light" : "dark");
$("theme").textContent = theme === "dark" ? "Light" : "Dark";
$("zout").onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.5); };
$("fit").onclick = fit;
function fit() {
  const net = shown();
  const pts = [];
  if (hq) pts.push(hq);
  if (net) pts.push(...net.banners);
  if (!pts.length) return;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs) - 10, x1 = Math.max(...xs) + 10, y0 = Math.min(...ys) - 10, y1 = Math.max(...ys) + 10;
  view.cu = (x0 + x1) / 2; view.cv = (y0 + y1) / 2;
  const r = cv.getBoundingClientRect();
  // the rotated box's screen extent: (dx + dy) / sqrt 2 both ways
  const span = (x1 - x0 + y1 - y0) * C45;
  view.s = Math.max(0.3, Math.min(40, 0.9 * Math.min(r.width, r.height) / span));
  draw();
}

const MODE_HELP = {
  view: "Clicks only move the map.",
  hq: "Click the middle of your Badland HQ.",
  outpost: "Click an outpost (anywhere in its no-build zone): normal → forced → excluded → normal.",
  ebanner: "Click a tile to put an enemy banner there, or click one to take it away.",
  ehq: "Click the middle of an enemy HQ to add it, or click one to take it away.",
};
function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll(".modes button")) b.classList.toggle("on", b.dataset.mode === m);
  $("modehelp").textContent = MODE_HELP[m];
  $("modebadge").textContent = "Click: " + { view: "move only", hq: "set HQ", outpost: "outpost state", ebanner: "enemy banner", ehq: "enemy HQ" }[m];
  saveState();
}
for (const b of document.querySelectorAll(".modes button")) b.onclick = () => setMode(b.dataset.mode);

function clickTile(x, y) {
  if (mode === "hq") return setHQ(x - 1, y - 1);
  if (mode === "outpost") {
    const o = outposts.find((q) => x >= q.fx && x < q.fx + q.fz && y >= q.fy && y < q.fy + q.fz);
    if (!o) return;
    const k = o.x + "," + o.y;
    if (forced.some((p) => key(p) === k)) { forced = forced.filter((p) => key(p) !== k); excluded.push([o.x, o.y]); }
    else if (excluded.some((p) => key(p) === k)) excluded = excluded.filter((p) => key(p) !== k);
    else forced.push([o.x, o.y]);
    return changed();
  }
  if (mode === "ebanner") {
    const i = enemies.findIndex((e) => e.type === "banner" && e.x === x && e.y === y);
    if (i >= 0) enemies.splice(i, 1); else enemies.push({ type: "banner", x, y, src: "map" });
    return changed();
  }
  if (mode === "ehq") {
    const i = enemies.findIndex((e) => e.type === "hq" && x >= e.x && x < e.x + 3 && y >= e.y && y < e.y + 3);
    if (i >= 0) enemies.splice(i, 1); else enemies.push({ type: "hq", x: x - 1, y: y - 1, src: "map" });
    return changed();
  }
}
function changed() { refreshAll(); saveState(); }

$("go").onclick = () => { const x = parseInt($("hx").value, 10), y = parseInt($("hy").value, 10); if (Number.isFinite(x) && Number.isFinite(y)) setHQ(x, y, true); };
function setHQ(x, y, centre) {
  hq = [x, y];
  $("hx").value = x; $("hy").value = y;
  if (centre) { view.cu = x + 1.5; view.cv = y + 1.5; if (view.s < 1) view.s = 1.2; }
  changed();
}

// ---------------------------------------------------------------- CSV in
$("loadcsv").onclick = () => {
  const rows = $("csvin").value.split(/\r?\n/).map((l) => l.split(",").map((s) => s.trim())).filter((r) => r.length >= 4 && Number.isFinite(+r[1]) && Number.isFinite(+r[2]) && r[1] !== "");
  const inPlains = (x, y) => x >= 300 && x <= 899 && y >= 300 && y <= 899;
  let tag = $("tag").value.trim();
  if (!tag) { const h = rows.find((r) => r[0] === "hq" && !inPlains(+r[1], +r[2])); if (h) tag = h[3]; }
  if (!tag) { $("csvmsg").innerHTML = '<span class="err">No Badland HQ in the CSV: type the alliance tag.</span>'; return; }
  $("tag").value = tag;
  const h = rows.find((r) => r[0] === "hq" && r[3] === tag && !inPlains(+r[1], +r[2]));
  own = { tag, banners: rows.filter((r) => r[0] === "banner" && r[3] === tag).map((r) => [+r[1], +r[2]]) };
  enemies = enemies.filter((e) => e.src !== "csv");
  let ne = 0;
  if ($("othersEnemy").checked) for (const r of rows) {
    if ((r[0] !== "banner" && r[0] !== "hq") || r[3] === tag) continue;
    enemies.push({ type: r[0], x: +r[1], y: +r[2], src: "csv" }); ne++;
  }
  const plainsHq = rows.some((r) => r[0] === "hq" && r[3] === tag && inPlains(+r[1], +r[2]));
  $("csvmsg").textContent = tag + ": " + own.banners.length + " banners" + (h ? ", HQ " + h[1] + "," + h[2] : ", no Badland HQ") + (plainsHq ? " (Plains HQ left out)" : "") + (ne ? "; " + ne + " enemy banners / HQs from other tags" : "") + ".";
  results = []; sel = -1; $("results").hidden = true; current = null;
  if (h) setHQ(+h[1], +h[2], true); else changed();
  fit();
  evaluateCurrent();
};
/* Score the CSV's network (same targets, enemies and rules as a run) to shade and list it. */
function evaluateCurrent() {
  if (!hq || !own.banners.length) return;
  const ev = new Worker("worker.js");
  ev.onmessage = (e) => { if (e.data.type === "current") { current = e.data.current; showCurrent(); terrCache.ref = null; draw(); } ev.terminate(); };
  ev.postMessage({ kind: "evaluate", hx: hq[0], hy: hq[1], banners: own.banners, opts: options() });
}
$("clearcsv").onclick = () => {
  $("csvin").value = ""; own = { tag: "", banners: [] }; current = null;
  enemies = enemies.filter((e) => e.src !== "csv");
  $("csvmsg").textContent = ""; $("current").hidden = true; changed();
};
$("clearout").onclick = () => { forced = []; excluded = []; changed(); };
// one checkbox per outpost kind (ids kind0..kind11, kept with the other fields)
$("kinds").innerHTML = Net.KINDS.map((k, i) => '<label class="check"><input id="kind' + i + '" type="checkbox" checked> ' + k + "</label>").join("");
for (let i = 0; i < Net.KINDS.length; i++) $("kind" + i).addEventListener("change", refreshAll);
const setKinds = (on) => { for (let i = 0; i < Net.KINDS.length; i++) $("kind" + i).checked = on; saveState(); refreshAll(); };
$("kall").onclick = () => setKinds(true);
$("knone").onclick = () => setKinds(false);
$("clearen").onclick = () => { enemies = []; changed(); };
$("showcur").onchange = () => { terrCache.ref = null; draw(); };

// ---------------------------------------------------------------- options
function options() {
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  return {
    ratio: [num("rb", 3), num("rw", 3), num("rs", 2), num("ri", 1)].map((v) => Math.max(0, v)),
    baseType: $("btype").value, basePerHour: Math.max(0, num("bper", 50000)),
    forced: forced.slice(), excluded: excluded.slice(),
    offKinds: Net.KINDS.filter((k, i) => { const e = $("kind" + i); return e && !e.checked; }),
    enemies: enemies.map((e) => ({ type: e.type, x: e.x, y: e.y })),
    variants: Math.max(1, Math.min(16, Math.round(num("variants", 4)))),
    improveMs: Math.max(0, Math.round(num("secs", 30) * 1000)),
    emptyWeight: Math.max(0, num("ew", 1.5) - 1),
    existing: own.banners.slice(), existingCost: Math.max(0, Math.min(1, num("exc", 0.5))),
    maxBanners: Math.max(20, Math.min(285, Math.round(num("cap", 285)))),
  };
}
const kph = (n) => Math.round(n * Net.NODE_RATE / 1000) + "k";
function refreshAll() {
  enMask = enemies.length ? enemyMask() : null;
  terrCache.ref = null;
  const o = options();
  const T = Net.targetsOf(o);
  const bt = Net.TYPES.indexOf(o.baseType);
  $("tgtmsg").innerHTML = !o.ratio[bt] ? '<span class="err">The base resource needs a ratio above 0.</span>'
    : "Minimum nodes " + T.join(" / ") + " = " + T.map(kph).join(" / ") + " per hour (each node 3600/h).";
  // outpost list
  const byKey = new Map(outposts.map((q) => [q.x + "," + q.y, q]));
  const line = (p, st) => { const q = byKey.get(key(p)); return "<div><span>" + (st === "f" ? '<span class="ok">forced</span> ' : '<span class="err">excluded</span> ') + (q ? q.name : "?") + " " + key(p) + '</span><button data-k="' + key(p) + '" data-s="' + st + '">×</button></div>'; };
  $("outlist").innerHTML = forced.map((p) => line(p, "f")).join("") + excluded.map((p) => line(p, "x")).join("") || '<div class="msg" style="margin:0">None.</div>';
  for (const b of $("outlist").querySelectorAll("button")) b.onclick = () => { const k = b.dataset.k; if (b.dataset.s === "f") forced = forced.filter((p) => key(p) !== k); else excluded = excluded.filter((p) => key(p) !== k); changed(); };
  const nb = enemies.filter((e) => e.type === "banner").length, nh = enemies.length - nb;
  $("enmsg").textContent = enemies.length ? nb + " enemy banner(s), " + nh + " enemy HQ(s)" + (enemies.some((e) => e.src === "csv") ? " (" + enemies.filter((e) => e.src === "csv").length + " from the CSV)" : "") + "." : "None.";
  const why = hq ? Net.hqProblem(world, hq[0], hq[1]) : "no HQ yet";
  $("hqmsg").innerHTML = hq ? "HQ " + key(hq) + " (" + zoneAt(hq[0], hq[1]) + ")." + (why ? ' <span class="warn">' + why + "</span>" : "") : MODE_HELP.hq;
  $("run").disabled = !world || !hq || !!why || !o.ratio[bt];
  draw();
}
for (const id of ["rb", "rw", "rs", "ri", "btype", "bper"]) $(id).addEventListener("input", refreshAll);

// ---------------------------------------------------------------- solve
let worker = null, timer = null;
$("run").onclick = () => {
  if (!hq) return;
  if (worker) worker.terminate();
  if (timer) clearInterval(timer);
  worker = new Worker("worker.js");
  const opts = options();
  results = []; sel = -1; $("results").hidden = true;
  $("run").disabled = true; $("prog").style.width = "0";
  const t0 = Date.now();
  let workers = 1, done = 0;
  const estimate = () => Math.ceil(opts.variants / workers) * (opts.improveMs / 1000 + 5);
  const tick = () => {
    const el = (Date.now() - t0) / 1000, est = estimate();
    $("prog").style.width = Math.min(98, Math.round(el / est * 100)) + "%";
    $("runmsg").textContent = done + " of " + opts.variants + " variants done · " + Math.round(el) + " s of about " + Math.round(est) + " s (" + workers + (workers > 1 ? " workers side by side)" : " worker)");
  };
  timer = setInterval(tick, 500);
  $("runmsg").textContent = "Starting…";
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "start") { workers = m.workers; tick(); }
    else if (m.type === "progress") { done = m.done; tick(); }
    else if (m.type === "current") { current = m.current; showCurrent(); }
    else if (m.type === "done") {
      clearInterval(timer); timer = null;
      $("run").disabled = false; $("prog").style.width = "100%";
      results = m.results;
      $("runmsg").textContent = "Done in " + Math.round(m.ms / 1000) + " s (" + m.workers + (m.workers > 1 ? " workers)." : " worker).");
      if (results.length) { $("results").hidden = false; listResults(); pick(0); fit(); }
    } else if (m.type === "error") {
      clearInterval(timer); timer = null;
      $("run").disabled = false;
      $("runmsg").innerHTML = '<span class="err">' + m.message + "</span>";
    }
  };
  // the current network scored again with this run's settings, then the run
  evaluateCurrent();
  worker.postMessage({ hx: hq[0], hy: hq[1], opts });
};

const nodesTxt = (n) => Net.TYPES.map((t) => n[t]).join(" / ");
function statsHtml(d) {
  const T = Net.TYPES.map((t) => d.targets[t]);
  const rows = [
    ["Banners", d.banners],
    ["Empty banners", d.empty],
    ["Already built (kept) / new to build", (d.kept || 0) + " / " + (d.banners - (d.kept || 0))],
    ...(d === current || !own.banners.length ? [] : [["Already built, taken down", own.banners.length - (d.kept || 0)]]),
    ["Cost (banners, kept ones cheaper, + extra for empties)", d.cost.toFixed(1)],
    ["Nodes bread / wood / stone / iron", nodesTxt(d.nodes)],
    ["Per hour", Net.TYPES.map((t) => kph(d.nodes[t])).join(" / ")],
    ["Minimum", T.join(" / ")],
    ["Outpost kinds reached", d.goals.filter((g) => g.met).length + " of " + d.goals.length],
  ];
  return rows.map(([a, b]) => "<div><span>" + a + "</span><span>" + b + "</span></div>").join("") +
    d.errors.map((w) => '<div class="err">' + w + "</div>").join("") +
    (d.warnings || []).map((w) => '<div class="warn">' + w + "</div>").join("");
}
function listResults() {
  const box = $("designs"); box.innerHTML = "";
  results.forEach((d, i) => {
    const b = document.createElement("button");
    b.className = "design";
    b.textContent = (d.errors.length ? "Errors · " : "") + d.banners + " banners (" + (d.banners - (d.kept || 0)) + " new) · " + d.empty + " empty · " + nodesTxt(d.nodes) + " · " + d.mode;
    b.onclick = () => pick(i);
    box.appendChild(b);
  });
}
function pick(i) {
  sel = i;
  [...$("designs").children].forEach((b, j) => b.classList.toggle("sel", j === i));
  const d = results[i];
  $("stats").innerHTML = statsHtml(d);
  $("goals").innerHTML = "<tr><th>Kind</th><th>Outpost</th></tr>" + d.goals.map((g) => "<tr><td>" + g.kind + (g.forced ? ' <span class="ok">forced</span>' : "") + "</td><td>" + (g.met ? g.at.map(key).join(", ") : '<span class="err">not reached</span>') + "</td></tr>").join("");
  $("csv").value = Net.toCsv(hq, d.design, d.emptyFlags, own.tag || $("tag").value || "NET", own.banners);
  $("showcur").checked = false;
  terrCache.ref = null;
  draw();
}
function showCurrent() {
  if (!current) return;
  $("current").hidden = false;
  $("curstats").innerHTML = statsHtml(current);
}
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("csv").value); $("copymsg").textContent = "Copied."; }
  catch (e) { $("csv").select(); $("copymsg").textContent = "Selected: press Ctrl+C."; }
};
$("dl").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([$("csv").value], { type: "text/csv" }));
  a.download = (own.tag || "network") + "_network.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------------------------------------------------------------- state kept between visits (this browser only)
const STATE = "ksplanner-net-state";
const fields = () => [...document.querySelectorAll("#side input[id], #side select[id], #side textarea[id]:not([readonly])")].filter((e) => e.id !== "showcur");
function saveState() {
  try {
    const v = { hq, own, forced, excluded, enemies, mode, view: { cu: view.cu, cv: view.cv, s: view.s } };
    for (const e of fields()) v["f:" + e.id] = e.type === "checkbox" ? e.checked : e.value;
    localStorage.setItem(STATE, JSON.stringify(v));
  } catch (e) {}
}
function loadState() {
  try {
    const v = JSON.parse(localStorage.getItem(STATE) || "null");
    if (!v) { setMode("view"); return; }
    for (const e of fields()) if ("f:" + e.id in v) { if (e.type === "checkbox") e.checked = !!v["f:" + e.id]; else e.value = v["f:" + e.id]; }
    hq = v.hq || null; own = v.own || own; forced = v.forced || []; excluded = v.excluded || []; enemies = v.enemies || [];
    if (hq) { $("hx").value = hq[0]; $("hy").value = hq[1]; }
    setMode(v.mode || "view");
  } catch (e) { setMode("view"); }
}
document.getElementById("side").addEventListener("input", saveState);
document.getElementById("side").addEventListener("change", saveState);

window.addEventListener("resize", resize);
resize();
init();
