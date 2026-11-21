/* Hive optimiser page: isometric map (game / KSMapper orientation), HQ picking, results. */
"use strict";
const $ = (id) => document.getElementById(id);
const M = 1200;
let world = null, base = null, staticLabels = [], smap = null;
let locked = false;          // clicks on the map leave the central point alone
let hq = null;              // [x, y] anchor (lower-left tile)
let designs = [], sel = -1;
let fplan = null;           // fence plan (step 2), drawn over the hive
const view = { cu: 600, cv: 600, s: 0.6 };   // centre in game coordinates, CSS px per tile
const cv = $("map"), g = cv.getContext("2d");
const C45 = Math.SQRT1_2;

const TERRAIN_COL = { 0: [226, 231, 210], 1: [128, 116, 100], 2: [92, 150, 210], 3: [92, 150, 210], 4: [120, 160, 100], 5: [180, 167, 214], 6: [194, 123, 160], 7: [200, 200, 200], 8: [213, 166, 189], 9: [40, 40, 40] };
// game zones, outermost first (game coordinates, inclusive)
const ZONES = [
  { name: "Plains", r: [300, 300, 899, 899], fill: "rgba(70,150,60,0.16)", line: "rgba(40,110,40,0.7)" },
  { name: "Fertile", r: [450, 450, 749, 749], fill: "rgba(30,120,30,0.20)", line: "rgba(20,90,20,0.8)" },
  { name: "Ruins", r: [552, 552, 647, 647], fill: "rgba(170,110,40,0.30)", line: "rgba(130,80,20,0.8)" },
  { name: "Forbidden", r: [586, 586, 613, 613], fill: "rgba(150,30,40,0.35)", line: "rgba(120,20,30,0.9)" },
];
const zoneAt = (x, y) => { let z = "Badlands"; for (const q of ZONES) if (x >= q.r[0] && x <= q.r[2] && y >= q.r[1] && y <= q.r[3]) z = q.name; return z; };
const NODE_COL = { bread: [214, 180, 60], wood: [70, 130, 60], stone: [150, 150, 150], iron: [150, 80, 50] };

async function init() {
  try {
    let res = await fetch("static_map.json");
    if (!res.ok) res = await fetch("../../data/static_map.json");
    const sm = await res.json();
    smap = sm;
    world = Hive.buildWorld(sm);
    base = document.createElement("canvas");
    base.width = M; base.height = M;
    const bg = base.getContext("2d");
    const img = bg.createImageData(M, M);
    // pixel (x, y) = tile (x, y): the view transform does the rotation. Clear ground is tinted by
    // resource zone (HQ only in Plains / Badlands); lakes and mountains keep their own colour.
    const ZONE_TINT = { Badlands: [230, 233, 216], Plains: [210, 227, 190], Fertile: [186, 214, 166], Ruins: [228, 207, 174], Forbidden: [224, 190, 194] };
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      const t = world.terrain[y * M + x];
      let c = t === 0 ? ZONE_TINT[zoneAt(x, y)] : (TERRAIN_COL[t] || [255, 0, 255]);
      // other ground nothing can be built on: hatched grey, so it never reads as a zone shade
      if (t >= 5) c = (x + y) % 4 === 0 ? [176, 168, 178] : [212, 207, 213];
      const o = (y * M + x) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
    for (const n of sm.nodes) {
      const c = NODE_COL[n.type] || [90, 60, 40];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const o = ((n.y + dy) * M + n.x + dx) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
      }
    }
    bg.putImageData(img, 0, 0);
    for (const z of ZONES) { bg.strokeStyle = z.line; bg.lineWidth = 1; bg.strokeRect(z.r[0] + 0.5, z.r[1] + 0.5, z.r[2] - z.r[0], z.r[3] - z.r[1]); }
    for (const s of sm.structures) {
      bg.fillStyle = "#922b21";
      bg.fillRect(s.x, s.y, s.size, s.size);
      const fx = Math.round(s.x + s.size / 2 - s.forbidden_zone / 2), fy = Math.round(s.y + s.size / 2 - s.forbidden_zone / 2);
      bg.strokeStyle = s.city_exempt ? "rgba(146,43,33,.35)" : "rgba(146,43,33,.8)";
      bg.lineWidth = 1;
      bg.strokeRect(fx + 0.5, fy + 0.5, s.forbidden_zone - 1, s.forbidden_zone - 1);
    }
    // labels: structures, nodes, lakes and mountains (one per connected patch)
    staticLabels = [];
    for (const s of sm.structures) staticLabels.push({ u: s.x + s.size / 2, v: s.y + s.size / 2, text: s.name || s.category, sub: s.x + "," + s.y, w: s.size, min: 1.5, big: true });
    for (const n of sm.nodes) staticLabels.push({ u: n.x + 1, v: n.y + 1, text: n.type[0].toUpperCase() + n.type.slice(1), sub: n.x + "," + n.y, min: 9 });
    const seen = new Uint8Array(M * M);
    for (let i = 0; i < M * M; i++) {
      const t = world.terrain[i];
      if (seen[i] || !(t === 1 || t === 2 || t === 3)) continue;
      const water = t !== 1, stack = [i];
      seen[i] = 1;
      let n = 0, sx = 0, sy = 0;
      while (stack.length) {
        const j = stack.pop(), x = j % M, y = (j / M) | 0;
        n++; sx += x; sy += y;
        for (const k of [j - 1, j + 1, j - M, j + M]) {
          if (k < 0 || k >= M * M || seen[k]) continue;
          if (Math.abs((k % M) - x) > 1) continue;
          const tk = world.terrain[k];
          if (water ? (tk === 2 || tk === 3) : tk === 1) { seen[k] = 1; stack.push(k); }
        }
      }
      if (n >= 6) staticLabels.push({ u: sx / n + 0.5, v: sy / n + 0.5, text: water ? "Lake" : "Mountain", min: 3, terrain: true });
    }
    $("loadmsg").textContent = "";
    fenceReady();
    try {
      const saved = JSON.parse(localStorage.getItem("hive-hq") || "null");
      if (saved) setHQ(saved[0], saved[1], true);
    } catch (e) {}
    draw();
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
function toScreen(u, v) { const m = mat(); return [m.a * u + m.c * v + m.e, m.b * u + m.d * v + m.f]; }   // device px
function toWorld(px, py) {   // CSS px -> game coords
  const m = mat(), X = px * dpr() - m.e, Y = py * dpr() - m.f, det = m.a * m.d - m.b * m.c;
  return [(m.d * X - m.c * Y) / det, (-m.b * X + m.a * Y) / det];
}
function tileAt(px, py) { const [u, v] = toWorld(px, py); return [Math.floor(u), Math.floor(v)]; }
function worldMode() { const m = mat(); g.setTransform(m.a, m.b, m.c, m.d, m.e, m.f); }
function screenMode() { g.setTransform(1, 0, 0, 1, 0, 0); }
function rect(x, y, w, h, fill, stroke) {
  if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, h); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.2 / (view.s * dpr()) * dpr(); g.strokeRect(x, y, w, h); }
}
function resize() {
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr()); cv.height = Math.round(r.height * dpr());
  draw();
}

