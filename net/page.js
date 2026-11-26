/* Banner network page: isometric map (game / KSMapper orientation), HQ, forced and excluded
   outposts, enemy banners and HQs, targets, results. */
"use strict";
const $ = (id) => document.getElementById(id);
const M = 1200;
let world = null, base = null, staticLabels = [], smap = null, outposts = [], zoneMask = null, nodeMask = null;
let hq = null;                 // [x, y] lower-left tile of the Badland HQ
// current network from the CSV: banners = the Badland network (scored, optimised); all = every banner of
// the tag; plains = the ones chained only to a Plains HQ (left out with "Connect only to the Badland HQ");
// guides = banners of ignored tags (drawn as outlines)
let own = { tag: "", banners: [], all: [], plains: [], plainsHqs: [], guides: [] };
let repair = null;             // step 0 on the current network: { fixes, before, after }
let forced = [], excluded = [];       // outpost anchors [x, y]
let enemies = [];              // { type: "banner" | "hq", x, y, src: "csv" | "map" }
let results = [], sel = -1, current = null;
/* Territory mask from a scan (territory_mask.json): pieces tile by tile and the unseen tiles.
   pieceOn[i]: null = automatic (on unless it carries your tag), true / false = set by hand. */
let scan = null, pieceOn = [];
let scanR = null;              // { piece: Int16Array (index + 1), unseen: Uint8Array, forbid: Uint8Array, runs, key, tiles }
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
/* A stronger shade of a colour for outlines: darker on the light map, brighter on the dark one. */
function strong(c) {
  const rgb = Array.isArray(c) ? c : [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const out = theme === "dark" ? rgb.map((v) => Math.round(v + (255 - v) * 0.45)) : rgb.map((v) => Math.round(v * 0.55));
  return "rgb(" + out.join(",") + ")";
}
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
    nodeMask = new Uint8Array(M * M);
    for (const n of sm.nodes) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) nodeMask[(n.y + dy) * M + n.x + dx] = 1;
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
    // the CSV kept from the last visit: validate it straight away
    if (hq && own.banners && own.banners.length) evaluateCurrent();
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
  const m = scanR ? scanR.forbid.slice() : new Uint8Array(M * M);
  for (const e of enemies) {
    const [x0, y0, w] = enemySq(e);
    for (let y = Math.max(0, y0); y < Math.min(M, y0 + w); y++) for (let x = Math.max(0, x0); x < Math.min(M, x0 + w); x++) m[y * M + x] = 1;
  }
  return m;
}
let enMask = null;

