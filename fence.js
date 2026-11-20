/* KSPlanner fence designer (step 2 of the hive design).
 *
 * A fence is a second alliance that surrounds the hive with rows of banners so that no free 2x2
 * space is left near it (in KvK any city may teleport anywhere free). Each fence is one alliance.
 * Its anchors define its territory: fence 1's stand 4 tiles from the hive's cities (their squares
 * end against them: 3 rows of 2x2), later fences' right against the fence before (2 new rows).
 * Each fence then plugs every free 2x2 inside its own territory (and any open pocket it encloses).
 *
 * Each fence: an HQ, then anchors in a chain that goes right round the hive. The anchors' 7x7
 * squares claim the ring (and define the fence's border); no anchor or HQ square may ever
 * hold a hive city, statue, node or banner tile, so nothing the hive needs can fall to the fence
 * if something is dismantled ("extra" cities of a design don't count: they are dropped if a
 * square needs their spot). Then fillers and the alliance's own buildings (2 traps, up to 3
 * statues; no gathering node) plug every 2x2 in its territory; a second pass moves single fillers
 * off other banners and towards the cities, the count unchanged.
 *
 * Build order (whoever builds first owns the overlap):
 *   1. fence 1 HQ (and any later fence's HQ placed first) and fence 1 anchors in chain order;
 *   2. the hive destroys and rebuilds the banners under those squares it safely can (never one
 *      whose loss hands a fence a city, statue, node or banner tile): fence 1 keeps the rest of
 *      the hive's free edge up to the cities;
 *   3. hive fillers, fence 1 yellow fillers (no new territory; grey inside its own HQ square);
 *   4. fence 2 HQ and anchors; then fence 1 orange fillers (they expand onto land fence 2 now
 *      owns) and fence 2 yellow fillers; and so on. The last fence's orange fillers (they expand
 *      the territory outward) come last.
 *
 * Rules as in the README: banner 7x7 centred, HQ 15x15 centred on its middle tile, anchors are
 * lower-left tiles, a new banner's square must touch (corners count) its alliance's territory, a
 * banner can't be built on territory claimed by another alliance.
 *
 * Runs in a browser worker or in Node (module.exports). Needs a HiGHS instance for the ILPs.
 */