function draw() {
  if (!cv.width) return;
  screenMode();
  g.fillStyle = "#0b0d10"; g.fillRect(0, 0, cv.width, cv.height);
  if (!base) return;
  worldMode();
  g.imageSmoothingEnabled = false;
  g.drawImage(base, 0, 0);
  const px = view.s * dpr();   // device px per tile
  const d = fplan && fplan.src === "csv" ? null : designs[sel];
  if (fplan) drawFenceBase();
  if (d) {
    g.fillStyle = "rgba(245,197,66,.25)";
    // territory tint on usable ground only, so lakes and blocked ground keep one colour
    if (!fplan) for (const key of territoryOf(d)) if (!world.terrain[key]) g.fillRect(key % M, (key / M) | 0, 1, 1);
    const edge = px >= 6 ? "rgba(0,0,0,.45)" : null;
    for (const c of d.cities) rect(c.x, c.y, 2, 2, c.k === 0 ? (c.extra ? "#85c1e9" : "#3498db") : (c.extra ? "#f5cba7" : "#e67e22"), edge);
    for (const e of d.extras) rect(e.x, e.y, e.w, e.w, "#7f8c8d", "#2c3e50");
    for (const b of d.banners) rect(b[0], b[1], 1, 1, "#2ecc71", edge && "#145a32");
    for (const b of d.fillers) rect(b[0], b[1], 1, 1, "#a8e6b8", edge && "#145a32");
    for (const h of d.holesLeft) rect(h[0], h[1], 2, 2, null, "#ff3b30");
    d.traps.forEach((t) => rect(t[0], t[1], 3, 3, "#c0392b", "#641e16"));
  }
  if (fplan) drawFence(px);
  const H = d ? d.hq : null;
  if (H) { rect(H[0] - 6, H[1] - 6, 15, 15, null, "rgba(142,68,173,.9)"); rect(H[0], H[1], 3, 3, "#8e44ad", "#4a235a"); }
  if (hq) { g.strokeStyle = "#f5c542"; g.lineWidth = 2 / view.s; g.beginPath(); g.moveTo(hq[0] - 1, hq[1] - 1); g.lineTo(hq[0] + 4, hq[1] + 4); g.moveTo(hq[0] + 4, hq[1] - 1); g.lineTo(hq[0] - 1, hq[1] + 4); g.stroke(); }
  if (px >= 10) {
    const corners = [[0, 0], [cv.width / dpr(), 0], [0, cv.height / dpr()], [cv.width / dpr(), cv.height / dpr()]].map(([a, b]) => toWorld(a, b));
    const u0 = Math.floor(Math.min(...corners.map((c) => c[0]))), u1 = Math.ceil(Math.max(...corners.map((c) => c[0])));
    const v0 = Math.floor(Math.min(...corners.map((c) => c[1]))), v1 = Math.ceil(Math.max(...corners.map((c) => c[1])));
    g.strokeStyle = "rgba(0,0,0,.12)"; g.lineWidth = 1 / px;
    g.beginPath();
    for (let u = u0; u <= u1; u++) { g.moveTo(u, v0); g.lineTo(u, v1); }
    for (let v = v0; v <= v1; v++) { g.moveTo(u0, v); g.lineTo(u1, v); }
    g.stroke();
  }
  // labels in screen space
  screenMode();
  if (d) {
    d.traps.forEach((t, i) => label(t[0] + 1.5, t[1] + 1.5, "BT" + (i + 1), px));
    if (px >= 14) {
      const lab = Hive.labelCities(d);
      g.fillStyle = "#fff"; g.font = "600 " + Math.round(Math.min(px * 0.45, 14 * dpr())) + "px system-ui"; g.textAlign = "center"; g.textBaseline = "middle";
      g.shadowColor = "rgba(0,0,0,.55)"; g.shadowBlur = 2 * dpr();
      for (const c of d.cities) {
        const [a, b] = toScreen(c.x + 1, c.y + 1);
        const n = String(+lab.get(c).slice(4));
        if (px >= 22 * dpr()) { g.fillText(n, a, b - px * 0.25); g.fillText(Hive.marchSecs(c.d[c.k]) + "s", a, b + px * 0.3); }
        else g.fillText(n, a, b);
      }
      g.shadowBlur = 0; g.shadowColor = "transparent";
    }
  }
  if (d) label(d.hq[0] + 1.5, d.hq[1] + 1.5, "HQ", px);
  if (fplan) drawFenceLabels(px);
  drawLabels(d, px);
}
/* KSMapper style: names centred (white with a soft shadow on coloured objects), coordinates in
   small grey text just under each object's bottom corner, which is its lower-left tile. */