// ---------------------------------------------------------------- territory mask from a scan
const MASK_STORE = "ksplanner-net-mask";
const tagOfPiece = (p) => [...(p.tags || []), p.probable, p.label_tag, String(p.name || "").replace(/\?$/, "")].filter(Boolean).map((t) => t.toLowerCase());
const isOwnPiece = (p) => !!own.tag && tagOfPiece(p).includes(own.tag.toLowerCase());
const pieceEnabled = (i) => (pieceOn[i] != null ? pieceOn[i] : !isOwnPiece(scan.pieces[i]));
function paintRuns(runs, fn) {
  for (let i = 0; i + 2 < runs.length; i += 3) {
    const y = runs[i]; if (y < 0 || y >= M) continue;
    for (let x = Math.max(0, runs[i + 1]); x <= Math.min(M - 1, runs[i + 2]); x++) fn(y * M + x);
  }
}
function encodeRuns(mask) {
  const out = [];
  for (let y = 0; y < M; y++) {
    let x = 0;
    while (x < M) {
      if (!mask[y * M + x]) { x++; continue; }
      const a = x; while (x < M && mask[y * M + x]) x++;
      out.push(y, a, x - 1);
    }
  }
  return out;
}
function hashRuns(r) { let h = 2166136261; for (const v of r) { h ^= v; h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + "." + r.length; }
/* The scan's raster: which piece holds each tile, the unseen tiles, and what the solver must treat as
   enemy ground (enabled pieces, plus the unseen tiles when that box is ticked, except inside your own
   HQ's and CSV banners' squares, where the icons of your own buildings hide the ground). */
function buildScan() {
  scanR = null;
  if (!scan) return;
  const t0 = performance.now();
  const piece = new Int16Array(M * M), unseen = new Uint8Array(M * M), forbid = new Uint8Array(M * M);
  scan.pieces.forEach((p, i) => paintRuns(p.runs, (c) => { piece[c] = i + 1; }));
  paintRuns(scan.unseen.runs, (c) => { unseen[c] = 1; });
  const mine = new Uint8Array(M * M);
  const sq = (x0, y0, x1, y1) => { for (let y = Math.max(0, y0); y <= Math.min(M - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(M - 1, x1); x++) mine[y * M + x] = 1; };
  if (hq) sq(hq[0] - 6, hq[1] - 6, hq[0] + 8, hq[1] + 8);
  for (const [x, y] of own.banners) sq(x - 3, y - 3, x + 3, y + 3);
  const on = scan.pieces.map((_, i) => pieceEnabled(i));
  const umode = $("unseenMode").value;
  let tiles = 0, unseenCounted = 0, unseenMine = 0;
  for (let c = 0; c < M * M; c++) { const p = piece[c]; if (p && on[p - 1]) { forbid[c] = 1; tiles++; } }
  // blocks of unseen tiles (8-neighbour): size, middle tile, and whether they touch an enemy piece
  const blockId = new Int32Array(M * M), blocks = [];
  for (let s = 0; s < M * M; s++) {
    if (!unseen[s] || blockId[s]) continue;
    const id = blocks.length + 1, list = [s];
    blockId[s] = id;
    let enemy = false, sx = 0, sy = 0;
    for (let k = 0; k < list.length; k++) {
      const c = list[k], x = c % M, y = (c / M) | 0;
      sx += x; sy += y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= M || Y >= M) continue;
        const d = Y * M + X;
        if (unseen[d]) { if (!blockId[d]) { blockId[d] = id; list.push(d); } }
        else if (forbid[d]) enemy = true;
      }
    }
    blocks.push({ id, size: list.length, x: Math.round(sx / list.length), y: Math.round(sy / list.length), enemy });
  }
  for (let c = 0; c < M * M; c++) {
    if (!unseen[c]) continue;
    if (mine[c]) { unseenMine++; continue; }
    if (umode === "enemy" || (umode === "touch" && blocks[blockId[c] - 1].enemy)) { forbid[c] = 1; unseenCounted++; }
  }
  const runs = encodeRuns(forbid);
  scanR = { piece, unseen, forbid, mine, blockId, blocks, runs, key: hashRuns(runs), tiles, unseenCounted, unseenMine };
  paintScan();
  console.log("[scan mask] " + on.filter(Boolean).length + "/" + on.length + " pieces on, " + tiles + " enemy tiles, " + unseenCounted +
    " unseen tiles counted as enemy (mode " + umode + ", " + blocks.length + " blocks), " + unseenMine + " unseen tiles inside your own squares, " + runs.length / 3 + " runs (" + Math.round(performance.now() - t0) + " ms)");
}
let scanImg = null;
function paintScan() {
  if (!scanR) { scanImg = null; return; }
  scanImg = scanImg || document.createElement("canvas");
  scanImg.width = M; scanImg.height = M;
  const cg = scanImg.getContext("2d"), img = cg.createImageData(M, M), d = img.data;
  const on = scan.pieces.map((_, i) => pieceEnabled(i));
  for (let c = 0; c < M * M; c++) {
    const p = scanR.piece[c], o = c * 4;
    let col = null;
    if (p) col = on[p - 1] ? [231, 76, 60, 80] : [120, 165, 230, 70];
    else if (scanR.unseen[c] && !scanR.mine[c]) col = scanR.forbid[c] ? [150, 150, 150, 150] : [150, 150, 150, 60];
    if (col) { d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = col[3]; }
  }
  cg.putImageData(img, 0, 0);
}
function scanList() {
  if (!scan) { $("masklist").innerHTML = ""; $("maskmsg").textContent = "No scan loaded."; return; }
  const big = [], small = [];
  scan.pieces.forEach((p, i) => (p.tiles >= 49 ? big : small).push(i));
  const row = (i) => {
    const p = scan.pieces[i], on = pieceEnabled(i);
    return '<div><label class="check" style="margin:0"><input type="checkbox" data-i="' + i + '"' + (on ? " checked" : "") + '> <span class="sw" style="display:inline-block;background:' + p.colour + '"></span> ' +
      p.name + (isOwnPiece(p) ? ' <span class="ok">yours</span>' : "") + '</label><span class="msg" style="margin:0">' + p.tiles + (p.hqs.length ? " · HQ " + p.hqs.map(key).join(" ") : "") + "</span></div>";
  };
  const smallOn = small.filter(pieceEnabled).length;
  $("masklist").innerHTML = big.map(row).join("") + (small.length ? '<div><label class="check" style="margin:0"><input type="checkbox" data-small="1"' + (smallOn ? " checked" : "") + "> " + small.length + " small pieces (under 49 tiles, " + small.reduce((a, i) => a + scan.pieces[i].tiles, 0) + " tiles)" + (smallOn && smallOn < small.length ? " · " + smallOn + " on" : "") + "</label></div>" : "");
  for (const b of $("masklist").querySelectorAll("input[data-i]")) b.onchange = () => { pieceOn[+b.dataset.i] = b.checked; scanChanged(); };
  const sb = $("masklist").querySelector("input[data-small]");
  if (sb) sb.onchange = () => { for (const i of small) pieceOn[i] = sb.checked; scanChanged(); };
  const nOn = scan.pieces.filter((_, i) => pieceEnabled(i)).length;
  const r = scan.region;
  $("maskmsg").innerHTML = "Kingdom " + (scan.kingdom != null ? scan.kingdom : "?") + ", scan " + (scan.scan || "?") + " (" + (scan.created || "") + "), region " + r[0] + "," + r[1] + " – " + r[2] + "," + r[3] + ". " +
    nOn + " of " + scan.pieces.length + " pieces are enemy ground (" + (scanR ? scanR.tiles : 0) + " tiles); " + scan.unseen.tiles + " tiles unseen" +
    (scanR ? " in " + scanR.blocks.length + " blocks, " + (scanR.unseenCounted ? scanR.unseenCounted + " counted as enemy" : "none counted as enemy") + (scanR.unseenMine ? ", " + scanR.unseenMine + " inside your own squares (yours)" : "") : "") + "." +
    (own.tag ? "" : ' <span class="warn">Load your CSV (or type your tag) so your own pieces are left out.</span>');
}
function scanChanged() { buildScan(); resplit(); scanList(); saveScanChoice(); refreshAll(); }
/* After the enemy ground changed: split the CSV's network again and score it again. */
function resplit() {
  if (!own.all || !own.all.length) return;
  splitOwn(); buildScan();
  results = []; sel = -1; $("results").hidden = true; current = null; repair = null;
  evaluateCurrent();
}
function saveScanChoice() { try { const v = JSON.parse(localStorage.getItem(STATE) || "{}"); v.pieceOn = pieceOn; localStorage.setItem(STATE, JSON.stringify(v)); } catch (e) {} }
function setScan(m, keepChoice) {
  scan = m;
  if (!keepChoice) pieceOn = m ? m.pieces.map(() => null) : [];
  buildScan(); resplit(); scanList(); refreshAll();
}
$("maskfile").onchange = async () => {
  const f = $("maskfile").files[0];
  if (!f) return;
  try {
    const m = JSON.parse(await f.text());
    if (m.format !== "ksplanner-territory-mask" || !Array.isArray(m.pieces) || !m.unseen) throw new Error("not a territory_mask.json from the scanner");
    try { localStorage.setItem(MASK_STORE, JSON.stringify(m)); } catch (e) { console.warn("[scan mask] not kept in the browser: " + e.message); }
    setScan(m, false); saveScanChoice();
  } catch (e) { $("maskmsg").innerHTML = '<span class="err">Could not read ' + f.name + ": " + e.message + "</span>"; }
  $("maskfile").value = "";
};
$("unseenMode").addEventListener("change", () => { buildScan(); resplit(); scanList(); refreshAll(); });
$("mall").onclick = () => { if (scan) { pieceOn = scan.pieces.map(() => true); scanChanged(); } };
$("mnone").onclick = () => { if (scan) { pieceOn = scan.pieces.map(() => false); scanChanged(); } };
$("mown").onclick = () => { if (scan) { pieceOn = scan.pieces.map(() => null); scanChanged(); } };
$("mclear").onclick = () => { try { localStorage.removeItem(MASK_STORE); } catch (e) {} pieceOn = []; setScan(null); saveScanChoice(); };
/* Banners of a network outside the scanned region, and unseen tiles inside its squares counted as enemy. */
function scanNotes(banners) {
  if (!scanR || !banners) return [];
  const [x1, y1, x2, y2] = scan.region;
  const out = banners.filter(([x, y]) => x - 3 < x1 || y - 3 < y1 || x + 3 > x2 || y + 3 > y2).length;
  // unseen blocks taken as free (not yours) that this network's squares rely on
  const used = new Map();
  for (const [bx, by] of banners) for (let y = by - 3; y <= by + 3; y++) for (let x = bx - 3; x <= bx + 3; x++) {
    if (x < 0 || y < 0 || x >= M || y >= M) continue;
    const c = y * M + x;
    if (!scanR.unseen[c] || scanR.forbid[c] || scanR.mine[c]) continue;
    const b = scanR.blockId[c];
    const u = used.get(b) || { tiles: new Set(), banners: new Set() };
    u.tiles.add(c); if (x === bx && y === by) u.banners.add(c);
    used.set(b, u);
  }
  const notes = [];
  if (out) notes.push(out + " banner(s) reach outside the scanned region: what stands there is unknown");
  if (used.size) {
    const list = [...used.entries()].sort((a, b) => b[1].tiles.size - a[1].tiles.size);
    const nt = list.reduce((a, [, u]) => a + u.tiles.size, 0), nb = list.reduce((a, [, u]) => a + u.banners.size, 0);
    notes.push("Relies on " + nt + " unseen tile(s) taken as free, in " + list.length + " block(s)" + (nb ? ", " + nb + " banner(s) standing on them" : "") +
      ". Check in the game around: " + list.slice(0, 12).map(([b, u]) => { const k = scanR.blocks[b - 1]; return k.x + "," + k.y + " (" + u.tiles.size + (u.banners.size ? ", " + u.banners.size + " b" : "") + ")"; }).join(", ") + (list.length > 12 ? " …" : ""));
  }
  return notes;
}

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
  // enemy ground: the scan's pieces tile by tile, then marked banners and HQs
  if (scanImg) g.drawImage(scanImg, 0, 0);
  for (const e of enemies) { const [x0, y0, w] = enemySq(e); rect(x0, y0, w, w, "rgba(231,76,60,.28)", null); }
  if (net) {
    if (terrCache.ref !== net.banners || terrCache.n !== net.removed.length) terrCache = { ref: net.banners, n: net.removed.length, set: territories(net) };
    // nodes keep their own colour (captured ones get an outline below)
    const paint = (set, col) => { g.fillStyle = col; for (const c of set) if (!world.terrain[c] && !nodeMask[c]) g.fillRect(c % M, (c / M) | 0, 1, 1); };
    paint(terrCache.set.gone, SHADE.removed);
    paint(terrCache.set.fresh, SHADE.fresh);
    paint(terrCache.set.kept, SHADE.kept);
  }
  // outposts: forced / excluded / reached
  const reached = new Set(net ? net.outposts.map((o) => o.x + "," + o.y) : []);
  const fset = new Set(forced.map(key)), xset = new Set(excluded.map(key));
  for (const o of outposts) {
    const k = o.x + "," + o.y;
    if (reached.has(k)) { const col = structCol(o.name); rect(o.fx, o.fy, o.fz, o.fz, col + "70", strong(col), 2.5); rect(o.x, o.y, o.size, o.size, null, strong(col), 2.5); }
    // forced / excluded: a ring around the building only, so the zone still shows whether it is reached
    if (fset.has(k)) rect(o.x - 1.5, o.y - 1.5, o.size + 3, o.size + 3, null, "#2ecc71", 3.5);
    if (xset.has(k)) {
      rect(o.x - 1.5, o.y - 1.5, o.size + 3, o.size + 3, null, "#ff3b30", 3.5);
      g.strokeStyle = "#ff3b30"; g.lineWidth = 3 / view.s; g.beginPath();
      g.moveTo(o.x - 1.5, o.y - 1.5); g.lineTo(o.x + o.size + 1.5, o.y + o.size + 1.5); g.moveTo(o.x + o.size + 1.5, o.y - 1.5); g.lineTo(o.x - 1.5, o.y + o.size + 1.5); g.stroke();
    }
  }
  const edge = px >= 6 ? "rgba(0,0,0,.5)" : null;
  // captured nodes: outlined in a stronger shade of their own colour
  if (net) for (const [x, y, t] of net.captured) rect(x, y, 2, 2, null, strong(TH().node[Net.TYPES[t]]), 2.5);
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
  // ignored tags: thin outlines (a guide); your Plains network: grey, left as it is
  if (own.guides) for (const [x, y] of own.guides) { g.strokeStyle = "rgba(220,224,230,.85)"; g.lineWidth = 1.2 * dpr() / px; g.strokeRect(x - off, y - off, sz, sz); }
  if ($("badlandOnly").checked && own.plains && own.plains.length) {
    for (const [x, y] of own.plains) sq(x, y, "#9aa3ad", "#4a5260");
    for (const [x, y] of own.plainsHqs) { rect(x - 6, y - 6, 15, 15, null, "rgba(154,163,173,.9)", 2); rect(x, y, 3, 3, "#9aa3ad", "#4a5260"); }
  }
  // step 0 on the current network: where a banner moves (from its old tile) and the new bridges
  if (repair && repair.fixes && net && net.isCurrent) for (const f of repair.fixes) {
    const to = f.type === "move" ? f.to : f.at;
    if (f.type === "move") { g.strokeStyle = "#22d3ee"; g.lineWidth = 2 * dpr() / px; g.beginPath(); g.moveTo(f.from[0] + 0.5, f.from[1] + 0.5); g.lineTo(to[0] + 0.5, to[1] + 0.5); g.stroke(); }
    rect(to[0] - 0.6, to[1] - 0.6, 2.2, 2.2, "rgba(34,211,238,.35)", "#22d3ee", 2.5);
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
  if (scanR && x >= 0 && y >= 0 && x < M && y < M) {
    const c = y * M + x, p = scanR.piece[c];
    if (p) { const q = scan.pieces[p - 1]; out.push(q.name + " territory (scan, " + q.tiles + " tiles" + (pieceEnabled(p - 1) ? ")" : ", switched off)")); }
    else if (scanR.unseen[c]) out.push("unseen in the scan" + (scanR.mine[c] ? " (inside your squares: yours)" : scanR.forbid[c] ? " (counted as enemy)" : ""));
  }
  if (enMask && enMask[y * M + x] && !out.some((t) => t.startsWith("Enemy") || t.includes("(scan") || t.startsWith("unseen"))) out.push("enemy territory");
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
  piece: "Click a piece of the loaded scan to switch it on (enemy ground) or off.",
};
function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll(".modes button")) b.classList.toggle("on", b.dataset.mode === m);
  $("modehelp").textContent = MODE_HELP[m];
  $("modebadge").textContent = "Click: " + { view: "move only", hq: "set HQ", outpost: "outpost state", ebanner: "enemy banner", ehq: "enemy HQ", piece: "scan piece" }[m];
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
  if (mode === "piece") {
    if (!scanR || x < 0 || y < 0 || x >= M || y >= M) return;
    const p = scanR.piece[y * M + x];
    if (!p) return;
    pieceOn[p - 1] = !pieceEnabled(p - 1);
    return scanChanged();
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
  if (scan) { buildScan(); scanList(); }
  changed();
}