(function (root) {
  "use strict";
  const MAP = 1200;
  const U = 0, M_HQ = 1, M_BAN = 2, OTHER = 3, F0 = 10;   // ownership codes; fence k (1-based) = F0 + k

  // ---------------------------------------------------------------- input
  const SIZE = { city: 2, obs2: 2, obs3: 3, beartrap: 3, hq: 3, banner: 1, resource: 2, obs1: 1 };

  function parseCsv(text) {
    const rows = [];
    for (const line of String(text).split(/\r?\n/)) {
      const a = line.split(",");
      if (a.length < 3) continue;
      const type = a[0].trim().toLowerCase(), x = parseInt(a[1], 10), y = parseInt(a[2], 10);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !SIZE[type]) continue;
      rows.push({ type, x, y, label: (a[3] || "").trim(), color: (a[4] || "").trim() });
    }
    return rows;
  }

  const sqB = (x, y) => [x - 3, y - 3, x + 3, y + 3];
  const sqH = (x, y) => [x - 6, y - 6, x + 8, y + 8];
  const inR = (r, x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  const hitsMask = (g, r, mask) => { for (let y = Math.max(0, r[1]); y <= Math.min(g.H - 1, r[3]); y++) for (let x = Math.max(0, r[0]); x <= Math.min(g.W - 1, r[2]); x++) if (mask[y * g.W + x]) return true; return false; };
  const touches = (a, b) => Math.max(a[0], b[0]) - Math.min(a[2], b[2]) <= 1 && Math.max(a[1], b[1]) - Math.min(a[3], b[3]) <= 1;

  /* Splits the mother alliance's banners into hive banners (square holds a city, trap, statue,
     node or HQ tile, or lies wholly inside hive territory) and network banners (treated as
     territory that is neither protected nor eatable). */
  function splitHive(mother) {
    const tiles = new Set();
    const addFoot = (x, y, w) => { for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) tiles.add((y + j) * MAP + x + i); };
    for (const [x, y] of mother.cities) addFoot(x, y, 2);
    for (const [x, y] of mother.traps) addFoot(x, y, 3);
    for (const b of mother.buildings || []) addFoot(b.x, b.y, b.w);
    addFoot(mother.hq[0], mother.hq[1], 3);
    const hive = [], rest = [];
    for (const b of mother.banners) {
      const r = sqB(b[0], b[1]);
      let hit = false;
      for (let y = r[1]; y <= r[3] && !hit; y++) for (let x = r[0]; x <= r[2]; x++) if (tiles.has(y * MAP + x)) { hit = true; break; }
      (hit ? hive : rest).push(b);
    }
    const terr = [sqH(...mother.hq)].concat(hive.map((b) => sqB(...b)));
    const covered = (x, y) => terr.some((r) => inR(r, x, y));
    for (let pass = 0; pass < 2; pass++) {
      for (let i = rest.length - 1; i >= 0; i--) {
        const r = sqB(...rest[i]);
        let all = true;
        for (let y = r[1]; y <= r[3] && all; y++) for (let x = r[0]; x <= r[2]; x++) if (!covered(x, y)) { all = false; break; }
        if (all) { hive.push(rest[i]); terr.push(r); rest.splice(i, 1); }
      }
    }
    return { hive, network: rest };
  }

  /* KSMapper CSV -> fence input. motherTag: the hive alliance. ignoreTags: alliances to leave out
     (old fences being redesigned). Every other alliance counts as foreign territory and buildings. */
  function fromCsv(text, motherTag, ignoreTags) {
    const rows = parseCsv(text);
    const ign = new Set((ignoreTags || []).map((t) => t.toLowerCase()));
    const mt = motherTag.toLowerCase();
    const hqRow = rows.find((r) => r.type === "hq" && r.label.toLowerCase() === mt);
    if (!hqRow) throw new Error("No HQ tagged " + motherTag + " in the CSV.");
    const tags = new Set(rows.filter((r) => r.type === "hq" || r.type === "banner").map((r) => r.label.toLowerCase()));
    const mother = { tag: hqRow.label, hq: [hqRow.x, hqRow.y], traps: [], banners: [], cities: [], buildings: [] };
    const others = { hqs: [], banners: [], buildings: [] };
    for (const r of rows) if (r.type === "banner" && r.label.toLowerCase() === mt) mother.banners.push([r.x, r.y]);
    const terr = [sqH(...mother.hq)].concat(mother.banners.map((b) => sqB(...b)));
    const inMother = (x, y, w) => { for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) if (!terr.some((q) => inR(q, x + i, y + j))) return false; return true; };
    for (const r of rows) {
      const lab = r.label.toLowerCase();
      if (ign.has(lab)) continue;
      if (r.type === "hq") { if (r !== hqRow) others.hqs.push([r.x, r.y]); continue; }
      if (r.type === "banner") { if (lab !== mt) others.banners.push([r.x, r.y]); continue; }
      const w = SIZE[r.type];
      const foreign = tags.has(lab) && lab !== mt;
      if (r.type === "city") { if (!foreign && inMother(r.x, r.y, 2)) mother.cities.push([r.x, r.y]); else others.buildings.push({ x: r.x, y: r.y, w }); continue; }
      if (r.type === "beartrap") { if (!foreign && inMother(r.x, r.y, 3)) mother.traps.push([r.x, r.y]); else others.buildings.push({ x: r.x, y: r.y, w }); continue; }
      if (r.type === "resource") { others.buildings.push({ x: r.x, y: r.y, w }); continue; }
      if (!foreign && inMother(r.x, r.y, w)) mother.buildings.push({ x: r.x, y: r.y, w, type: w === 3 ? "node" : "statue", label: r.label });
      else others.buildings.push({ x: r.x, y: r.y, w });
    }
    return { mother, others };
  }

  /* Hive optimiser design (game coordinates, see hive.js toGameDesign) -> fence input. */
  function fromDesign(d, tag) {
    return {
      mother: {
        tag: tag || "HIVE", hq: d.hq.slice(), traps: d.traps.map((t) => t.slice()),
        banners: d.banners.concat(d.fillers || []).map((b) => b.slice()),
        cities: d.cities.map((c) => [c.x, c.y, !!c.extra]),
        buildings: (d.extras || []).map((e) => ({ x: e.x, y: e.y, w: e.w, type: e.type })),
      },
      others: { hqs: [], banners: [], buildings: [] },
    };
  }

  // ---------------------------------------------------------------- grid
  function makeGrid(world, input, layers) {
    const { mother, others } = input;
    const split = splitHive(mother);
    const hiveTerr = [sqH(...mother.hq)].concat(split.hive.map((b) => sqB(...b)));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of hiveTerr) { x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[2]); y1 = Math.max(y1, r[3]); }
    const margin = 22 + 6 * layers;
    const ox = Math.max(0, x0 - margin), oy = Math.max(0, y0 - margin);
    const W = Math.min(MAP, x1 + margin + 1) - ox, H = Math.min(MAP, y1 + margin + 1) - oy;
    const N = W * H;
    const g = {
      ox, oy, W, H, N, layers, mother, split,
      cityBlock: new Uint8Array(N), allyBlock: new Uint8Array(N), hqBlock: new Uint8Array(N),
      occ: new Uint8Array(N), own: new Uint8Array(N), prot: new Uint8Array(N), extraAt: new Int32Array(N).fill(-1),
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const b = world.block[(y + oy) * MAP + x + ox], i = y * W + x;
      g.cityBlock[i] = (b & (1 | 4)) ? 1 : 0;
      g.allyBlock[i] = (b & (1 | 2)) ? 1 : 0;
      g.hqBlock[i] = (b & (1 | 2 | 8)) ? 1 : 0;
    }
    const idx = (x, y) => { const lx = x - ox, ly = y - oy; return lx < 0 || ly < 0 || lx >= W || ly >= H ? -1 : ly * W + lx; };
    g.idx = idx;
    const paint = (r, code, onlyFree) => {
      for (let y = Math.max(r[1], oy); y <= Math.min(r[3], oy + H - 1); y++) for (let x = Math.max(r[0], ox); x <= Math.min(r[2], ox + W - 1); x++) {
        const i = idx(x, y);
        if (!onlyFree || g.own[i] === U) g.own[i] = code;
      }
    };
    const foot = (x, y, w, fn) => { for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) { const k = idx(x + i, y + j); if (k >= 0) fn(k); } };
    // ownership: hive HQ square, hive banner squares, then everything else that is claimed
    paint(sqH(...mother.hq), M_HQ, false);
    for (const b of split.hive) paint(sqB(...b), M_BAN, true);
    for (const h of others.hqs) paint(sqH(...h), OTHER, true);
    for (const b of others.banners.concat(split.network)) paint(sqB(...b), OTHER, true);
    // hive banners (for the rebuild list)
    g.hiveB = split.hive.map((b) => ({ x: b[0], y: b[1], i: idx(b[0], b[1]) }));
    // occupancy; protected tiles = what a fence square may never hold (it would take it from the
    // hive if a hive banner were dismantled): cities, statues, node, banners outside the HQ square
    const prot = (k) => { if (g.own[k] === M_BAN) g.prot[k] = 1; };
    const core = new Uint8Array(N);   // where distances are measured from
    foot(mother.hq[0], mother.hq[1], 3, (k) => { g.occ[k] = 1; core[k] = 1; });
    for (const t of mother.traps) foot(t[0], t[1], 3, (k) => { g.occ[k] = 1; core[k] = 1; });
    mother.cities.forEach((c, n) => foot(c[0], c[1], 2, (k) => {
      g.occ[k] = 1;
      if (c[2]) { if (g.own[k] === M_BAN) g.extraAt[k] = n; }
      else { prot(k); core[k] = 1; }
    }));
    for (const b of mother.buildings || []) foot(b.x, b.y, b.w, (k) => { g.occ[k] = 1; prot(k); core[k] = 1; });
    for (const b of split.hive) foot(b[0], b[1], 1, (k) => { g.occ[k] = 1; prot(k); });
    for (const b of split.network) foot(b[0], b[1], 1, (k) => { g.occ[k] = 1; });
    for (const h of others.hqs) foot(h[0], h[1], 3, (k) => { g.occ[k] = 1; });
    for (const b of others.banners) foot(b[0], b[1], 1, (k) => { g.occ[k] = 1; });
    for (const b of others.buildings) foot(b.x, b.y, b.w, (k) => { g.occ[k] = 1; });
    // what the hive has built (HQ, traps, cities, statues, node): no fence square may hold it
    // outside the hive HQ's square (it would fall to the fence when the hive rebuilds)
    g.built = core;
    g.hqSq = (() => { const r = sqH(mother.hq[0] - ox, mother.hq[1] - oy); return (t) => inR(r, t % W, (t / W) | 0); })();
    // Chebyshev distance to the hive's cities (and its HQ, traps, statues, node)
    g.d = new Int16Array(N).fill(999);
    const q = [];
    for (let t = 0; t < N; t++) if (core[t]) { g.d[t] = 0; q.push(t); }
    for (let h = 0; h < q.length; h++) {
      const t = q[h], x = t % W, y = (t / W) | 0, nd = g.d[t] + 1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const s = yy * W + xx;
        if (g.d[s] > nd) { g.d[s] = nd; q.push(s); }
      }
    }
    return g;
  }

  const freeTile = (g, i) => !g.cityBlock[i] && !g.occ[i];

  /* Lower-left indices of every free 2x2 window (all four tiles city-buildable and empty). */
  function freeWindows(g, pred) {
    const { W, H } = g, out = [];
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      if (freeTile(g, i) && freeTile(g, i + 1) && freeTile(g, i + W) && freeTile(g, i + W + 1) && (!pred || pred(i))) out.push(i);
    }
    return out;
  }
  const winTiles = (g, i) => [i, i + 1, i + g.W, i + g.W + 1];

  // ---------------------------------------------------------------- LP helpers
  function solveLP(highs, lines, timeLimit) {
    return highs.solve(lines.join("\n"), { time_limit: timeLimit, mip_rel_gap: 0, output_flag: false });
  }
  const okStatus = (s) => s && s.Columns && /Optimal|Time limit|limit reached/i.test(s.Status) && s.ObjectiveValue != null;

  // ---------------------------------------------------------------- one fence: HQ + anchors
  const ownerOf = (o) => (o === M_HQ || o === M_BAN ? 0 : o > F0 ? o - F0 : -1);
  const ours = (o) => o === M_HQ || o === M_BAN || o > F0;

  /* Windows the alliances must plug: free, no foreign tile, every tile inside the hive's or a
     fence's territory or in an open pocket they enclose (not linked to the outside through
     unclaimed ground). What lies outside the last fence is its exterior. */
  function bandWindows(g) {
    const { W, H, N } = g;
    const out = new Uint8Array(N), q = [];
    const seed = (t) => { if (!out[t] && !ours(g.own[t])) { out[t] = 1; q.push(t); } };
    for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
    for (let h = 0; h < q.length; h++) {
      const t = q[h], x = t % W;
      if (x > 0) seed(t - 1); if (x < W - 1) seed(t + 1); if (t >= W) seed(t - W); if (t + W < N) seed(t + W);
    }
    return freeWindows(g, (i) => winTiles(g, i).every((t) => g.own[t] !== OTHER && !out[t]));
  }

  /* Tiles fence k must claim: open tiles (of a free 2x2) up to its anchor line. */
  /* Chebyshev distance of every tile to the land the hive and the fences before k own. */
  function ownDist(g, k) {
    const { W, H, N } = g;
    const d = new Int16Array(N).fill(999), q = [];
    for (let t = 0; t < N; t++) { const o = g.own[t]; if (o === M_HQ || o === M_BAN || (o > F0 && o < F0 + k)) { d[t] = 0; q.push(t); } }
    for (let h = 0; h < q.length; h++) {
      const t = q[h], x = t % W, y = (t / W) | 0, nd = d[t] + 1;
      if (nd > 20) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const s = yy * W + xx;
        if (d[s] > nd) { d[s] = nd; q.push(s); }
      }
    }
    return d;
  }

  /* Where fence k's anchors stand and how far off a tile is: fence 1 on the line 4 tiles from the
     cities (its square ends against them); later fences right against the fence before (that one
     never moves again, so overlapping it costs nothing and saves expansion). */
  function anchorLine(g, k) {
    if (k === 1) {
      // on the line 4 tiles from the cities, or right against the hive HQ's square (it never
      // shrinks), whichever is nearer
      const { W, H, N } = g;
      const dh = new Int16Array(N).fill(999), q = [];
      for (let t = 0; t < N; t++) if (g.own[t] === M_HQ) { dh[t] = 0; q.push(t); }
      for (let h = 0; h < q.length; h++) {
        const t = q[h], x = t % W, y = (t / W) | 0, nd = dh[t] + 1;
        if (nd > 6) continue;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const s = yy * W + xx; if (dh[s] > nd) { dh[s] = nd; q.push(s); } }
      }
      return (p) => Math.min(Math.abs(g.d[p] - 4), dh[p] - 1);
    }
    const od = ownDist(g, k);
    return (p) => od[p] - 1;
  }

  function claimTiles(g, k) {
    const { W, H } = g;
    const R = new Set();
    // the ring up to the anchors' line (every tile within it is claimed, so the fence closes right
    // round): fence 1 up to 4 tiles from the cities, later fences the ground touching the fence
    // before; beyond it the fillers carry on, orange where they expand
    // later fences stay outside fence 1's line: ground left open inside it is the hive's to cover
    const near = k === 1 ? (t) => g.d[t] <= 4 : ((od) => (t) => od[t] <= 1 && g.d[t] > 4)(ownDist(g, k));
    const res = (t) => k === 1 && g.reserved && g.reserved[t];   // a later fence's HQ square
    // fence 1 also takes the hive's banner land up to its line (the hive rebuilds round its cities)
    const open = (t) => g.own[t] === U;
    for (const i of freeWindows(g, (w) => !winTiles(g, w).some((t) => g.own[t] === OTHER))) for (const t of winTiles(g, i)) if (open(t) && near(t) && !res(t)) R.add(t);
    return R;
  }

  /* Hive banner ground (outside its HQ's square) up to fence 1's line, extra cities on it
     included: fence 1 always takes it (the hive must not spend banners on it; the fences may).
     Each 2x2 left wholly to the hive costs SOFT in the anchor ILP, more than an anchor, and each
     tile left SOFT_TILE: a 1-tile line of hive ground is cheaper to leave than an anchor that only
     eats it (the fence's banners lean against it). */
  const SOFT = 3;
  const SOFT_TILE = 0.15;
  const HQ_OUT = 10;
  const LAST_AREA = 0.0005;   // per tile of new ground the last fence's fillers claim (tie-break, above touching)
  const MAX_EXTRA_SECS = 31;
  const HIVE_BANNER = 2;   // a hive banner weighs two fence banners: the fences should pay
  function softTiles(g, k) {
    const S = new Set();
    if (k !== 1) return S;
    const { W, H } = g;
    const open = (t) => !g.cityBlock[t] && g.own[t] !== OTHER && (!g.occ[t] || g.extraAt[t] >= 0);
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const w = winTiles(g, y * W + x);
      if (w.every(open)) for (const t of w) if (g.own[t] === M_BAN && !g.prot[t] && g.d[t] <= 4 && !(g.reserved && g.reserved[t])) S.add(t);
    }
    return S;
  }

  /* A square may hold hive land, protected tiles included: the hive only destroys and rebuilds the
     banners it safely can (rebuildPlan), so a protected tile stays with the hive. Extra cities on
     ground the square does take are dropped. */
  function squareInfo(g, r, k, R, keepCost) {
    const { W, H } = g;
    if (r[0] < 0 || r[1] < 0 || r[2] >= W || r[3] >= H) return null;
    const extras = new Set();
    let ring = 0, cost = 0;
    for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
      const t = y * W + x;
      if (k === 1 && g.built[t] && !g.hqSq(t)) return null;
      // an outer fence's HQ or anchor never holds hive ground: should a hive banner come down by
      // mistake, it would take the ground and cut the hive apart
      // once the build order is tracked (g.reg), banner ground the hive can destroy and rebuild in
      // place (cycleHive checks it) and the hive HQ's own ground (it never falls) are fine
      if (k > 1 && (g.built[t] || (ownerOf(g.own[t]) === 0 && (!g.reg || g.prot[t])))) return null;
      if (g.extraAt[t] >= 0) extras.add(g.extraAt[t]);
      if (R.has(t)) ring++;
      else if (g.own[t] === U) cost += g.cityBlock[t] || g.occ[t] ? 0.005 : 0.02;   // land beyond the ring
    }
    if (keepCost) cost += keepCost(r);
    return { extras: [...extras], ring, cost };
  }

  /* Which hive banners the hive destroys and rebuilds once the squares `rects` (fence 1's HQ and
     anchors, and any HQ built before them) stand: each one under a square, unless that would hand a
     protected tile (city, statue, node, a hive banner's own tile) to a fence. Every protected tile
     under a square keeps a cover among the hive HQ's square and the banners that stay; where it has
     several, the banner that frees least ground stays. keep[t] = 1: the hive keeps tile t. */
  function rebuildPlan(g, rects) {
    const { W, H, N } = g;
    const under = new Uint8Array(N);
    for (const r of rects) for (let y = Math.max(0, r[1]); y <= Math.min(H - 1, r[3]); y++) for (let x = Math.max(0, r[0]); x <= Math.min(W - 1, r[2]); x++) under[y * W + x] = 1;
    const hb = g.split.hive.map((b) => { const x = b[0] - g.ox, y = b[1] - g.oy; return sqB(x, y); });
    const tilesOf = (r, fn) => { for (let y = Math.max(0, r[1]); y <= Math.min(H - 1, r[3]); y++) for (let x = Math.max(0, r[0]); x <= Math.min(W - 1, r[2]); x++) fn(y * W + x); };
    const hqR = sqH(g.mother.hq[0] - g.ox, g.mother.hq[1] - g.oy);
    const inD = hb.map((r) => { let hit = false; tilesOf(r, (t) => { if (under[t] && g.own[t] === M_BAN) hit = true; }); return hit; });
    const frees = hb.map((r) => { let n = 0; tilesOf(r, (t) => { if (under[t] && g.own[t] === M_BAN) n++; }); return n; });
    const bannerTile = new Uint8Array(N);
    for (const b of g.hiveB) if (b.i >= 0) bannerTile[b.i] = 1;
    // where a new hive banner could stand after the rebuild: a free or hive tile no square covers
    const spot = (p) => !under[p] && !g.allyBlock[p] && (!g.occ[p] || bannerTile[p]) && (g.own[p] === U || g.own[p] === M_BAN || g.own[p] === M_HQ);
    const reachable = (t) => { const x = t % W, y = (t / W) | 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const xx = x + dx, yy = y + dy; if (xx < 3 || yy < 3 || xx >= W - 3 || yy >= H - 3) continue; if (spot(yy * W + xx)) return true; } return false; };
    // a protected tile needs a cover that stays if a square takes it, or if no new banner could
    // give it back
    const needsKeep = new Uint8Array(N);
    for (let t = 0; t < N; t++) if (g.prot[t] && !bannerTile[t] && !inR(hqR, t % W, (t / W) | 0) && (under[t] || !reachable(t))) needsKeep[t] = 1;
    for (let changed = true; changed; ) {
      changed = false;
      for (let t = 0; t < N; t++) {
        if (!needsKeep[t]) continue;
        const covers = [];
        hb.forEach((r, i) => { if (inR(r, t % W, (t / W) | 0)) covers.push(i); });
        if (!covers.length || covers.some((i) => !inD[i])) continue;
        covers.sort((a, b) => frees[a] - frees[b]);
        inD[covers[0]] = false; changed = true;
      }
    }
    const keep = new Uint8Array(N);
    tilesOf(hqR, (t) => { keep[t] = 1; });
    hb.forEach((r, i) => { if (!inD[i]) tilesOf(r, (t) => { keep[t] = 1; }); });
    return { keep, rebuilt: g.split.hive.filter((b, i) => inD[i]) };
  }

  function solveLayer(g, k, highs, opts, log) {
    const { W, H } = g;
    const R = claimTiles(g, k), S = softTiles(g, k);
    const keepCost = null;
    if (!R.size) return null;
    const hitsResFoot = (r) => { if (k !== 1 || !g.resFoot) return false; for (let y = Math.max(0, r[1]); y <= Math.min(H - 1, r[3]); y++) for (let x = Math.max(0, r[0]); x <= Math.min(W - 1, r[2]); x++) if (g.resFoot[y * W + x]) return true; return false; };
    const dil = new Uint8Array(g.N);   // anchors that cover or can link to the band
    for (const r of [...R, ...S]) { const x = r % W, y = (r / W) | 0; for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H) dil[yy * W + xx] = 1; } }
    const vars = [];
    const offOf = anchorLine(g, k);
    for (let p = 0; p < g.N; p++) {
      // on open ground or on the fence's own (its HQ's square): a banner may stand on either
      // only on ground free at this step (or the fence's own): never on the hive's land, which
      // stands until the hive rebuilds
      if (!dil[p] || (g.own[p] !== U && g.own[p] !== F0 + k) || g.allyBlock[p] || g.occ[p] || (g.noAnchor && g.noAnchor.has(p))) continue;
      const x = p % W, y = (p / W) | 0, r = sqB(x, y);
      if (hitsResFoot(r)) continue;
      // anchors define the border: they stand on the line 4 tiles beyond the inner region (their
      // square ends against the cities, or against the fence before); off that line only where
      // it can't be helped, at 2 per tile of offset
      const off = offOf(p);
      if (off > (k === 1 ? 4 : 1)) continue;
      const info = squareInfo(g, r, k, R, keepCost);
      if (info) vars.push({ kind: "a", p, x, y, r, ...info, off });
    }
    const fixed = g.fixedHQ && g.fixedHQ[k];
    // a layer given whole (the prune pass): its HQ and anchors, connectors added only if needed
    const fixL = opts.fixLayer && opts.fixLayer[k];
    const fixSet = fixL ? new Set(fixL.anchors.map((a) => g.idx(a[0], a[1]))) : null;
    const hqs = [];
    // each fence's HQ stands in its own band, against the ring before it: open ground its square
    // holds beyond the band (past the reach of anchors on the line) must be filled for nothing,
    // at about one filler per HQ_OUT tiles
    const od = k === 1 ? null : ownDist(g, k);
    const beyond = k === 1 ? (t) => g.d[t] > 7 : (t) => od[t] > 4;
    if (!fixed && !fixL) for (let y = 6; y < H - 8; y++) for (let x = 6; x < W - 8; x++) {
      let ok = true;
      for (let j = 0; j < 3 && ok; j++) for (let i = 0; i < 3; i++) { const t = (y + j) * W + x + i; if (g.own[t] !== U || g.hqBlock[t] || g.occ[t]) { ok = false; break; } }
      if (!ok) continue;
      const r = sqH(x, y), info = hitsResFoot(sqH(x, y)) ? null : squareInfo(g, r, k, R, keepCost);
      if (info) {
        let out = 0;
        for (let yy = r[1]; yy <= r[3]; yy++) for (let xx = r[0]; xx <= r[2]; xx++) { const t = yy * W + xx; if (g.own[t] === U && !g.cityBlock[t] && !g.occ[t] && beyond(t)) out++; }
        info.cost += out / HQ_OUT;
      }
      if (info && info.ring >= 8) hqs.push({ kind: "h", x, y, r, ...info, score: info.ring - 4 * info.cost });
    }
    const picked = [];
    const hqRule = (x, y, r) => { if (!squareInfo(g, r, k, R, keepCost)) throw new Error("Fence " + k + ": an HQ at " + (x + g.ox) + "," + (y + g.oy) + " would hold " + (k === 1 ? "something the hive built" : "hive ground") + "."); };
    if (fixed) { if (!fixed.placed) hqRule(fixed.x, fixed.y, fixed.r); picked.push(Object.assign({}, fixed, { kind: "h", cost: 0, extras: [] })); }
    else if (fixL) {
      const x = fixL.hq[0] - g.ox, y = fixL.hq[1] - g.oy, r = sqH(x, y);
      hqRule(x, y, r);
      picked.push(Object.assign({ kind: "h", x, y, r }, squareInfo(g, r, k, R, keepCost)));
    } else {
      if (!hqs.length) throw new Error("Fence " + (k) + ": no free Plains/Badlands spot for its HQ next to the band.");
      hqs.sort((a, b) => b.score - a.score);
      for (const h of hqs) { if (picked.length >= 40) break; if (!picked.some((q) => Math.abs(q.x - h.x) + Math.abs(q.y - h.y) < 3)) picked.push(h); }
    }
    vars.push(...picked);
    // every later fence's HQ also stands against the hive, as part of fence 1's ring: in its square
    // fence 1 needs no banners (that fence owns the ground before fence 1's anchors go up)
    if (k === 1 && opts.outerHQ === true) for (let f = 2; f <= g.layers; f++) for (const h of picked) vars.push(Object.assign({}, h, { kind: "o", fence: f }));
    const name = (j) => vars[j].kind + j;
    const cover = new Map();
    vars.forEach((v, j) => { for (let y = v.r[1]; y <= v.r[3]; y++) for (let x = v.r[0]; x <= v.r[2]; x++) { const t = y * W + x; if (R.has(t)) { let a = cover.get(t); if (!a) cover.set(t, a = []); a.push(j); } } });
    const uncovered = [...R].filter((t) => !cover.has(t));
    const cons = [], obj = [];
    // fence 1: wherever its square covers most (the line 4 tiles out is only a tie-break); later
    // fences: right against the fence before, 2 per tile off
    // opts.noise (a seed): small random costs per anchor, so the solver picks another layout among the
    // (near) ties; the same seed gives the same layout on any machine
    let seed = ((opts.noise | 0) * 7919 + k * 104729) % 2147483648;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const costOf = vars.map((v) => (v.kind === "a" ? 1 + (k === 1 ? 0.05 : 2) * v.off + (opts.noise ? 0.3 * rnd() : 0) : 0) + v.cost);
    vars.forEach((v, j) => obj.push("+ " + costOf[j].toFixed(4) + " " + name(j)));
    const xs = new Set();
    vars.forEach((v, j) => { for (const c of v.extras) { xs.add(c); cons.push(name(j) + " - x" + c + " <= 0"); } });
    // extra cities are dropped for free wherever a square needs their ground
    for (const t of R) { const a = cover.get(t); if (a) cons.push(a.map(name).join(" + ") + " >= 1"); }
    const soft = new Map();
    vars.forEach((v, j) => { for (let y = v.r[1]; y <= v.r[3]; y++) for (let x = v.r[0]; x <= v.r[2]; x++) { const t = y * W + x; if (S.has(t)) { let a = soft.get(t); if (!a) soft.set(t, a = []); a.push(j); } } });
    for (const [t, a] of soft) { cons.push(a.map(name).join(" + ") + " + u" + t + " >= 1"); obj.push("+ " + SOFT_TILE + " u" + t); }
    // a 2x2 left wholly to the hive costs it a banner; a 1-tile line costs nothing (the fence's
    // banners lean against it)
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const b = y * W + x, w = winTiles(g, b);
      if (!w.every((t) => S.has(t))) continue;
      const vs = w.filter((t) => soft.has(t)), fixedLeft = 4 - vs.length;
      if (!vs.length) continue;
      cons.push("v" + b + " - " + vs.map((t) => "u" + t).join(" - ") + " >= " + (fixedLeft - 3));
      obj.push("+ " + SOFT + " v" + b);
    }
    cons.push(vars.map((v, j) => (v.kind === "h" ? name(j) : null)).filter(Boolean).join(" + ") + " = 1");
    for (let f = 2; f <= g.layers && k === 1 && opts.outerHQ === true; f++) cons.push(vars.map((v, j) => (v.kind === "o" && v.fence === f ? name(j) : null)).filter(Boolean).join(" + ") + " = 1");
    vars.forEach((h, c) => {
      if (h.kind === "a") return;
      vars.forEach((a, j) => {
        if (a.kind !== "a") return;
        const clash = h.kind === "o" ? inR(h.r, a.x, a.y) : a.x >= h.x - 1 && a.x <= h.x + 3 && a.y >= h.y - 1 && a.y <= h.y + 3;
        if (clash) cons.push(name(j) + " + " + name(c) + " <= 1");
      });
    });
    // HQs of different fences: squares may not overlap
    const hv = vars.map((v, j) => j).filter((j) => vars[j].kind !== "a");
    for (let a = 0; a < hv.length; a++) for (let b = a + 1; b < hv.length; b++) {
      const u = vars[hv[a]], v = vars[hv[b]];
      if ((u.fence || 1) === (v.fence || 1)) continue;
      if (Math.max(u.r[0], v.r[0]) <= Math.min(u.r[2], v.r[2]) && Math.max(u.r[1], v.r[1]) <= Math.min(u.r[3], v.r[3])) cons.push(name(hv[a]) + " + " + name(hv[b]) + " <= 1");
    }
    const binaries = vars.map((v, j) => name(j)).concat([...xs].map((c) => "x" + c));
    // links follow ownership at build time: a square gains only open ground (or the fence's own),
    // never the hive's land (rebuilt only afterwards) nor the other fences' HQ squares (built first).
    // A banner may go up where its square touches (corners count) a tile the fence then owns.
    const gainOf = vars.map((v) => {
      const out = [];
      for (let y = v.r[1]; y <= v.r[3]; y++) for (let x = v.r[0]; x <= v.r[2]; x++) { const t = y * W + x; if (g.own[t] === U || g.own[t] === F0 + k) out.push(t); }
      return out;
    });
    let outerSq = [];   // the other fences' HQ squares in the current solution (fence 1 only)
    const setOuter = (sel) => { outerSq = sel.filter((j) => vars[j].kind === "o").map((j) => vars[j].r); };
    const gainSet = gainOf.map((a) => new Set(a));
    const link = (i, j) => {
      const a = vars[i].r, b = vars[j].r;
      if (!touches(a, b)) return false;
      // j is linked from i if a cell j's square holds for the fence lies on or next to one i holds
      const inOuter = (t) => outerSq.some((r) => inR(r, t % W, (t / W) | 0));
      for (const t of gainOf[j]) {
        if (inOuter(t)) continue;
        const x = t % W, y = (t / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const s = (y + dy) * W + x + dx; if (gainSet[i].has(s) && !inOuter(s)) return true; }
      }
      return false;
    };
    // anchors in build order from the HQ (breadth first); the unlinked ones are left out
    const buildOrder = (selAll) => {
      const sel = selAll.filter((j) => vars[j].kind !== "o");
      const hqJ = sel.find((j) => vars[j].kind === "h");
      const seen = new Set([hqJ]), order = [];
      let frontier = [hqJ];
      while (frontier.length) {
        const next = [];
        for (const i of frontier) for (const j of sel) if (!seen.has(j) && link(i, j)) { seen.add(j); order.push(j); next.push(j); }
        frontier = next;
      }
      return { seen, order };
    };
    const reach = (selAll) => { setOuter(selAll); return buildOrder(selAll).seen; };
    const cuts = [];
    let sol = null, chosen = null, optimal = false;
    if (fixL) chosen = vars.map((v, j) => j).filter((j) => vars[j].kind === "h" || (vars[j].kind === "a" && fixSet.has(vars[j].p)));
    else for (let it = 0; it < 6; it++) {
      const L = ["Minimize", " obj: " + obj.join(" ").replace(/^\+ /, ""), "Subject To"];
      cons.concat(cuts).forEach((c, i) => L.push(" c" + i + ": " + c));
      L.push("Binary", " " + binaries.join(" "), "End");
      const t0 = Date.now();
      sol = solveLP(highs, L, opts.timeLimit || 40);
      if (log) log("fence " + k + " ILP: " + vars.length + " vars, " + R.size + " band tiles, " + ((Date.now() - t0) / 1000).toFixed(1) + " s, " + (sol && sol.Status) + ", obj " + (sol && sol.ObjectiveValue));
      if (!okStatus(sol)) throw new Error("Fence " + k + ": the anchor solver failed (" + (sol && sol.Status) + ").");
      optimal = sol.Status === "Optimal";
      chosen = vars.map((v, j) => j).filter((j) => { const c = sol.Columns[name(j)]; return c && c.Primal > 0.5; });
      const reached = reach(chosen);
      const lost = chosen.filter((j) => !reached.has(j) && vars[j].kind === "a");
      if (!lost.length) break;
      const rootJ = [...reached], nCuts = cuts.length;
      const seen = new Set();
      for (const s0 of lost) {
        if (seen.has(s0)) continue;
        const S = [s0], inS = new Set([s0]); seen.add(s0);
        for (let q = 0; q < S.length; q++) vars.forEach((v, j) => {
          if (inS.has(j) || v.kind !== "a" || !(link(S[q], j) || link(j, S[q])) || rootJ.some((r) => link(r, j))) return;
          inS.add(j); S.push(j); if (lost.includes(j)) seen.add(j);
        });
        // any solution that holds the lost anchor reaches S through one of these
        const nb = [];
        vars.forEach((v, j) => { if (!inS.has(j) && v.kind !== "o" && S.some((c) => link(j, c))) nb.push(name(j)); });
        // no anchor can ever link into S: a cut would forbid it outright, so leave it to the
        // connector search (and the rule check, if that fails too)
        if (nb.length) for (const j of lost) if (inS.has(j)) cuts.push(nb.join(" + ") + " - " + name(j) + " >= 0");
      }
      if (log) log("fence " + k + ": linking " + lost.length + " anchor(s) to the HQ");
      if (cuts.length === nCuts) break;   // nothing new to tell the solver
    }
    // still apart: cheapest chain of extra anchors (shortest path over linked squares); a connector
    // may drop extra cities, as any anchor may
    for (let guard = 0; guard < 20; guard++) {
      const reached = reach(chosen);
      const lost = new Set(chosen.filter((j) => !reached.has(j) && vars[j].kind === "a"));
      if (!lost.size) break;
      const dist = new Float64Array(vars.length).fill(Infinity), prev = new Int32Array(vars.length).fill(-1), done = new Uint8Array(vars.length);
      for (const j of reached) dist[j] = 0;
      let hit = -1;
      for (;;) {
        let u = -1, du = Infinity;
        for (let j = 0; j < vars.length; j++) if (!done[j] && dist[j] < du) { du = dist[j]; u = j; }
        if (u < 0) break;
        done[u] = 1;
        if (lost.has(u)) { hit = u; break; }
        for (let j = 0; j < vars.length; j++) {
          if (done[j] || vars[j].kind !== "a" || !link(u, j)) continue;
          const nd = du + (lost.has(j) ? 0 : costOf[j]);
          if (nd < dist[j]) { dist[j] = nd; prev[j] = u; }
        }
      }
      if (hit < 0) break;
      const add = [];
      for (let u = prev[hit]; u >= 0 && !reached.has(u); u = prev[u]) add.push(u);
      chosen = chosen.concat(add.filter((j) => !chosen.includes(j)));
      optimal = false;
      if (log) log("fence " + k + ": added " + add.length + " connector anchor(s)");
    }
    const hq = vars[chosen.find((j) => vars[j].kind === "h")];
    setOuter(chosen);
    const bo = buildOrder(chosen);
    const unlinked = chosen.filter((j) => vars[j].kind === "a" && !bo.seen.has(j)).map((j) => vars[j]);
    const anchors = bo.order.filter((j) => vars[j].kind === "a").map((j) => vars[j]).concat(unlinked);
    const outer = chosen.filter((j) => vars[j].kind === "o").map((j) => vars[j]);
    return { hq, anchors, outer, band: R.size, uncovered, optimal, unlinked, soft: [...S], hqCands: fixed ? [] : picked.slice(0, 12).map((h) => [h.x, h.y]) };
  }

  /* After fence 1's anchors (and the HQs built first) the hive destroys the banners under those
     squares it safely can (g.destroyed) and builds the fewest new ones, anywhere outside the fences,
     that give back to it every city, statue and node tile left without territory: as Pedro does,
     usually right against the cities, where no fence square reaches. A new banner stands on a free
     tile or the hive's, gains only open ground and must chain to the hive's territory. Exact ILP,
     linking by lazy cuts, then shortest connector chains. Extra cities left without territory are
     dropped. Returns the new banners in build order and the dropped extra cities. */
  function rehive(g, highs, opts) {
    const { W, H, N } = g;
    const D = new Set((g.destroyed || []).map(String));
    const out = { built: [], dropped: [], missing: 0 };
    if (!D.size) return out;
    const idx = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x);
    // destroyed: their tiles are free, their land without another hive cover is open ground
    for (const b of g.split.hive) if (D.has(String(b))) { const t = g.idx(b[0], b[1]); if (t >= 0) { g.occ[t] = 0; g.prot[t] = 0; } }
    const hqR = sqH(g.mother.hq[0] - g.ox, g.mother.hq[1] - g.oy);
    const cover = new Uint8Array(N);
    const mark = (r) => { for (let y = Math.max(0, r[1]); y <= Math.min(H - 1, r[3]); y++) for (let x = Math.max(0, r[0]); x <= Math.min(W - 1, r[2]); x++) cover[y * W + x] = 1; };
    mark(hqR);
    for (const b of g.split.hive) if (!D.has(String(b))) mark(sqB(b[0] - g.ox, b[1] - g.oy));
    for (let t = 0; t < N; t++) if (g.own[t] === M_BAN && !cover[t]) g.own[t] = U;
    g.hiveB = g.hiveB.filter((b) => !D.has(b.x + "," + b.y));
    // tiles the hive needs back: its cities (not the extra ones), statues and node
    const need = [];
    const foot = (x, y, w) => { for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) { const t = g.idx(x + i, y + j); if (t >= 0 && g.own[t] === U) need.push(t); } };
    for (const c of g.mother.cities) if (!c[2]) foot(c[0], c[1], 2);
    for (const b of g.mother.buildings || []) foot(b.x, b.y, b.w);
    const hiveOwn = (t) => g.own[t] === M_HQ || g.own[t] === M_BAN;
    if (need.length) {
      const needSet = new Set(need);
      const near = new Uint8Array(N);
      for (const t of need) { const x = t % W, y = (t / W) | 0; for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) { const s = idx(x + dx, y + dy); if (s >= 0) near[s] = 1; } }
      const cands = [];
      for (let p = 0; p < N; p++) {
        if (!near[p] || g.occ[p] || g.allyBlock[p] || !(g.own[p] === U || hiveOwn(p))) continue;
        const x = p % W, y = (p / W) | 0, r = sqB(x, y);
        if (r[0] < 0 || r[1] < 0 || r[2] >= W || r[3] >= H) continue;
        const covers = [], gain = [];
        let blocked = false;
        for (let yy = r[1]; yy <= r[3]; yy++) for (let xx = r[0]; xx <= r[2]; xx++) { const t = yy * W + xx; if (needSet.has(t)) covers.push(t); if (g.own[t] === U) gain.push(t); if (g.resFoot && g.resFoot[t]) blocked = true; }
        if (blocked) continue;   // a later fence's HQ must find its 3x3 open
        cands.push({ p, x, y, r, covers, gain });   // covering a need, or only a connector
      }
      // a new banner may go up where its square touches the hive's land, or a tile another new one
      // gained before it
      // linked to the hive's land: its square holds hive cells, or a cell it gains lies next to one
      const touchesBase = (c) => {
        for (let yy = c.r[1]; yy <= c.r[3]; yy++) for (let xx = c.r[0]; xx <= c.r[2]; xx++) { const t = idx(xx, yy); if (t >= 0 && hiveOwn(t)) return true; }
        for (const t of c.gain) { const x = t % W, y = (t / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const s = idx(x + dx, y + dy); if (s >= 0 && hiveOwn(s)) return true; } }
        return false;
      };
      const base = cands.map(touchesBase);
      const gset = cands.map((c) => new Set(c.gain));
      const link = (i, j) => { const b = cands[j].r; if (!(Math.max(cands[i].r[0], b[0]) - Math.min(cands[i].r[2], b[2]) <= 1 && Math.max(cands[i].r[1], b[1]) - Math.min(cands[i].r[3], b[3]) <= 1)) return false; for (const t of cands[j].gain) { const x = t % W, y = (t / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (gset[i].has(idx(x + dx, y + dy))) return true; } return false; };
      const order = (sel) => {
        const seen = new Set(), ord = [];
        let fr = sel.filter((j) => base[j]);
        fr.forEach((j) => { seen.add(j); ord.push(j); });
        while (fr.length) { const nx = []; for (const i of fr) for (const j of sel) if (!seen.has(j) && link(i, j)) { seen.add(j); ord.push(j); nx.push(j); } fr = nx; }
        return { seen, ord };
      };
      const byTile = new Map();
      cands.forEach((c, j) => { for (const t of c.covers) { let a = byTile.get(t); if (!a) byTile.set(t, a = []); a.push(j); } });
      const cuts = [];
      let chosen = [];
      for (let it = 0; it < 8; it++) {
        const L = ["Minimize", " obj: " + cands.map((c, j) => (1 + 0.001 * c.gain.length).toFixed(4) + " x" + j).join(" + ") + (need.length ? " + " + need.map((t) => "1000 m" + t).join(" + ") : ""), "Subject To"];
        let r = 0;
        for (const t of need) L.push(" c" + (r++) + ": " + (byTile.get(t) || []).map((j) => "x" + j + " + ").join("") + "m" + t + " >= 1");
        for (const c of cuts) L.push(" k" + (r++) + ": " + c);
        L.push("Bounds", ...need.map((t) => " 0 <= m" + t + " <= 1"));
        L.push("Binary", " " + cands.map((c, j) => "x" + j).join(" "), "End");
        const sol = solveLP(highs, L, opts.timeLimit || 40);
        if (!okStatus(sol)) break;
        chosen = cands.map((c, j) => j).filter((j) => { const v = sol.Columns["x" + j]; return v && v.Primal > 0.5; });
        const { seen } = order(chosen);
        const lost = chosen.filter((j) => !seen.has(j));
        if (!lost.length) break;
        const n0 = cuts.length;
        for (const s of lost) {
          const nb = cands.map((c, j) => j).filter((j) => j !== s && link(j, s));
          if (nb.length) cuts.push(nb.map((j) => "x" + j).join(" + ") + " - x" + s + " >= 0");
        }
        if (cuts.length === n0) break;
      }
      // still apart: connector banners on the shortest chain from the hive's land
      for (let guard = 0; guard < 20; guard++) {
        const { seen } = order(chosen);
        const lost = new Set(chosen.filter((j) => !seen.has(j)));
        if (!lost.size) break;
        const all = cands.map((c, j) => j);
        // connectors may be any free or hive tile, not only those covering a need: widen the set
        const dist = new Float64Array(cands.length).fill(Infinity), prev = new Int32Array(cands.length).fill(-1), done = new Uint8Array(cands.length);
        for (const j of all) if (seen.has(j) || (base[j] && !lost.has(j))) dist[j] = seen.has(j) ? 0 : 1;
        let hit = -1;
        for (;;) {
          let u = -1, du = Infinity;
          for (const j of all) if (!done[j] && dist[j] < du) { du = dist[j]; u = j; }
          if (u < 0) break;
          done[u] = 1;
          if (lost.has(u)) { hit = u; break; }
          for (const j of all) { if (done[j] || !link(u, j)) continue; const nd = du + (lost.has(j) ? 0 : 1); if (nd < dist[j]) { dist[j] = nd; prev[j] = u; } }
        }
        if (hit < 0) break;
        const add = [];
        for (let u = prev[hit]; u >= 0 && !seen.has(u); u = prev[u]) add.push(u);
        if (dist[hit] === 1 && prev[hit] < 0) add.push(hit);
        chosen = chosen.concat(add.filter((j) => !chosen.includes(j)));
      }
      const { ord, seen } = order(chosen);
      const placed = ord.concat(chosen.filter((j) => !seen.has(j)));
      for (const j of placed) {
        const c = cands[j];
        for (const t of c.gain) if (g.own[t] === U) g.own[t] = M_BAN;
        g.occ[c.p] = 1; g.prot[c.p] = 1;
        g.hiveB.push({ x: c.x + g.ox, y: c.y + g.oy, i: c.p });
        out.built.push([c.x + g.ox, c.y + g.oy]);
      }
      out.missing = need.filter((t) => g.own[t] === U).length;
    }
    // extra cities left without territory are dropped
    g.mother.cities.forEach((c, n) => {
      if (!c[2]) return;
      let lost = false;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const t = g.idx(c[0] + i, c[1] + j); if (t >= 0 && g.extraAt[t] === n && g.own[t] !== M_BAN && g.own[t] !== M_HQ) lost = true; }
      if (lost) { out.dropped.push(n); for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const t = g.idx(c[0] + i, c[1] + j); if (t >= 0) { g.occ[t] = 0; g.extraAt[t] = -1; } } }
    });
    return out;
  }

  /* Applies a fence: ownership (fence 1 also takes the hive's free edge, the hive rebuilding the
     banners under its squares), occupancy, dropped extra cities. Anchors in build order. */
  function commitLayer(g, k, res) {
    const { W } = g;
    const code = F0 + k;
    const dropped = new Set();
    // fence 1 (and the HQs built before its anchors) take the hive's land the hive gives up by
    // rebuilding the banners it safely can; everything else only open ground
    let keep = null;
    if (k === 1) {
      const rects = Object.values(g.fixedHQ || {}).filter((h) => h.early).map((h) => h.r)
        .concat((res.outer || []).map((h) => h.r), [res.hq.r], res.anchors.map((a) => a.r));
      const rp = rebuildPlan(g, rects);
      keep = rp.keep;
      g.destroyed = rp.rebuilt;
      for (const h of Object.entries(g.fixedHQ || {}).filter(([, h]) => h.early)) {
        const r = h[1].r, c = F0 + +h[0];
        for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) { const t = y * W + x; if (g.own[t] === M_BAN && !keep[t]) { if (g.extraAt[t] >= 0) dropped.add(g.extraAt[t]); g.own[t] = c; } }
      }
    }
    const claim = (r, c, eat) => { for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
      const t = y * W + x, o = g.own[t];
      if (o === U || (eat && o === M_BAN && !(keep && keep[t]))) {
        if (g.extraAt[t] >= 0) dropped.add(g.extraAt[t]);
        g.own[t] = c;
      }
    } };
    g.fixedHQ = g.fixedHQ || {};
    for (const h of res.outer || []) {
      claim(h.r, F0 + h.fence, true);
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) g.occ[(h.y + j) * W + h.x + i] = 1;
      g.fixedHQ[h.fence] = { x: h.x, y: h.y, r: h.r, early: true };
    }
    if (!(g.fixedHQ[k] && g.fixedHQ[k].early)) claim(res.hq.r, code, k === 1);
    for (const a of res.anchors) claim(a.r, code, k === 1);
    for (const n of dropped) { const c = g.mother.cities[n]; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const t = g.idx(c[0] + i, c[1] + j); if (t >= 0) { g.occ[t] = 0; g.extraAt[t] = -1; } } }
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) g.occ[(res.hq.y + j) * W + res.hq.x + i] = 1;
    for (const a of res.anchors) g.occ[a.p] = 1;
    // anchors come in build order from solveLayer (linked by ownership), unlinked ones last
    return { order: res.anchors.slice(), dropped: [...dropped] };
  }

  /* Who owns what, in build order (the game's rule: a tile belongs to the earliest-built standing HQ
     or banner that covers it). Set up once fence 1 and the hive's rebuild stand; later HQs, anchors,
     removals and the hive's destroy-and-rebuild cycles go through it, so freed ground goes where the
     game would send it. */
  function buildReg(g, input, fences, log) {
    const reg = [];
    const add = (code, r, kind, at) => { reg.push({ code, r, kind, at, alive: true }); return reg.length - 1; };
    const D = new Set((g.destroyed || []).map(String));
    add(M_HQ, sqH(g.mother.hq[0] - g.ox, g.mother.hq[1] - g.oy), "hq", g.mother.hq);
    for (const b of g.split.hive) if (!D.has(String(b))) add(M_BAN, sqB(b[0] - g.ox, b[1] - g.oy), "banner", b);
    for (const h of input.others.hqs) add(OTHER, sqH(h[0] - g.ox, h[1] - g.oy), "other");
    for (const b of input.others.banners.concat(g.split.network)) add(OTHER, sqB(b[0] - g.ox, b[1] - g.oy), "other");
    for (const f of fences) { f.hq.reg = add(F0 + f.k, f.hq.r, "hq"); for (const a of f.anchors) a.reg = add(F0 + f.k, a.r, "anchor"); }
    for (const b of g.rebuilt || []) add(M_BAN, sqB(b[0] - g.ox, b[1] - g.oy), "banner", b);
    g.reg = reg;
    g.regOwner = new Int32Array(g.N).fill(-1);
    const before = g.own.slice();
    regPaint(g, [0, 0, g.W - 1, g.H - 1]);
    let diff = 0;
    for (let t = 0; t < g.N; t++) if (before[t] !== g.own[t]) diff++;
    if (diff && log) log("build-order ownership differs from the running grid on " + diff + " tile(s)");
  }

  function regPaint(g, r) {
    const { W, H } = g;
    for (let y = Math.max(0, r[1]); y <= Math.min(H - 1, r[3]); y++) for (let x = Math.max(0, r[0]); x <= Math.min(W - 1, r[2]); x++) {
      const t = y * W + x;
      let o = -1;
      for (let i = 0; i < g.reg.length; i++) { const e = g.reg[i]; if (e.alive && inR(e.r, x, y)) { o = i; break; } }
      g.regOwner[t] = o;
      g.own[t] = o < 0 ? U : g.reg[o].code;
    }
  }

  function snapG(g, fences) {
    return { own: g.own.slice(), occ: g.occ.slice(), extraAt: g.extraAt.slice(), regOwner: g.regOwner.slice(), alive: g.reg.map((e) => e.alive), n: g.reg.length, anchors: fences.map((f) => f.anchors) };
  }
  function restoreG(g, s, fences) {
    // copies: the same snapshot may be restored more than once
    g.own = s.own.slice(); g.occ = s.occ.slice(); g.extraAt = s.extraAt.slice(); g.regOwner = s.regOwner.slice();
    g.reg.length = s.n; g.reg.forEach((e, i) => { e.alive = s.alive[i]; });
    fences.forEach((f, i) => { if (i < s.anchors.length) f.anchors = s.anchors[i]; });
  }

  /* The hive destroys, one at a time, each standing banner that owns ground inside `rects` (outside
     its HQ's square, which never falls) and rebuilds it in place: the squares already standing take
     the freed ground first. Fails if a hive city, statue, node or banner tile ends up outside the
     hive's ground, or a banner's own tile falls to someone else. Extra cities that lose ground are
     dropped. */
  function cycleHive(g, rects) {
    const { W, H } = g;
    const hqR = sqH(g.mother.hq[0] - g.ox, g.mother.hq[1] - g.oy);
    const cycled = [], dropped = [], freed = [];
    const hiveOwn = (t) => g.own[t] === M_BAN || g.own[t] === M_HQ;
    for (let guard = 0; guard < 60; guard++) {
      let pick = -1;
      for (const r of rects) {
        for (let y = Math.max(0, r[1]); y <= Math.min(H - 1, r[3]) && pick < 0; y++) for (let x = Math.max(0, r[0]); x <= Math.min(W - 1, r[2]); x++) {
          if (inR(hqR, x, y)) continue;
          const o = g.regOwner[y * W + x];
          if (o >= 0 && g.reg[o].code === M_BAN) { pick = o; break; }
        }
        if (pick >= 0) break;
      }
      if (pick < 0) break;
      const e = g.reg[pick], at = e.at;
      e.alive = false;
      regPaint(g, e.r);
      const bt = g.idx(at[0], at[1]);
      if (bt < 0 || !(g.own[bt] === U || hiveOwn(bt))) return { ok: false, why: "the hive could not rebuild its banner " + at.join(",") + " (its tile went to another alliance)", bad: e.r };
      g.reg.push({ code: M_BAN, r: e.r, kind: "banner", at, alive: true });
      regPaint(g, e.r);
      cycled.push(at.slice());
      for (let y = Math.max(0, e.r[1]); y <= Math.min(H - 1, e.r[3]); y++) for (let x = Math.max(0, e.r[0]); x <= Math.min(W - 1, e.r[2]); x++) {
        const t = y * W + x;
        if (hiveOwn(t)) continue;
        if (g.prot[t]) return { ok: false, why: "the hive would lose " + (x + g.ox) + "," + (y + g.oy) + " when it rebuilds " + at.join(","), bad: e.r };
        freed.push(t);
        if (g.extraAt[t] >= 0) {
          const n = g.extraAt[t], c = g.mother.cities[n];
          dropped.push(n);
          for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const s = g.idx(c[0] + i, c[1] + j); if (s >= 0) { g.occ[s] = 0; g.extraAt[s] = -1; } }
        }
      }
    }
    return { ok: true, cycled, dropped, freed };
  }

  /* Every alliance whose ring a new HQ cut (the hive and the fences before k) must stay chained to
     its HQ (KSMapper's rule: each banner's square holds a cell linked, 8-adjacent, to the HQ's).
     Returns what broke, or null. */
  function chainBroken(g, fences, k) {
    const { W, H, N } = g;
    const groups = [{ name: g.mother.tag, codes: [M_HQ, M_BAN], hq: 0, members: g.reg.filter((e) => e.alive && e.code === M_BAN).map((e) => e.r) }]
      .concat(fences.filter((f) => f.k < k && f.hq.reg >= 0).map((f) => ({ name: "Fence " + f.k, codes: [F0 + f.k], hq: f.hq.reg, members: f.anchors.map((a) => a.r) })));
    for (const G of groups) {
      const seen = new Uint8Array(N), q = [];
      for (let t = 0; t < N; t++) if (g.regOwner[t] === G.hq) { seen[t] = 1; q.push(t); }
      while (q.length) {
        const t = q.pop(), x = t % W, y = (t / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const s = yy * W + xx;
          if (!seen[s] && G.codes.includes(g.own[s])) { seen[s] = 1; q.push(s); }
        }
      }
      for (const r of G.members) {
        let ok = false;
        for (let y = Math.max(0, r[1]); y <= Math.min(H - 1, r[3]) && !ok; y++) for (let x = Math.max(0, r[0]); x <= Math.min(W - 1, r[2]); x++) if (seen[y * W + x]) { ok = true; break; }
        if (!ok) return G.name + " would have a banner cut off from its HQ";
      }
    }
    return null;
  }

  /* Fence k's HQ at x,y (grid), built after the fences before it: their banners whose square touches
     its 3x3 come down first; the HQ goes up; the hive destroys and rebuilds in place each banner
     whose ground the HQ's square needs; every ring it cut must still chain to its HQ. On failure the
     grid is left as it was. */
  function placeHQ(g, k, fences, x, y) {
    const s = snapG(g, fences);
    const fail = (why) => { restoreG(g, s, fences); return { ok: false, why }; };
    const foot = [];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) foot.push([x + i, y + j]);
    if (foot.some(([a, b]) => a < 0 || b < 0 || a >= g.W || b >= g.H)) return fail("off the map window");
    const removed = [];
    for (const f of fences) {
      if (f.k >= k) continue;
      const out = f.anchors.filter((a) => foot.some(([a2, b2]) => inR(a.r, a2, b2)));
      if (!out.length) continue;
      f.anchors = f.anchors.filter((a) => !out.includes(a));
      for (const a of out) { g.reg[a.reg].alive = false; g.occ[a.p] = 0; regPaint(g, a.r); removed.push({ k: f.k, x: a.x, y: a.y }); }
    }
    for (const [a, b] of foot) { const t = b * g.W + a; if (g.own[t] !== U || g.occ[t] || g.hqBlock[t]) return fail("its 3x3 is not open ground"); }
    const r = sqH(x, y);
    for (let yy = Math.max(0, r[1]); yy <= Math.min(g.H - 1, r[3]); yy++) for (let xx = Math.max(0, r[0]); xx <= Math.min(g.W - 1, r[2]); xx++) { const t = yy * g.W + xx; if (g.built[t] && !g.hqSq(t)) return fail("its square holds a hive building"); }
    const hqReg = g.reg.length;
    g.reg.push({ code: F0 + k, r, kind: "hq", alive: true });
    regPaint(g, r);
    for (const [a, b] of foot) g.occ[b * g.W + a] = 1;
    const cyc = cycleHive(g, [r]);
    if (!cyc.ok) return fail(cyc.why);
    const cut = chainBroken(g, fences, k);
    if (cut) return fail(cut);
    return { ok: true, hqReg, removed, cycled: cyc.cycled, dropped: cyc.dropped, freed: cyc.freed, foot: foot.map(([a, b]) => b * g.W + a) };
  }

  /* Where fence k's HQ may go, best first: squares overlapping most of the HQ squares already up (the
     hive's and the fences' before k), so the HQ adds the least new ground. Its 3x3 on open ground (or
     on ground of an earlier fence's anchors, which come down), its square holding nothing the hive
     built outside the hive HQ's square. k = 1 overlaps the hive HQ only. */
  function hqCandidates(g, k, fences) {
    const { W, H } = g;
    const hiveR = sqH(g.mother.hq[0] - g.ox, g.mother.hq[1] - g.oy);
    const rects = [hiveR].concat(fences.filter((f) => f.k < k).map((f) => f.hq.r));
    const anchorTile = new Set();
    for (const f of fences) if (f.k < k) for (const a of f.anchors) anchorTile.add(a.p);
    const seen = new Set(), out = [];
    for (const R of rects) for (let y = Math.max(0, R[1] - 8); y <= Math.min(H - 3, R[3] + 6); y++) for (let x = Math.max(0, R[0] - 8); x <= Math.min(W - 3, R[2] + 6); x++) {
      const key = y * W + x;
      if (seen.has(key)) continue;
      seen.add(key);
      let ok = true;
      for (let j = 0; j < 3 && ok; j++) for (let i = 0; i < 3; i++) {
        const t = (y + j) * W + x + i, o = g.own[t];
        if (g.hqBlock[t] || !(o === U || (k > 1 && o > F0 && o - F0 < k)) || (g.occ[t] && !anchorTile.has(t))) { ok = false; break; }
      }
      if (!ok) continue;
      const r = sqH(x, y);
      if (r[0] < 0 || r[1] < 0 || r[2] >= W || r[3] >= H) continue;
      let ov = 0;
      for (let yy = r[1]; yy <= r[3] && ok; yy++) for (let xx = r[0]; xx <= r[2]; xx++) {
        const t = yy * W + xx;
        if (g.built[t] && !g.hqSq(t)) { ok = false; break; }
        if (rects.some((q) => inR(q, xx, yy))) ov++;
      }
      if (!ok || !ov) continue;
      const d = Math.max(Math.abs(x + 1 - (hiveR[0] + 7)), Math.abs(y + 1 - (hiveR[1] + 7)));
      out.push({ x, y, ov, d });
    }
    return out.sort((a, b) => b.ov - a.ov || a.d - b.d || a.y - b.y || a.x - b.x);
  }

  /* Ground open to the outside right after fence A's anchors, before the next fence's: open ground,
     and later fences' land not yet built (their HQs built first excepted), linked to the window's
     edge. A fence banner whose square gains any of it would push the fence outward: orange. */
  function outwardMask(g, own, A, early) {
    const { W, H, N } = g;
    const free = (t) => (own[t] === U || ownerOf(own[t]) > A) && !early.some((e) => e.k > A && inR(e.r, t % W, (t / W) | 0));
    const out = new Uint8Array(N), q = [];
    for (let t = 0; t < N; t++) { const x = t % W, y = (t / W) | 0; if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && free(t)) { out[t] = 1; q.push(t); } }
    while (q.length) { const t = q.pop(), x = t % W, y = (t / W) | 0; for (const s of [x + 1 < W ? t + 1 : -1, x > 0 ? t - 1 : -1, y + 1 < H ? t + W : -1, y > 0 ? t - W : -1]) if (s >= 0 && !out[s] && free(s)) { out[s] = 1; q.push(s); } }
    return out;
  }

  // ---------------------------------------------------------------- fillers (all alliances at once)
  /* Every free 2x2 in the band gets a banner or a building of whoever owns one of its tiles.
     Hive and inner-fence banners may only expand onto land a later fence owns (orange: built after
     that fence's anchors); the outer fence's may expand outward (orange: built last). */
  function solveFillers(g, highs, opts, fences) {
    const { W, H } = g;
    const n = fences.length;
    const wins = bandWindows(g);
    const winAt = new Map();
    wins.forEach((w, q) => { for (const t of winTiles(g, w)) { let a = winAt.get(t); if (!a) winAt.set(t, a = []); a.push(q); } });
    const cands = [];
    // a fence banner may stand on open ground if its square touches its alliance's territory (it
    // claims the tile, so it is orange); fence fillers that expand wait for the next fence's
    // anchors (the last fence's come last); the hive never expands
    // open ground that reaches the outside: only the last fence may claim it (the hive and the
    // inner fences claim only ground the next fence already shuts in)
    const outside = new Uint8Array(g.N), oq = [];
    for (let t = 0; t < g.N; t++) { const x = t % W, y = (t / W) | 0; if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && g.own[t] === U) { outside[t] = 1; oq.push(t); } }
    while (oq.length) { const t = oq.pop(), x = t % W, y = (t / W) | 0; for (const s of [x + 1 < W ? t + 1 : -1, x > 0 ? t - 1 : -1, y + 1 < H ? t + W : -1, y > 0 ? t - W : -1]) if (s >= 0 && !outside[s] && g.own[s] === U) { outside[s] = 1; oq.push(s); } }
    const touchesOwn = (x, y, code) => { for (let yy = y - 4; yy <= y + 4; yy++) for (let xx = x - 4; xx <= x + 4; xx++) { const i = g.idx(xx + g.ox, yy + g.oy); if (i >= 0 && g.own[i] === code) return true; } return false; };
    const earlyHQ = fences.filter((f) => f.early).map((f) => ({ k: f.k, r: f.hq.r }));
    const outA = [null];
    for (let A = 1; A <= n; A++) outA.push(outwardMask(g, g.own, A, earlyHQ));
    for (const t of winAt.keys()) {
      if (g.allyBlock[t] || g.occ[t]) continue;
      const owners = [];
      if (g.own[t] === U) { for (let f = n; f >= 1; f--) if (touchesOwn(t % W, (t / W) | 0, F0 + f)) owners.push(f); }
      else if (ownerOf(g.own[t]) >= 0) owners.push(ownerOf(g.own[t]));
      for (const A of owners) {
      const x = t % W, y = (t / W) | 0;
      let gain = false, later = 0, inHq = A > 0 && inR(fences[A - 1].hq.r, x, y), leaks = false, out = false;
      for (let yy = y - 3; yy <= y + 3; yy++) for (let xx = x - 3; xx <= x + 3; xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) { gain = true; leaks = true; out = true; continue; }
        const s = yy * W + xx, o = g.own[s];
        if (o === U && !g.cityBlock[s]) gain = true;
        if (A > 0 && outA[A][s] && !g.cityBlock[s]) out = true;
        if (outside[s]) leaks = true;
        const B = ownerOf(o);
        if (B > Math.max(A, 1)) later = Math.max(later, B);
        if (inHq && !inR(fences[A - 1].hq.r, xx, yy)) inHq = false;
      }
      if (g.own[t] === U) gain = true;
      if (A > 0 && outA[A][t]) out = true;
      if (leaks && A < n) continue;
      // a hive banner may claim open ground too (rebuilt round the cities, it plugs what is left);
      // a fence banner is orange only if it would push the fence outward (ground it gains in a
      // pocket already shut in leaves it yellow)
      const phase = A === 0 ? (gain ? 1 : Math.max(later, 1)) : out ? Math.max(A + 1, later) : Math.max(later, A);
      // fence A's fillers go up after fence A+1's anchors: none may claim the 3x3 of a later HQ, or
      // ground a later cycle of the hive frees for a later fence, before that fence is up
      if (A >= 1 && (g.later || []).some((L) => L.k >= A + 2 && hitsMask(g, sqB(x, y), L.mask))) continue;
      cands.push({ kind: "banner", owner: A, tiles: [t], x, y, w: 1, phase, orange: phase > Math.max(A, 1), grey: inHq && phase === A });
      }
    }
    // the hive may also plug its spaces with statues (up to 3 in all, counting those it has);
    // each fence: up to 3 statues and its 2 traps, never a gathering node (max: per fence)
    const types = [{ type: "statue", w: 2, max: 3, hive: true, hiveMax: 3 }, { type: "node", w: 3, max: 0, hive: true, hiveMax: 1 }, { type: "trap", w: 3, max: 2, hive: false }];
    const hiveHas = { statue: 0, node: 0 };
    for (const b of g.mother.buildings || []) hiveHas[b.type || (b.w === 3 ? "node" : "statue")]++;
    const hiveMax = (T) => T.hiveMax || T.max;
    const hiveNeed = 0;
    for (const T of types) for (let y = 0; y + T.w <= H; y++) for (let x = 0; x + T.w <= W; x++) {
      const t0 = y * W + x, A = ownerOf(g.own[t0]);
      if (A < 0 || (A === 0 && (!T.hive || hiveHas[T.type] >= hiveMax(T)))) continue;
      if (A > 0 && !T.max) continue;
      const mandatory = A === 0 && T.type === "statue";
      const tiles = [], extras = new Set();
      let ok = true, hits = false;
      for (let j = 0; j < T.w && ok; j++) for (let i = 0; i < T.w; i++) {
        const s = t0 + j * W + i;
        // a hive statue may take an extra city's spot (the city is dropped)
        const extra = mandatory && g.extraAt[s] >= 0;
        if (ownerOf(g.own[s]) !== A || (g.occ[s] && !extra) || g.allyBlock[s]) { ok = false; break; }
        if (extra) extras.add(g.extraAt[s]);
        if (winAt.has(s)) hits = true;
        tiles.push(s);
      }
      if (ok && (hits || mandatory)) cands.push({ kind: T.type, owner: A, tiles, x, y, w: T.w, phase: Math.max(A, 1), extras: [...extras] });
    }
    // an extra city slot instead of a hive banner, never instead of a fence's, and only up to
    // MAX_EXTRA_SECS of march from its nearest trap; farther the hive uses a statue or a banner
    const trapsL = g.mother.traps.map((t) => [t[0] - g.ox + 1.5, t[1] - g.oy + 1.5]);
    const secs = (x, y) => Math.round(2.5 * Math.min(...trapsL.map((c) => Math.hypot(x + 1 - c[0], y + 1 - c[1]))) + 4);
    for (let y = 0; y + 2 <= H; y++) for (let x = 0; x + 2 <= W; x++) {
      const t0 = y * W + x, tiles = [t0, t0 + 1, t0 + W, t0 + W + 1];
      if (!winAt.has(t0) || !tiles.every((t) => ownerOf(g.own[t]) === 0 && !g.occ[t] && !g.cityBlock[t])) continue;
      if (secs(x, y) > MAX_EXTRA_SECS) continue;
      cands.push({ kind: "city", owner: 0, tiles, x, y, w: 2, phase: 1 });
    }
    // the hive: an extra city first, then a statue (they are few), then a banner
    const cost = (c) => (c.kind === "banner" ? (c.owner === 0 ? HIVE_BANNER : 1) + (c.orange && c.owner < n ? 0.003 : 0) : c.kind === "city" ? 1.0005
      : (c.owner === 0 && c.kind === "statue" ? 1.001 : 0.001) + 0.5 * (c.extras ? c.extras.length : 0));
    const L = ["Minimize", null, "Subject To"];
    let r = 0;
    const byWin = wins.map(() => []);
    const byTile = new Map();
    cands.forEach((c, j) => {
      const seen = new Set();
      for (const t of c.tiles) {
        for (const q of winAt.get(t) || []) if (!seen.has(q)) { seen.add(q); byWin[q].push(j); }
        let a = byTile.get(t); if (!a) byTile.set(t, a = []); a.push(j);
      }
    });
    const holes = [];
    // coverage is soft (slack s_q at a high price) so a window only limited buildings could plug
    // never makes the model infeasible: it comes back as a hole for the repair step
    const slack = [];
    byWin.forEach((a, q) => { if (a.length) { slack.push(q); L.push(" w" + (r++) + ": " + a.map((j) => "v" + j).join(" + ") + " + s" + q + " >= 1"); } else holes.push(wins[q]); });
    for (const a of byTile.values()) if (a.length > 1 && a.some((j) => cands[j].kind !== "banner")) L.push(" t" + (r++) + ": " + a.map((j) => "v" + j).join(" + ") + " <= 1");
    // every inner layer is shut in. Layers: hive 0, fence k, the outside n + 1. Open ground that
    // touches layer j and is open to the outside must fall in a square of a later layer (soft, like
    // the 2x2s). Layers may otherwise meet (no ring rule): only closure and the 2x2s count.
    const nbs = (t) => { const x = t % W, y = (t / W) | 0; return [x + 1 < W ? t + 1 : -1, x > 0 ? t - 1 : -1, y + 1 < H ? t + W : -1, y > 0 ? t - W : -1].filter((q) => q >= 0); };
    const covers = (c, t) => c.kind === "banner" && Math.abs(c.x - t % W) <= 3 && Math.abs(c.y - ((t / W) | 0)) <= 3;
    const seal = [];
    for (let t = 0; t < g.N; t++) {
      if (g.own[t] !== U) continue;
      let lo = 99, hi = -1;
      for (const q of nbs(t)) { const l = ownerOf(g.own[q]); if (l >= 0) { lo = Math.min(lo, l); hi = Math.max(hi, l); } }
      if (!outside[t] || lo >= n) continue;   // the last fence may meet the outside
      hi = n + 1;
      {
        const js = [];
        cands.forEach((c, j) => { if (c.owner > lo && c.owner < hi && covers(c, t)) js.push(j); });
        seal.push(t);
        L.push(" z" + (r++) + ": " + (js.length ? js.map((j) => "v" + j).join(" + ") + " + " : "") + "z" + t + " >= 1");
      }
    }
    for (let A = 0; A <= n; A++) for (const T of types) {
      const js = cands.map((c, j) => (c.owner === A && c.kind === T.type ? j : -1)).filter((j) => j >= 0);
      const max = Math.max(0, A === 0 ? hiveMax(T) - (hiveHas[T.type] || 0) : T.max);
      if (js.length > max) L.push(" k" + (r++) + ": " + js.map((j) => "v" + j).join(" + ") + " <= " + max);
      if (A === 0 && T.type === "statue" && hiveNeed) { slack.push("st"); L.push(" k" + (r++) + ": " + (js.length ? js.map((j) => "v" + j).join(" + ") + " + " : "") + "sst >= " + hiveNeed); }
    }
    // tie-breakers that never cost a banner: banners that touch (corners count: two banners touch
    // when they share a 2x2 block) and, slightly, banners far from the cities
    const fixed = new Uint8Array(g.N);
    for (const b of g.hiveB) if (b.i >= 0) fixed[b.i] = 1;
    for (const f of fences) { for (const a of f.anchors) fixed[a.p] = 1; for (const b of f.pre || []) fixed[b.p] = 1; }
    const banAt = new Map();
    cands.forEach((c, j) => { if (c.kind === "banner") { let a = banAt.get(c.tiles[0]); if (!a) banAt.set(c.tiles[0], a = []); a.push(j); } });
    const crowd = [];
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const b = y * W + x, ts = [b, b + 1, b + W, b + W + 1];
      const vs = [].concat(...ts.map((t) => banAt.get(t) || []));
      const f = ts.reduce((a, t) => a + fixed[t], 0);
      if (!vs.length || vs.length + f < 2 || opts.noTies) continue;
      crowd.push(b);
      L.push(" b" + (r++) + ": " + vs.map((j) => "v" + j).join(" + ") + " - e" + b + " <= " + (1 - f));
    }
    // the last fence: as much new ground as its banners can claim (the wall reaches farther); a
    // tile weighs a little more than a pair of touching banners, far less than a banner
    const areaVars = [];
    if (n > 0 && !opts.noTies) {
      const claimBy = new Map();
      cands.forEach((c, j) => {
        if (c.kind !== "banner" || c.owner !== n) return;
        const x = c.tiles[0] % W, y = (c.tiles[0] / W) | 0;
        for (let yy = Math.max(0, y - 3); yy <= Math.min(H - 1, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(W - 1, x + 3); xx++) {
          const t = yy * W + xx;
          if (g.own[t] !== U || g.cityBlock[t]) continue;
          let a = claimBy.get(t); if (!a) claimBy.set(t, a = []); a.push(j);
        }
      });
      // the inner fences' fillers go up before the last fence's: ground they claim is not the last
      // fence's (so they leave it what they can)
      const preBy = new Map();
      cands.forEach((c, j) => {
        if (c.kind !== "banner" || c.owner < 1 || c.owner >= n) return;
        const x = c.tiles[0] % W, y = (c.tiles[0] / W) | 0;
        for (let yy = Math.max(0, y - 3); yy <= Math.min(H - 1, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(W - 1, x + 3); xx++) {
          const t = yy * W + xx;
          if (!claimBy.has(t)) continue;
          let a = preBy.get(t); if (!a) preBy.set(t, a = []); a.push(j);
        }
      });
      for (const [t, js] of claimBy) {
        areaVars.push(t);
        L.push(" a" + (r++) + ": g" + t + " - " + js.map((j) => "v" + j).join(" - ") + " <= 0");
        for (const j of preBy.get(t) || []) L.push(" a" + (r++) + ": g" + t + " + v" + j + " <= 1");
      }
    }
    // nearer the cities, but the last fence's fillers farther out
    const near = (c) => (c.kind !== "banner" ? 0 : (c.owner === n ? -1 : 1) * 0.00001 * Math.min(g.d[c.tiles[0]], 30));
    L[1] = " obj: " + cands.map((c, j) => (cost(c) + near(c)).toFixed(5) + " v" + j).concat(slack.map((q) => "30 s" + q), crowd.map((b) => "0.0004 e" + b), seal.map((t) => "30 z" + t)).join(" + ")
      + areaVars.map((t) => " - " + LAST_AREA + " g" + t).join("");
    L.push("Bounds");
    for (const q of slack) L.push(" 0 <= s" + q + " <= " + (q === "st" ? hiveNeed : 1));
    for (const b of crowd) L.push(" e" + b + " >= 0");
    for (const t of seal) L.push(" 0 <= z" + t + " <= 1");
    for (const t of areaVars) L.push(" 0 <= g" + t + " <= 1");
    L.push("Binary", " " + cands.map((c, j) => "v" + j).join(" "), "End");
    const sol = solveLP(highs, L, opts.fillTimeLimit || 90);
    if (!okStatus(sol)) throw new Error("The filler solver failed (" + (sol && sol.Status) + ").");
    const chosenIdx = cands.map((c, j) => j).filter((j) => { const v = sol.Columns["v" + j]; return v && v.Primal > 0.5; });
    const chosen = chosenIdx.map((j) => cands[j]);
    let statuesMissing = 0;
    for (const q of slack) { const v = sol.Columns["s" + q]; if (!v || v.Primal < 0.5) continue; if (q === "st") statuesMissing = Math.round(v.Primal); else holes.push(wins[q]); }
    const dropped = [];
    for (const c of chosen) for (const n of c.extras || []) dropped.push(n);
    return { chosen, chosenIdx, cands, wins, holes, windows: wins.length, optimal: sol.Status === "Optimal", statuesMissing, dropped };
  }

  /* Second pass, the count unchanged: a filler moves one tile at a time to a spot that still plugs
     every 2x2 only it plugs, is built no later (an orange may become yellow), and touches fewer banners (corners
     count) or, as many, lies nearer the cities. Spaced banners leave cities less room to slip. */
  function spaceFillers(g, fences, F) {
    const { W, H } = g, { cands, wins } = F;
    const sel = new Set(F.chosenIdx);
    const ban = new Uint8Array(g.N), taken = new Uint8Array(g.N);
    for (const b of g.hiveB) if (b.i >= 0) ban[b.i] = 1;
    for (const f of fences) { for (const a of f.anchors) ban[a.p] = 1; for (const b of f.pre || []) ban[b.p] = 1; }
    for (const j of sel) for (const t of cands[j].tiles) { taken[t] = 1; if (cands[j].kind === "banner") ban[t] = 1; }
    const winIdx = new Map(wins.map((w, q) => [w, q]));
    const winsOf = (t) => [t, t - 1, t - W, t - W - 1].map((w) => winIdx.get(w)).filter((q) => q !== undefined);
    const cov = new Int32Array(wins.length);
    for (const j of sel) { const seen = new Set(); for (const t of cands[j].tiles) for (const q of winsOf(t)) if (!seen.has(q)) { seen.add(q); cov[q]++; } }
    const byTile = new Map();
    cands.forEach((c, j) => { if (c.kind === "banner") { let a = byTile.get(c.tiles[0]); if (!a) byTile.set(c.tiles[0], a = []); a.push(j); } });
    const touch = (t, self) => {
      const x = t % W, y = (t / W) | 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const s = yy * W + xx;
        if (s !== self && ban[s]) n++;
      }
      return n;
    };
    // fewest banners touching; then nearer the cities, but the last fence's fillers farther out
    // and claiming as much new ground as they can (a tile weighs a little more than a touching banner)
    const n = fences.length;
    const pre = new Uint8Array(g.N);   // ground the inner fences' fillers claim first
    const open = (t) => g.own[t] === U && !g.cityBlock[t] && !pre[t];
    const claim = new Int32Array(g.N);   // the last fence's chosen banners covering each open tile
    const sqTiles = (t, fn) => { const x = t % W, y = (t / W) | 0; for (let yy = Math.max(0, y - 3); yy <= Math.min(H - 1, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(W - 1, x + 3); xx++) fn(yy * W + xx); };
    for (const j of sel) if (cands[j].kind === "banner" && cands[j].owner >= 1 && cands[j].owner < n) sqTiles(cands[j].tiles[0], (q) => { pre[q] = 1; });
    for (const j of sel) if (cands[j].kind === "banner" && cands[j].owner === n) sqTiles(cands[j].tiles[0], (q) => { if (open(q)) claim[q]++; });
    // ground claimed if the banner stood on s instead of t
    const areaAt = (s, t) => { let a = 0; sqTiles(s, (q) => { if (open(q) && claim[q] - (Math.abs((q % W) - (t % W)) <= 3 && Math.abs(((q / W) | 0) - ((t / W) | 0)) <= 3 ? 1 : 0) === 0) a++; }); return a; };
    const score = (t, self, c) => 1000 * touch(t, self) + (c.owner === n ? -1250 * areaAt(t, self) - g.d[t] : g.d[t]);
    let moved = 0;
    for (let pass = 0; pass < 8; pass++) {
      let any = false;
      for (const j of [...sel]) {
        const c = cands[j];
        if (c.kind !== "banner") continue;
        const t = c.tiles[0], x = t % W, y = (t / W) | 0;
        const mine = winsOf(t).filter((q) => cov[q] === 1).map((q) => winTiles(g, wins[q]));
        let best = -1, bestS = score(t, t, c);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const s = yy * W + xx;
          if (taken[s] || g.occ[s] || !mine.every((w) => w.includes(s))) continue;
          const sc = score(s, t, c);
          if (sc >= bestS) continue;
          // an orange may become yellow, never the reverse (but in the last fence, whose oranges come last)
          for (const k of byTile.get(s) || []) { const d = cands[k]; if (d.owner === c.owner && (c.owner === n || (d.phase <= c.phase && (!d.orange || c.orange)))) { best = k; bestS = sc; break; } }
        }
        if (best < 0) continue;
        const s = cands[best].tiles[0];
        for (const q of winsOf(t)) cov[q]--;
        for (const q of winsOf(s)) cov[q]++;
        if (c.owner === n) { sqTiles(t, (q) => { if (open(q)) claim[q]--; }); sqTiles(s, (q) => { if (open(q)) claim[q]++; }); }
        taken[t] = ban[t] = 0; taken[s] = ban[s] = 1;
        sel.delete(j); sel.add(best);
        moved++; any = true;
      }
      if (!any) break;
    }
    F.chosenIdx = [...sel];
    F.chosen = F.chosenIdx.map((j) => cands[j]);
    return moved;
  }

  /* A window nothing can plug (open land out of reach, or hive land whose fillers would expand):
     one more banner of the outer fence claims the ground around it. It is a filler, not an anchor
     (it fixes no border): orange, built first among the last fillers. */
  function repairHoles(g, fences, holes) {
    const { W, H } = g;
    const n = fences.length, Fn = fences[n - 1], code = F0 + n;
    let added = 0;
    for (const h of holes) {
      let best = null;
      for (const q of winTiles(g, h)) {
        if (g.occ[q] || (g.allyBlock[q] && g.own[q] !== U)) continue;
        const qx = q % W, qy = (q / W) | 0;
        // ground to claim: the window's open tiles if q is open; else the open land q's filler
        // square would gain (hive and inner fences may not expand)
        const target = [];
        if (g.own[q] === U) { for (const s of winTiles(g, h)) if (g.own[s] === U) target.push(s); }
        else if (ownerOf(g.own[q]) !== n) {
          for (let yy = Math.max(0, qy - 3); yy <= Math.min(H - 1, qy + 3); yy++) for (let xx = Math.max(0, qx - 3); xx <= Math.min(W - 1, qx + 3); xx++) { const s = yy * W + xx; if (g.own[s] === U && !g.cityBlock[s]) target.push(s); }
        }
        if (!target.length) continue;
        let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
        for (const s of target) { const xx = s % W, yy = (s / W) | 0; gx0 = Math.min(gx0, xx); gy0 = Math.min(gy0, yy); gx1 = Math.max(gx1, xx); gy1 = Math.max(gy1, yy); }
        if (gx1 - gx0 > 6 || gy1 - gy0 > 6) continue;
        for (let py = gy1 - 3; py <= gy0 + 3; py++) for (let px = gx1 - 3; px <= gx0 + 3; px++) {
          if (px < 3 || py < 3 || px >= W - 3 || py >= H - 3) continue;
          const p = py * W + px;
          if (g.own[p] !== U || g.allyBlock[p] || g.occ[p]) continue;
          const r = sqB(px, py);
          let near = false;
          for (let yy = Math.max(0, r[1] - 1); yy <= Math.min(H - 1, r[3] + 1) && !near; yy++) for (let xx = Math.max(0, r[0] - 1); xx <= Math.min(W - 1, r[2] + 1); xx++) if (g.own[yy * W + xx] === code) { near = true; break; }
          if (!near) continue;
          let cost = 0, ok = true;
          for (let yy = r[1]; yy <= r[3] && ok; yy++) for (let xx = r[0]; xx <= r[2]; xx++) {
            const s = yy * W + xx;
            if (g.prot[s] || g.extraAt[s] >= 0) { ok = false; break; }
            if (g.own[s] === U && !g.cityBlock[s]) cost++;
          }
          if (ok && (!best || cost < best.cost)) best = { cost, p, x: px, y: py, r };
        }
      }
      if (!best) continue;
      for (let yy = best.r[1]; yy <= best.r[3]; yy++) for (let xx = best.r[0]; xx <= best.r[2]; xx++) {
        const s = yy * W + xx, o = g.own[s];
        if (o === U) g.own[s] = code;   // built late: it can't take hive ground any more
      }
      g.occ[best.p] = 1;
      (Fn.pre = Fn.pre || []).push({ p: best.p, x: best.x, y: best.y, r: best.r });
      added++;
    }
    return added;
  }

  /* Where each hive city's banner goes when its player is away: one of its 4 tiles or a free tile
     right beside it, chosen so that with any set of cities empty and a banner on each empty one's
     spot, no free 2x2 opens. A city that one banner can't seal gets two (flagged). Exact ILP. */
  function cityCorners(g, highs, fill, dropped) {
    const { W, H } = g;
    const occ = g.occ.slice();
    for (const c of fill.chosen) for (const t of c.tiles) occ[t] = 1;
    const cities = [];
    g.mother.cities.forEach((c, n) => { if (!dropped.has(n)) cities.push({ x: c[0], y: c[1] }); });
    for (const c of fill.chosen) if (c.kind === "city") cities.push({ x: c.x + g.ox, y: c.y + g.oy });
    const cityOf = new Map();
    cities.forEach((c, n) => { for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const t = g.idx(c.x + i, c.y + j); if (t >= 0) { cityOf.set(t, n); occ[t] = 0; } } });
    const free = (t) => !occ[t] && !g.cityBlock[t] && g.own[t] !== OTHER;
    // a city's banner goes on one of its own tiles or on a free tile right beside it (a 1-tile gap
    // next to a city needs it there). A 2x2 that opens when the cities in it are empty only counts
    // the spots of those cities: a neighbour's spot holds a banner only while that one is empty too
    const spots = cities.map((c) => {
      const own = [], side = [];
      for (let j = -1; j <= 2; j++) for (let i = -1; i <= 2; i++) {
        const t = g.idx(c.x + i, c.y + j);
        if (t < 0) continue;
        if (i >= 0 && i <= 1 && j >= 0 && j <= 1) own.push(t);
        else if (free(t) && !cityOf.has(t) && ownerOf(g.own[t]) >= 0) side.push(t);   // the hive's or a fence's ground (its banner)
      }
      return { own, side };
    });
    const L = ["Minimize", null, "Subject To"];
    const vars = new Map();   // name -> [city, tile]
    const vn = (n, t) => { const k = "z" + n + "_" + t; if (!vars.has(k)) vars.set(k, [n, t]); return k; };
    let r = 0;
    const slack = [];
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const w = winTiles(g, y * W + x);
      if (!w.every(free) || !w.some((t) => cityOf.has(t))) continue;
      const inW = new Set(w.filter((t) => cityOf.has(t)).map((t) => cityOf.get(t)));
      const vs = [];
      for (const n of inW) for (const t of w) if (spots[n].own.includes(t) || spots[n].side.includes(t)) vs.push(vn(n, t));
      slack.push(r);
      L.push(" w" + r + ": " + [...new Set(vs)].join(" + ") + " + q" + r + " >= 1"); r++;
    }
    cities.forEach((c, n) => { L.push(" c" + n + ": " + spots[n].own.map((t) => vn(n, t)).join(" + ") + (spots[n].side.length ? " + " + spots[n].side.map((t) => vn(n, t)).join(" + ") : "") + " >= 1"); });
    // fewest banners per city; then its own tiles before the gap beside it; then nearest the HQ
    const hx = g.mother.hq[0] + 1.5 - g.ox, hy = g.mother.hq[1] + 1.5 - g.oy;
    const names = [...vars.keys()];
    L[1] = " obj: " + names.map((k) => { const [n, t] = vars.get(k); return (1 + (spots[n].own.includes(t) ? 0 : 0.01) + 0.0001 * Math.hypot(t % W + 0.5 - hx, ((t / W) | 0) + 0.5 - hy)).toFixed(6) + " " + k; }).concat(slack.map((q) => "100 q" + q)).join(" + ");
    L.push("Bounds");
    for (const q of slack) L.push(" 0 <= q" + q + " <= 1");
    L.push("Binary", " " + names.join(" "), "End");
    const sol = highs.solve(L.join("\n"), { time_limit: 30, mip_rel_gap: 0, output_flag: false });
    if (!okStatus(sol)) return null;
    const out = cities.map((c) => ({ x: c.x, y: c.y, banners: [] }));
    for (const k of names) { const col = sol.Columns[k]; if (!col || col.Primal < 0.5) continue; const [n, t] = vars.get(k); out[n].banners.push([t % W + g.ox, ((t / W) | 0) + g.oy, ownerOf(g.own[t])]); }
    let open = 0;
    for (const q of slack) { const col = sol.Columns["q" + q]; if (col && col.Primal > 0.5) open++; }
    return { cities: out, open };
  }

  // ---------------------------------------------------------------- driver
  /* input: { mother, others } (fromCsv / fromDesign). opts: { layers, tags[], cap, timeLimit,
     fillTimeLimit, log }. Returns a plan in game coordinates. */
  /* HQs a later fence could build before fence 1's anchors (as WL2 in Ffs): its square spans fence
     1's band and the next one, saving anchors in both. Ranked by the band tiles it covers. */
  function earlyCands(g) {
    const { W, H } = g, out = [];
    for (let y = 6; y < H - 8; y++) for (let x = 6; x < W - 8; x++) {
      let ok = true, dmin = 999;
      for (let j = 0; j < 3 && ok; j++) for (let i = 0; i < 3; i++) { const t = (y + j) * W + x + i; if (g.own[t] !== U || g.hqBlock[t] || g.occ[t]) { ok = false; break; } dmin = Math.min(dmin, g.d[t]); }
      if (!ok || dmin < 5 || dmin > 9) continue;
      let score = 0;
      for (let yy = y - 6; yy <= y + 8; yy++) for (let xx = x - 6; xx <= x + 8; xx++) { const t = yy * W + xx; if (g.own[t] !== U || g.cityBlock[t]) continue; const d = g.d[t]; score += d >= 1 && d <= 12 ? 1 : -0.5; }
      out.push({ x, y, score });
    }
    out.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of out) { if (picked.length >= 6) break; if (!picked.some((q) => Math.max(Math.abs(q.x - c.x), Math.abs(q.y - c.y)) < 5)) picked.push(c); }
    return picked.map((c) => [c.x + g.ox, c.y + g.oy]);
  }

  /* Fences round the hive. Each fence's HQ goes where its square overlaps most of the HQ squares
     already up (placeHQ); the anchors around it are an exact ILP that counts anchors, not the fillers
     they will need, so several anchor layouts (opts.layouts, 16 by default: seeded tie-breaks, the
     same on any machine) are designed end to end; the iterations (removals only) then start from the
     two best, and the plan with the fewest banners is kept (rule errors and open spaces first). */
  /* The design search runs as a generator: it yields batches of independent end-to-end runs (each
     an options object for designOnce) and gets their plans back (null where a run failed). design()
     runs them one after the other; designAsync() hands each batch to an evaluator, e.g. a pool of
     workers. The batches and their order are the same either way, so both give the same plan. */
  function* designSteps(world, input, opts, highs, onProgress) {
    // banners spent: fences, hive fillers and the hive's net change of banners in the rebuild
    const total = (p) => p.fences.reduce((a, f) => a + f.banners, 0) + p.hive.banners.length + p.rebuild.length - (p.destroy || []).length;
    // the plan kept: fewest banners, a hive banner counting HIVE_BANNER (the fences should pay)
    const score = (p) => p.fences.reduce((a, f) => a + f.banners, 0) + HIVE_BANNER * (p.hive.banners.length + p.rebuild.length - (p.destroy || []).length);
    const worse = (a, b) => a.errors.length - b.errors.length || a.holes.length - b.holes.length || score(a) - score(b);
    const prog = (stage, frac) => { if (onProgress) onProgress({ stage, frac }); };
    const n = Math.max(1, opts.layouts || 16);
    prog("layouts", 0);
    const plans = yield Array.from({ length: n }, (_, i) => Object.assign({}, opts, { noise: i || undefined }));
    const tried = plans.map((p, i) => (p ? { plan: p, seed: i } : null)).filter(Boolean).sort((a, b) => worse(a.plan, b.plan));
    if (!tried.length) throw new Error("Every anchor layout failed (see the log).");
    let best = tried[0].plan;
    const layoutNote = n + " anchor layout(s) designed end to end: " + tried.map((t) => total(t.plan) + (t.plan.errors.length ? "E" : "")).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join(", ") + " banners" + (plans.length - tried.length ? " (" + (plans.length - tried.length) + " failed)" : "") + ".";
    const pruneNotes = [];
    if (opts.prune !== false) {
      for (const t of tried.slice(0, 2)) {
        if (t.plan.errors.length) continue;
        const before = total(t.plan);
        const pr = yield* pruneSteps(world, input, opts, highs, t.plan, score, onProgress);
        pruneNotes.push("from " + before + ": " + pr.runs + " removal(s) tried, " + pr.kept + " kept (" + total(pr.plan) + ")");
        if (worse(pr.plan, best) < 0) best = pr.plan;
      }
    }
    if (pruneNotes.length) best.notes.unshift("Iterations (anchor removals) " + pruneNotes.join("; ") + ".");
    best.notes.unshift(layoutNote + " Kept: " + total(best) + " banners.");
    prog("done", 1);
    return best;
  }

  const runOne = (world, input, highs, o) => { try { return designOnce(world, input, o, highs, null); } catch (e) { if (o.log) o.log("run failed: " + e.message); return null; } };

  /* Every layer given whole (HQ and anchors): nothing for the layouts or the iterations to vary. */
  const allFixed = (opts) => { const n = opts.layers || 1; if (!opts.fixLayer) return false; for (let k = 1; k <= n; k++) if (!opts.fixLayer[k]) return false; return true; };

  function design(world, input, opts, highs, onProgress) {
    if (opts.hqs || opts.outerHQ === true || opts.hqSearch === false || allFixed(opts)) return designOnce(world, input, opts, highs, onProgress);
    const gen = designSteps(world, input, opts, highs, onProgress);
    let r = gen.next();
    while (!r.done) r = gen.next(r.value.map((o) => runOne(world, input, highs, o)));
    return r.value;
  }

  /* evaluate(list of options) -> Promise of plans (null for a failed run), in the same order. */
  async function designAsync(world, input, opts, highs, onProgress, evaluate) {
    if (opts.hqs || opts.outerHQ === true || opts.hqSearch === false || allFixed(opts)) return designOnce(world, input, opts, highs, onProgress);
    const gen = designSteps(world, input, opts, highs, onProgress);
    let r = gen.next();
    while (!r.done) r = gen.next(await evaluate(r.value));
    return r.value;
  }

  /* Iterations after the anchor layouts. Moves: take an anchor out (1-tile shifts were dropped: they
     never saved a banner in the tests). Each move is designed again end to end with the fences up
     to the moved anchor's fixed (connectors added only where a link breaks) and the later ones
     designed afresh, the fillers without their fine tie-breaks (same counts, about 3 times
     faster); its gain is kept per move. Each round prices every move not yet priced (one batch:
     they are independent) and takes the one that saves most; moves far from it keep their gain
     (priced again before they are taken), those near it or in later fences are priced again. The
     final plan is designed once in full. Counts of runs, not a clock, bound the work (40 at most,
     and it stops after 15 in a row that saved nothing), so every machine gives the same plan. A generator: it yields batches of runs (see designSteps). */
  function* pruneSteps(world, input, opts, highs, best, score, onProgress) {
    const maxEvals = opts.pruneEvals || 40, maxIdle = opts.pruneIdle || 15, maxTiles = opts.pruneTiles || 12, D = 16;
    let lastGain = 0;   // stop after maxIdle runs in a row that saved nothing
    const n = best.fences.length;
    const key = (a) => a[0] + "," + a[1];
    const fixOf = (fences, k) => { const o = {}; for (const f of fences) if (f.k <= k) o[f.k] = { hq: f.hq, anchors: f.anchorsBuilt || f.anchors }; return o; };
    const quick = Object.assign({}, opts, { noTies: true });
    const job = (fences, k, o) => Object.assign({}, o, { hqs: best.hqsGiven || undefined, fixLayer: fixOf(fences, k) });
    let evals = 0, kept = 0, ver = 0;
    const tick = () => { if (onProgress) onProgress({ stage: "prune", frac: Math.min(1, evals / maxEvals) }); };
    // the plan priced the way the moves are
    tick();
    let P = (yield [job(best.fences, n, quick)])[0]; evals++;
    if (!P || P.errors.length) return { plan: best, runs: evals, kept };
    const snap = (plan) => { const probe = {}; simulate(world, input, plan, probe); const out = []; for (let y = plan.oy; y < plan.oy + plan.H; y++) for (let x = plan.ox; x < plan.ox + plan.W; x++) out.push(probe.tagAt(x, y)); return out; };
    const withAnchors = (k, anchors, gone) => P.fences.map((f) => (f.k === k ? Object.assign({}, f, { anchors, anchorsBuilt: (f.anchorsBuilt || f.anchors).filter((b) => key(b) !== gone) }) : f));
    const movesOf = () => {
      const base = snap(P), out = [];
      for (const f of P.fences) for (const a of f.anchors) {
        // a removal that changes much of the final ground would break the fence: not tried
        const rest = f.anchors.filter((b) => key(b) !== key(a));
        const sn = snap(Object.assign({}, P, { fences: withAnchors(f.k, rest, key(a)) }));
        let diff = 0;
        for (let i = 0; i < sn.length; i++) if (sn[i] !== base[i]) diff++;
        if (diff <= maxTiles) out.push({ id: f.k + ":" + key(a) + ">-", k: f.k, at: a, anchors: rest, gone: key(a), rank: diff });
      }
      return out.sort((u, v) => u.rank - v.rank);
    };
    const cache = new Map();   // move id -> { gain, ver, plan }
    const price = function* (ms) {
      const qs = yield ms.map((m) => job(withAnchors(m.k, m.anchors, m.gone), m.k, quick));
      ms.forEach((m, i) => {
        evals++;
        const q = qs[i];
        const ok = q && !q.errors.length && q.holes.length <= P.holes.length && (!m.to || q.fences[m.k - 1].anchors.some((a) => key(a) === key(m.to)));
        cache.set(m.id, { gain: ok ? score(P) - score(q) : -Infinity, ver, plan: q });
        if (opts.log) opts.log("prune " + m.id + ": " + (ok ? score(q) + " vs " + score(P) : "invalid"));
      });
      tick();
    };
    const budget = () => Math.min(maxEvals - evals, maxIdle - (evals - lastGain));
    while (budget() > 0) {
      const moves = movesOf();
      const fresh = moves.filter((m) => !cache.has(m.id)).slice(0, budget());
      if (fresh.length) yield* price(fresh);
      // the best move; one priced against an older plan is priced again first
      let taken = null;
      for (;;) {
        let bm = null, bg = 0;
        for (const m of moves) { const c = cache.get(m.id); if (c && c.gain > bg) { bg = c.gain; bm = m; } }
        if (!bm) break;
        if (cache.get(bm.id).ver !== ver) { if (budget() <= 0) { cache.delete(bm.id); continue; } yield* price([bm]); continue; }
        taken = bm; break;
      }
      if (!taken) break;
      P = cache.get(taken.id).plan; ver++; kept++; lastGain = evals;
      const near = (a) => Math.max(Math.abs(a[0] - taken.at[0]), Math.abs(a[1] - taken.at[1])) <= D;
      for (const [id] of cache) { const m = moves.find((u) => u.id === id); if (!m || m.k > taken.k || near(m.at)) cache.delete(id); }
    }
    // the plan in full, fine tie-breaks included
    let full = best;
    if (kept) {
      const q = (yield [job(P.fences, n, opts)])[0];
      if (q && !q.errors.length && q.holes.length <= best.holes.length && score(q) <= score(best)) full = q;
    }
    return { plan: full, runs: evals, kept: full === best ? 0 : kept };
  }

  function designOnce(world, input, opts, highs, onProgress) {
    const layers = Math.max(1, Math.min(4, opts.layers | 0 || 1));
    const g = makeGrid(world, input, layers);
    const prog = (stage, frac) => { if (onProgress) onProgress({ stage, frac }); };
    const notes = [];
    const fences = [];
    const ownBefore = g.own.slice();
    const dropped = [];
    const early = earlyCands(g);
    let hqCands1 = [], hive = { built: [] };
    // Fence 1's HQ goes up first and claims open ground now: the given one, or the spot whose square
    // overlaps most of the hive HQ's (the least new ground). Each later fence's HQ goes up at its own
    // turn, after the anchors before it (placeHQ, below).
    g.fixedHQ = {};
    g.reserved = new Uint8Array(g.N); g.resFoot = new Uint8Array(g.N);
    let hq1 = opts.hqs && opts.hqs[1] ? [opts.hqs[1].x - g.ox, opts.hqs[1].y - g.oy] : null;
    if (!hq1 && !(opts.fixLayer && opts.fixLayer[1])) { const c = hqCandidates(g, 1, [])[0]; if (c) hq1 = [c.x, c.y]; }
    if (hq1) {
      const [x, y] = hq1, r = sqH(x, y);
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { const t = (y + j) * g.W + x + i; if (x + i < 0 || y + j < 0 || x + i >= g.W || y + j >= g.H || g.own[t] !== U || g.hqBlock[t] || g.occ[t]) throw new Error("Fence 1: no HQ can stand at " + (x + g.ox) + "," + (y + g.oy) + "."); }
      g.fixedHQ[1] = { x, y, r, early: true };
      for (let yy = Math.max(0, r[1]); yy <= Math.min(g.H - 1, r[3]); yy++) for (let xx = Math.max(0, r[0]); xx <= Math.min(g.W - 1, r[2]); xx++) { const t = yy * g.W + xx; if (g.own[t] === U) g.own[t] = F0 + 1; }
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) g.occ[(y + j) * g.W + x + i] = 1;
    }
    g.later = [];
    for (let k = 1; k <= layers; k++) {
      prog("anchors " + k, (k - 1) / (layers + 1));
      // fence k's HQ (k > 1): the given spot, or the first that passes, by overlap with the HQ
      // squares already up; the banners in its way come down and the hive cycles what it must
      let placed = null;
      if (k > 1 && g.reg) {
        const fixL = opts.fixLayer && opts.fixLayer[k];
        const given = fixL ? fixL.hq : opts.hqs && opts.hqs[k] ? [opts.hqs[k].x, opts.hqs[k].y] : null;
        let at = null, why = null;
        if (given) {
          at = [given[0] - g.ox, given[1] - g.oy];
          placed = placeHQ(g, k, fences, at[0], at[1]);
          if (!placed.ok) throw new Error("Fence " + k + ": no HQ at " + given.join(",") + " (" + placed.why + ").");
        } else {
          for (const c of hqCandidates(g, k, fences)) { placed = placeHQ(g, k, fences, c.x, c.y); if (placed.ok) { at = [c.x, c.y]; placed.ov = c.ov; break; } if (!why) why = placed.why; }
        }
        if (placed && placed.ok) {
          g.fixedHQ[k] = { x: at[0], y: at[1], r: sqH(at[0], at[1]), placed: true };
          dropped.push(...placed.dropped);
          if (placed.removed.length) notes.push("Fence " + k + "'s HQ takes down " + placed.removed.length + " banner(s) of the fence(s) before it: " + placed.removed.map((b) => "F" + b.k + " " + (b.x + g.ox) + "," + (b.y + g.oy)).join(", ") + ".");
          if (placed.cycled.length) notes.push(input.mother.tag + " destroys and rebuilds in place, for fence " + k + "'s HQ: " + placed.cycled.map(String).join(" ") + ".");
        } else {
          placed = null;
          notes.push("Fence " + k + ": no HQ spot overlapping the HQs already up passes (first reason: " + (why || "none found") + "); its HQ is chosen by its band.");
        }
      }
      const s0 = k > 1 && g.reg ? snapG(g, fences) : null;
      let res = null, c = null, cycA = null;
      for (let attempt = 0; ; attempt++) {
        res = solveLayer(g, k, highs, opts, opts.log);
        if (!res) break;
        if (k === 1) hqCands1 = res.hqCands.map(([x, y]) => [x + g.ox, y + g.oy]);
        // the prune pass screens a move by its own fence's anchors alone
        if (opts.anchorsOnly === k) return { k, anchors: res.anchors.map((a) => [a.x + g.ox, a.y + g.oy]), unlinked: (res.unlinked || []).length };
        c = commitLayer(g, k, res);
        if (!s0) break;
        // the registry follows: the HQ (if its band chose it) and the anchors, then the hive cycles
        // every banner whose ground an anchor square needs; a cycle that would cost the hive a
        // building rules those anchors out and the layer is solved again
        if (placed) res.hq.reg = placed.hqReg;
        else { res.hq.reg = g.reg.length; g.reg.push({ code: F0 + k, r: res.hq.r, kind: "hq", alive: true }); regPaint(g, res.hq.r); }
        for (const a of c.order) { a.reg = g.reg.length; g.reg.push({ code: F0 + k, r: a.r, kind: "anchor", alive: true }); regPaint(g, a.r); }
        cycA = cycleHive(g, c.order.map((a) => a.r));
        if (cycA.ok || attempt >= 3) break;
        restoreG(g, s0, fences);
        g.noAnchor = g.noAnchor || new Set();
        for (const a of c.order) if (Math.max(a.r[0], cycA.bad[0]) <= Math.min(a.r[2], cycA.bad[2]) && Math.max(a.r[1], cycA.bad[1]) <= Math.min(a.r[3], cycA.bad[3])) g.noAnchor.add(a.p);
      }
      if (!res) { notes.push("Fence " + k + ": nothing left to enclose."); break; }
      if (cycA && !cycA.ok) notes.push("Fence " + k + ": " + cycA.why + ".");
      if (k === 1) {
        hive = rehive(g, highs, opts);
        g.rebuilt = hive.built;
        dropped.push(...hive.dropped);
        if (hive.missing) notes.push(input.mother.tag + ": " + hive.missing + " city/statue/node tile(s) left without territory after the rebuild.");
      }
      // hive ground inside fence 1's line it still holds (no anchor can take it, or a banner the
      // hive can't rebuild holds it)
      res.softLeft = res.soft.filter((t) => g.own[t] === M_BAN).length;
      dropped.push(...c.dropped);
      if (cycA && cycA.ok) dropped.push(...cycA.dropped);
      fences.push({ k, hq: res.hq, anchors: c.order, order0: c.order.slice(), band: res.band, uncovered: res.uncovered, optimal: res.optimal, unlinked: res.unlinked, softLeft: res.softLeft, early: !!(g.fixedHQ[k] && g.fixedHQ[k].early),
        removes: placed ? placed.removed : [], cycleHQ: placed ? placed.cycled : [], cycleAnchors: cycA && cycA.ok ? cycA.cycled : [] });
      if (placed || (cycA && cycA.ok && cycA.freed.length)) {
        const mask = new Uint8Array(g.N);
        for (const t of placed ? placed.foot.concat(placed.freed) : []) mask[t] = 1;
        for (const t of cycA && cycA.ok ? cycA.freed : []) mask[t] = 1;
        g.later.push({ k, mask });
      }
      if (k === 1) buildReg(g, input, fences, opts.log);
    }
    prog("fillers", layers / (layers + 1));
    let fill = solveFillers(g, highs, opts, fences);
    for (let pass = 0; pass < 6 && fill.holes.length && fences.length; pass++) {
      if (opts.log) opts.log("holes: " + fill.holes.map((t) => (t % g.W + g.ox) + "," + (((t / g.W) | 0) + g.oy) + "[" + winTiles(g, t).map((s) => g.own[s]).join("") + "]").join(" "));
      const added = repairHoles(g, fences, fill.holes);
      if (!added) break;
      if (opts.log) opts.log(added + " ground-claiming filler(s) added");
      fill = solveFillers(g, highs, opts, fences);
    }
    const moved = spaceFillers(g, fences, fill);
    if (opts.log) opts.log(moved + " filler move(s) in the spacing pass");
    const corners = cityCorners(g, highs, fill, new Set(dropped.concat(fill.dropped)));
    // hive banners destroyed after fence 1's anchors, and the new ones built in their place
    const G = (x, y) => [x + g.ox, y + g.oy];
    const tags = opts.tags || [];
    const plan = {
      hiveTag: input.mother.tag, ox: g.ox, oy: g.oy, W: g.W, H: g.H,
      // old rule: every fence's HQ against the hive, all built first; now each fence's HQ goes up
      // at the start of its own turn, against the ring before it
      hqsFirst: opts.outerHQ === true,
      hqCands1, earlyCands: early, hqsGiven: opts.hqs || null,
      own: Array.from(g.own),   // codes: 1/2 hive, 3 foreign, 10+k fence k
      destroy: (g.destroyed || []).map((b) => b.slice()),
      rebuild: hive.built.map((b) => b.slice()),
      dropped: [...new Set(dropped.concat(fill.dropped))].map((n) => input.mother.cities[n].slice(0, 2)),
      hive: { banners: [], buildings: [], cities: [] },
      fences: fences.map((f) => ({
        k: f.k, tag: tags[f.k - 1] || "F" + f.k,
        hq: G(f.hq.x, f.hq.y),
        anchors: f.anchors.map((a) => G(a.x, a.y)),
        // every anchor it builds, in chain order, those a later HQ takes down included
        anchorsBuilt: (f.order0 || f.anchors).map((a) => G(a.x, a.y)),
        // banners of earlier fences taken down for its HQ, and the hive's destroy-and-rebuild cycles
        removes: (f.removes || []).map((b) => ({ k: b.k, x: b.x + g.ox, y: b.y + g.oy })),
        cycleHQ: (f.cycleHQ || []).map((b) => b.slice()), cycleAnchors: (f.cycleAnchors || []).map((b) => b.slice()),
        fillers: [], buildings: [],
        uncovered: f.uncovered.map((t) => G(t % g.W, (t / g.W) | 0)), anchorsOptimal: f.optimal,
        unlinked: (f.unlinked || []).map((a) => G(a.x, a.y)), softLeft: f.softLeft || 0, early: f.early,
      })),
      holes: fill.holes.map((t) => G(t % g.W, (t / g.W) | 0)),
      windows: fill.windows, fillOptimal: fill.optimal, notes,
      input: { mother: input.mother, others: input.others },
    };
    for (const c of fill.chosen) {
      const dest = c.owner === 0 ? plan.hive : plan.fences[c.owner - 1];
      if (c.kind === "banner") dest[c.owner === 0 ? "banners" : "fillers"].push({ x: c.x + g.ox, y: c.y + g.oy, phase: c.phase, orange: !!c.orange, grey: !!c.grey });
      else if (c.kind === "city") {
        const x = c.x + g.ox, y = c.y + g.oy;
        const d = input.mother.traps.map((t) => Math.hypot(x + 1 - t[0] - 1.5, y + 1 - t[1] - 1.5));
        const k = d.indexOf(Math.min(...d));
        plan.hive.cities.push({ x, y, k, secs: Math.round(2.5 * d[k] + 4), phase: 1 });
      }
      else dest.buildings.push({ type: c.kind, x: c.x + g.ox, y: c.y + g.oy, w: c.w, phase: c.phase });
    }
    fences.forEach((f, i) => { plan.fences[i].fillers = (f.pre || []).map((b) => ({ x: b.x + g.ox, y: b.y + g.oy, phase: f.k, orange: true, grey: false, pre: true })).concat(plan.fences[i].fillers); });
    // final territory for the map: every banner's square, fillers included (open ground goes to
    // whoever builds there first, in build order)
    for (const s of buildSteps(plan)) for (const it of s.items) {
      if (it.type !== "banner" || it.role === "rebuild" || it.role === "anchor" || it.role === "destroy") continue;
      const code = it.tag === plan.hiveTag ? M_BAN : F0 + plan.fences.find((f) => f.tag === it.tag).k;
      for (let y = it.y - 3; y <= it.y + 3; y++) for (let x = it.x - 3; x <= it.x + 3; x++) { const i = g.idx(x, y); if (i >= 0 && g.own[i] === U) g.own[i] = code; }
    }
    plan.own = Array.from(g.own);
    if (corners) {
      plan.cityBanners = corners.cities;
      const two = corners.cities.filter((c) => c.banners.length > 1).length;
      if (two) notes.push(two + " hive cit" + (two === 1 ? "y needs" : "ies need") + " 2 banners when empty (both spots marked red).");
      if (corners.open) notes.push(corners.open + " 2x2 space(s) would open if the cities around them were empty.");
    }
    const cap = opts.cap || 180;
    for (const f of plan.fences) {
      f.banners = f.anchors.length + f.fillers.length;
      if (f.banners > cap) notes.push(f.tag + ": " + f.banners + " banners, above the guideline of " + cap + " (a guide only: nothing is held back for it).");
      if (f.softLeft) notes.push(f.tag + ": " + f.softLeft + " tile(s) of hive ground inside its line stay with the hive (no anchor can take them, or a hive banner that also holds a city does).");
      if (f.uncovered.length) notes.push(f.tag + ": " + f.uncovered.length + " band tile(s) no anchor can claim without covering a city, statue, node or hive banner.");
    }
    if (plan.dropped.length) notes.push(plan.dropped.length + " extra cit" + (plan.dropped.length === 1 ? "y" : "ies") + " dropped (a fence square or a hive statue needs the spot).");
    if (plan.holes.length) notes.push(plan.holes.length + " free 2x2 space(s) nothing can plug (outlined red).");
    if (fill.statuesMissing) notes.push(input.mother.tag + ": no room left for " + fill.statuesMissing + " statue(s) in its territory.");
    // the full rule check runs on every plan, so a broken one (e.g. an anchor no chain from its HQ
    // reaches) is reported, never silent
    const chk = check(world, input, plan);
    plan.errors = chk.errors.map((e) => "Rule check: " + e).concat(simulate(world, input, plan).map((e) => "Build simulation: " + e));
    if (chk.freeWindowsLeft) plan.errors.push("Rule check: " + chk.freeWindowsLeft + " free 2x2 space(s) left inside the territory.");
    prog("done", 1);
    return plan;
  }

  /* Build order: fence 1's HQ and anchors; the hive destroys and rebuilds what fence 1 needs; then for
     each later fence: the banners of earlier fences in the way of its HQ come down, its HQ, the hive's
     destroy-and-rebuild cycles for that HQ, its anchors (and their cycles), then the fillers of the
     fence before it (shut in now): yellow, buildings, orange. Last: the last fence's fillers, then the
     hive's fillers, statues and extra cities. Returns [{title, items:[{tag, type, x, y, role}]}]. */
  function buildSteps(plan) {
    const steps = [];
    const n = plan.fences.length;
    const hive = plan.hiveTag;
    const push = (title, items) => { if (items.length) steps.push({ title, items }); };
    const banner = (tag, x, y, role) => ({ tag, type: "banner", x, y, role });
    const cycle = (list) => [].concat(...list.map(([x, y]) => [banner(hive, x, y, "destroy"), banner(hive, x, y, "rebuild")]));
    const fill = (f, last) => {
      const live = f.fillers.filter((b) => !b.pre);
      push((last ? "Last: " : "") + f.tag + " yellow fillers" + (last ? "" : " (it is shut in now)"), live.filter((b) => !b.orange).map((b) => banner(f.tag, b.x, b.y, b.grey ? "grey" : "yellow")));
      push(f.tag + " buildings", f.buildings.map((b) => ({ tag: f.tag, type: b.type, x: b.x, y: b.y, role: "building" })));
      push(f.tag + " orange fillers" + (last ? " (they expand its territory)" : ""), live.filter((b) => b.orange).map((b) => banner(f.tag, b.x, b.y, "orange")));
    };
    for (let k = 1; k <= n; k++) {
      const f = plan.fences[k - 1];
      push("Take down the banners in the way of " + f.tag + "'s HQ", (f.removes || []).map((b) => banner(plan.fences[b.k - 1].tag, b.x, b.y, "destroy")));
      steps.push({ title: f.tag + " HQ", items: [{ tag: f.tag, type: "hq", x: f.hq[0], y: f.hq[1] }] });
      push(hive + ": destroy and rebuild in place, one at a time (" + f.tag + "'s HQ takes their ground)", cycle(f.cycleHQ || []));
      push(f.tag + " anchors, in chain order from its HQ", (f.anchorsBuilt || f.anchors).map(([x, y]) => banner(f.tag, x, y, "anchor")));
      if (k === 1) {
        push(hive + ": destroy these banners", (plan.destroy || []).map(([x, y]) => banner(hive, x, y, "destroy")));
        push(hive + ": build these banners (in this order)", plan.rebuild.map(([x, y]) => banner(hive, x, y, "rebuild")));
      }
      push(hive + ": destroy and rebuild in place, one at a time (" + f.tag + "'s anchors take their ground)", cycle(f.cycleAnchors || []));
      push(f.tag + " fillers that claim ground for the rest (orange)", f.fillers.filter((b) => b.pre).map((b) => banner(f.tag, b.x, b.y, "orange")));
      if (k > 1) fill(plan.fences[k - 2], false);
    }
    if (n) fill(plan.fences[n - 1], true);
    push("Last of all: " + hive + " fillers", plan.hive.banners.map((b) => banner(hive, b.x, b.y, b.orange ? "orange" : "yellow")));
    push(hive + " statues and node", plan.hive.buildings.map((b) => ({ tag: hive, type: b.type, x: b.x, y: b.y, role: "building" })));
    push(hive + " extra cities", (plan.hive.cities || []).map((c) => ({ tag: hive, type: "city", x: c.x, y: c.y, role: "city", k: c.k, secs: c.secs })));
    return steps;
  }

  const COLOUR = { anchor: "#ff0080", yellow: "#ffff00", grey: "#c0c0c0", orange: "#ff8040", rebuild: "#80ff80", building: "#222222", hq: "#8e44ad", trap: "#c0392b" };

  /* KSMapper import CSV (type,X,Y,label,#color,seq), in build order. */
  /* The rows of buildSteps that still stand at the end, in build order: a banner taken down drops
     out (the base rows of the map included), one rebuilt in place comes back at its new turn. */
  function standingRows(plan, base) {
    const rows = base.slice();
    for (const s of buildSteps(plan)) for (const it of s.items) {
      if (it.role === "destroy") {
        for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]; if (r[0] === "banner" && r[1] === it.x && r[2] === it.y && r[3] === it.tag) { rows.splice(i, 1); break; } }
        continue;
      }
      if (it.type === "hq") rows.push(["hq", it.x, it.y, it.tag, COLOUR.hq]);
      else if (it.type === "banner") rows.push(["banner", it.x, it.y, it.tag, COLOUR[it.role]]);
      else if (it.type === "trap") rows.push(["beartrap", it.x, it.y, it.tag, COLOUR.trap]);
      else if (it.type === "city") rows.push(["city", it.x, it.y, "BT" + (it.k + 1) + " extra " + it.secs + "s", it.k === 0 ? "#85c1e9" : "#f5cba7"]);
      else rows.push([it.type === "node" ? "obs3" : "obs2", it.x, it.y, it.tag + (it.type === "node" ? " node" : " statue"), COLOUR.building]);
    }
    return rows;
  }

  function toCsv(plan) {
    return standingRows(plan, []).map((r, i) => r.concat(i + 1).join(",")).join("\n") + "\n";
  }

  /* The whole map in one KSMapper CSV, one seq in build order (KSMapper gives each tile to the
     lowest seq that covers it and checks links on owned tiles, so the order decides the territory).
     baseCsv: the hive as it stood (the design's CSV, or the pasted one, other alliances included);
     its rows come first, in their own seq order, without the tags in `ignore` (old fences), the
     extra cities the plan drops and the banners the hive rebuilds; those come back right after
     fence 1's anchors, as in the game; then every other step of buildSteps. */
  function toFullCsv(plan, baseCsv, ignore) {
    const skip = new Set((ignore || []).map((t) => t.trim()).filter(Boolean));
    const dropped = new Set((plan.dropped || []).map(String));
    const destroy = new Set((plan.destroy || []).map(String));
    const base = [];
    String(baseCsv || "").split(/\r?\n/).forEach((line, i) => {
      const a = line.trim().split(",");
      if (a.length < 3 || line.trim().startsWith("#")) return;
      const type = a[0].trim().toLowerCase(), x = parseInt(a[1], 10), y = parseInt(a[2], 10);
      if (!SIZE[type] || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const label = (a[3] || "").trim();
      if (skip.has(label)) return;
      if (type === "city" && dropped.has(x + "," + y)) return;
      const row = [type, x, y, label, (a[4] || "").trim()];
      if (type === "banner" && label === plan.hiveTag && destroy.has(x + "," + y)) return;   // destroyed after fence 1's anchors
      const sq = parseInt(a[5], 10);
      base.push({ row, key: Number.isFinite(sq) ? sq : Infinity, i });
    });
    base.sort((p, q) => p.key - q.key || p.i - q.i);
    const rows = standingRows(plan, base.map((b) => b.row));
    return rows.map((r, i) => r.concat(i + 1).join(",")).join("\n") + "\n";
  }

  /* Game-rule simulator: the plan built step by step (buildSteps), from the hive as it stands.
     Each tile belongs to the earliest-built standing HQ or banner that covers it; a destroyed banner
     frees its tiles for the next one. Every build must stand on unoccupied ground that is free or its
     alliance's, and a banner's square must touch (corners count) its alliance's territory. At the end,
     as KSMapper checks it: every banner's alliance cells chain to its HQ's (8-adjacent), and every hive
     city lies wholly in hive territory. Returns the list of errors. */
  function simulate(world, input, plan, probe) {
    const errs = [];
    const g = makeGrid(world, input, plan.fences.length);
    const { W, H, N } = g, idx = g.idx;
    const structs = [];
    const ownIdx = new Int32Array(N).fill(-1);
    const occ = new Map();
    const paint = (i) => { const r = structs[i].r; for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) { const t = idx(x, y); if (t >= 0 && ownIdx[t] < 0) ownIdx[t] = i; } };
    const recompute = () => { ownIdx.fill(-1); structs.forEach((s, i) => { if (s.alive) paint(i); }); };
    const tagOf = (t) => (t < 0 || ownIdx[t] < 0 ? null : structs[ownIdx[t]].tag);
    const foot = (x, y, w) => { const out = []; for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) out.push(idx(x + i, y + j)); return out; };
    const addStruct = (type, x, y, tag) => { structs.push({ type, x, y, tag, r: type === "hq" ? sqH(x, y) : sqB(x, y), alive: true }); paint(structs.length - 1); };
    const occupy = (x, y, w, what) => { for (const t of foot(x, y, w)) if (t >= 0) occ.set(t, what); };
    const m = input.mother, hive = plan.hiveTag;
    const dropped = new Set((plan.dropped || []).map(String));
    // the world as it stands: hive HQ and banners, then the other alliances
    addStruct("hq", m.hq[0], m.hq[1], hive); occupy(m.hq[0], m.hq[1], 3, hive + " HQ");
    const network = new Set(g.split.network.map(String));   // the hive's banners elsewhere on the map
    for (const b of m.banners) if (idx(b[0], b[1]) >= 0) { addStruct("banner", b[0], b[1], hive); occupy(b[0], b[1], 1, hive + " banner"); if (network.has(String(b))) structs[structs.length - 1].network = true; }
    for (const h of input.others.hqs) { addStruct("hq", h[0], h[1], "#other"); occupy(h[0], h[1], 3, "other HQ"); }
    for (const b of input.others.banners) { addStruct("banner", b[0], b[1], "#other"); occupy(b[0], b[1], 1, "other banner"); }
    for (const t of m.traps) occupy(t[0], t[1], 3, hive + " trap");
    for (const c of m.cities) if (!dropped.has(String(c.slice(0, 2)))) occupy(c[0], c[1], 2, hive + " city");
    for (const b of m.buildings || []) occupy(b.x, b.y, b.w, hive + " " + (b.type || "building"));
    for (const b of input.others.buildings) occupy(b.x, b.y, b.w, "other building");
    const hasTerr = (tag) => structs.some((s) => s.alive && s.tag === tag);
    const kOf = new Map(plan.fences.map((f) => [f.tag, f.k]));
    const ruled = [];   // fence HQs and anchors, for the hive-ground rule at the end
    for (const step of buildSteps(plan)) for (const it of step.items) {
      const tag = it.tag, at = it.x + "," + it.y;
      if (it.role === "destroy") {
        const s = structs.find((q) => q.alive && q.type === "banner" && q.tag === tag && q.x === it.x && q.y === it.y);
        if (!s) { errs.push(tag + " banner " + at + " to destroy is not there"); continue; }
        s.alive = false; occ.delete(idx(it.x, it.y)); recompute();
        continue;
      }
      const w = it.type === "hq" || it.type === "trap" || it.type === "node" ? 3 : it.type === "city" || it.type === "statue" ? 2 : 1;
      const tiles = foot(it.x, it.y, w);
      if (tiles.some((t) => t < 0)) { errs.push(tag + " " + it.type + " " + at + " off the map window"); continue; }
      const busy = tiles.find((t) => occ.has(t));
      if (busy !== undefined) errs.push(tag + " " + it.type + " " + at + " on a tile taken by " + occ.get(busy));
      if (it.type === "hq") {
        if (tiles.some((t) => tagOf(t) !== null)) errs.push(tag + " HQ " + at + " on claimed ground");
        if (tiles.some((t) => g.hqBlock[t])) errs.push(tag + " HQ " + at + " on forbidden ground");
        addStruct("hq", it.x, it.y, tag); occupy(it.x, it.y, 3, tag + " HQ");
        if (kOf.has(tag)) ruled.push({ what: "HQ", s: structs[structs.length - 1], k: kOf.get(tag) });
        if (kOf.get(tag) === 1) {
          // as its anchors: nothing the hive built, but in the hive HQ's own square (it never falls)
          const r = sqH(it.x, it.y), hr = sqH(m.hq[0], m.hq[1]);
          for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) { if (inR(hr, x, y)) continue; const o = occ.get(idx(x, y)); if (o && o.startsWith(hive + " ") && !/ HQ$/.test(o)) { errs.push(tag + " HQ " + at + " square holds " + o + " at " + x + "," + y); y = r[3] + 1; break; } }
        }
      } else if (it.type === "banner") {
        const t = tiles[0], o = tagOf(t);
        if (o !== null && o !== tag) errs.push(tag + " banner " + at + " on " + o + "'s ground");
        if (g.allyBlock[t]) errs.push(tag + " banner " + at + " on forbidden ground");
        if (hasTerr(tag)) {
          let touch = false;
          for (let y = it.y - 4; y <= it.y + 4 && !touch; y++) for (let x = it.x - 4; x <= it.x + 4; x++) if (tagOf(idx(x, y)) === tag) { touch = true; break; }
          if (!touch) errs.push(tag + " banner " + at + " does not touch its territory");
        } else errs.push(tag + " banner " + at + " before its HQ");
        addStruct("banner", it.x, it.y, tag); occupy(it.x, it.y, 1, tag + " banner");
        if (it.role === "anchor" && kOf.has(tag)) ruled.push({ what: "anchor", s: structs[structs.length - 1], k: kOf.get(tag) });
      } else {
        // cities, statues, node, traps: on free tiles; statues and node in their alliance's territory
        if ((it.type === "statue" || it.type === "node") && tiles.some((t) => tagOf(t) !== tag)) errs.push(tag + " " + it.type + " " + at + " outside its territory");
        occupy(it.x, it.y, w, tag + " " + it.type);
      }
    }
    // the end, as KSMapper sees it: alliance cells chained to the HQ's
    const tags = [hive].concat(plan.fences.map((f) => f.tag));
    for (const tag of tags) {
      const hqI = structs.findIndex((s) => s.alive && s.type === "hq" && s.tag === tag);
      if (hqI < 0) continue;
      const seen = new Uint8Array(N), q = [];
      for (let t = 0; t < N; t++) if (ownIdx[t] === hqI) { seen[t] = 1; q.push(t); }
      while (q.length) { const t = q.pop(), x = t % W, y = (t / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const s = idx(x + dx + g.ox, y + dy + g.oy); if (s >= 0 && !seen[s] && tagOf(s) === tag) { seen[s] = 1; q.push(s); } } }
      structs.forEach((s) => {
        if (!s.alive || s.tag !== tag || s.type !== "banner" || s.network) return;
        let linked = false;
        for (let y = s.r[1]; y <= s.r[3] && !linked; y++) for (let x = s.r[0]; x <= s.r[2]; x++) { const t = idx(x, y); if (t >= 0 && tagOf(t) === tag && seen[t]) { linked = true; break; } }
        if (!linked) errs.push(tag + " banner " + s.x + "," + s.y + " is cut off from its HQ (KSMapper orphan)");
      });
    }
    for (const c of m.cities) {
      if (dropped.has(String(c.slice(0, 2)))) continue;
      if (foot(c[0], c[1], 2).some((t) => tagOf(t) !== hive)) errs.push(hive + " city " + c[0] + "," + c[1] + " outside its territory");
    }
    for (const c of plan.hive.cities || []) if (foot(c.x, c.y, 2).some((t) => tagOf(t) !== hive)) errs.push(hive + " extra city " + c.x + "," + c.y + " outside its territory");
    // an outer fence's HQ or anchor holds no hive ground (fillers may: they are easy to rebuild)
    for (const { what, s, k } of ruled) {
      if (k < 2 || !s.alive) continue;
      let n = 0;
      for (let y = s.r[1]; y <= s.r[3]; y++) for (let x = s.r[0]; x <= s.r[2]; x++) { const t = idx(x, y); if (tagOf(t) === hive && ownIdx[t] !== 0) n++; }
      if (n) errs.push(s.tag + " " + what + " " + s.x + "," + s.y + " square holds " + n + " tile(s) of hive ground");
    }
    // closure: the hive's and the inner fences' territory must not touch open ground that reaches
    // the outside (pockets shut in by the hive itself do not count)
    const outside = new Uint8Array(N), q = [];
    const free = (t) => t >= 0 && tagOf(t) === null;
    for (let t = 0; t < N; t++) { const x = t % W, y = (t / W) | 0; if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && free(t)) { outside[t] = 1; q.push(t); } }
    const nb4 = (t) => { const x = t % W + g.ox, y = ((t / W) | 0) + g.oy; return [idx(x + 1, y), idx(x - 1, y), idx(x, y + 1), idx(x, y - 1)]; };
    while (q.length) for (const s of nb4(q.pop())) if (free(s) && !outside[s]) { outside[s] = 1; q.push(s); }
    const inner = new Set([hive].concat(plan.fences.slice(0, -1).map((f) => f.tag)));
    const leaks = new Map();
    for (let t = 0; t < N; t++) {
      const o = tagOf(t);
      if (!inner.has(o) || !nb4(t).some((s) => s >= 0 && outside[s])) continue;
      const s = structs[ownIdx[t]], key = o + " " + s.type + " " + s.x + "," + s.y;
      if (s.network) continue;   // the hive's banners elsewhere stand outside the fences
      if (!leaks.has(key)) leaks.set(key, (t % W + g.ox) + "," + (((t / W) | 0) + g.oy));
    }
    for (const [key, at] of leaks) errs.push("Fence open: " + key + " territory touches open ground outside at " + at);
    // layers (the hive 0, fence k) for the checks below; any layers may meet (no ring rule): only
    // closure and free 2x2s count
    const layer = new Map([[hive, 0]].concat(plan.fences.map((f) => [f.tag, f.k])));
    const netAt = (t) => ownIdx[t] >= 0 && structs[ownIdx[t]].network;
    // no free 2x2 shut in: every 2x2 of open, buildable, unoccupied tiles is plugged, but those
    // wholly the last fence's (its ground beyond the ring) or open to the outside
    const last = plan.fences.length ? plan.fences[plan.fences.length - 1].tag : hive;
    // open ground that reaches the outside over other alliances' land too (a pocket against a
    // neighbour is the neighbour's business, as for closure)
    const open2 = new Uint8Array(N), q2 = [];
    const pass = (t) => t >= 0 && (tagOf(t) === null || !layer.has(tagOf(t)));
    for (let t = 0; t < N; t++) { const x = t % W, y = (t / W) | 0; if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && pass(t)) { open2[t] = 1; q2.push(t); } }
    while (q2.length) for (const s of nb4(q2.pop())) if (pass(s) && !open2[s]) { open2[s] = 1; q2.push(s); }
    const nearForeign = new Uint8Array(N);
    for (let t = 0; t < N; t++) {
      const o = tagOf(t);
      if (o === null || layer.has(o)) continue;
      const x = t % W, y = (t / W) | 0;
      for (let yy = Math.max(0, y - 5); yy <= Math.min(H - 1, y + 4); yy++) for (let xx = Math.max(0, x - 5); xx <= Math.min(W - 1, x + 4); xx++) nearForeign[yy * W + xx] = 1;
    }
    let holes = 0, firstHole = null;
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const ts = [y * W + x, y * W + x + 1, (y + 1) * W + x, (y + 1) * W + x + 1];
      if (ts.some((t) => occ.has(t) || g.cityBlock[t] || open2[t] || netAt(t))) continue;
      const tags = ts.map(tagOf);
      if (tags.every((o) => o === last) || tags.some((o) => o !== null && !layer.has(o))) continue;
      // near a neighbour's land (4 tiles): the neighbour's business for now, as for closure (the
      // filler ILP leaves alone ground that reaches the outside over a neighbour's land)
      if (nearForeign[ts[0]]) continue;
      holes++;
      if (!firstHole) firstHole = (x + g.ox) + "," + (y + g.oy);
    }
    if (holes) errs.push("Free 2x2 shut in: " + holes + " (first at " + firstHole + ")");
    if (probe) probe.tagAt = (x, y) => tagOf(idx(x, y));
    return [...new Set(errs)];
  }

  /* Independent check of a plan against the rules. */
  function check(world, input, plan) {
    const errs = [];
    const g = makeGrid(world, input, plan.fences.length);
    const { W } = g, idx = g.idx, own = g.own;
    const dropped = new Set((plan.dropped || []).map(String));
    const occ = (x, y, w, what) => { for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) { const t = idx(x + i, y + j); if (t < 0) continue; if (g.occ[t]) errs.push(what + " on an occupied tile " + (x + i) + "," + (y + j)); g.occ[t] = 1; } };
    // the hive keeps its HQ square and the land of every banner it does not destroy
    const destroyed = new Set((plan.destroy || []).map(String));
    const keep = new Uint8Array(g.N);
    const mark = (r) => { for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) { const t = idx(x, y); if (t >= 0) keep[t] = 1; } };
    mark(sqH(...input.mother.hq));
    for (const b of g.split.hive) if (!destroyed.has(String(b))) mark(sqB(...b));
    const destroyedTile = new Set(g.split.hive.filter((b) => destroyed.has(String(b))).map((b) => idx(b[0], b[1])));
    // ground a destroyed hive banner frees goes first to other alliances' squares that cover it
    const otherCover = new Uint8Array(g.N);
    for (const r of input.others.hqs.map((h) => sqH(...h)).concat(input.others.banners.concat(g.split.network).map((b) => sqB(...b)))) for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) { const t = idx(x, y); if (t >= 0) otherCover[t] = 1; }
    const square = (tag, what, r, k, eat) => {
      for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
        const t = idx(x, y);
        if (t < 0) continue;
        const takes = own[t] === U || (eat && own[t] === M_BAN && !keep[t]);
        if (!takes) continue;
        if (own[t] === M_BAN && otherCover[t]) { own[t] = OTHER; continue; }
        if (g.prot[t] && !destroyedTile.has(t)) errs.push(tag + " " + what + " square takes the hive's " + x + "," + y);
        if (g.extraAt[t] >= 0) {
          const c = input.mother.cities[g.extraAt[t]];
          if (!dropped.has(String(c.slice(0, 2)))) errs.push(tag + " " + what + " square takes extra city " + c[0] + "," + c[1] + " that is not dropped");
          for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const s = idx(c[0] + i, c[1] + j); g.occ[s] = 0; g.extraAt[s] = -1; }
        }
        own[t] = F0 + k;
      }
    };
    // ownership when fence 1's HQs and anchors go up: the hive still holds its banner land (it is
    // rebuilt only afterwards), so they gain open ground only
    const live = own.slice();
    const gain = (r, code) => { for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) { const t = idx(x, y); if (t >= 0 && live[t] === U) live[t] = code; } };
    const hqUp = (f) => {
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { const t = idx(f.hq[0] + i, f.hq[1] + j); if (own[t] !== U) errs.push(f.tag + " HQ on claimed ground"); if (g.hqBlock[t]) errs.push(f.tag + " HQ on forbidden ground"); }
      occ(f.hq[0], f.hq[1], 3, f.tag + " HQ");
      square(f.tag, "HQ", sqH(...f.hq), f.k, plan.hqsFirst || f.early || f.k === 1);
      gain(sqH(...f.hq), F0 + f.k);
    };
    const isEarly = (f) => plan.hqsFirst || f.early;
    for (const f of plan.fences) if (isEarly(f)) hqUp(f);
    for (const f of plan.fences) {
      if (!isEarly(f)) hqUp(f);
      // links are checked on the final ground (the order in between does not matter)
      const k = f.k, L = own;
      for (const [x, y] of f.anchors) {
        const t = idx(x, y);
        if (L[t] !== U && L[t] !== F0 + k) errs.push(f.tag + " anchor " + x + "," + y + " on claimed ground");
        if (g.allyBlock[t]) errs.push(f.tag + " anchor " + x + "," + y + " on forbidden ground");
        const r = sqB(x, y);
        // its square must touch (corners count) a tile the fence owns at that moment
        let link = false;
        for (let yy = y - 4; yy <= y + 4 && !link; yy++) for (let xx = x - 4; xx <= x + 4; xx++) { const i = idx(xx, yy); if (i >= 0 && L[i] === F0 + k) { link = true; break; } }
        if (!link) errs.push(f.tag + " anchor " + x + "," + y + " does not touch its territory");
        occ(x, y, 1, f.tag + " anchor");
        square(f.tag, "anchor " + x + "," + y, r, k, k === 1);
        if (k === 1) gain(r, F0 + 1);
      }
      if (k > 1 && ((f.cycleHQ || []).length || (f.cycleAnchors || []).length)) {
        // the hive destroyed and rebuilt these banners in place: their ground in this fence's HQ and
        // anchor squares that no other hive banner (nor the hive HQ) covers is now the fence's
        const cyc = new Set((f.cycleHQ || []).concat(f.cycleAnchors || []).map(String));
        const standing = g.split.hive.filter((b) => !destroyed.has(String(b))).concat(plan.rebuild || []).filter((b) => !cyc.has(String(b))).map((b) => sqB(...b));
        const hiveR = sqH(...input.mother.hq);
        for (const r of [sqH(...f.hq)].concat(f.anchors.map((a) => sqB(...a)))) for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
          const t = idx(x, y);
          if (t < 0 || own[t] !== M_BAN || inR(hiveR, x, y) || standing.some((q) => inR(q, x, y))) continue;
          own[t] = F0 + k;
        }
      }
      if (k !== 1) continue;
      // the hive destroys those banners (their land nothing else of the hive covers is open
      // ground) and builds the new ones, each touching (corners count) its territory
      for (const b of g.split.hive) if (destroyed.has(String(b))) { const t = idx(b[0], b[1]); if (t >= 0) g.occ[t] = 0; }
      for (let t = 0; t < g.N; t++) if (own[t] === M_BAN && !keep[t]) own[t] = otherCover[t] ? OTHER : U;
      for (const [x, y] of plan.rebuild || []) {
        const t = idx(x, y);
        if (t < 0 || !(own[t] === U || own[t] === M_HQ || own[t] === M_BAN)) errs.push(plan.hiveTag + " new banner " + x + "," + y + " on another alliance's ground");
        let link = false;
        for (let yy = y - 4; yy <= y + 4 && !link; yy++) for (let xx = x - 4; xx <= x + 4; xx++) { const i = idx(xx, yy); if (i >= 0 && (own[i] === M_HQ || own[i] === M_BAN)) { link = true; break; } }
        if (!link) errs.push(plan.hiveTag + " new banner " + x + "," + y + " does not touch its territory");
        occ(x, y, 1, plan.hiveTag + " new banner");
        const r = sqB(x, y);
        for (let yy = r[1]; yy <= r[3]; yy++) for (let xx = r[0]; xx <= r[2]; xx++) { const i = idx(xx, yy); if (i >= 0 && own[i] === U) own[i] = M_BAN; }
      }
    }
    const n = plan.fences.length;
    // dropped extra cities free their ground (for fence squares or hive statues)
    for (const c of plan.dropped || []) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const t = idx(c[0] + i, c[1] + j); if (t >= 0 && g.extraAt[t] >= 0) { g.occ[t] = 0; g.extraAt[t] = -1; } }
    const earlyHQ = plan.fences.filter((f) => plan.hqsFirst || f.early).map((f) => ({ k: f.k, r: sqH(f.hq[0] - g.ox, f.hq[1] - g.oy) }));
    let outA = null;   // set once the ground-claiming fillers (built right after the anchors) stand
    const fillerCheck = (A, tag, b) => {
      const t = idx(b.x, b.y);
      const o = own[t];
      let gain = false;
      if (A > 0 && o === U) {
        let touch = false;
        for (let yy = b.y - 4; yy <= b.y + 4 && !touch; yy++) for (let xx = b.x - 4; xx <= b.x + 4; xx++) { const i = idx(xx, yy); if (i >= 0 && own[i] === F0 + A) { touch = true; break; } }
        if (!touch) errs.push(tag + " filler " + b.x + "," + b.y + " does not touch its territory");
        gain = true;
      } else if ((A === 0 && o !== M_HQ && o !== M_BAN) || (A > 0 && o !== F0 + A)) errs.push(tag + " filler " + b.x + "," + b.y + " outside its territory");
      let out = A > 0 && !!outA && outA[A - 1][t];
      for (let yy = b.y - 3; yy <= b.y + 3; yy++) for (let xx = b.x - 3; xx <= b.x + 3; xx++) { const i = idx(xx, yy); if (i < 0 || (own[i] === U && !g.cityBlock[i])) gain = true; if (outA && (i < 0 || (A > 0 && outA[A - 1][i] && !g.cityBlock[i]))) out = true; }
      // the hive may cover what is left round its cities (it is rebuilt anyway); a fence filler that
      // would push its fence outward must be orange
      if (out && b.orange === false) errs.push(tag + " filler " + b.x + "," + b.y + " pushes the fence outward but is not orange");
    };
    for (const f of plan.fences) for (const b of f.fillers) if (b.pre) {
      fillerCheck(f.k, f.tag, b);
      for (let yy = b.y - 3; yy <= b.y + 3; yy++) for (let xx = b.x - 3; xx <= b.x + 3; xx++) { const i = idx(xx, yy); if (i >= 0 && own[i] === U) own[i] = F0 + f.k; }
    }
    outA = plan.fences.map((f) => outwardMask(g, own, f.k, earlyHQ));
    const band = bandWindows(g);   // territory after the anchors (and ground-claiming fillers)
    for (const b of plan.hive.banners) fillerCheck(0, plan.hiveTag, b);
    for (const f of plan.fences) for (const b of f.fillers) if (!b.pre) fillerCheck(f.k, f.tag, b);
    for (const b of plan.hive.banners) occ(b.x, b.y, 1, "hive filler");
    for (const f of plan.fences) for (const b of f.fillers) occ(b.x, b.y, 1, f.tag + " filler");
    for (const b of plan.hive.buildings) occ(b.x, b.y, b.w, "hive " + b.type);
    for (const c of plan.hive.cities || []) {
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const t = idx(c.x + i, c.y + j); if (t < 0 || ownerOf(own[t]) !== 0 || g.cityBlock[t]) errs.push("hive extra city " + c.x + "," + c.y + " outside the hive's territory"); }
      occ(c.x, c.y, 2, "hive extra city");
    }
    for (const f of plan.fences) for (const b of f.buildings) occ(b.x, b.y, b.w, f.tag + " " + b.type);
    input.mother.cities.forEach((c) => { if (c[2]) return; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const t = idx(c[0] + i, c[1] + j); if (t >= 0 && own[t] !== M_HQ && own[t] !== M_BAN) errs.push("hive city " + c[0] + "," + c[1] + " lost territory"); } });
    const left = band.filter((i) => winTiles(g, i).every((t) => !g.occ[t]));
    return { errors: [...new Set(errs)], freeWindowsLeft: left.length, left: left.map((t) => [t % W + g.ox, ((t / W) | 0) + g.oy]), g };
  }

  const api = { COLOUR, parseCsv, fromCsv, fromDesign, design, designAsync, designOnce, buildSteps, toCsv, toFullCsv, check, simulate, splitHive, makeGrid };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Fence = api;
})(typeof self !== "undefined" ? self : this);