function coordAt(x, y, px) {
  if (px < 8 * dpr()) return;
  const [a, b] = toScreen(x, y);
  g.font = Math.round(Math.min(11 * dpr(), Math.max(8 * dpr(), px * 0.32))) + "px system-ui";
  g.textAlign = "center"; g.textBaseline = "top";
  g.fillStyle = "rgba(55,60,70,.9)";
  g.fillText(x + "," + y, a, b + 1 * dpr());
}
function nameAt(u, v, t, size, onColour) {
  const [a, b] = toScreen(u, v);
  g.font = "600 " + Math.round(size) + "px system-ui";
  g.textAlign = "center"; g.textBaseline = "middle";
  if (onColour) { g.shadowColor = "rgba(0,0,0,.6)"; g.shadowBlur = 3 * dpr(); g.fillStyle = "#fff"; }
  else g.fillStyle = "rgba(40,50,65,.8)";
  g.fillText(t, a, b);
  g.shadowBlur = 0; g.shadowColor = "transparent";
}
function drawLabels(d, px) {
  const corners = [[0, 0], [cv.width / dpr(), 0], [0, cv.height / dpr()], [cv.width / dpr(), cv.height / dpr()]].map(([a, b]) => toWorld(a, b));
  const u0 = Math.min(...corners.map((c) => c[0])) - 4, u1 = Math.max(...corners.map((c) => c[0])) + 4;
  const v0 = Math.min(...corners.map((c) => c[1])) - 4, v1 = Math.max(...corners.map((c) => c[1])) + 4;
  const D = dpr();
  for (const L of staticLabels) {
    if (px < L.min * D || L.u < u0 || L.u > u1 || L.v < v0 || L.v > v1) continue;
    if (L.terrain) { nameAt(L.u, L.v, L.text, 10 * D, false); continue; }
    nameAt(L.u, L.v, L.text, Math.min(12 * D, Math.max(9 * D, px * 0.45)), true);
    if (L.sub) { const [x, y] = L.sub.split(",").map(Number); coordAt(x, y, L.big ? Math.max(px, 8 * D) : px); }
  }
  if (!d) return;
  coordAt(d.hq[0], d.hq[1], Math.max(px, 8 * D));
  d.traps.forEach((t) => coordAt(t[0], t[1], Math.max(px, 8 * D)));
  if (px >= 26 * D) for (const bn of d.banners) coordAt(bn[0], bn[1], px);
  if (px >= 26 * D) for (const c of d.cities) coordAt(c.x, c.y, px);
}
function label(u, v, text, px) {
  if (px < 4) return;
  const [a, b] = toScreen(u, v);
  g.fillStyle = "#fff"; g.font = "600 " + Math.round(Math.max(10, px * 0.9)) + "px system-ui"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, a, b);
}
function territoryOf(d) {
  if (d._terr) return d._terr;
  const s = new Set();
  const sq = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) s.add(y * M + x); };
  sq(d.hq[0] - 6, d.hq[1] - 6, d.hq[0] + 8, d.hq[1] + 8);
  for (const [x, y] of d.banners) sq(x - 3, y - 3, x + 3, y + 3);
  d._terr = s;
  return s;
}

// ---------------------------------------------------------------- fences (step 2)
const FENCE_TINT = ["rgba(255,0,128,.22)", "rgba(140,60,255,.22)", "rgba(0,170,170,.24)", "rgba(150,90,30,.26)"];
/* Territory as planned (hive after fence 1 took its free edge, then each fence), plus, for a CSV
   hive, the hive's own buildings and foreign ones. World mode. */