// ---------------------------------------------------------------- CSV in
$("loadcsv").onclick = () => {
  const t0 = performance.now();
  const ignore = new Set($("ignoreTags").value.split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean));
  const all = $("csvin").value.split(/\r?\n/).map((l) => l.split(",").map((s) => s.trim())).filter((r) => r.length >= 4 && Number.isFinite(+r[1]) && Number.isFinite(+r[2]) && r[1] !== "");
  const ignored = all.filter((r) => ignore.has(String(r[3]).toLowerCase()));
  const rows = all.filter((r) => !ignore.has(String(r[3]).toLowerCase()));
  const inPlains = (x, y) => x >= 300 && x <= 899 && y >= 300 && y <= 899;
  let tag = $("tag").value.trim();
  if (!tag) { const h = rows.find((r) => r[0] === "hq" && !inPlains(+r[1], +r[2])); if (h) tag = h[3]; }
  if (!tag) { $("csvmsg").innerHTML = '<span class="err">No Badland HQ in the CSV: type the alliance tag.</span>'; return; }
  $("tag").value = tag;
  const h = rows.find((r) => r[0] === "hq" && r[3] === tag && !inPlains(+r[1], +r[2]));
  const mineB = rows.filter((r) => r[0] === "banner" && r[3] === tag).map((r) => [+r[1], +r[2]]);
  own = { tag, banners: mineB.slice(), all: mineB, plains: [],
    plainsHqs: rows.filter((r) => r[0] === "hq" && r[3] === tag && inPlains(+r[1], +r[2])).map((r) => [+r[1], +r[2]]),
    guides: ignored.filter((r) => r[0] === "banner").map((r) => [+r[1], +r[2]]) };
  enemies = enemies.filter((e) => e.src !== "csv");
  let ne = 0;
  if ($("othersEnemy").checked) for (const r of rows) {
    if ((r[0] !== "banner" && r[0] !== "hq") || r[3] === tag) continue;
    enemies.push({ type: r[0], x: +r[1], y: +r[2], src: "csv" }); ne++;
  }
  results = []; sel = -1; $("results").hidden = true; current = null; repair = null;
  console.log("[csv] " + all.length + " rows, " + ignored.length + " ignored (" + [...ignore].join(" ") + "), tag " + tag + ": " + mineB.length + " banners, Badland HQ " + (h ? h[1] + "," + h[2] : "none") + ", " + own.plainsHqs.length + " Plains HQ(s), " + ne + " enemy rows");
  if (h) { hq = [+h[1], +h[2]]; $("hx").value = hq[0]; $("hy").value = hq[1]; view.cu = hq[0] + 1.5; view.cv = hq[1] + 1.5; }
  buildScan();
  splitOwn();
  buildScan(); scanList();
  csvMsg(h, ne, ignored.length);
  changed();
  fit();
  evaluateCurrent();
  console.log("[csv] loaded in " + Math.round(performance.now() - t0) + " ms");
};
function csvMsg(h, ne, ni) {
  const p = own.plains.length;
  $("csvmsg").textContent = own.tag + ": " + own.banners.length + " banners" + (h ? " with the Badland HQ " + h[1] + "," + h[2] : ", no Badland HQ") +
    (own.plainsHqs.length ? (p ? "; " + p + " chained only to the Plains HQ (left out)" : "; Plains HQ " + own.plainsHqs.map(key).join(" ") + " left out") : "") +
    (ne ? "; " + ne + " enemy banners / HQs from other tags" : "") + (ni ? "; " + ni + " rows of ignored tags" : "") + ".";
}
/* With "Connect only to the Badland HQ": the banners chained only to a Plains HQ leave the network
   (same link rules as the solver, with the current enemies and scan). */