function drawFenceBase() {
  const p = fplan;
  for (let y = 0; y < p.H; y++) for (let x = 0; x < p.W; x++) {
    const o = p.own[y * p.W + x], gx = x + p.ox, gy = y + p.oy;
    if (!o || o === 3 || world.terrain[gy * M + gx]) continue;
    g.fillStyle = o < 10 ? "rgba(245,197,66,.25)" : FENCE_TINT[(o - 11) % 4];
    g.fillRect(gx, gy, 1, 1);
  }
  if (p.src !== "csv") return;
  const m = p.input.mother, o = p.input.others, px = view.s * dpr(), edge = px >= 6 ? "rgba(0,0,0,.45)" : null;
  for (const b of o.buildings) rect(b.x, b.y, b.w, b.w, "rgba(90,90,90,.75)", edge);
  for (const b of o.banners) rect(b[0], b[1], 1, 1, "rgba(60,60,60,.8)", null);
  for (const h of o.hqs) rect(h[0], h[1], 3, 3, "rgba(60,60,60,.85)", null);
  for (const c of m.cities) rect(c[0], c[1], 2, 2, "#3498db", edge);
  for (const b of m.buildings || []) rect(b.x, b.y, b.w, b.w, "#7f8c8d", "#2c3e50");
  for (const b of m.banners) rect(b[0], b[1], 1, 1, "#2ecc71", edge && "#145a32");
  for (const t of m.traps) rect(t[0], t[1], 3, 3, "#c0392b", "#641e16");
  rect(m.hq[0], m.hq[1], 3, 3, "#8e44ad", "#4a235a");
}
function drawFence(px) {
  const p = fplan, edge = px >= 6 ? "rgba(0,0,0,.5)" : null;
  const C = Fence.COLOUR;
  for (const b of p.hive.buildings) rect(b.x, b.y, b.w, b.w, "#34495e", "#1b2631");
  for (const b of p.hive.banners) rect(b.x, b.y, 1, 1, b.orange ? C.orange : C.yellow, "#145a32");
  for (const c of p.hive.cities || []) rect(c.x, c.y, 2, 2, c.k === 0 ? "#85c1e9" : "#f5cba7", "#1b4f72");
  for (const f of p.fences) {
    rect(f.hq[0], f.hq[1], 3, 3, C.hq, "#4a235a");
    for (const b of f.buildings) rect(b.x, b.y, b.w, b.w, b.type === "trap" ? C.trap : "#34495e", "#1b2631");
    for (const b of f.fillers) rect(b.x, b.y, 1, 1, b.orange ? C.orange : b.grey ? C.grey : C.yellow, edge);
    for (const a of f.anchors) rect(a[0], a[1], 1, 1, C.anchor, edge);
  }
  g.lineWidth = 2.5 / (view.s * dpr()) * dpr();
  // the hive's new banners (built after fence 1's anchors) and the ones it destroys (crossed out)
  for (const b of p.rebuild) { rect(b[0], b[1], 1, 1, "#2ecc71", "#145a32"); g.strokeStyle = "#00e5ff"; g.strokeRect(b[0] - 0.15, b[1] - 0.15, 1.3, 1.3); }
  for (const b of p.destroy || []) { g.strokeStyle = "#ff3b30"; g.beginPath(); g.moveTo(b[0] - 0.1, b[1] - 0.1); g.lineTo(b[0] + 1.1, b[1] + 1.1); g.moveTo(b[0] + 1.1, b[1] - 0.1); g.lineTo(b[0] - 0.1, b[1] + 1.1); g.stroke(); }
  for (const h of p.holes) rect(h[0], h[1], 2, 2, null, "#ff3b30");
  for (const c of p.dropped || []) { rect(c[0], c[1], 2, 2, "rgba(255,59,48,.35)", "#ff3b30"); g.strokeStyle = "#ff3b30"; g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(c[0] + 2, c[1] + 2); g.moveTo(c[0] + 2, c[1]); g.lineTo(c[0], c[1] + 2); g.stroke(); }
  for (const f of p.fences) for (const u of f.uncovered) rect(u[0] + 0.3, u[1] + 0.3, 0.4, 0.4, "#ff3b30", null);
  // where each hive city's banner goes if it is empty: a dark triangle in that corner
  for (const c of p.cityBanners || []) for (const [bx, by] of c.banners) {
    if (bx < c.x || by < c.y || bx > c.x + 1 || by > c.y + 1) {   // on the free tile beside the city
      rect(bx + 0.25, by + 0.25, 0.5, 0.5, c.banners.length > 1 ? "#ff3b30" : "#111", "#fff");
      continue;
    }
    const sx = bx > c.x ? 1 : 0, sy = by > c.y ? 1 : 0, dx = sx ? -0.6 : 0.6, dy = sy ? -0.6 : 0.6;
    const X = bx + sx, Y = by + sy;
    g.fillStyle = c.banners.length > 1 ? "#ff3b30" : "#111";
    g.beginPath(); g.moveTo(X, Y); g.lineTo(X + dx, Y); g.lineTo(X, Y + dy); g.closePath(); g.fill();
  }
}
/* Alliance tag written inside a 1-tile banner, once the tile is big enough to hold it. */
function tagIn(x, y, text, px, colour) {
  const D = dpr();
  if (px < 18 * D) return;
  const [u, v] = toScreen(x + 0.5, y + 0.5);
  g.fillStyle = colour; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = "700 " + Math.round(Math.min(px * 0.36, 14 * D)) + "px system-ui";
  g.fillText(text, u, v);
}
function drawFenceLabels(px) {
  const p = fplan, D = dpr();
  for (const f of p.fences) {
    label(f.hq[0] + 1.5, f.hq[1] + 1.5, f.tag, px);
    coordAt(f.hq[0], f.hq[1], Math.max(px, 8 * D));
    for (const b of f.buildings) if (b.type === "trap") label(b.x + 1.5, b.y + 1.5, f.tag, px);
    for (const a of f.anchors) tagIn(a[0], a[1], f.tag, px, "#fff");
    for (const b of f.fillers) tagIn(b.x, b.y, f.tag, px, "#222");
    if (px >= 26 * D) for (const a of f.anchors) coordAt(a[0], a[1], px);
  }
  for (const b of p.hive.banners) tagIn(b.x, b.y, p.hiveTag, px, "#222");
  if (px >= 14 * D) for (const c of p.hive.cities || []) nameAt(c.x + 1, c.y + 1, c.secs + "s", Math.min(12 * D, px * 0.45), true);
  for (const b of p.input.mother.banners) tagIn(b[0], b[1], p.hiveTag, px, "#fff");
  if (p.src === "csv") { label(p.input.mother.hq[0] + 1.5, p.input.mother.hq[1] + 1.5, p.input.mother.tag, px); coordAt(p.input.mother.hq[0], p.input.mother.hq[1], Math.max(px, 8 * D)); }
}

function fenceReady() { $("frun").disabled = !world || ($("fsrc").value === "design" ? !designs[sel] : !$("fcsv").value.trim()); }
$("fsrc").onchange = () => { $("fcsvbox").hidden = $("fsrc").value !== "csv"; fenceReady(); };
$("fcsv").oninput = fenceReady;
let fworker = null;
$("frun").onclick = () => {
  let input;
  const tags = $("ftags").value.split(",").map((t) => t.trim()).filter(Boolean);
  try {
    if ($("fsrc").value === "design") input = Fence.fromDesign(designs[sel], $("tag").value || "HIVE");
    else if (!$("fhive").value.trim()) throw new Error("Enter the hive alliance tag.");
    else input = Fence.fromCsv($("fcsv").value, $("fhive").value.trim(), $("fignore").value.split(",").map((t) => t.trim()).filter(Boolean));
  } catch (e) { $("frunmsg").innerHTML = '<span class="err">' + e.message + "</span>"; return; }
  if (fworker) fworker.terminate();
  fworker = new Worker("worker.js");
  const src = $("fsrc").value;
  // the hive as it stood, for the complete CSV (old fences left out by tag)
  const base = src === "design" ? { csv: designs[sel].csv, ignore: [] } : { csv: $("fcsv").value, ignore: $("fignore").value.split(",") };
  const opts = { layers: Math.max(1, Math.min(4, +$("flayers").value || 1)), tags, cap: +$("fcap").value || 180, timeLimit: 40, fillTimeLimit: 120 };
  $("frun").disabled = true; $("frunmsg").textContent = "Starting…"; $("fprog").style.width = "0";
  const t0 = Date.now();
  fworker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") {
      const st = m.p.stage;
      $("frunmsg").textContent = st.startsWith("anchors") ? "Placing the HQ and anchors of fence " + st.split(" ")[1] + "…" : st === "fillers" ? "Plugging every free 2x2 space…" : st === "prune" ? "Trying anchor removals end to end (this takes minutes)…" : st === "layouts" ? "Designing 16 anchor layouts end to end…" : "Finishing…";
      $("fprog").style.width = Math.round((m.p.frac || 0) * 100) + "%";
    } else if (m.type === "fence-done") {
      fenceReady(); $("fprog").style.width = "100%";
      fplan = m.plan; fplan.src = src;
      fplan.full = Fence.toFullCsv(fplan, base.csv, base.ignore);
      $("frunmsg").textContent = "Done in " + Math.round((Date.now() - t0) / 1000) + " s.";
      showFence();
    } else if (m.type === "error") {
      fenceReady();
      $("frunmsg").innerHTML = '<span class="err">' + m.message + "</span>";
    }
  };
  fworker.postMessage({ kind: "fence", input, opts });
};
function showFence() {
  const p = fplan;
  $("fresults").hidden = false;
  const rows = [];
  for (const f of p.fences) {
    const orange = f.fillers.filter((b) => b.orange).length, grey = f.fillers.filter((b) => b.grey).length;
    rows.push([f.tag + " banners (guideline " + (+$("fcap").value || 180) + ")", f.banners]);
    rows.push(["  anchors / fillers", f.anchors.length + " / " + f.fillers.length]);
    rows.push(["  fillers yellow / grey / orange", (f.fillers.length - orange - grey) + " / " + grey + " / " + orange]);
    rows.push(["  HQ", f.hq.join(",")]);
    rows.push(["  traps, statues, node", f.buildings.map((b) => b.type).join(", ") || "none"]);
  }
  rows.push([p.hiveTag + " fillers (its own free spaces)", p.hive.banners.length]);
  if ((p.hive.cities || []).length) rows.push([p.hiveTag + " extra cities instead of fillers (up to 31 s)", p.hive.cities.length]);
  if (p.hive.buildings.length) rows.push([p.hiveTag + " statues / node placed", p.hive.buildings.map((b) => b.type).join(", ")]);
  rows.push([p.hiveTag + " banners destroyed / new", (p.destroy || []).length + " / " + p.rebuild.length]);
  if (p.dropped && p.dropped.length) rows.push(["Extra cities dropped", p.dropped.map((c) => c.join(",")).join("; ")]);
  rows.push(["Total banners (fences + hive fillers + hive new − destroyed)", p.fences.reduce((a, f) => a + f.banners, 0) + p.hive.banners.length + p.rebuild.length - (p.destroy || []).length]);
  rows.push(["2x2 spaces plugged", p.windows]);
  $("fstats").innerHTML = rows.map(([a, b]) => "<div><span>" + a + "</span><span>" + b + "</span></div>").join("") +
    (p.errors || []).map((w) => '<div class="err">' + w + "</div>").join("") +
    p.notes.map((w) => '<div class="warn">' + w + "</div>").join("") +
    (p.fillOptimal ? "" : '<div class="warn">Filler count not proven minimal (solver time limit)</div>');
  let n = 0;
  $("fsteps").innerHTML = p.steps.map((s) => {
    const list = s.items.map((it) => {
      const what = it.type === "hq" ? "HQ" : it.type === "banner" ? "" : it.type;
      return (what ? what + " " : "") + it.x + "," + it.y;
    }).join("; ");
    n++;
    return "<details" + (n <= 2 ? " open" : "") + "><summary>" + n + ". " + s.title + " (" + s.items.length + ")</summary><div class=\"co\">" + list + "</div></details>";
  }).join("");
  $("fcsvout").value = p.csv;
  $("ffullout").value = p.full || "";
  const c = p.input.mother.hq;
  view.cu = c[0] + 1.5; view.cv = c[1] + 1.5; if (view.s < 6) view.s = 7;
  draw();
}
$("ffullcopy").onclick = async () => {
  try { await navigator.clipboard.writeText($("ffullout").value); $("ffullcopymsg").textContent = "Copied."; }
  catch (e) { $("ffullout").select(); $("ffullcopymsg").textContent = "Selected: press Ctrl+C."; }
};
$("fcopy").onclick = async () => {
  try { await navigator.clipboard.writeText($("fcsvout").value); $("fcopymsg").textContent = "Copied."; }
  catch (e) { $("fcsvout").select(); $("fcopymsg").textContent = "Selected: press Ctrl+C."; }
};
$("fclear").onclick = () => { fplan = null; $("fresults").hidden = true; draw(); };