function splitOwn() {
  if (!own.all) own.all = own.banners.slice();
  own.banners = own.all.slice(); own.plains = [];
  if (!hq || !world || !own.all.length || !own.plainsHqs || !own.plainsHqs.length || !$("badlandOnly").checked) return;
  const o = options();
  const r = Net.splitNetworks(world, hq[0], hq[1], own.plainsHqs, own.all, { enemies: o.enemies, mask: o.mask, verbose: true });
  own.banners = r.badland; own.plains = r.plains;
}
$("badlandOnly").addEventListener("change", () => {
  if (!own.all || !own.all.length) return;
  results = []; sel = -1; $("results").hidden = true; current = null; repair = null;
  buildScan(); splitOwn(); buildScan(); scanList();
  csvMsg(hq ? ["hq", hq[0], hq[1]] : null, enemies.filter((e) => e.src === "csv").length, 0);
  changed(); evaluateCurrent();
});
/* Score the CSV's network (same targets, enemies and rules as a run) to shade and list it. */
function evaluateCurrent(then) {
  if (!hq || !own.banners.length) return;
  $("current").hidden = false;
  if (!current) { $("curstats").innerHTML = '<div class="msg">Scoring the network from the CSV…</div>'; $("curfix").innerHTML = ""; }
  const ev = new Worker("worker.js");
  ev.onmessage = (e) => { if (e.data.type === "current") { current = e.data.current; repair = e.data.repair || null; showCurrent(); terrCache.ref = null; draw(); if (then) then(); } ev.terminate(); };
  ev.postMessage({ kind: "evaluate", hx: hq[0], hy: hq[1], banners: own.banners, opts: options() });
}
$("clearcsv").onclick = () => {
  $("csvin").value = ""; own = { tag: "", banners: [], all: [], plains: [], plainsHqs: [], guides: [] }; current = null; repair = null;
  enemies = enemies.filter((e) => e.src !== "csv");
  $("csvmsg").textContent = ""; $("current").hidden = true; buildScan(); scanList(); changed();
};
$("tag").addEventListener("change", () => { if (!own.banners.length) own.tag = $("tag").value.trim(); if (scan) { buildScan(); scanList(); refreshAll(); } });
$("clearout").onclick = () => { forced = []; excluded = []; changed(); };
/* Force every outpost the CSV's network reaches (it stays reached in every design). */
$("forcecur").onclick = () => {
  if (!own.banners.length || !hq) { $("outmsg").innerHTML = '<span class="warn">Load a CSV with your network first.</span>'; return; }
  const apply = () => {
    const reached = current.outposts.map((o) => [o.x, o.y]);
    const k = new Set(reached.map(key));
    excluded = excluded.filter((p) => !k.has(key(p)));
    for (const p of reached) if (!forced.some((q) => key(q) === key(p))) forced.push(p);
    $("outmsg").textContent = reached.length + " outpost(s) the current network reaches are forced.";
    changed();
  };
  if (current) return apply();
  $("outmsg").textContent = "Scoring the current network…";
  evaluateCurrent(apply);
};
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
    // your Plains network counts as ground the Badland network keeps off
    enemies: enemies.map((e) => ({ type: e.type, x: e.x, y: e.y })).concat(plainsGround()),
    mask: scanR && scanR.runs.length ? { key: scanR.key, runs: scanR.runs } : null,
    variants: Math.max(1, Math.min(16, Math.round(num("variants", 4)))),
    improveMs: Math.max(0, Math.round(num("secs", 30) * 1000)),
    emptyWeight: Math.max(0, num("ew", 1.5) - 1),
    existing: own.banners.slice(), existingCost: Math.max(0, Math.min(1, num("exc", 0.5))),
    surplusValue: Math.max(0, num("sv", 0.5)), verbose: true,
    maxBanners: Math.max(20, Math.min(285, Math.round(num("cap", 285)))),
  };
}
function plainsGround() {
  if (!$("badlandOnly").checked || !own.plains || !own.plainsHqs || !own.plainsHqs.length) return [];
  return own.plainsHqs.map(([x, y]) => ({ type: "hq", x, y })).concat(own.plains.map(([x, y]) => ({ type: "banner", x, y })));
}
const kph = (n) => Math.round(n * Net.NODE_RATE / 1000) + "k";
function refreshAll() {
  enMask = enemies.length || scanR ? enemyMask() : null;
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
  $("enmsg").textContent = (scanR ? "Scan: " + scanR.tiles + " enemy tiles" + (scanR.unseenCounted ? " + " + scanR.unseenCounted + " unseen" : "") + ". " : "") + (enemies.length ? nb + " enemy banner(s), " + nh + " enemy HQ(s)" + (enemies.some((e) => e.src === "csv") ? " (" + enemies.filter((e) => e.src === "csv").length + " from the CSV)" : "") + "." : (scanR ? "No banners or HQs marked." : "None."));
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
      if (m.repair) repair = m.repair;
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
/* Summary as a table; with the CSV's network scored too, side by side with it and the change. */
function statsHtml(d, cmp) {
  const notes = scanNotes(d.design || (d === current ? own.banners : null));
  const T = {};
  Net.TYPES.forEach((t) => { T[t] = d.targets[t]; });
  const kept = (x) => (x === current ? own.banners.length : x.kept || 0);
  const rows = [
    { l: "Banners", v: (x) => x.banners, better: -1 },
    ...(own.banners.length ? [
      { l: "Already built", v: kept, better: 0 },
      { l: "New to build", v: (x) => x.banners - kept(x), better: -1 },
      { l: "Taken down", v: (x) => (x === current ? 0 : own.banners.length - kept(x)), better: -1 },
    ] : []),
    { l: "Empty", v: (x) => x.empty, better: -1 },
    ...Net.TYPES.map((t) => ({ l: t[0].toUpperCase() + t.slice(1), ls: "min " + T[t], v: (x) => x.nodes[t], sub: (x) => kph(x.nodes[t]) + "/h", min: T[t], better: 1 })),
    { l: "Outposts", v: (x) => x.goals.filter((g) => g.met).length, sub: (x) => "of " + x.goals.length, better: 1 },
    { l: "Cost", v: (x) => Math.round(x.cost * 10) / 10, better: -1, title: "Banners (the ones already built count less), plus the extra for empty banners: what the networks are ranked by" },
  ];
  const cell = (r, x) => {
    const v = r.v(x), short = r.min != null && v < r.min;
    return '<td class="n' + (short ? " bad" : "") + '">' + v + (r.sub ? '<span class="sub">' + r.sub(x) + "</span>" : "") + "</td>";
  };
  const change = (r) => {
    const a = r.v(cmp), b = r.v(d), dv = Math.round((b - a) * 10) / 10;
    if (!dv) return '<td class="n mute">=</td>';
    // above the minimum on both sides, more resources are worth nothing: no colour
    const neutral = !r.better || (r.min != null && a >= r.min && b >= r.min);
    const good = dv * r.better > 0;
    return '<td class="n ' + (neutral ? "mute" : good ? "good" : "bad") + '">' + (dv > 0 ? "+" : "−") + Math.abs(dv) + "</td>";
  };
  const head = cmp ? "<tr><th></th><th>Current</th><th>Proposed</th><th>Change</th></tr>" : "";
  const body = rows.map((r) => "<tr" + (r.title ? ' title="' + r.title + '"' : "") + "><td>" + r.l + (r.ls ? '<span class="sub">' + r.ls + "</span>" : "") + "</td>" + (cmp ? cell(r, cmp) : "") + cell(r, d) + (cmp ? change(r) : "") + "</tr>").join("");
  // cut-off banners and banners on bad ground, named with what stands there
  const errs = d.cutGroups && d.cutGroups.length ? d.errors.filter((w) => !/not chained to the HQ/.test(w)).concat(cutText(d.cutGroups)) : d.errors;
  const warns = (d.warnings || []).filter((w) => !(d.onEnemy && /stand on enemy ground/.test(w)))
    .concat(d.onEnemy && d.onEnemy.length ? [d.onEnemy.slice(0, 6).map(([x, y]) => x + "," + y + " stands on " + groundAt(x, y)).join("; ") + (d.onEnemy.length > 6 ? " … (" + d.onEnemy.length + " in all)" : "") + ": it can't be built there."] : []);
  return '<table class="stat' + (cmp ? " cmp" : "") + '">' + head + body + "</table>" +
    errs.map((w) => '<div class="err">' + w + "</div>").join("") +
    warns.concat(notes).map((w) => '<div class="warn">' + w + "</div>").join("");
}
/* What stands on a tile, in words (for banners the map data says can't stand there). */
function groundAt(x, y) {
  const c = y * M + x;
  if (scanR && scanR.forbid[c] && scanR.piece[c]) return scan.pieces[scanR.piece[c] - 1].name + "'s ground (scan)";
  if (scanR && scanR.forbid[c] && scanR.unseen[c]) return "unseen tiles counted as enemy (scan)";
  const inSq = (e) => { const [x0, y0, w] = enemySq(e); return x >= x0 && x < x0 + w && y >= y0 && y < y0 + w; };
  const e = enemies.find(inSq);
  if (e) return "the square of an enemy " + (e.type === "hq" ? "HQ" : "banner") + " at " + e.x + "," + e.y;
  if (plainsGround().some(inSq)) return "your Plains network's ground";
  return "ground that can't hold a banner";
}
function cutText(groups) {
  return groups.map((g) => {
    const n = g.banners.length;
    if (g.bad.length) {
      const beyond = n - g.bad.length;
      return g.bad.map(([x, y]) => x + "," + y + " stands on " + groundAt(x, y)).join("; ") + ": " + (beyond ? "it and " + beyond + " banner(s) beyond it are" : "it is") + " cut off from the HQ";
    }
    return n + " banner(s) around " + key(g.banners[0]) + " are cut off from the HQ (no owned tiles link them)";
  });
}
/* Step 0 for the CSV's network, in words. */
function repairHtml() {
  if (!repair) return "";
  if (!repair.fixes.length) return repair.after.chained < repair.after.banners ? '<div class="msg">Step 0 found no fix that costs at most one new banner: the cut-off banners are left to the search.</div>' : "";
  const line = (f) => f.type === "move"
    ? "Move " + key(f.from) + " → " + key(f.to) + (f.reconnects ? ": chains " + f.reconnects + " banner(s) back" : "") + (f.offBadGround ? (f.reconnects ? ", " : ": ") + "off ground that can't hold it" : "")
    : "New banner " + key(f.at) + " as a bridge: chains " + f.reconnects + " banner(s) back";
  return '<div class="msg" style="margin-top:8px"><b>Step 0</b> (done first by "Design network"; the moves show on the map in cyan):</div><div class="list">' +
    repair.fixes.map((f) => "<div><span>" + line(f) + "</span></div>").join("") + "</div>" +
    '<div class="msg">After it: ' + repair.after.chained + " of " + repair.after.banners + " banners chained to the HQ" + (repair.after.bad ? ", " + repair.after.bad + " still on ground that can't hold one" : "") + ".</div>";
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
  $("stats").innerHTML = statsHtml(d, current && own.banners.length ? current : null);
  $("goals").innerHTML = "<tr><th>Kind</th><th>Outpost</th></tr>" + d.goals.map((g) => "<tr><td>" + g.kind + (g.forced ? ' <span class="ok">forced</span>' : "") + "</td><td>" + (g.met ? g.at.map(key).join(", ") : '<span class="err">not reached</span>') + "</td></tr>").join("");
  $("csv").value = Net.toCsv(hq, d.design, d.emptyFlags, own.tag || $("tag").value || "NET", own.banners);
  $("showcur").checked = false;
  terrCache.ref = null;
  draw();
}
function showCurrent() {
  if (!current) return;
  $("current").hidden = false;
  $("curstats").innerHTML = statsHtml(current, null);
  $("curfix").innerHTML = repairHtml();
  // the selected network's table gains the comparison column once the current one is scored
  if (results[sel]) $("stats").innerHTML = statsHtml(results[sel], current);
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
const fields = () => [...document.querySelectorAll("#side input[id], #side select[id], #side textarea[id]:not([readonly])")].filter((e) => e.id !== "showcur" && e.type !== "file");
function saveState() {
  try {
    const v = { hq, own, forced, excluded, enemies, mode, pieceOn, view: { cu: view.cu, cv: view.cv, s: view.s } };
    for (const e of fields()) v["f:" + e.id] = e.type === "checkbox" ? e.checked : e.value;
    localStorage.setItem(STATE, JSON.stringify(v));
  } catch (e) {}
}
function loadState() {
  try {
    const v = JSON.parse(localStorage.getItem(STATE) || "null");
    if (!v) { scanList(); setMode("view"); return; }
    for (const e of fields()) if ("f:" + e.id in v) { if (e.type === "checkbox") e.checked = !!v["f:" + e.id]; else e.value = v["f:" + e.id]; }
    hq = v.hq || null; own = v.own || own; forced = v.forced || []; excluded = v.excluded || []; enemies = v.enemies || [];
    if (hq) { $("hx").value = hq[0]; $("hy").value = hq[1]; }
    try {
      const m = JSON.parse(localStorage.getItem(MASK_STORE) || "null");
      if (m && m.format === "ksplanner-territory-mask") {
        scan = m;
        pieceOn = Array.isArray(v.pieceOn) && v.pieceOn.length === m.pieces.length ? v.pieceOn : m.pieces.map(() => null);
        buildScan();
      }
    } catch (e) { console.warn("[scan mask] could not restore: " + e.message); }
    scanList();
    setMode(v.mode || "view");
  } catch (e) { setMode("view"); }
}
document.getElementById("side").addEventListener("input", saveState);
document.getElementById("side").addEventListener("change", saveState);

window.addEventListener("resize", resize);
resize();
init();