/* Description of whatever stands on a tile, for the status line under the map. */
function describeAt(x, y) {
  const inBox = (bx, by, w) => x >= bx && x < bx + w && y >= by && y < by + w;
  const out = [];
  const stepOf = (type, bx, by, tag) => {
    if (!fplan || !fplan.steps) return "";
    for (let i = 0; i < fplan.steps.length; i++) for (const it of fplan.steps[i].items) if (it.x === bx && it.y === by && (!tag || it.tag === tag) && (it.type === type || (type === "statue" && it.type === "statue"))) return " (build step " + (i + 1) + ")";
    return "";
  };
  const corner = (cx, cy) => {
    if (!fplan || !fplan.cityBanners) return "";
    const c = fplan.cityBanners.find((q) => q.x === cx && q.y === cy);
    const who = (o) => (o > 0 ? " (" + fplan.fences[o - 1].tag + " banner)" : "");
    return c ? ", banner if empty at " + c.banners.map((b) => b[0] + "," + b[1] + who(b[2])).join(" and ") : "";
  };
  const d = fplan && fplan.src === "csv" ? null : designs[sel];
  if (fplan) {
    const p = fplan;
    for (const f of p.fences) {
      if (inBox(f.hq[0], f.hq[1], 3)) out.push(f.tag + " HQ " + f.hq.join(",") + stepOf("hq", f.hq[0], f.hq[1], f.tag));
      for (const a of f.anchors) if (a[0] === x && a[1] === y) out.push(f.tag + " anchor" + stepOf("banner", x, y, f.tag));
      for (const b of f.fillers) if (b.x === x && b.y === y) out.push(f.tag + " filler, " + (b.orange ? "orange (expands its territory)" : b.grey ? "grey (inside its HQ's territory)" : "yellow (no new territory)") + stepOf("banner", x, y, f.tag));
      for (const b of f.buildings) if (inBox(b.x, b.y, b.w)) out.push(f.tag + " " + b.type + " " + b.x + "," + b.y + stepOf(b.type, b.x, b.y, f.tag));
    }
    for (const b of p.hive.banners) if (b.x === x && b.y === y) out.push(p.hiveTag + " filler (its own free space)" + stepOf("banner", x, y, p.hiveTag));
    for (const c of p.hive.cities || []) if (inBox(c.x, c.y, 2)) out.push(p.hiveTag + " extra city BT" + (c.k + 1) + ", " + c.secs + " s" + corner(c.x, c.y) + stepOf("city", c.x, c.y, p.hiveTag));
    for (const b of p.destroy || []) if (b[0] === x && b[1] === y) out.push(p.hiveTag + " banner to destroy after " + p.fences[0].tag + "'s anchors");
    for (const b of p.rebuild) if (b[0] === x && b[1] === y) out.push(p.hiveTag + " new banner" + stepOf("banner", x, y, p.hiveTag));
    for (const c of p.dropped || []) if (inBox(c[0], c[1], 2)) out.push("extra city dropped for the fence");
    if (p.src === "csv") {
      const m = p.input.mother;
      if (inBox(m.hq[0], m.hq[1], 3)) out.push(m.tag + " HQ " + m.hq.join(","));
      for (const t of m.traps) if (inBox(t[0], t[1], 3)) out.push(m.tag + " bear trap " + t.join(","));
      for (const c of m.cities) if (inBox(c[0], c[1], 2)) out.push(m.tag + " city " + c[0] + "," + c[1] + corner(c[0], c[1]));
      for (const b of m.banners) if (b[0] === x && b[1] === y) out.push(m.tag + " banner");
      for (const b of m.buildings || []) if (inBox(b.x, b.y, b.w)) out.push(m.tag + " " + (b.type || "building"));
      for (const b of p.input.others.buildings) if (inBox(b.x, b.y, b.w)) out.push("other alliance's building or city");
      for (const b of p.input.others.banners) if (b[0] === x && b[1] === y) out.push("other alliance's banner");
    }
  }
  if (d) {
    if (inBox(d.hq[0], d.hq[1], 3)) out.push("Hive HQ " + d.hq.join(","));
    d.traps.forEach((t, i) => { if (inBox(t[0], t[1], 3)) out.push("BT" + (i + 1) + " " + t.join(",")); });
    const lab = Hive.labelCities(d);
    for (const c of d.cities) if (inBox(c.x, c.y, 2)) out.push(lab.get(c) + (c.extra ? " (extra)" : "") + " " + c.x + "," + c.y + ", " + Hive.marchSecs(c.d[0]) + " s to BT1, " + Hive.marchSecs(c.d[1]) + " s to BT2" + corner(c.x, c.y));
    for (const e of d.extras) if (inBox(e.x, e.y, e.w)) out.push((e.type === "node" ? "Gathering node " : "Statue ") + e.x + "," + e.y);
    for (const b of d.banners) if (b[0] === x && b[1] === y) out.push("Hive banner" + (fplan ? stepOf("banner", x, y) : ""));
  }
  if (smap) {
    for (const n of smap.nodes) if (inBox(n.x, n.y, 2)) out.push(n.type[0].toUpperCase() + n.type.slice(1) + " node " + n.x + "," + n.y);
    for (const st of smap.structures) if (inBox(st.x, st.y, st.size)) out.push((st.name || st.category) + " " + st.x + "," + st.y);
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
    // screen delta -> world delta (inverse of the linear part, CSS px)
    const k = view.s;
    view.cu = drag.cu - (dx - dy) / (2 * k * C45);
    view.cv = drag.cv - (-dx - dy) / (2 * k * C45);
    draw();
  }
});
cv.addEventListener("pointerup", (e) => {
  if (drag && !drag.moved && world && !locked) {
    const r = cv.getBoundingClientRect();
    const [tx, ty] = tileAt(e.clientX - r.left, e.clientY - r.top);
    setHQ(tx - 1, ty - 1);
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
function setLock(on) { locked = on; $("lock").classList.toggle("on", locked); $("lock").textContent = locked ? "Locked" : "Lock"; }
$("lock").onclick = () => { setLock(!locked); saveSettings(); };
$("zin").onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.5); };
$("zout").onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.5); };
$("fixhq").onchange = () => { $("radius").disabled = $("fixhq").checked; };
$("radius").disabled = $("fixhq").checked;
$("go").onclick = () => { const x = parseInt($("hx").value, 10), y = parseInt($("hy").value, 10); if (Number.isFinite(x) && Number.isFinite(y)) setHQ(x, y, true); };

function setHQ(x, y, centre) {
  $("hx").value = x; $("hy").value = y;
  if (x < 0 || y < 0 || x >= M || y >= M) return;
  hq = [x, y];
  try { localStorage.setItem("hive-hq", JSON.stringify(hq)); } catch (e) {}
  saveSettings();
  const why = Hive.hqBlockReason(world, x, y);
  $("hqmsg").innerHTML = "Central point " + x + "," + y + "." + (why ? ' <span class="warn">An HQ could not stand exactly here (' + why + '); use a search radius above 0.</span>' : "");
  $("run").disabled = false;
  if (centre) { view.cu = x + 1.5; view.cv = y + 1.5; if (view.s < 6) view.s = 9; }
  draw();
}

// ---------------------------------------------------------------- solve
let worker = null;
$("run").onclick = () => {
  if (!hq) return;
  if (worker) worker.terminate();
  worker = new Worker("worker.js");
  designs = []; sel = -1; $("results").hidden = true;
  $("run").disabled = true; $("runmsg").textContent = "Starting…"; $("prog").style.width = "0";
  const opts = {
    minCities: +$("minCities").value || 120, radius: Math.max(0, +$("radius").value || 0), bannerCost: Math.max(0, +$("bannerCost").value || 0), symCost: Math.max(0, +($("symCost").value || 0)), extraSecs: Math.max(1, +$("extraSecs").value || 31), centreTie: Math.max(0, +$("centreTie").value || 0),
    designs: +$("ndesigns").value || 4, tag: $("tag").value || "HIVE",
  };
  if ($("fixhq").checked) opts.radius = 0;
  opts.refitMax = $("refit").checked ? 30 : 0;
  const trap = (a, b) => { const x = parseInt($(a).value, 10), y = parseInt($(b).value, 10); return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null; };
  opts.traps = [trap("t1x", "t1y"), trap("t2x", "t2y")];
  const t0 = Date.now();
  const log = [];
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") {
      const p = m.p;
      const txt = { modules: "Solving the ideal trap cluster…", screen: "Checked trap positions (" + (p.found || 0) + " candidates)…", refine: "Fitting banners and re-fitting clusters around obstacles…", repair: "Fitting clusters around obstacles…", hq: "Trying HQ positions…" }[p.stage] || p.stage;
      $("runmsg").innerHTML = log.join("<br>") + (log.length ? "<br>" : "") + txt;
      $("prog").style.width = Math.round((p.frac || 0) * 100) + "%";
    } else if (m.type === "warn") {
      log.push('<span class="warn">' + m.message + "</span>");
    } else if (m.type === "done") {
      $("run").disabled = false; $("prog").style.width = "100%";
      designs = m.designs;
      $("runmsg").textContent = designs.length ? "Done in " + Math.round((Date.now() - t0) / 1000) + " s." : "No design found.";
      if (designs.length) { $("results").hidden = false; listDesigns(); pick(0); }
    } else {
      $("run").disabled = false;
      $("runmsg").innerHTML = '<span class="err">' + m.message + "</span>";
    }
  };
  worker.postMessage({ hx: hq[0], hy: hq[1], opts });
};

const pct = (d) => (d.ideal ? " (+" + ((d.stats.coreAvg / d.ideal - 1) * 100).toFixed(1) + "%)" : "");
function listDesigns() {
  const box = $("designs"); box.innerHTML = "";
  designs.forEach((d, i) => {
    const b = document.createElement("button");
    b.className = "design";
    const s = d.stats;
    b.textContent = s.secs.map((t) => t.avg.toFixed(1) + "s / max " + t.max + "s").join(" | ") + " · " + s.perTrap.join("+") + (s.extra ? " +" + s.extra + " extra" : "") + " cities · " + d.k + " banners · " + Math.round(s.sym * 100) + "% sym" + (s.looseFar ? " · " + s.looseFar + " loose" : "") + " · HQ " + d.hq.join(",");
    b.onclick = () => pick(i);
    box.appendChild(b);
  });
}
function pick(i) {
  sel = i;
  [...$("designs").children].forEach((b, j) => b.classList.toggle("sel", j === i));
  const d = designs[i], s = d.stats;
  const warn = [];
  if (d.missing.length) warn.push("No room left for: " + d.missing.join(", "));
  if (d.holesLeft.length) warn.push(d.holesLeft.length + " empty 2x2 spaces left (outlined red)");
  if (s.connectors) warn.push(s.connectors + " banner(s) added only to connect to the HQ");
  if (s.coverOptimal === false) warn.push("Banner count not proven minimal (solver time limit)");
  const fmtRows = (r) => r.map((v) => v.toFixed(2)).join(" / ");
  $("stats").innerHTML = [
    ["Core slots BT1 / BT2", s.perTrap.join(" / ")],
    ["Extra slots (free territory) BT1 / BT2", s.extraPerTrap.join(" / ")],
    ["Loose cities (can stand 1 tile off with the rest in place)", (s.loose || 0) + (s.loose ? " (" + (s.looseFar || 0) + " away from the HQ / node)" : "")],
    ["Total cities", s.total + (s.short ? " (" + s.short + " short of the cities wanted)" : "")],
    ["Symmetry", Math.round(s.sym * 100) + "%" + (s.symAxis ? " (mirror in the HQ's middle " + (s.symAxis === "x" ? "column" : "row") + ")" : "") + (s.symPair ? ", mirrored clusters" : "")],
    ["Core march time BT1 avg / max", s.secs[0].avg.toFixed(1) + " s / " + s.secs[0].max + " s"],
    ["Core march time BT2 avg / max", s.secs[1].avg.toFixed(1) + " s / " + s.secs[1].max + " s"],
    ["All slots BT1 / BT2 avg", s.secsAll.map((t) => t.avg.toFixed(1) + " s").join(" / ")],
    ["BT1 rows 1 / 2 / 3 / 4", fmtRows(s.rows[0])],
    ["BT2 rows 1 / 2 / 3 / 4", fmtRows(s.rows[1])],
    ["Ideal rows (no banners)", "2.73 / 4.82 / 6.74 / 8.39"],
    ["Banners (territory only)", s.banners],
    ["HQ", d.hq.join(",") + (s.hqShift && (s.hqShift[0] || s.hqShift[1]) ? " (moved " + s.hqShift.join(",") + ")" : "")],
    ["BT1", d.traps[0].join(",")], ["BT2", d.traps[1].join(",")],
    ["Farthest slot", s.coreMax.toFixed(2)],
    ["Cities from Fertile Land (mean, tiles)", s.centre != null ? s.centre.toFixed(1) : "–"],
    ["Slot tiles under HQ territory", s.underHq + " of " + s.coreTiles],
    ["Territory tiles", d.territory],
  ].map(([a, b]) => "<div><span>" + a + "</span><span>" + b + "</span></div>").join("") +
    warn.map((w) => '<div class="warn">' + w + "</div>").join("");
  $("csv").value = d.csv;
  if (fplan && fplan.src === "design") { fplan = null; $("fresults").hidden = true; }
  fenceReady();
  const lab = Hive.labelCities(d);
  const rows = d.cities.slice().sort((a, b) => lab.get(a).localeCompare(lab.get(b)));
  $("slots").innerHTML = "<tr><th>Slot</th><th>X,Y</th><th>Distance</th><th>BT1</th><th>BT2</th></tr>" +
    rows.map((c) => "<tr><td>" + lab.get(c) + "</td><td>" + c.x + "," + c.y + "</td><td>" + c.d[c.k].toFixed(2) + "</td><td>" + Hive.marchSecs(c.d[0]) + "s</td><td>" + Hive.marchSecs(c.d[1]) + "s</td></tr>").join("");
  view.cu = d.hq[0] + 1.5; view.cv = d.hq[1] + 1.5; if (view.s < 6) view.s = 9;
  draw();
}
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("csv").value); $("copymsg").textContent = "Copied."; }
  catch (e) { $("csv").select(); $("copymsg").textContent = "Selected: press Ctrl+C."; }
};

// ---------------------------------------------------------------- settings kept between visits
// every input of the side panel (pasted CSV included) and the lock, in this browser only
const SETTINGS = "ksplanner-hive-settings";
const settingFields = () => [...document.querySelectorAll("#side input[id], #side select[id], #side textarea[id]:not([readonly])")];
function saveSettings() {
  try {
    const v = { _locked: locked };
    for (const e of settingFields()) v[e.id] = e.type === "checkbox" ? e.checked : e.value;
    localStorage.setItem(SETTINGS, JSON.stringify(v));
  } catch (e) {}
}
function loadSettings() {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS) || "null");
    if (!v) return;
    for (const e of settingFields()) if (e.id in v) { if (e.type === "checkbox") e.checked = !!v[e.id]; else e.value = v[e.id]; }
    setLock(!!v._locked);
  } catch (e) {}
  $("radius").disabled = $("fixhq").checked;
  $("fcsvbox").hidden = $("fsrc").value !== "csv";
}
document.getElementById("side").addEventListener("input", saveSettings);
document.getElementById("side").addEventListener("change", saveSettings);
loadSettings();

window.addEventListener("resize", resize);
resize();
init();
