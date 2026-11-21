/* KSPlanner hive optimiser.
 *
 * Given an HQ position, places two bear traps and the structural banners, fills the territory
 * with 2x2 city slots, places the gathering node (3x3) and the statues (2x2), and plugs every
 * remaining free 2x2 window with filler banners that add no territory.
 *
 * Game rules (see README): HQ 3x3 projects 15x15 centred on its middle tile; a banner 1x1
 * projects 7x7 centred on itself; a banner's square must touch (corners count) territory already
 * connected to the HQ. Anchors are lower-left tiles. Cities must be fully inside territory.
 *
 * Runs in a browser worker or in Node (module.exports).
 */
(function (root) {
  "use strict";
  const MAP = 1200;

  // ---------------------------------------------------------------- world masks
  function b64ToBytes(b64) {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  const ZONES = {
    king: [594, 594, 605, 605],
    ruins: [552, 552, 647, 647],     // no alliance buildings
    fertile: [450, 450, 749, 749],   // no HQ
  };

  function buildWorld(staticMap) {
    const packed = b64ToBytes(staticMap.terrain_mask.packed_base64);
    const N = MAP * MAP;
    const terrain = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const v = packed[i >> 1];
      terrain[i] = (i & 1) ? (v >> 4) : (v & 15);
    }
    // bit 1: blocks everything, bit 2: blocks alliance buildings, bit 4: blocks cities, bit 8: blocks HQ
    const block = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (terrain[i]) block[i] = 1 | 2 | 4 | 8;
    const rect = (x1, y1, x2, y2, bits) => {
      x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(MAP - 1, x2); y2 = Math.min(MAP - 1, y2);
      for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) block[y * MAP + x] |= bits;
    };
    const ns = staticMap.node_size || 2;
    for (const n of staticMap.nodes) rect(n.x, n.y, n.x + ns - 1, n.y + ns - 1, 1 | 2 | 4 | 8);
    for (const s of staticMap.structures) {
      rect(s.x, s.y, s.x + s.size - 1, s.y + s.size - 1, 1 | 2 | 4 | 8);
      const fx = Math.round(s.x + s.size / 2 - s.forbidden_zone / 2);
      const fy = Math.round(s.y + s.size / 2 - s.forbidden_zone / 2);
      rect(fx, fy, fx + s.forbidden_zone - 1, fy + s.forbidden_zone - 1, s.city_exempt ? (2 | 8) : (2 | 4 | 8));
    }
    rect(...ZONES.king, 1 | 2 | 4 | 8);
    rect(...ZONES.ruins, 2 | 8);
    rect(...ZONES.fertile, 8);
    return { terrain, block, nodes: staticMap.nodes, structures: staticMap.structures, nodeSize: ns };
  }

  function hqBlockReason(world, hx, hy) {
    if (hx < 6 || hy < 6 || hx + 8 >= MAP || hy + 8 >= MAP) return "too close to the map edge";
    for (let y = hy; y < hy + 3; y++) for (let x = hx; x < hx + 3; x++) {
      const b = world.block[y * MAP + x];
      if (b & 1) return "terrain, node or structure under the HQ";
      if (b & 2) return "no-build zone (structure or Ruins)";
      if (b & 8) return "HQ only allowed in Plains / Badlands";
    }
    return null;
  }

  // ---------------------------------------------------------------- PRNG
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- context (local window)
  function makeContext(world, hx, hy, opts) {
    const R = opts.radius || 42;
    const S = 2 * R + 3;
    const ox = hx - R, oy = hy - R;
    const ally = new Uint8Array(S * S), city = new Uint8Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const gx = ox + x, gy = oy + y, i = y * S + x;
      if (gx < 0 || gy < 0 || gx >= MAP || gy >= MAP) { ally[i] = 1; city[i] = 1; continue; }
      const b = world.block[gy * MAP + gx];
      ally[i] = (b & 2) ? 1 : 0;
      city[i] = (b & 4) ? 1 : 0;
    }
    return {
      world, R, S, ox, oy, hq: [R, R], ally, city,
      target: opts.target || 120,
      terr: new Uint8Array(S * S), occ: new Uint8Array(S * S), free: new Uint8Array(S * S),
      used: new Int32Array(S * S), stamp: 1, seen: new Int32Array(S * S),
      cand: new Int32Array(S * S), keys: new Float64Array(S * S),
    };
  }

  // ---------------------------------------------------------------- evaluation
  function trapCentres(st) { return st.t.map(([x, y]) => [x + 1.5, y + 1.5]); }

  function nearestDist(tc, cx, cy) {
    let best = 1e9, which = 0;
    for (let k = 0; k < tc.length; k++) {
      const dx = cx - tc[k][0], dy = cy - tc[k][1], d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) { best = d; which = k; }
    }
    return [best, which];
  }

  const touches = (a, b) =>
    Math.max(a[0], b[0]) - Math.min(a[2], b[2]) <= 1 && Math.max(a[1], b[1]) - Math.min(a[3], b[3]) <= 1;

  /* Paints territory, occupancy and free tiles for a state. Returns penalties and bbox. */
  function paint(ctx, st, extraOcc) {
    const { S, terr, occ, free, ally, city } = ctx;
    const [hx, hy] = ctx.hq;
    terr.fill(0); occ.fill(0);
    const rects = [[hx - 6, hy - 6, hx + 8, hy + 8]];
    for (const [bx, by] of st.b) rects.push([bx - 3, by - 3, bx + 3, by + 3]);
    const conn = new Uint8Array(rects.length); conn[0] = 1;
    const stack = [0];
    while (stack.length) {
      const i = stack.pop();
      for (let j = 1; j < rects.length; j++) if (!conn[j] && touches(rects[i], rects[j])) { conn[j] = 1; stack.push(j); }
    }
    let pen = 0, x0 = S, y0 = S, x1 = 0, y1 = 0;
    for (let r = 0; r < rects.length; r++) {
      if (!conn[r]) { pen += 400; continue; }
      const q = rects[r];
      const qx0 = Math.max(0, q[0]), qy0 = Math.max(0, q[1]), qx1 = Math.min(S - 1, q[2]), qy1 = Math.min(S - 1, q[3]);
      for (let y = qy0; y <= qy1; y++) for (let x = qx0; x <= qx1; x++) terr[y * S + x] = 1;
      if (qx0 < x0) x0 = qx0; if (qy0 < y0) y0 = qy0; if (qx1 > x1) x1 = qx1; if (qy1 > y1) y1 = qy1;
    }
    const put = (x, y, w, code, mustTerr) => {
      for (let yy = y; yy < y + w; yy++) for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || yy < 0 || xx >= S || yy >= S) { pen += 400; continue; }
        const i = yy * S + xx;
        if (occ[i]) pen += 400;
        if (ally[i]) pen += 400;
        if (mustTerr && !terr[i]) pen += 60;
        occ[i] = code;
      }
    };
    put(hx, hy, 3, 1, false);
    for (const [tx, ty] of st.t) put(tx, ty, 3, 2, true);
    for (const [bx, by] of st.b) put(bx, by, 1, 3, false);
    if (extraOcc) for (const e of extraOcc) put(e.x, e.y, e.w, e.code, true);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * S + x;
      free[i] = terr[i] && !city[i] && !occ[i] ? 1 : 0;
    }
    return { pen, bbox: [x0, y0, x1, y1], conn };
  }

  /* Greedy 2x2 packing over the free mask, in several orders; keeps the best. */
  function pockets(ctx, bbox) {
    const { S, terr, seen } = ctx;
    const x0 = Math.max(0, bbox[0] - 1), y0 = Math.max(0, bbox[1] - 1), x1 = Math.min(S - 1, bbox[2] + 1), y1 = Math.min(S - 1, bbox[3] + 1);
    const stamp = ++ctx.stamp;
    const q = [];
    for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) { const i = y * S + x; if (!terr[i] && seen[i] !== stamp) { seen[i] = stamp; q.push(i); } }
    for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) { const i = y * S + x; if (!terr[i] && seen[i] !== stamp) { seen[i] = stamp; q.push(i); } }
    while (q.length) {
      const i = q.pop(), x = i % S, y = (i / S) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
        const j = ny * S + nx;
        if (!terr[j] && seen[j] !== stamp) { seen[j] = stamp; q.push(j); }
      }
    }
    const pocket = new Uint8Array(S * S);
    let count = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * S + x;
      if (!terr[i] && seen[i] !== stamp) { pocket[i] = 1; count++; }
    }
    return { pocket, count };
  }

  /* 2x2 windows inside the hive (territory + pockets) that are empty and city-buildable,
     excluding windows fully inside territory when cities are still allowed there. */
  function holeWindows(ctx, bbox, pocket, occAll) {
    const { S, terr, city } = ctx;
    const out = [];
    const inHive = (i) => terr[i] || pocket[i];
    const ok = (i) => inHive(i) && !city[i] && !occAll[i];
    for (let y = bbox[1] - 1; y <= bbox[3]; y++) for (let x = bbox[0] - 1; x <= bbox[2]; x++) {
      if (x < 0 || y < 0 || x + 1 >= S || y + 1 >= S) continue;
      const i = y * S + x;
      if (ok(i) && ok(i + 1) && ok(i + S) && ok(i + S + 1)) out.push(i);
    }
    return out;
  }


  // ---------------------------------------------------------------- balanced packing (fast proxy)
  function windowsOf(ctx, mask, bbox) {
    const { S } = ctx;
    const out = [];
    for (let y = Math.max(0, bbox[1]); y < Math.min(S - 1, bbox[3]); y++) for (let x = Math.max(0, bbox[0]); x < Math.min(S - 1, bbox[2]); x++) {
      const i = y * S + x;
      if (mask[i] && mask[i + 1] && mask[i + S] && mask[i + S + 1]) out.push(i);
    }
    return out;
  }

  /* Greedy: N slots per trap, nearest (window, trap) pairs first; a few lattice-biased variants. */
  function packBalanced(ctx, st, bbox, N, variants) {
    const { S, used } = ctx;
    const tc = trapCentres(st);
    const win = windowsOf(ctx, ctx.free, bbox);
    const n = win.length;
    const pd = new Float64Array(2 * n);
    for (let q = 0; q < n; q++) {
      const x = win[q] % S, y = (win[q] / S) | 0;
      pd[2 * q] = Math.hypot(x + 1 - tc[0][0], y + 1 - tc[0][1]);
      pd[2 * q + 1] = Math.hypot(x + 1 - tc[1][0], y + 1 - tc[1][1]);
    }
    let best = null;
    const keys = new Float64Array(2 * n);
    for (let v = 0; v < variants; v++) {
      const a = (v - 1) & 1, b = ((v - 1) >> 1) & 1;
      for (let p = 0; p < 2 * n; p++) {
        let key = pd[p];
        if (v > 0) {
          const q = p >> 1, k = p & 1, x = win[q] % S, y = (win[q] / S) | 0;
          if (((x - st.t[k][0] - a) & 1) || ((y - st.t[k][1] - b) & 1)) key += 0.75;
        }
        keys[p] = key;
      }
      const order = Array.from({ length: 2 * n }, (_, p) => p).sort((p, r) => keys[p] - keys[r]);
      const stamp = ++ctx.stamp;
      const cnt = [0, 0];
      let sum = 0;
      const cities = [];
      for (const p of order) {
        const k = p & 1;
        if (cnt[k] >= N) { if (cnt[1 - k] >= N) break; continue; }
        const i = win[p >> 1];
        if (used[i] === stamp || used[i + 1] === stamp || used[i + S] === stamp || used[i + S + 1] === stamp) continue;
        used[i] = used[i + 1] = used[i + S] = used[i + S + 1] = stamp;
        cnt[k]++; sum += pd[p];
        cities.push({ i, k, d: pd[p] });
      }
      const deficit = Math.max(0, N - cnt[0]) + Math.max(0, N - cnt[1]);
      const val = deficit * 80 + sum;
      if (!best || val < best.val) best = { val, sum, deficit, cnt, cities };
    }
    return best;
  }

  function pocketWindows(ctx, bbox) {
    const pc = pockets(ctx, bbox);
    if (!pc.count) return 0;
    const { S, terr, city, occ } = ctx, pocket = pc.pocket;
    let n = 0;
    const ok = (j) => (terr[j] || pocket[j]) && !city[j] && !occ[j];
    for (let y = bbox[1]; y < bbox[3]; y++) for (let x = bbox[0]; x < bbox[2]; x++) {
      const i = y * S + x;
      if (ok(i) && ok(i + 1) && ok(i + S) && ok(i + S + 1) && (pocket[i] || pocket[i + 1] || pocket[i + S] || pocket[i + S + 1])) n++;
    }
    return n;
  }

  function score(ctx, st) {
    const p = paint(ctx, st);
    const pk = packBalanced(ctx, st, p.bbox, ctx.N, ctx.variants);
    const pw = pocketWindows(ctx, p.bbox);
    const val = p.pen + pk.val + pw * 40;
    return { val, sum: pk.sum, deficit: pk.deficit, pen: p.pen, pocketWin: pw };
  }

  // ---------------------------------------------------------------- construction + annealing
  function cloneState(st) { return { t: st.t.map((a) => a.slice()), b: st.b.map((a) => a.slice()) }; }

  const LAYOUTS = [[1, -1], [1, 1], [1, 0], [0, 1]];   // trap axis; [1,-1] is left-right on screen

  function initialTraps(ctx, dir, D) {
    const [hx, hy] = ctx.hq;
    const len = Math.hypot(dir[0], dir[1]);
    const ux = dir[0] / len, uy = dir[1] / len;
    const c = [hx + 1.5, hy + 1.5];
    return [[Math.round(c[0] - D * ux - 1.5), Math.round(c[1] - D * uy - 1.5)],
            [Math.round(c[0] + D * ux - 1.5), Math.round(c[1] + D * uy - 1.5)]];
  }

  /* Greedy banner choice: maximise new city-buildable tiles weighted by closeness to the traps,
     plus covering uncovered trap tiles. */
  function bestNewBanner(ctx, st, rand) {
    const { S, city, ally } = ctx;
    paint(ctx, st);
    const terr = ctx.terr.slice(), occ = ctx.occ.slice();
    const tc = trapCentres(st);
    const trapTile = new Uint8Array(S * S);
    for (const [tx, ty] of st.t) for (let y = ty; y < ty + 3; y++) for (let x = tx; x < tx + 3; x++) if (x >= 0 && y >= 0 && x < S && y < S) trapTile[y * S + x] = 1;
    let best = null;
    for (let by = 3; by < S - 3; by++) for (let bx = 3; bx < S - 3; bx++) {
      const bi = by * S + bx;
      if (ally[bi] || occ[bi]) continue;
      let touch = false;
      for (let y = by - 4; y <= by + 4 && !touch; y++) for (let x = bx - 4; x <= bx + 4; x++) {
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        if (terr[y * S + x]) { touch = true; break; }
      }
      if (!touch) continue;
      let gain = 0;
      for (let y = by - 3; y <= by + 3; y++) for (let x = bx - 3; x <= bx + 3; x++) {
        const i = y * S + x;
        if (terr[i]) continue;
        if (trapTile[i]) gain += 30;
        if (city[i] || occ[i]) continue;
        const d = nearestDist(tc, x + 0.5, y + 0.5)[0];
        gain += 1 / (1 + (d / 8) * (d / 8));
      }
      gain += rand() * 0.05;
      if (!best || gain > best.gain) best = { gain, pos: [bx, by] };
    }
    return best ? best.pos : [ctx.hq[0] + 1, ctx.hq[1] + 1];
  }

  function anneal(ctx, st0, iters, rand, onTick) {
    const { S } = ctx;
    let cur = cloneState(st0), cs = score(ctx, cur);
    let best = cloneState(cur), bs = cs;
    const T0 = 20, T1 = 0.2;
    const clampB = (v) => Math.max(3, Math.min(S - 4, v));
    const clampT = (v) => Math.max(0, Math.min(S - 3, v));
    for (let it = 0; it < iters; it++) {
      const T = T0 * Math.pow(T1 / T0, it / iters);
      const nxt = cloneState(cur);
      const r = rand();
      if (r < 0.5 && nxt.b.length) {
        const b = nxt.b[(rand() * nxt.b.length) | 0];
        const m = rand() < 0.7 ? 1 : 3;
        b[0] = clampB(b[0] + Math.round((rand() * 2 - 1) * m));
        b[1] = clampB(b[1] + Math.round((rand() * 2 - 1) * m));
      } else if (r < 0.68 && nxt.b.length) {
        const j = (rand() * nxt.b.length) | 0;
        const others = nxt.b.filter((_, q) => q !== j);
        const anchors = [ctx.hq.map((v) => v + 1)].concat(others);
        const a = anchors[(rand() * anchors.length) | 0];
        const reach = a === anchors[0] ? 11 : 7;
        nxt.b[j] = [clampB(a[0] + Math.round((rand() * 2 - 1) * reach)), clampB(a[1] + Math.round((rand() * 2 - 1) * reach))];
      } else if (r < 0.88) {
        const t = nxt.t[(rand() * 2) | 0];
        t[0] = clampT(t[0] + Math.round((rand() * 2 - 1) * 2));
        t[1] = clampT(t[1] + Math.round((rand() * 2 - 1) * 2));
      } else {
        // shift a trap together with the banners nearest to it
        const k = (rand() * 2) | 0, t = nxt.t[k];
        const dx = Math.round((rand() * 2 - 1) * 2), dy = Math.round((rand() * 2 - 1) * 2);
        t[0] = clampT(t[0] + dx); t[1] = clampT(t[1] + dy);
        for (const b of nxt.b) {
          const dOwn = Math.hypot(b[0] - t[0], b[1] - t[1]), dOther = Math.hypot(b[0] - nxt.t[1 - k][0], b[1] - nxt.t[1 - k][1]);
          if (dOwn < dOther && dOwn < 12) { b[0] = clampB(b[0] + dx); b[1] = clampB(b[1] + dy); }
        }
      }
      const ns = score(ctx, nxt);
      if (ns.val <= cs.val || rand() < Math.exp((cs.val - ns.val) / T)) {
        cur = nxt; cs = ns;
        if (cs.val < bs.val) { best = cloneState(cur); bs = cs; }
      }
      if (onTick && (it & 255) === 0) onTick(it / iters, bs);
    }
    return { st: best, s: bs };
  }

  // ---------------------------------------------------------------- exact core packing (ILP)
  // nodeLimit (branch-and-bound nodes) gives the same answer on any machine; time is then only a safety net
  function solveLP(highs, lp, timeLimit, nodeLimit) {
    const o = { time_limit: timeLimit, mip_rel_gap: 0, output_flag: false };
    if (nodeLimit) o.mip_max_nodes = nodeLimit;
    return highs.solve(lp, o);
  }

  /* N slots per trap, minimum total distance to the slot's trap; windows given as anchor indices. */
  function coreILP(ctx, highs, win, st, N, dmax, timeLimit) {
    const { S } = ctx;
    const tc = trapCentres(st);
    const vars = [];   // {i, k, d}
    for (const i of win) {
      const x = i % S, y = (i / S) | 0;
      for (let k = 0; k < 2; k++) {
        const d = Math.hypot(x + 1 - tc[k][0], y + 1 - tc[k][1]);
        if (d <= dmax[k]) vars.push({ i, k, d });
      }
    }
    const tiles = new Map();
    vars.forEach((v, j) => { for (const t of [v.i, v.i + 1, v.i + S, v.i + S + 1]) { let a = tiles.get(t); if (!a) tiles.set(t, a = []); a.push(j); } });
    const L = ["Minimize", " obj: " + vars.map((v, j) => v.d.toFixed(5) + " x" + j).join(" + "), "Subject To"];
    for (let k = 0; k < 2; k++) L.push(" n" + k + ": " + vars.map((v, j) => (v.k === k ? "x" + j : null)).filter(Boolean).join(" + ") + " = " + N);
    let r = 0;
    for (const a of tiles.values()) if (a.length > 1) L.push(" t" + (r++) + ": " + a.map((j) => "x" + j).join(" + ") + " <= 1");
    L.push("Binary", " " + vars.map((v, j) => "x" + j).join(" "), "End");
    const sol = solveLP(highs, L.join("\n"), timeLimit);
    if (!sol || !sol.Columns || !/Optimal|Time limit/.test(sol.Status)) return null;
    const out = [];
    vars.forEach((v, j) => { const c = sol.Columns["x" + j]; if (c && c.Primal > 0.5) out.push(v); });
    if (out.filter((v) => v.k === 0).length !== N || out.filter((v) => v.k === 1).length !== N) return null;
    return { cities: out, optimal: sol.Status === "Optimal" };
  }

  const idealCache = {};
  /* Best possible average distance for N slots around one trap on open ground. */
  function idealAvg(highs, N) {
    if (idealCache[N]) return idealCache[N];
    const R = Math.ceil(Math.sqrt(N * 4 / Math.PI)) + 4, S = 2 * R + 3;
    const cands = [];
    for (let y = 0; y < S - 1; y++) for (let x = 0; x < S - 1; x++) {
      if (x + 1 >= R && x <= R + 2 && y + 1 >= R && y <= R + 2) continue;
      cands.push({ x, y, d: Math.hypot(x + 1 - (R + 1.5), y + 1 - (R + 1.5)) });
    }
    const tiles = new Map();
    cands.forEach((c, j) => { for (const t of [c.y * S + c.x, c.y * S + c.x + 1, (c.y + 1) * S + c.x, (c.y + 1) * S + c.x + 1]) { let a = tiles.get(t); if (!a) tiles.set(t, a = []); a.push(j); } });
    const L = ["Minimize", " obj: " + cands.map((c, j) => c.d.toFixed(5) + " x" + j).join(" + "), "Subject To", " n: " + cands.map((c, j) => "x" + j).join(" + ") + " = " + N];
    let r = 0;
    for (const a of tiles.values()) if (a.length > 1) L.push(" t" + (r++) + ": " + a.map((j) => "x" + j).join(" + ") + " <= 1");
    L.push("Binary", " " + cands.map((c, j) => "x" + j).join(" "), "End");
    const sol = solveLP(highs, L.join("\n"), 20);
    idealCache[N] = sol && sol.ObjectiveValue ? sol.ObjectiveValue / N : null;
    return idealCache[N];
  }

  // ---------------------------------------------------------------- filling the rest
  /* Maximum greedy packing of 2x2 slots on a mask; nearest-to-trap preferred among equal counts. */
  function maxFill(ctx, mask, bbox, tc) {
    const { S, used } = ctx;
    const win = windowsOf(ctx, mask, bbox);
    if (!win.length) return [];
    const dist = win.map((i) => nearestDist(tc, (i % S) + 1, ((i / S) | 0) + 1)[0]);
    const idx = win.map((_, q) => q);
    const orders = [idx.slice().sort((a, b) => dist[a] - dist[b]), idx.slice(), idx.slice().reverse()];
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const lat = (q) => (((win[q] % S) - a) & 1) | ((((win[q] / S) | 0) - b) & 1);
      orders.push(idx.slice().sort((p, q) => (lat(p) - lat(q)) || (dist[p] - dist[q])));
    }
    let best = null;
    for (const o of orders) {
      const stamp = ++ctx.stamp;
      const placed = [];
      let sum = 0;
      for (const q of o) {
        const i = win[q];
        if (used[i] === stamp || used[i + 1] === stamp || used[i + S] === stamp || used[i + S + 1] === stamp) continue;
        used[i] = used[i + 1] = used[i + S] = used[i + S + 1] = stamp;
        placed.push(i); sum += dist[q];
      }
      if (!best || placed.length > best.length || (placed.length === best.length && sum < best.sum)) { best = placed; best.sum = sum; }
    }
    return best;
  }

  function finalize(ctx, st, N, opts, highs, fixedCore) {
    const { S, ally, city } = ctx;
    const tc = trapCentres(st);
    const p = paint(ctx, st);
    const bbox = p.bbox;
    for (const [tx, ty] of st.t) { bbox[0] = Math.min(bbox[0], tx); bbox[1] = Math.min(bbox[1], ty); bbox[2] = Math.max(bbox[2], tx + 2); bbox[3] = Math.max(bbox[3], ty + 2); }
    const terr = ctx.terr.slice();

    // 1. core: N slots per trap (given, or exact over the territory)
    let core = fixedCore || null, exact = !!fixedCore;
    const greedy = core ? null : packBalanced(ctx, st, bbox, N, 5);
    if (!core && highs) {
      const dmax = [0, 1].map((k) => Math.max(...greedy.cities.filter((c) => c.k === k).map((c) => c.d), 0) + 2.5);
      const res = coreILP(ctx, highs, windowsOf(ctx, ctx.free, bbox), st, N, dmax, opts.ilpTime || 20);
      if (res) { core = res.cities; exact = res.optimal; }
    }
    if (!core) core = greedy.cities.map((c) => ({ i: c.i, k: c.k, d: c.d }));
    const pen = p.pen;

    const occAll = ctx.occ.slice();
    const mark = (i, w, code) => { for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) occAll[i + y * S + x] = code; };
    for (const c of core) mark(c.i, 2, 6);
    const freeMask = () => { const m = new Uint8Array(S * S); for (let i = 0; i < S * S; i++) m[i] = terr[i] && !city[i] && !occAll[i] ? 1 : 0; return m; };

    // 2. gathering node and statues: on the spots that cost the fewest extra slots, far from the traps
    const extras = [], missing = [];
    const placeExtra = (w, code, label) => {
      const base = freeMask();
      const before = maxFill(ctx, base, bbox, tc).length;
      let best = null;
      for (let y = bbox[1]; y <= bbox[3] - w + 1; y++) for (let x = bbox[0]; x <= bbox[2] - w + 1; x++) {
        let ok = true;
        for (let yy = y; yy < y + w && ok; yy++) for (let xx = x; xx < x + w; xx++) {
          const i = yy * S + xx;
          if (!terr[i] || occAll[i] || ally[i]) { ok = false; break; }
        }
        if (!ok) continue;
        const m = base.slice();
        for (let yy = y; yy < y + w; yy++) for (let xx = x; xx < x + w; xx++) m[yy * S + xx] = 0;
        const after = maxFill(ctx, m, bbox, tc).length;
        const far = nearestDist(tc, x + w / 2, y + w / 2)[0];
        const sc = (after - before) * 1000 + far;
        if (!best || sc > best.sc) best = { sc, x, y };
      }
      if (!best) { missing.push(label); return; }
      extras.push({ x: best.x, y: best.y, w, code });
      mark(best.y * S + best.x, w, code);
    };
    for (let q = 0; q < (opts.gatheringNodes ?? 1); q++) placeExtra(3, 4, "gathering node");
    for (let q = 0; q < (opts.statues ?? 3); q++) placeExtra(2, 5, "statue");

    // 3. the rest of the territory: extra slots
    const extraCities = maxFill(ctx, freeMask(), bbox, tc);
    for (const i of extraCities) mark(i, 2, 6);

    // 4. filler banners: 7x7 fully inside existing territory, plug every empty 2x2 left in the hive
    const pc = pockets(ctx, bbox);
    let holes = holeWindows(ctx, bbox, pc.pocket, occAll);
    const fillers = [];
    const inside7 = (bx, by) => {
      for (let y = by - 3; y <= by + 3; y++) for (let x = bx - 3; x <= bx + 3; x++) if (x < 0 || y < 0 || x >= S || y >= S || !terr[y * S + x]) return false;
      return true;
    };
    while (holes.length) {
      const cover = new Map();
      for (const h of holes) for (const i of [h, h + 1, h + S, h + S + 1]) {
        if (ally[i] || occAll[i] || !inside7(i % S, (i / S) | 0)) continue;
        cover.set(i, (cover.get(i) || 0) + 1);
      }
      if (!cover.size) break;
      let bi = -1, bc = 0;
      for (const [i, c] of cover) if (c > bc) { bc = c; bi = i; }
      occAll[bi] = 7;
      fillers.push([bi % S, (bi / S) | 0]);
      holes = holes.filter((h) => !(h === bi || h + 1 === bi || h + S === bi || h + S + 1 === bi));
    }

    // structural banner build order: breadth-first from the HQ
    const [hx, hy] = ctx.hq;
    const rects = [[hx - 6, hy - 6, hx + 8, hy + 8]].concat(st.b.map(([x, y]) => [x - 3, y - 3, x + 3, y + 3]));
    const order = [], done = new Uint8Array(rects.length); done[0] = 1;
    let frontier = [0];
    while (frontier.length) {
      const nf = [];
      for (const i of frontier) for (let j = 1; j < rects.length; j++) if (!done[j] && touches(rects[i], rects[j])) { done[j] = 1; nf.push(j); order.push(j - 1); }
      frontier = nf;
    }

    const toCity = (i, k, isExtra) => {
      const x = i % S, y = (i / S) | 0;
      const d = tc.map(([cx, cy]) => Math.hypot(x + 1 - cx, y + 1 - cy));
      return { x, y, d, k: k == null ? (d[0] <= d[1] ? 0 : 1) : k, extra: isExtra };
    };
    const cities = core.map((c) => toCity(c.i, c.k, false)).concat(extraCities.map((i) => toCity(i, null, true)));
    let territory = 0;
    for (let i = 0; i < S * S; i++) territory += terr[i];
    const coreD = core.map((c) => c.d);
    return {
      ox: ctx.ox, oy: ctx.oy, S, hq: [hx, hy], traps: st.t, banners: order.map((j) => st.b[j]), fillers, extras, cities,
      holesLeft: holes, missing, territory, pen: p.pen,
      stats: {
        perTrap: N, banners: st.b.length, fillers: fillers.length, extra: extraCities.length,
        extraPerTrap: [0, 1].map((k) => cities.filter((c) => c.extra && c.k === k).length),
        coreAvg: coreD.reduce((a, b) => a + b, 0) / coreD.length,
        coreAvgPerTrap: [0, 1].map((k) => { const v = core.filter((c) => c.k === k).map((c) => c.d); return v.reduce((a, b) => a + b, 0) / v.length; }),
        coreMax: Math.max(...coreD), exact,
      },
    };
  }

  // ---------------------------------------------------------------- ideal trap pattern
  const patternCache = {};
  /* Most compact N slots around one trap (minimum total distance to its centre), forced to
     4-fold rotational symmetry (the pinwheel players use; it is also the unconstrained optimum).
     Returns city anchors relative to the trap anchor. N is rounded down to a multiple of 4. */
  function idealPattern(highs, N) {
    N = Math.max(4, N - (N % 4));
    if (patternCache[N]) return patternCache[N];
    const R = Math.ceil(Math.sqrt((N * 4) / Math.PI)) + 4;
    const key = (x, y) => x + "," + y;
    const cand = [], idx = new Map();
    for (let y = -R; y <= R + 2; y++) for (let x = -R; x <= R + 2; x++) {
      if (x + 1 >= 0 && x <= 2 && y + 1 >= 0 && y <= 2) continue;
      idx.set(key(x, y), cand.length); cand.push([x, y]);
    }
    const d = ([x, y]) => Math.hypot(x - 0.5, y - 0.5);
    const rot = ([x, y]) => [1 - y, x];          // 90 degrees about the trap centre
    const seen = new Set(), orbits = [];
    cand.forEach((c) => {
      if (seen.has(key(...c))) return;
      const orb = [c];
      for (let r = rot(c); key(...r) !== key(...c); r = rot(r)) orb.push(r);
      orb.forEach((o) => seen.add(key(...o)));
      if (orb.some((o) => !idx.has(key(...o)))) return;
      const tiles = new Set();
      for (const o of orb) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const k = key(o[0] + dx, o[1] + dy);
        if (tiles.has(k)) return;
        tiles.add(k);
      }
      orbits.push(orb);
    });
    const tiles = new Map();
    orbits.forEach((orb, i) => { for (const o of orb) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const k = key(o[0] + dx, o[1] + dy); let a = tiles.get(k); if (!a) tiles.set(k, a = []); a.push(i); } });
    const L = ["Minimize", " obj: " + orbits.map((o, i) => o.reduce((a, c) => a + d(c), 0).toFixed(6) + " x" + i).join(" + "), "Subject To",
      " n: " + orbits.map((o, i) => o.length + " x" + i).join(" + ") + " = " + N];
    let r = 0;
    for (const a of tiles.values()) if (a.length > 1) L.push(" t" + (r++) + ": " + a.map((i) => "x" + i).join(" + ") + " <= 1");
    L.push("Binary", " " + orbits.map((o, i) => "x" + i).join(" "), "End");
    const sol = solveLP(highs, L.join("\n"), 30);
    const out = [];
    orbits.forEach((o, i) => { if (sol.Columns["x" + i].Primal > 0.5) out.push(...o); });
    out.sort((a, b) => d(a) - d(b));
    patternCache[N] = out;
    return out;
  }
  const mirrorPattern = (P) => P.map(([x, y]) => [1 - x, y]);
  // a slot whose mirror image is in the other cluster: worth this many tiles of distance in a refit
  const SYM_BONUS = 0.3;

  // ---------------------------------------------------------------- banners: set cover of the core
  /* Required tiles: every core city tile outside the HQ square. Candidates: free, alliance-buildable
     tiles whose 7x7 square covers at least one required tile. */
  function coverProblem(ctx, occ, req) {
    const { S, ally } = ctx;
    const cand = new Map();   // banner tile -> list of required indices
    req.forEach((t, ri) => {
      const x = t % S, y = (t / S) | 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const bx = x + dx, by = y + dy;
        if (bx < 3 || by < 3 || bx > S - 4 || by > S - 4) continue;
        const b = by * S + bx;
        if (occ[b] || ally[b]) continue;
        let a = cand.get(b); if (!a) cand.set(b, a = []); a.push(ri);
      }
    });
    return cand;
  }

  function greedyCover(req, cand) {
    const covered = new Uint8Array(req.length);
    let left = req.length, n = 0;
    const lists = [...cand.entries()];
    while (left > 0) {
      let best = null, bc = 0;
      for (const [b, a] of lists) { let c = 0; for (const ri of a) if (!covered[ri]) c++; if (c > bc) { bc = c; best = a; } }
      if (!best) return Infinity;
      for (const ri of best) if (!covered[ri]) { covered[ri] = 1; left--; }
      n++;
    }
    return n;
  }

  /* Minimum number of banners; among equal counts, the ones closest to the traps (weight = tie-break,
     kept far below 1 per banner so it never trades a banner for compactness). mirror (optional):
     banner tile -> its mirror image's tile; a banner whose image also stands earns 0.1 (0.2 a pair),
     still far below a banner, so symmetry never costs a banner but wins over compactness. */
  function exactCover(highs, req, cand, timeLimit, weight, mirror) {
    const ids = [...cand.keys()];
    const byReq = req.map(() => []);
    ids.forEach((b, j) => { for (const ri of cand.get(b)) byReq[ri].push(j); });
    if (byReq.some((a) => !a.length)) return null;
    const coef = (b) => (weight ? (1 + Math.min(weight(b), 30) / 1000).toFixed(6) + " " : "");
    const jOf = new Map(ids.map((b, j) => [b, j]));
    const pairs = [];
    if (mirror) ids.forEach((b, j) => { const m = jOf.get(mirror(b)); if (m !== undefined) pairs.push([j, m]); });
    const L = ["Minimize", " obj: " + ids.map((b, j) => coef(b) + "y" + j).join(" + ") + pairs.map((_, q) => " - 0.1 z" + q).join(""), "Subject To"];
    byReq.forEach((a, ri) => L.push(" r" + ri + ": " + a.map((j) => "y" + j).join(" + ") + " >= 1"));
    pairs.forEach(([j, m], q) => { L.push(" za" + q + ": z" + q + " - y" + j + " <= 0"); if (m !== j) L.push(" zb" + q + ": z" + q + " - y" + m + " <= 0"); });
    L.push("Binary", " " + ids.map((b, j) => "y" + j).join(" ") + pairs.map((_, q) => " z" + q).join(""), "End");
    const sol = solveLP(highs, L.join("\n"), timeLimit);
    if (!sol || !sol.Columns) return null;
    const out = [];
    ids.forEach((b, j) => { const c = sol.Columns["y" + j]; if (c && c.Primal > 0.5) out.push(b); });
    return { banners: out, optimal: sol.Status === "Optimal" };
  }

  /* Distance from a banner tile to the nearest trap centre (cover tie-break: keep banners inside). */
  const trapDist = (ctx, parts) => (b) => {
    const x = (b % ctx.S) + 0.5, y = ((b / ctx.S) | 0) + 0.5;
    return Math.min(...parts.map((p) => Math.hypot(x - p.tx - 1.5, y - p.ty - 1.5)));
  };

  /* Adds connector banners until every banner chains to the HQ (squares touching, corners count). */
  function connect(ctx, occ, banners) {
    const { S, ally } = ctx;
    const [hx, hy] = ctx.hq;
    const sq = (b) => { const x = b % S, y = (b / S) | 0; return [x - 3, y - 3, x + 3, y + 3]; };
    const hqRect = [hx - 6, hy - 6, hx + 8, hy + 8];
    const added = [];
    for (let guard = 0; guard < 30; guard++) {
      const all = banners.concat(added);
      const rects = [hqRect].concat(all.map(sq));
      const conn = new Uint8Array(rects.length); conn[0] = 1;
      const st = [0];
      while (st.length) { const i = st.pop(); for (let j = 1; j < rects.length; j++) if (!conn[j] && touches(rects[i], rects[j])) { conn[j] = 1; st.push(j); } }
      const lost = rects.filter((_, j) => !conn[j]);
      if (!lost.length) return added;
      const inSet = rects.filter((_, j) => conn[j]);
      // candidate touching the connected part, closest to (ideally touching) a lost square
      let best = null;
      for (let by = 3; by < S - 3; by++) for (let bx = 3; bx < S - 3; bx++) {
        const b = by * S + bx;
        if (occ[b] || ally[b] || all.includes(b)) continue;
        const r = [bx - 3, by - 3, bx + 3, by + 3];
        if (!inSet.some((q) => touches(q, r))) continue;
        let gap = Infinity;
        for (const q of lost) gap = Math.min(gap, Math.max(Math.max(q[0], r[0]) - Math.min(q[2], r[2]), Math.max(q[1], r[1]) - Math.min(q[3], r[3])));
        if (!best || gap < best.gap) best = { gap, b };
      }
      if (!best) return added;
      added.push(best.b);
    }
    return added;
  }

  // ---------------------------------------------------------------- driver
  /* Most compact N slots per trap around fixed traps, avoiding fixed ground obstacles, the HQ and
     the traps (nothing else exists yet). Returns cities and total distance, or null. */
  function coreAround(ctx, highs, traps, N, dmax, block) {
    const { S } = ctx;
    const tc = traps.map(([x, y]) => [x + 1.5, y + 1.5]);
    const vars = [];
    const r = Math.ceil(dmax) + 1;
    const seen = new Set();
    for (let k = 0; k < 2; k++) {
      const [tx, ty] = traps[k];
      for (let y = Math.max(1, ty - r); y <= Math.min(S - 3, ty + r + 2); y++) for (let x = Math.max(1, tx - r); x <= Math.min(S - 3, tx + r + 2); x++) {
        const i = y * S + x;
        if (block[i] || block[i + 1] || block[i + S] || block[i + S + 1]) continue;
        for (let kk = 0; kk < 2; kk++) {
          if (seen.has(i * 2 + kk)) continue;
          const d = Math.hypot(x + 1 - tc[kk][0], y + 1 - tc[kk][1]);
          if (d > dmax) continue;
          seen.add(i * 2 + kk);
          vars.push({ i, k: kk, d });
        }
      }
    }
    const tiles = new Map();
    vars.forEach((v, j) => { for (const t of [v.i, v.i + 1, v.i + S, v.i + S + 1]) { let a = tiles.get(t); if (!a) tiles.set(t, a = []); a.push(j); } });
    const L = ["Minimize", " obj: " + vars.map((v, j) => v.d.toFixed(5) + " x" + j).join(" + "), "Subject To"];
    for (let k = 0; k < 2; k++) {
      const terms = vars.map((v, j) => (v.k === k ? "x" + j : null)).filter(Boolean);
      if (terms.length < N) return null;
      L.push(" n" + k + ": " + terms.join(" + ") + " = " + N);
    }
    let rr = 0;
    for (const a of tiles.values()) if (a.length > 1) L.push(" t" + (rr++) + ": " + a.map((j) => "x" + j).join(" + ") + " <= 1");
    L.push("Binary", " " + vars.map((v, j) => "x" + j).join(" "), "End");
    const sol = solveLP(highs, L.join("\n"), 15);
    if (!sol || !sol.Columns || !/Optimal|Time limit/.test(sol.Status)) return null;
    const out = [];
    vars.forEach((v, j) => { const c = sol.Columns["x" + j]; if (c && c.Primal > 0.5) out.push(v); });
    if (out.filter((v) => v.k === 0).length !== N || out.filter((v) => v.k === 1).length !== N) return null;
    return { core: out, D: out.reduce((a, v) => a + v.d, 0), optimal: sol.Status === "Optimal" };
  }

  // ---------------------------------------------------------------- trap module (cluster + inner banners)
  const moduleCache = {};
  /* One trap on open ground: N slots plus the banners whose squares cover every slot, 4-fold
     symmetric, minimum total distance with at most K banners. Inner banners sit in single-tile
     gaps; the HQ square later makes some of them unnecessary. */
  function trapModule(highs, N, K) {
    N = Math.max(4, N - (N % 4));
    const ck = N + "/" + K;
    if (moduleCache[ck]) return moduleCache[ck];
    const key = (x, y) => x + "," + y;
    const isTrap = (x, y) => x >= 0 && x <= 2 && y >= 0 && y <= 2;
    const RC = Math.ceil(Math.sqrt((N * 4) / Math.PI)) + 4;
    const rotC = ([x, y]) => [1 - y, x], rotT = ([x, y]) => [2 - y, x];
    const dC = ([x, y]) => Math.hypot(x - 0.5, y - 0.5);
    const four = (c) => [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => [c[0] + dx, c[1] + dy]);
    const orbits = (cands, rot) => {
      const seen = new Set(), out = [];
      for (const c of cands) {
        if (seen.has(key(...c))) continue;
        const o = [c];
        for (let r = rot(c); key(...r) !== key(...c); r = rot(r)) o.push(r);
        o.forEach((q) => seen.add(key(...q)));
        out.push(o);
      }
      return out;
    };
    const cc = [];
    for (let y = -RC; y <= RC + 2; y++) for (let x = -RC; x <= RC + 2; x++) {
      if (four([x, y]).some(([a, b]) => isTrap(a, b))) continue;
      if (dC([x, y]) <= RC - 1) cc.push([x, y]);
    }
    const cityOrb = orbits(cc, rotC).filter((o) => { const s = new Set(); for (const c of o) for (const t of four(c)) { if (s.has(key(...t))) return false; s.add(key(...t)); } return true; });
    const tileUsers = new Map();
    cityOrb.forEach((o, i) => o.forEach((c) => four(c).forEach((t) => { const k = key(...t); let a = tileUsers.get(k); if (!a) tileUsers.set(k, a = new Set()); a.add(i); })));
    const bc = new Map();
    for (const k of tileUsers.keys()) {
      const [x, y] = k.split(",").map(Number);
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (!isTrap(x + dx, y + dy)) bc.set(key(x + dx, y + dy), [x + dx, y + dy]);
    }
    const banOrb = orbits([...bc.values()], rotT);
    const banOf = new Map();
    banOrb.forEach((o, j) => o.forEach((t) => banOf.set(key(...t), j)));
    const allTiles = new Map(bc);
    for (const k of tileUsers.keys()) allTiles.set(k, k.split(",").map(Number));
    const reps = orbits([...allTiles.values()], rotT).map((o) => o[0]);
    const L = ["Minimize", " obj: " + cityOrb.map((o, i) => (4 * dC(o[0])).toFixed(6) + " x" + i).join(" + "), "Subject To",
      " n: " + cityOrb.map((o, i) => "x" + i).join(" + ") + " = " + N / 4,
      " k: " + banOrb.map((o, j) => "b" + j).join(" + ") + " <= " + Math.floor(K / 4)];
    let r = 0;
    for (const t of reps) {
      const k = key(...t);
      const users = [...(tileUsers.get(k) || [])];
      const b = banOf.get(k);
      const terms = users.map((i) => "x" + i);
      if (b !== undefined) terms.push("b" + b);
      if (terms.length > 1) L.push(" p" + (r++) + ": " + terms.join(" + ") + " <= 1");
      if (users.length) {
        const cov = new Set();
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const bb = banOf.get(key(t[0] + dx, t[1] + dy)); if (bb !== undefined) cov.add(bb); }
        L.push(" c" + (r++) + ": " + users.map((i) => "x" + i).join(" + ") + " - " + [...cov].map((j) => "b" + j).join(" - ") + " <= 0");
      }
    }
    L.push("Binary", " " + cityOrb.map((o, i) => "x" + i).join(" ") + " " + banOrb.map((o, j) => "b" + j).join(" "), "End");
    const sol = solveLP(highs, L.join("\n"), 60);
    if (!sol || !sol.Columns || !/Optimal|Time limit/.test(sol.Status)) return null;
    const cities = [], banners = [];
    cityOrb.forEach((o, i) => { if (sol.Columns["x" + i].Primal > 0.5) cities.push(...o); });
    banOrb.forEach((o, j) => { if (sol.Columns["b" + j].Primal > 0.5) banners.push(...o); });
    cities.sort((a, b) => dC(a) - dC(b));
    return (moduleCache[ck] = { N, K, cities, banners, avg: cities.reduce((a, c) => a + dC(c), 0) / N });
  }
  const mirrorModule = (m) => ({ cities: m.cities.map(([x, y]) => [1 - x, y]), banners: m.banners.map(([x, y]) => [2 - x, y]) });

  const coverableCache = {};
  /* Most compact 4-fold symmetric cluster of N slots in which every slot tile is within 3 tiles
     (Chebyshev) of a tile that is neither slot nor trap, so a banner can reach it. The single-tile
     gaps this leaves are where the banners go. City anchors relative to the trap anchor. */
  function coverablePattern(highs, N) {
    N = Math.max(4, N - (N % 4));
    if (coverableCache[N]) return coverableCache[N];
    const key = (x, y) => x + "," + y;
    const isTrap = (x, y) => x >= 0 && x <= 2 && y >= 0 && y <= 2;
    const RC = Math.ceil(Math.sqrt((N * 4) / Math.PI)) + 5;
    const rotC = ([x, y]) => [1 - y, x], rotT = ([x, y]) => [2 - y, x];
    const dC = ([x, y]) => Math.hypot(x - 0.5, y - 0.5);
    const four = (c) => [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => [c[0] + dx, c[1] + dy]);
    const orbits = (cands, rot) => {
      const seen = new Set(), out = [];
      for (const c of cands) {
        if (seen.has(key(...c))) continue;
        const o = [c];
        for (let r = rot(c); key(...r) !== key(...c); r = rot(r)) o.push(r);
        o.forEach((q) => seen.add(key(...q)));
        out.push(o);
      }
      return out;
    };
    const cc = [];
    for (let y = -RC; y <= RC + 2; y++) for (let x = -RC; x <= RC + 2; x++) {
      if (four([x, y]).some(([a, b]) => isTrap(a, b))) continue;
      if (dC([x, y]) <= RC - 2) cc.push([x, y]);
    }
    const orb = orbits(cc, rotC).filter((o) => { const st = new Set(); for (const c of o) for (const t of four(c)) { if (st.has(key(...t))) return false; st.add(key(...t)); } return true; });
    const use = new Map();
    orb.forEach((o, i) => o.forEach((c) => four(c).forEach((t) => { const k = key(...t); if (!use.has(k)) use.set(k, new Map()); const m = use.get(k); m.set(i, (m.get(i) || 0) + 1); })));
    const reps = orbits([...use.keys()].map((k) => k.split(",").map(Number)), rotT).map((o) => o[0]);
    const L = ["Minimize", " obj: " + orb.map((o, i) => (4 * dC(o[0])).toFixed(6) + " x" + i).join(" + "), "Subject To",
      " n: " + orb.map((o, i) => "x" + i).join(" + ") + " = " + N / 4];
    let r = 0;
    for (const t of reps) {
      const users = use.get(key(...t));
      if (users.size > 1) L.push(" p" + (r++) + ": " + [...users.keys()].map((i) => "x" + i).join(" + ") + " <= 1");
      // if t is used, at least one tile within 3 of t is free: occupied(N3(t)) + used(t) <= |N3(t)|
      const coef = new Map();
      let free = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const u = [t[0] + dx, t[1] + dy];
        if (isTrap(...u)) continue;
        free++;
        const m = use.get(key(...u));
        if (m) for (const [i, c] of m) coef.set(i, (coef.get(i) || 0) + c);
      }
      for (const i of users.keys()) coef.set(i, (coef.get(i) || 0) + 1);
      L.push(" c" + (r++) + ": " + [...coef].map(([i, c]) => c + " x" + i).join(" + ") + " <= " + free);
    }
    L.push("Binary", " " + orb.map((o, i) => "x" + i).join(" "), "End");
    const sol = solveLP(highs, L.join("\n"), 60);
    const out = [];
    orb.forEach((o, i) => { if (sol.Columns["x" + i].Primal > 0.5) out.push(...o); });
    out.sort((a, b) => dC(a) - dC(b));
    return (coverableCache[N] = out);
  }

  /* Row statistics of a trap's slots, sorted by distance: row 1 = first 8 (pinwheel), row 2 = next
     16, row 3 = next 20, row 4 = the rest. */
  /* March time in seconds, as KSMapper shows it (centre to centre). */
  const marchSecs = (d) => Math.round(2.5 * d + 4);

  function rowAverages(ds) {
    ds = ds.slice().sort((a, b) => a - b);
    const cut = [0, 8, 24, 44, ds.length];
    const out = [];
    for (let r = 0; r < 4; r++) { const v = ds.slice(cut[r], cut[r + 1]); out.push(v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0); }
    return out;
  }

  /* Trap cluster rebuilt on the spot around ground obstacles (fixed HQ only): row 1 is the fixed
     pinwheel, row 2 is kept whole where it can be (heavy penalty per missing slot), rows 3-4 adapt.
     pat: the ideal pattern in the wanted orientation (anchors relative to the trap anchor).
     prefer (optional): set of slot anchors (context indices) worth a small bonus, e.g. the mirror
     of the other trap's slots, so the refit stays as symmetric as the obstacles allow. */
  function rowCluster(ctx, highs, tx, ty, pat, N, K, timeLimit, nodeLimit, prefer) {
    const { S, ally, city } = ctx;
    const R = ctx.R;
    const key = (x, y) => y * S + x;
    const inB = (x, y) => x >= 1 && y >= 1 && x < S - 2 && y < S - 2;
    const isTrap = (x, y) => x >= tx && x <= tx + 2 && y >= ty && y <= ty + 2;
    const isHQb = (x, y) => x >= R && x <= R + 2 && y >= R && y <= R + 2;
    const inSq = (x, y) => x >= R - 6 && x <= R + 8 && y >= R - 6 && y <= R + 8;
    const four = ([x, y]) => [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]];
    const dC = ([x, y]) => Math.hypot(x + 1 - tx - 1.5, y + 1 - ty - 1.5);
    const ring1 = pat.slice(0, 8).map(([x, y]) => [x + tx, y + ty]);
    const ring2 = new Set(pat.slice(8, 24).map(([x, y]) => key(x + tx, y + ty)));
    const r1 = new Set(ring1.map((c) => key(...c)));
    const r1T = new Set();
    for (const c of ring1) for (const t of four(c)) { if (!inB(...t) || isHQb(...t) || city[key(...t)]) return null; r1T.add(key(...t)); }
    const cands = [];
    for (let y = ty - 12; y <= ty + 14; y++) for (let x = tx - 12; x <= tx + 14; x++) {
      const c = [x, y];
      if (dC(c) > 10.59) continue;   // 30 s cap
      if (r1.has(key(x, y))) { cands.push({ c, fixed: true }); continue; }
      if (four(c).some((t) => !inB(...t) || isTrap(...t) || isHQb(...t) || city[key(...t)] || r1T.has(key(...t)))) continue;
      cands.push({ c, r2: ring2.has(key(x, y)) });
    }
    const use = new Map();
    cands.forEach((v, i) => four(v.c).forEach((t) => { const k = key(...t); let a = use.get(k); if (!a) use.set(k, a = []); a.push(i); }));
    const bIdx = new Map();
    for (const k of use.keys()) {
      const x = k % S, y = (k / S) | 0;
      if (inSq(x, y)) continue;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const bx = x + dx, by = y + dy, kk = key(bx, by);
        if (bIdx.has(kk) || !inB(bx, by) || isTrap(bx, by) || isHQb(bx, by) || r1T.has(kk) || ally[kk] || city[kk]) continue;
        bIdx.set(kk, bIdx.size);
      }
    }
    const obj = cands.map((v, i) => (dC(v.c) - (v.r2 ? 40 : 0) - (prefer && prefer.has(key(...v.c)) ? SYM_BONUS : 0)).toFixed(5) + " x" + i).join(" + ").replace(/\+ -/g, "- ");
    const L = ["Minimize", " obj: " + obj, "Subject To", " n: " + cands.map((v, i) => "x" + i).join(" + ") + " = " + N,
      " k: " + (bIdx.size ? [...bIdx.values()].map((j) => "b" + j).join(" + ") : "0 x0") + " <= " + K];
    cands.forEach((v, i) => { if (v.fixed) L.push(" f" + i + ": x" + i + " = 1"); });
    let r = 0;
    for (const [k, us] of use) {
      const b = bIdx.get(k);
      const terms = us.map((i) => "x" + i);
      if (b !== undefined) terms.push("b" + b);
      if (terms.length > 1) L.push(" p" + (r++) + ": " + terms.join(" + ") + " <= 1");
      const x = k % S, y = (k / S) | 0;
      if (!inSq(x, y)) {
        const cov = [];
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const bb = bIdx.get(key(x + dx, y + dy)); if (bb !== undefined) cov.push("b" + bb); }
        L.push(" c" + (r++) + ": " + us.map((i) => "x" + i).join(" + ") + (cov.length ? " - " + cov.join(" - ") : "") + " <= 0");
      }
    }
    L.push("Binary", " " + cands.map((v, i) => "x" + i).join(" ") + (bIdx.size ? " " + [...bIdx.values()].map((j) => "b" + j).join(" ") : ""), "End");
    const sol = solveLP(highs, L.join("\n"), timeLimit, nodeLimit);
    if (!sol || !sol.Columns || !/Optimal|limit/i.test(sol.Status)) return null;
    const out = [];
    cands.forEach((v, i) => { const c = sol.Columns["x" + i]; if (c && c.Primal > 0.5) out.push(v.c); });
    if (out.length !== N) return null;
    return { cities: out.map(([x, y]) => [x - tx, y - ty]), avg: out.reduce((a, c) => a + dC(c), 0) / N };
  }

  /* The user gives a central point; HQ positions within `radius` of it are all tried (0 = HQ exactly
     there). For each HQ, every library cluster (row 1 fixed pinwheel, row 2 whole, rows 3-4 shaped
     for K banners around the HQ square) is rotated to each side of the HQ; clean pairs are kept,
     the best per banner budget go to an exact banner cover. Results sorted by average distance. */
  async function solve(world, cx, cy, opts, onProgress, highs) {
    opts = Object.assign({ minCities: 120, designs: 8, radius: 15, perBudget: 3, maxHits: 8, refitNodes: 1000, refitTime: 120, refitMax: 0, bannerCost: 0.1, centreTie: 0.2, symCost: 1, extraSecs: 31 }, opts || {});
    // nearer Fertile Land is better (it gives cities a big bonus), but only as a tie-break: the
    // distance of a w x w piece to the Fertile square (Chebyshev, like the zones; 0 inside it)
    const fertDist = (x, y, w) => { const [x0, y0, x1, y1] = ZONES.fertile; return Math.max(0, x0 - (x + w - 1), x - x1, y0 - (y + w - 1), y - y1); };
    // while scanning: the traps' mean distance; for designs: every city's (stats.centre)
    const centreDist = (traps) => traps.reduce((a, t) => a + fertDist(t[0], t[1], 3), 0) / traps.length;
    // without refits (the default: they cost a lot of time for ~1% of march time and symmetry) only
    // clean clusters are kept, so the places per budget go to designs that can be built as they are
    const maxHits = opts.refitMax ? opts.maxHits : 0;
    // `list` sorted by val: take the best left, every item within T of it, nearest the centre first
    const tieRank = (list, val, cen, T) => {
      const left = list.slice(), out = [];
      while (left.length) {
        const lim = val(left[0]) + T + 1e-9;
        let n = 0;
        while (n < left.length && val(left[n]) <= lim) n++;
        out.push(...left.splice(0, n).sort((a, b) => cen(a) - cen(b) || val(a) - val(b)));
      }
      return out;
    };
    if (!highs) throw new Error("The exact solver (HiGHS) is required.");
    // clusters that don't keep row 2 whole (its 16 slots) break the rule that rows 1-2 never move
    const lib = (opts.library || []).filter((m) => m.cities.length === m.N && (m.r2kept === undefined || m.r2kept >= 16));
    if (!lib.length) throw new Error("No cluster library loaded.");
    // minCities is the number of cities wanted in all: the two clusters hold up to the library's
    // largest pair, extra slots in the free territory make up the rest
    const minC = opts.minCities;
    const coreMin = Math.min(minC, 2 * Math.max(...lib.map((m) => m.N)));
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const P = idealPattern(highs, 60);   // row definitions (first 8, next 16, ...) and the base pinwheel
    const ideal = P.slice(0, 48).reduce((a, [x, y]) => a + Math.hypot(x - 0.5, y - 0.5), 0) / 48;
    const rotA = ([x, y]) => [1 - y, x], rotV = ([u, v]) => [-v, u];
    // library entries in all 4 rotations (relative to the trap anchor)
    const variants = [];
    for (const m of lib) {
      let pat = m.cities, off = m.hq;
      for (let r = 0; r < 4; r++) {
        if (r) { pat = pat.map(rotA); off = rotV(off); }
        // rows 1-2 (the 24 nearest slots) must stand on clean ground; the rest may be re-fitted
        const order = pat.map((c, i) => [Math.hypot(c[0] - 0.5, c[1] - 0.5), i]).sort((a, b) => a[0] - b[0]);
        const inner = new Uint8Array(pat.length);
        for (let q = 0; q < 24 && q < order.length; q++) inner[order[q][1]] = 1;
        variants.push({ m, pat, off, rot: r, inner });
      }
    }
    // mirror images in the HQ's axes, relative to the trap anchor: "x" flips x about the HQ's middle
    // column, "y" flips y about its middle row
    const mirPat = (axis, pat) => pat.map(axis === "x" ? ([x, y]) => [1 - x, y] : ([x, y]) => [x, 1 - y]);
    const mirOff = (axis, off) => (axis === "x" ? [-off[0], off[1]] : [off[0], -off[1]]);
    const mirV = (v, axis) => ({ m: v.m, pat: mirPat(axis, v.pat), off: mirOff(axis, v.off), rot: v.rot, inner: v.inner, mir: axis, base: v });
    // the ideal pattern (rows 1-2 fixed in a refit) in a variant's orientation
    const idealOf = (v) => {
      if (v.base) return mirPat(v.mir, idealOf(v.base));
      let pat = v.m.chir ? mirrorPattern(P) : P;
      for (let r = 0; r < v.rot; r++) pat = pat.map(rotA);
      return pat;
    };
    const RAD = 40;
    function contextFor(hx, hy) {
      const ctx = makeContext(world, hx, hy, { radius: RAD });
      const { S, ally, city } = ctx;
      const R = ctx.R;
      const hqB = (j) => { const x = j % S, y = (j / S) | 0; return x >= R && x <= R + 2 && y >= R && y <= R + 2; };
      const inHqSq = (j) => { const x = j % S, y = (j / S) | 0; return x >= R - 6 && x <= R + 8 && y >= R - 6 && y <= R + 8; };
      const place = (tx, ty, pat) => {
        if (tx < 4 || ty < 4 || tx + 6 >= S || ty + 6 >= S) return null;
        const tiles = [], cityA = [];
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) { const j = (ty + y) * S + tx + x; if (hqB(j) || ally[j]) return null; tiles.push(j); }
        for (const [dx, dy] of pat) {
          const x = tx + dx, y = ty + dy;
          if (x < 1 || y < 1 || x + 2 >= S || y + 2 >= S) return null;
          const i = y * S + x;
          for (const j of [i, i + 1, i + S, i + S + 1]) { if (hqB(j) || city[j]) return null; tiles.push(j); }
          cityA.push(i);
        }
        return { tx, ty, cityA, tiles };
      };
      const problem = (parts) => {
        const occ = new Uint8Array(S * S);
        for (let i = 0; i < S * S; i++) occ[i] = city[i];
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) occ[(R + y) * S + R + x] = 1;
        const req = [];
        for (const part of parts) for (const j of part.tiles) { if (occ[j]) return null; occ[j] = 1; }
        for (const part of parts) for (const i of part.cityA) for (const j of [i, i + 1, i + S, i + S + 1]) if (!inHqSq(j)) req.push(j);
        return { occ, req, cover: coverProblem(ctx, occ, req) };
      };
      // mirror images in the HQ's axes (context coordinates): a placed cluster, its slots as a
      // preference set for a refit, a banner tile
      const mx = (axis, x, y, w) => (axis === "x" ? [2 * R + 3 - x - w, y] : [x, 2 * R + 3 - y - w]);
      const mirror = {
        part: (p, axis) => {
          const [tx, ty] = mx(axis, p.tx, p.ty, 3);
          return place(tx, ty, mirPat(axis, p.cityA.map((i) => [i % S - p.tx, ((i / S) | 0) - p.ty])));
        },
        pref: (p, axis) => new Set(p.cityA.map((i) => { const [x, y] = mx(axis, i % S, (i / S) | 0, 2); return y * S + x; })),
        banner: (axis) => (b) => { const [x, y] = mx(axis, b % S, (b / S) | 0, 1); return y * S + x; },
      };
      return { ctx, place, problem, mirror };
    }

    // 1. pair compatibility (clusters must not overlap) depends only on the variants: precompute once
    //    in HQ-relative coordinates; per HQ position only ground and map edges change.
    const G = 70, GO = 35;   // grid around the HQ anchor
    const tilesOf = (v) => {
      const tx = -v.off[0], ty = -v.off[1];
      const t = [];
      let x0 = tx, y0 = ty, x1 = tx + 2, y1 = ty + 2;
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) t.push((ty + y + GO) * G + tx + x + GO);
      for (const [dx, dy] of v.pat) {
        const x = tx + dx + GO, y = ty + dy + GO;
        t.push(y * G + x, y * G + x + 1, (y + 1) * G + x, (y + 1) * G + x + 1);
        x0 = Math.min(x0, tx + dx); y0 = Math.min(y0, ty + dy); x1 = Math.max(x1, tx + dx + 1); y1 = Math.max(y1, ty + dy + 1);
      }
      v.box = [x0, y0, x1, y1];
      return t;
    };
    const vt = variants.map(tilesOf);
    // keep, per trap position and budget, only the most compact variant
    const bestVar = new Map();
    variants.forEach((v, i) => { const k = v.off.join(",") + "|" + v.m.K + "|" + v.m.N; const j = bestVar.get(k); if (j === undefined || v.m.avg < variants[j].m.avg) bestVar.set(k, i); });
    const vids = [...bestVar.values()];
    const compat = [], mids = [], mcompat = [];
    {
      const stamp = new Int32Array(G * G);
      let st = 0;
      for (let a = 0; a < vids.length; a++) {
        const i = vids[a];
        st++;
        for (const t of vt[i]) stamp[t] = st;
        for (let b = a + 1; b < vids.length; b++) {
          const j = vids[b];
          if (variants[i].off[0] === variants[j].off[0] && variants[i].off[1] === variants[j].off[1]) continue;
          if (variants[i].m.N + variants[j].m.N < coreMin) continue;
          const bi = variants[i].box, bj = variants[j].box;
          let clash = false;
          if (!(bi[2] < bj[0] || bj[2] < bi[0] || bi[3] < bj[1] || bj[3] < bi[1])) for (const t of vt[j]) if (stamp[t] === st) { clash = true; break; }
          if (!clash) compat.push([i, j]);
        }
      }
      // symmetric pairs: each kept variant with its own mirror image on the other side of the HQ
      for (const i of vids) for (const axis of ["x", "y"]) {
        const v = variants[i], w = mirV(v, axis);
        if (w.off[0] === v.off[0] && w.off[1] === v.off[1]) continue;
        if (2 * v.m.N < coreMin) continue;
        const j = variants.length;
        variants.push(w);
        vt.push(tilesOf(w));
        st++;
        for (const t of vt[i]) stamp[t] = st;
        const bi = v.box, bj = w.box;
        let clash = false;
        if (!(bi[2] < bj[0] || bj[2] < bi[0] || bi[3] < bj[1] || bj[3] < bi[1])) for (const t of vt[j]) if (stamp[t] === st) { clash = true; break; }
        if (!clash) { mids.push(j); mcompat.push([i, j, axis]); }
      }
    }

    // forced trap positions (game coordinates; [BT1, BT2], either may be null): only pairs whose
    // traps stand there; if the library has no cluster at that offset, clusters are built on the spot
    const forced = (opts.traps || []).map((t, i) => (t ? { x: t[0], y: t[1], i } : null)).filter(Boolean);
    const tpos = (hx, hy, v) => [hx - v.off[0], hy - v.off[1]];
    const forcedOK = (hx, hy, A, B) => {
      const a = tpos(hx, hy, A), b = tpos(hx, hy, B);
      return forced.every((f) => (a[0] === f.x && a[1] === f.y) || (b[0] === f.x && b[1] === f.y));
    };

    // 2. scan HQ positions
    const positions = [];
    const rad = Math.max(0, opts.radius | 0);
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const hx = cx + dx, hy = cy + dy;
      if (!hqBlockReason(world, hx, hy)) positions.push([hx, hy]);
    }
    if (!positions.length) throw new Error("No valid HQ position within " + rad + " tiles of " + cx + "," + cy + ".");
    const best = new Map();   // banner budget -> list of {avg, hx, hy, A, B}
    const cap = opts.perBudget * 4;
    // the best `cap` per budget, by estimate, then nearer the centre, then first found: a total
    // order, so keeping a chunk's best first and merging them in scan order gives the same lists
    const keeper = (best) => (k, c) => {
      let a = best.get(k);
      if (!a) best.set(k, a = []);
      const z = a[a.length - 1];
      if (a.length >= cap && (c.avg > z.avg || (c.avg === z.avg && c.cd >= z.cd))) return;
      a.push(c);
      a.sort((p, q) => p.avg - q.avg || p.cd - q.cd);   // equal estimates: nearer the centre kept
      if (a.length > cap) a.length = cap;
    };
    const keep = keeper(best);
    const hydrate = (c) => Object.assign(c, { A: variants[c.i], B: variants[c.j] });
    // positions q0..q1-1; emit(k, candidate) with variants by index (plain data, for helper workers)
    const valid = new Uint8Array(variants.length);
    const scanRange = async (q0, q1, emit, progress) => {
      for (let q = q0; q < q1; q++) {
        const [hx, hy] = positions[q];
        let seq = 0;
        const ctx = makeContext(world, hx, hy, { radius: RAD });
        const R = ctx.R, S = ctx.S;
        for (const i of vids.concat(mids)) {
          const v = variants[i];
          const tx = R - v.off[0], ty = R - v.off[1];
          let ok = tx >= 4 && ty >= 4 && tx + 6 < S && ty + 6 < S, hits = 0;
          for (let y = 0; y < 3 && ok; y++) for (let x = 0; x < 3; x++) if (ctx.ally[(ty + y) * S + tx + x]) { ok = false; break; }
          if (ok) for (let q = 0; q < v.pat.length; q++) {
            const x = tx + v.pat[q][0], y = ty + v.pat[q][1];
            if (x < 1 || y < 1 || x + 2 >= S || y + 2 >= S) { ok = false; break; }
            const j = y * S + x;
            if (ctx.city[j] || ctx.city[j + 1] || ctx.city[j + S] || ctx.city[j + S + 1]) {
              if (v.inner[q] || ++hits > maxHits) { ok = false; break; }
            }
          }
          valid[i] = ok ? hits + 1 : 0;
        }
        // free pairs under their banner budget; symmetric pairs apart (budget + 1000), so they are
        // never crowded out by slightly better estimates (the symmetry is priced at the end)
        for (const [i, j, mir] of compat.concat(mcompat)) {
          if (!valid[i] || !valid[j]) continue;
          const A = variants[i], B = variants[j];
          if (forced.length && !forcedOK(hx, hy, A, B)) continue;
          const hA = valid[i] - 1, hB = valid[j] - 1;
          // each slot moved off an obstacle costs roughly 2 tiles of distance (estimate; re-fitted exactly later)
          const avg = (A.m.N * A.m.avg + B.m.N * B.m.avg + 2 * (hA + hB)) / (A.m.N + B.m.N);
          emit(A.m.K + B.m.K + (mir ? 1000 : 0), { avg, hx, hy, i, j, hA, hB, mir: mir || null, cd: centreDist([tpos(hx, hy, A), tpos(hx, hy, B)]), q, s: seq++ });
        }
        if (progress && (q % 4 === 0 || q === q1 - 1)) await progress(q);
      }
    };
    // a helper worker's share: its chunk's best per budget, in scan order
    if (opts.scanRange) {
      const mine = new Map();
      await scanRange(opts.scanRange[0], opts.scanRange[1], keeper(mine), null);
      return [...mine].flatMap(([k, a]) => a.map((c) => Object.assign(c, { k }))).sort((a, b) => a.q - b.q || a.s - b.s);
    }
    if (opts.scanPool && positions.length >= 64) {
      // spread over the helper workers in chunks; merged in scan order (same lists as one worker)
      // two chunks per helper: each chunk repeats the set-up (~0.4 s), so few large ones
      const n = Math.max(1, Math.min(Math.ceil(positions.length / 32), 2 * (opts.scanPool.size || 4))), jobs = [];
      for (let c = 0; c < n; c++) jobs.push([Math.floor((c * positions.length) / n), Math.floor(((c + 1) * positions.length) / n)]);
      let doneJobs = 0;
      const res = await opts.scanPool(jobs, () => { if (onProgress) onProgress({ stage: "hq", frac: ++doneJobs / jobs.length, found: 0 }); });
      for (const c of res.flat().sort((a, b) => a.q - b.q || a.s - b.s)) keep(c.k, hydrate(c));
    } else {
      await scanRange(0, positions.length, (k, c) => keep(k, hydrate(c)), async (q) => {
        if (onProgress) { onProgress({ stage: "hq", frac: (q + 1) / positions.length, found: best.size }); await tick(); }
      });
    }

    // 3. exact banner cover for the best per budget (distinct HQ + trap pairs)
    // refits are capped by count, not clock time, so every machine tries the same ones
    const finals = [], refits = new Map();
    let nRefits = 0;
    const budgets = [...best.keys()].sort((a, b) => a % 1000 - b % 1000 || a - b);
    // within a budget, estimates less than centreTie s apart (1 tile ~ 2.5 s): nearer the centre first
    for (const k of budgets) best.set(k, tieRank(best.get(k), (c) => c.avg, (c) => c.cd, opts.centreTie / 2.5));
    let total = 0;
    for (const k of budgets) total += Math.min(opts.perBudget, best.get(k).length);
    let done = 0;
    for (const k of budgets) {
      const seen = new Set();
      let n = 0;
      for (const c of best.get(k)) {
        if (n >= opts.perBudget) break;
        const sig = c.hx + "," + c.hy + "|" + c.A.off.join(",") + "," + c.A.m.K + "," + c.A.m.N + "|" + c.B.off.join(",") + "," + c.B.m.K + "," + c.B.m.N + "|" + (c.mir || "");
        if (seen.has(sig)) continue;
        seen.add(sig);
        n++;
        const { ctx, place, problem, mirror } = contextFor(c.hx, c.hy);
        const R = ctx.R;
        // clusters with slots on obstacles are re-fitted exactly (rows 1-2 kept, rows 3+ move);
        // `toward` (a placed cluster, symmetric pairs only): the refit leans to its mirror image
        const fitted = (v, hits, toward) => {
          if (!hits) return place(R - v.off[0], R - v.off[1], v.pat);
          // the same cluster at the same HQ comes up under several budgets: fit it once
          const key = c.hx + "," + c.hy + "|" + v.off.join(",") + "|" + v.m.N + "," + v.m.K + "," + v.m.chir + "," + v.rot + "," + (v.mir || "") +
            (toward ? "|" + toward.cityA.join(",") : "");
          let cities = refits.get(key);
          if (cities === undefined) {
            if (nRefits >= opts.refitMax) return null;   // out of refits: clean clusters only
            nRefits++;
            const res = rowCluster(ctx, highs, R - v.off[0], R - v.off[1], idealOf(v), v.m.N, v.m.K, opts.refitTime, opts.refitNodes,
              toward ? mirror.pref(toward, c.mir) : null);
            refits.set(key, cities = res ? res.cities : null);
          }
          return cities ? place(R - v.off[0], R - v.off[1], cities) : null;
        };
        const tries = [];
        if (!c.mir) {
          const pa = fitted(c.A, c.hA);
          tries.push([pa, pa && fitted(c.B, c.hB)]);
        } else if (!c.hA && !c.hB) tries.push([fitted(c.A, 0), fitted(c.B, 0)]);
        else {
          // symmetric pair near obstacles (one try, refits are the slow part): the side with more
          // obstacles is re-fitted and the other is its exact image; where the image is not clean,
          // that side re-fits too, leaning to the image (or stays ideal if it has no obstacles)
          const [X, hX, Y, hY] = c.hA >= c.hB ? [c.A, c.hA, c.B, c.hB] : [c.B, c.hB, c.A, c.hA];
          const x = fitted(X, hX);
          tries.push([x, x && (mirror.part(x, c.mir) || (hY ? fitted(Y, hY, x) : fitted(Y, 0)))]);
        }
        done++;
        if (onProgress) { onProgress({ stage: "refine", frac: done / total }); await tick(); }
        const tried = new Set();
        for (const [pa, pb2] of tries) {
          if (!pa || !pb2) continue;
          const tk = pa.cityA.join(",") + "|" + pb2.cityA.join(",");
          if (tried.has(tk)) continue;
          tried.add(tk);
          const pb = problem([pa, pb2]);
          if (!pb) continue;
          const ex = exactCover(highs, pb.req, pb.cover, 6, trapDist(ctx, [pa, pb2]), c.mir ? mirror.banner(c.mir) : null);
          if (!ex) continue;
          const occ = pb.occ.slice();
          for (const b of ex.banners) occ[b] = 1;
          const conn = connect(ctx, occ, ex.banners);
          finals.push({ c, ctx, parts: [pa, pb2], banners: ex.banners.concat(conn), connectors: conn.length, optimal: ex.optimal, mir: c.mir || null });
        }
      }
    }

    // 3. fixed HQ (or forced traps) with nothing clean: rebuild clusters on the spot, around the
    //    obstacles (rows 3-4 adapt); a forced trap takes the library's clusters of nearby offsets
    if (!finals.length && (rad === 0 || forced.length)) {
      let hx0 = cx, hy0 = cy;
      if (hqBlockReason(world, cx, cy)) { const p = positions.slice().sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy))[0]; hx0 = p[0]; hy0 = p[1]; }
      const { ctx, place, problem, mirror } = contextFor(hx0, hy0);
      const R = ctx.R;
      const groups = forced.length === 2 ? [[], []] : [[], []];   // slot 0: first forced trap (or free); slot 1: second (or free)
      for (const v of variants) {
        if (v.m.chir === undefined || v.base) continue;
        const pat = idealOf(v);
        if (!forced.length) { groups[0].push({ v, tx: R - v.off[0], ty: R - v.off[1], pat, near: 0 }); continue; }
        forced.forEach((f, gi) => {
          const fx = f.x - ctx.ox, fy = f.y - ctx.oy;
          const near = Math.max(Math.abs(R - fx - v.off[0]), Math.abs(R - fy - v.off[1]));
          groups[gi].push({ v, tx: fx, ty: fy, pat, near });
        });
        if (forced.length === 1) groups[1].push({ v, tx: R - v.off[0], ty: R - v.off[1], pat, near: 0 });
      }
      const fitGroup = async (reps, lim, base, span) => {
        // nearest offsets first; big enough for half the minimum first; at most 2 tries per size,
        // so the pairs can reach any minimum the library allows
        const out = [], perN = new Map(), half = coreMin / 2;
        let n = 0;
        for (const rp of reps.sort((a, b) => a.near - b.near || (a.v.m.N < half) - (b.v.m.N < half) || Math.abs(a.v.m.N - half) - Math.abs(b.v.m.N - half) || a.v.m.avg - b.v.m.avg)) {
          const k = rp.v.m.N + "/" + rp.v.off.join(",");
          if ((perN.get(k) || 0) >= (rp.near ? 2 : 1)) continue;
          perN.set(k, (perN.get(k) || 0) + 1);
          if (n++ >= lim) break;
          if (onProgress) { onProgress({ stage: "repair", frac: base + span * n / lim }); await tick(); }
          const res = rowCluster(ctx, highs, rp.tx, rp.ty, rp.pat, rp.v.m.N, rp.v.m.K, 10);
          if (!res) continue;
          const part = place(rp.tx, rp.ty, res.cities);
          if (part) out.push({ part, avg: res.avg, K: rp.v.m.K, N: rp.v.m.N });
        }
        return out;
      };
      // a forced trap: the library's clusters whose offset from the HQ is nearest to it
      for (const grp of forced.length ? groups.slice(0, forced.length) : []) {
        const lo = Math.min(...grp.map((r) => r.near));
        for (let i = grp.length - 1; i >= 0; i--) if (grp[i].near > lo + 3) grp.splice(i, 1);
      }
      const pairs = [];
      if (!forced.length) {
        const singles = await fitGroup(groups[0], 12, 0, 1);
        for (let i = 0; i < singles.length; i++) for (let j = i + 1; j < singles.length; j++) pairs.push([singles[i], singles[j]]);
        // symmetric pairs: each fitted cluster with its mirror image
        for (const a of singles) for (const axis of ["x", "y"]) {
          const p = mirror.part(a.part, axis);
          if (p && (p.tx !== a.part.tx || p.ty !== a.part.ty)) pairs.push([a, { part: p, avg: a.avg, K: a.K, N: a.N }, axis]);
        }
      } else {
        // the free trap (one forced) tries more offsets: near ones collide with the forced cluster
        const g0 = await fitGroup(groups[0], 10, 0, 0.4), g1 = await fitGroup(groups[1], forced.length === 1 ? 30 : 10, 0.4, 0.6);
        for (const a of g0) for (const b of g1) pairs.push([a, b]);
      }
      for (const [a, b, mir] of pairs) {
        if (a.N + b.N < coreMin) continue;
        const pb = problem([a.part, b.part]);
        if (!pb) continue;
        const ex = exactCover(highs, pb.req, pb.cover, 6, trapDist(ctx, [a.part, b.part]), mir ? mirror.banner(mir) : null);
        if (!ex) continue;
        const occ = pb.occ.slice();
        for (const bn of ex.banners) occ[bn] = 1;
        const conn = connect(ctx, occ, ex.banners);
        finals.push({ c: { hx: hx0, hy: hy0 }, ctx, parts: [a.part, b.part], banners: ex.banners.concat(conn), connectors: conn.length, optimal: ex.optimal, mir: mir || null });
      }
    }
    if (!finals.length) throw new Error("No clean layout found. Try another central point or a larger radius.");

    // 3b. polish: a library cluster is shaped on an empty map for its banner budget, and the banner
    //     cover only serves its slots, so faster free spots just outside the territory go unused. For
    //     each design, try one more banner (with its mirror image when the design has a mirror axis):
    //     the slowest cities of a trap (never rows 1-2, its 24 nearest) move to the faster spots it
    //     brings into territory. Kept when the mean march gain beats `bannerCost` per banner; banners
    //     the moves leave useless come down. Repeated while it pays. The polished design is added
    //     next to the original, so the ranking (loose cities, symmetry, score) picks.
    //     Every design is polished (`polishTop` limits it to the most promising: mean march + banner cost).
    if (opts.polish !== false) {
      const est = (f) => {
        const S = f.ctx.S;
        let sum = 0, n = 0;
        f.parts.forEach((p) => p.cityA.forEach((i) => { sum += marchSecs(Math.hypot((i % S) + 1 - p.tx - 1.5, ((i / S) | 0) + 1 - p.ty - 1.5)); n++; }));
        return sum / n + opts.bannerCost * f.banners.length;
      };
      const extra = [];
      for (const f of finals.slice().sort((a, b) => est(a) - est(b)).slice(0, opts.polishTop ?? Infinity)) { const p = polish(f); if (p) extra.push(p); }
      finals.push(...extra);
    }
    function polish(f) {
      const { ctx } = f, S = ctx.S, R = ctx.R;
      const parts = f.parts.map((p) => ({ tx: p.tx, ty: p.ty, cityA: p.cityA.slice() }));
      let banners = f.banners.slice();
      const tc = parts.map((p) => [p.tx + 1.5, p.ty + 1.5]);
      const secsOf = (i, k) => marchSecs(Math.hypot((i % S) + 1 - tc[k][0], ((i / S) | 0) + 1 - tc[k][1]));
      const near = (i) => { const d = tc.map(([x, y]) => Math.hypot((i % S) + 1 - x, ((i / S) | 0) + 1 - y)); return d[0] <= d[1] ? 0 : 1; };
      // rows 1-2 stay: each trap's 24 nearest slots
      const keep = new Set();
      parts.forEach((p, k) => p.cityA.slice().sort((a, b) => secsOf(a, k) - secsOf(b, k) || a - b).slice(0, 24).forEach((i) => keep.add(i)));
      const t0 = parts[0], t1 = parts[1];
      const axis = f.mir || (t0.ty === t1.ty && t0.tx + t1.tx === 2 * R ? "x" : t0.tx === t1.tx && t0.ty + t1.ty === 2 * R ? "y" : null);
      const mirB = (b) => { const x = b % S, y = (b / S) | 0; return axis === "x" ? y * S + (2 * R + 2 - x) : (2 * R + 2 - y) * S + x; };
      const nCore = parts[0].cityA.length + parts[1].cityA.length;
      const terrOf = (bs) => {
        const t = new Uint8Array(S * S);
        for (let y = R - 6; y <= R + 8; y++) for (let x = R - 6; x <= R + 8; x++) t[y * S + x] = 1;
        for (const b of bs) { const bx = b % S, by = (b / S) | 0; for (let y = by - 3; y <= by + 3; y++) for (let x = bx - 3; x <= bx + 3; x++) if (x >= 0 && y >= 0 && x < S && y < S) t[y * S + x] = 1; }
        return t;
      };
      const occOf = () => {
        const o = new Uint8Array(S * S);
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) o[(R + y) * S + R + x] = 1;
        for (const p of parts) {
          for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) o[(p.ty + y) * S + p.tx + x] = 1;
          for (const i of p.cityA) o[i] = o[i + 1] = o[i + S] = o[i + S + 1] = 1;
        }
        for (const b of banners) o[b] = 1;
        return o;
      };
      const covered = (terr, i) => terr[i] && terr[i + 1] && terr[i + S] && terr[i + S + 1];
      const chained = (bs) => {
        const rects = [[R - 6, R - 6, R + 8, R + 8]].concat(bs.map((b) => [b % S - 3, ((b / S) | 0) - 3, b % S + 3, ((b / S) | 0) + 3]));
        const ok = new Uint8Array(rects.length); ok[0] = 1;
        let ch = true;
        while (ch) { ch = false; for (let j = 1; j < rects.length; j++) if (!ok[j]) for (let i = 0; i < rects.length; i++) if (ok[i] && touches(rects[i], rects[j])) { ok[j] = 1; ch = true; break; } }
        return ok.every(Boolean);
      };
      let changed = false;
      for (let round = 0; round < 6; round++) {
        const terr = terrOf(banners), occ = occOf();
        const xs = [], ys = [];
        for (const p of parts) for (const i of p.cityA) { xs.push(i % S); ys.push((i / S) | 0); }
        const x0 = Math.max(4, Math.min(...xs) - 5), x1 = Math.min(S - 5, Math.max(...xs) + 6), y0 = Math.max(4, Math.min(...ys) - 5), y1 = Math.min(S - 5, Math.max(...ys) + 6);
        let best = null;
        const tried = new Set();
        for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) {
          const b = by * S + bx;
          if (occ[b] || ctx.ally[b] || tried.has(b)) continue;
          let add = [b];
          if (axis) { const m = mirB(b); if (m !== b) { if (m < 0 || m >= S * S || occ[m] || ctx.ally[m]) continue; add.push(m); } }
          add.forEach((q) => tried.add(q));
          const bs = banners.concat(add);
          const touchesTerr = (q) => { const qx = q % S, qy = (q / S) | 0; for (let y = qy - 4; y <= qy + 4; y++) for (let x = qx - 4; x <= qx + 4; x++) if (x >= 0 && y >= 0 && x < S && y < S && terr[y * S + x]) return true; return false; };
          if (!add.every(touchesTerr)) continue;
          const t2 = terrOf(bs), o2 = occ.slice();
          for (const q of add) o2[q] = 1;
          // new spots: fully in the new territory, not before (extra slots take those anyway), free ground
          const spots = [];
          for (const q of add) {
            const qx = q % S, qy = (q / S) | 0;
            for (let y = qy - 4; y <= qy + 3; y++) for (let x = qx - 4; x <= qx + 3; x++) {
              if (x < 1 || y < 1 || x + 2 >= S || y + 2 >= S) continue;
              const i = y * S + x;
              if (!covered(t2, i) || covered(terr, i)) continue;
              if (o2[i] || o2[i + 1] || o2[i + S] || o2[i + S + 1] || ctx.city[i] || ctx.city[i + 1] || ctx.city[i + S] || ctx.city[i + S + 1]) continue;
              const k = near(i);
              spots.push({ i, k, s: secsOf(i, k) });
            }
          }
          if (!spots.length) continue;
          spots.sort((p, q) => p.s - q.s || p.i - q.i);
          // the slowest movable cities of each trap, slowest first
          const slow = parts.map((p, k) => p.cityA.filter((i) => !keep.has(i)).map((i) => ({ i, s: secsOf(i, k) })).sort((p2, q) => q.s - p2.s || q.i - p2.i));
          const used = new Set(), moves = [];
          let gain = 0;
          const ptr = [0, 0];
          for (const sp of spots) {
            const t4 = [sp.i, sp.i + 1, sp.i + S, sp.i + S + 1];
            if (t4.some((t) => used.has(t))) continue;
            const c = slow[sp.k][ptr[sp.k]];
            if (!c || c.s <= sp.s) continue;
            ptr[sp.k]++;
            t4.forEach((t) => used.add(t));
            moves.push({ k: sp.k, from: c.i, to: sp.i });
            gain += c.s - sp.s;
          }
          const g = gain / nCore - opts.bannerCost * add.length;
          if (g > 1e-9 && (!best || g > best.g)) best = { g, add, moves };
        }
        // compaction: a banner (with its mirror image) comes down when the cities that lose their
        // territory can move to the fastest free spots still in territory (same trap, never rows
        // 1-2) for less than the banner is worth
        {
          const done = new Set();
          const free0 = [];
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const i = y * S + x;
            if (!covered(terr, i) || occ[i] || occ[i + 1] || occ[i + S] || occ[i + S + 1] || ctx.city[i] || ctx.city[i + 1] || ctx.city[i + S] || ctx.city[i + S + 1]) continue;
            const k = near(i);
            free0.push({ i, k, s: secsOf(i, k) });
          }
          free0.sort((p2, q) => p2.s - q.s || p2.i - q.i);
          for (const b of banners) {
            if (done.has(b)) continue;
            let drop = [b];
            if (axis) { const m = mirB(b); if (m !== b && banners.includes(m)) drop.push(m); }
            drop.forEach((q) => done.add(q));
            const rest = banners.filter((q) => !drop.includes(q));
            if (!chained(rest)) continue;
            const t2 = terrOf(rest);
            const lost = [];
            parts.forEach((p, k) => p.cityA.forEach((i) => { if (!covered(t2, i)) lost.push({ i, k }); }));
            if (lost.some((c) => keep.has(c.i))) continue;
            if (!lost.length) { const g = opts.bannerCost * drop.length; if (!best || g > best.g) best = { g, add: [], drop, moves: [] }; continue; }
            // free spots still in territory (spots made of a lost city's tiles are not tried)
            const spots = [[], []];
            for (const sp of free0) if (covered(t2, sp.i)) spots[sp.k].push(sp);
            const usedT = new Set(), moves = [];
            let loss = 0, ok = true;
            for (const c of lost.sort((p2, q) => secsOf(p2.i, p2.k) - secsOf(q.i, q.k) || p2.i - q.i)) {
              const sp = spots[c.k].find((q) => ![q.i, q.i + 1, q.i + S, q.i + S + 1].some((t) => usedT.has(t)));
              if (!sp) { ok = false; break; }
              [sp.i, sp.i + 1, sp.i + S, sp.i + S + 1].forEach((t) => usedT.add(t));
              moves.push({ k: c.k, from: c.i, to: sp.i });
              loss += sp.s - secsOf(c.i, c.k);
            }
            if (!ok) continue;
            const g = opts.bannerCost * drop.length - loss / nCore;
            if (g > 1e-9 && (!best || g > best.g)) best = { g, add: [], drop, moves };
          }
        }
        if (!best) break;
        for (const mv of best.moves) { const a = parts[mv.k].cityA; a[a.indexOf(mv.from)] = mv.to; }
        if (best.drop) banners = banners.filter((q) => !best.drop.includes(q));
        banners = banners.concat(best.add);
        changed = true;
        // banners the moves left useless come down (the chain must hold)
        for (let j = banners.length - 1; j >= 0; j--) {
          const rest = banners.filter((_, q) => q !== j), t = terrOf(rest);
          if (parts.every((p) => p.cityA.every((i) => covered(t, i))) && chained(rest)) banners = rest;
        }
      }
      if (!changed) return null;
      const placed = parts.map((p) => {
        const tiles = [];
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) tiles.push((p.ty + y) * S + p.tx + x);
        for (const i of p.cityA) tiles.push(i, i + 1, i + S, i + S + 1);
        return { tx: p.tx, ty: p.ty, cityA: p.cityA, tiles };
      });
      return { c: f.c, ctx, parts: placed, banners, connectors: f.connectors, optimal: f.optimal, mir: f.mir, polished: true };
    }

    // 4. designs, sorted by average distance (rows: 1 = 8 pinwheel slots, 2 = next 16, ...)
    const designs = finals.map((f) => {
      const { ctx } = f;
      const S = ctx.S, R = ctx.R;
      const parts = f.parts.slice().sort((a, b) => (b.tx - b.ty) - (a.tx - a.ty));   // BT1 = further right on screen
      // a forced trap keeps the label it was given
      const at = (p, t) => p.tx + ctx.ox === t.x && p.ty + ctx.oy === t.y;
      const f0 = forced.find((t) => t.i === 0), f1 = forced.find((t) => t.i === 1);
      if ((f0 && at(parts[1], f0)) || (!f0 && f1 && at(parts[0], f1))) parts.reverse();
      const traps = parts.map((p) => [p.tx, p.ty]);
      const cities = [];
      parts.forEach((part, k) => part.cityA.forEach((i) => {
        const x = i % S, y = (i / S) | 0;
        const d = traps.map(([tx, ty]) => Math.hypot(x + 1 - tx - 1.5, y + 1 - ty - 1.5));
        cities.push({ x, y, d, k, extra: false });
      }));
      const terr = new Set();
      const add = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) terr.add(y * S + x); };
      add(R - 6, R - 6, R + 8, R + 8);
      for (const b of f.banners) add(b % S - 3, ((b / S) | 0) - 3, b % S + 3, ((b / S) | 0) + 3);
      const used = new Uint8Array(S * S);
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) used[(R + y) * S + R + x] = 1;
      for (const p of parts) for (const j of p.tiles) used[j] = 1;
      for (const b of f.banners) used[b] = 1;
      // gathering node and statues (permanent, mandatory), inside the territory
      const extras = [], missing = [];
      {
        // gathering node: as equidistant from the two traps as possible and close to them, in the
        // HQ's territory if it fits (it plugs that ground like a filler). It may take the spot of a
        // few slots (8 each), the cheapest way to balance the design when the middle is full.
        {
          const inHq = (x, y) => x >= R - 6 && x <= R + 8 && y >= R - 6 && y <= R + 8;
          const cityAt = new Map();
          cities.forEach((c, n) => { for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) cityAt.set((c.y + j) * S + c.x + i, n); });
          for (const c of cities) for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) used[(c.y + j) * S + c.x + i] = 0;
          for (const p of parts) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) used[(p.ty + y) * S + p.tx + x] = 1;
          let best = null;
          for (const j0 of terr) {
            const x0 = j0 % S, y0 = (j0 / S) | 0;
            let ok = true, hq = true;
            const hit = new Set();
            for (let y = y0; y < y0 + 3 && ok; y++) for (let x = x0; x < x0 + 3; x++) {
              const j = y * S + x;
              if (!terr.has(j) || used[j] || ctx.ally[j]) { ok = false; break; }
              if (cityAt.has(j)) hit.add(cityAt.get(j));
              if (!inHq(x, y)) hq = false;
            }
            if (!ok || hit.size > 4) continue;
            const [d1, d2] = traps.map(([tx, ty]) => Math.hypot(x0 + 1.5 - tx - 1.5, y0 + 1.5 - ty - 1.5));
            const sc = 3 * Math.abs(d1 - d2) + 0.5 * (d1 + d2) + (hq ? 0 : 30) + 8 * hit.size;
            if (!best || sc < best.sc) best = { sc, x: x0, y: y0, hit };
          }
          if (best) {
            for (const n of [...best.hit].sort((a, b) => b - a)) cities.splice(n, 1);
            extras.push({ x: best.x, y: best.y, w: 3, code: 4 });
          } else missing.push("gathering node");
          for (const c of cities) for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) used[(c.y + j) * S + c.x + i] = 1;
          if (best) for (let y = best.y; y < best.y + 3; y++) for (let x = best.x; x < best.x + 3; x++) used[y * S + x] = 1;
        }
        // statues (only if opts.statues is set: with more city slots than players the alliance
        // always has room for them): never on a city slot and never
        // making the hive bigger. Inside the HQ's square they are always safe (that ground never
        // falls to a fence); elsewhere every tile within 3 of the statue must already lie within 3
        // of the hive's cities, HQ, traps or node, so the fence's anchors keep their line. Nearest
        // the HQ first.
        {
          const hc = R + 1.5;
          const inHq = (x, y) => x >= R - 6 && x <= R + 8 && y >= R - 6 && y <= R + 8;
          const dc = new Int16Array(S * S).fill(99), q = [];
          const seed = (x, y, w) => { for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) { const t = (y + j) * S + x + i; if (dc[t]) { dc[t] = 0; q.push(t); } } };
          seed(R, R, 3);
          for (const [tx, ty] of traps) seed(tx, ty, 3);
          for (const c of cities) seed(c.x, c.y, 2);
          for (const e of extras) seed(e.x, e.y, e.w);
          for (let h = 0; h < q.length; h++) {
            const t = q[h], x = t % S, y = (t / S) | 0, nd = dc[t] + 1;
            if (nd > 4) continue;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
              const u = yy * S + xx;
              if (dc[u] > nd) { dc[u] = nd; q.push(u); }
            }
          }
          const tucked = (x0, y0) => {
            for (let y = y0 - 3; y <= y0 + 4; y++) for (let x = x0 - 3; x <= x0 + 4; x++) {
              if (x < 0 || y < 0 || x >= S || y >= S || dc[y * S + x] > 3) return false;
            }
            return true;
          };
          for (let n = 0; n < (opts.statues ?? 0); n++) {
            let best = null;
            for (const j0 of terr) {
              const x0 = j0 % S, y0 = (j0 / S) | 0;
              let ok = true, hq = true;
              for (let y = y0; y < y0 + 2 && ok; y++) for (let x = x0; x < x0 + 2; x++) {
                const j = y * S + x;
                if (!terr.has(j) || used[j] || ctx.ally[j]) { ok = false; break; }
                if (!inHq(x, y)) hq = false;
              }
              if (!ok || (!hq && !tucked(x0, y0))) continue;
              const sc = Math.hypot(x0 + 1 - hc, y0 + 1 - hc) + (hq ? 0 : 10);
              if (!best || sc < best.sc) best = { sc, x: x0, y: y0 };
            }
            if (!best) { missing.push("statue"); continue; }
            for (let y = best.y; y < best.y + 2; y++) for (let x = best.x; x < best.x + 2; x++) used[y * S + x] = 1;
            extras.push({ x: best.x, y: best.y, w: 2, code: 5 });
          }
        }
      }
      // loose cities: with every other city in place, and the fence taking all free ground open to the
      // outside, can a city still stand 1 tile off its slot (sideways or diagonally) on friendly free
      // ground? Next to the HQ, node or statues it can't always be helped (3x3 and 2x2 don't mesh):
      // counted apart. Designs with loose cities elsewhere come after the others.
      const countLoose = () => {
        let loose = 0, looseFar = 0;
        const solid = (j) => used[j] || ctx.city[j] || ctx.ally[j];
        const outside = new Uint8Array(S * S), st = [];
        for (let i = 0; i < S; i++) for (const j of [i, (S - 1) * S + i, i * S, i * S + S - 1]) if (!solid(j) && !outside[j]) { outside[j] = 1; st.push(j); }
        while (st.length) {
          const j = st.pop(), x = j % S, y = (j / S) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
            const k = yy * S + xx;
            if (!outside[k] && !solid(k)) { outside[k] = 1; st.push(k); }
          }
        }
        const hole = (x, y) => { const j = y * S + x; return x >= 0 && y >= 0 && x < S && y < S && !solid(j) && !outside[j] && terr.has(j); };
        const fixedRects = [[R, R, R + 2, R + 2]].concat(extras.map((e) => [e.x, e.y, e.x + e.w - 1, e.y + e.w - 1]));
        // a shift counts as next to the HQ / node / statues when the gap it slides into touches one
        // (corners count): that gap is the 3x3 / 2x2 mismatch
        const nearFixed = (x, y) => fixedRects.some((r) => touches(r, [x, y, x, y]));
        for (const c of cities) {
          let can = false, far = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            let ok = true, near = false;
            for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
              const x = c.x + dx + i, y = c.y + dy + j;
              if (x >= c.x && x <= c.x + 1 && y >= c.y && y <= c.y + 1) continue;   // its own tile
              if (!hole(x, y)) { ok = false; break; }
              if (nearFixed(x, y)) near = true;
            }
            if (!ok) continue;
            can = true;
            if (!near) far = true;
          }
          if (can) loose++;
          if (far) looseFar++;
        }
        return { loose, looseFar };
      };
      // the design's mirror axis: a symmetric pair's, or the one its traps happen to share
      const [t0, t1] = traps;
      const axis = f.mir || (t0[1] === t1[1] && t0[0] + t1[0] === 2 * R ? "x" : t0[0] === t1[0] && t0[1] + t1[1] === 2 * R ? "y" : null);
      // extra slots: every free 2x2 left inside the territory within extraSecs (31 s) of a trap, nearest first
      // (the fence takes back the ones it needs);
      // farther ones, nearest first, only while the cities wanted (minCities) are not reached. With
      // a mirror axis, each slot taken brings its image along when that is free too.
      {
        const ok = (j) => terr.has(j) && !used[j] && !ctx.city[j];
        const free4 = (x, y) => { if (x < 0 || y < 0 || x + 1 >= S || y + 1 >= S) return false; const j = y * S + x; return ok(j) && ok(j + 1) && ok(j + S) && ok(j + S + 1); };
        const slot = (x, y) => { const d = traps.map(([tx, ty]) => Math.hypot(x + 1 - tx - 1.5, y + 1 - ty - 1.5)); return { x, y, d, k: d[0] <= d[1] ? 0 : 1 }; };
        const cand = [];
        for (const j of terr) if (free4(j % S, (j / S) | 0)) cand.push(slot(j % S, (j / S) | 0));
        cand.sort((a, b) => a.d[a.k] - b.d[b.k] || a.y - b.y || a.x - b.x);
        const take = (c) => {
          for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) used[(c.y + j) * S + c.x + i] = 1;
          cities.push({ x: c.x, y: c.y, d: c.d, k: c.k, extra: true });
        };
        const undo = () => {
          const c = cities.pop();
          for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) used[(c.y + j) * S + c.x + i] = 0;
        };
        // a slot (with its image) that would leave a city loose away from the HQ / node is skipped:
        // extra slots must hold like the rest
        let farNow = countLoose().looseFar;
        for (const far of [false, true]) for (const c of cand) {
          const secs = marchSecs(c.d[c.k]);
          if (far ? secs <= opts.extraSecs || cities.length >= minC : secs > opts.extraSecs) continue;
          if (!free4(c.x, c.y)) continue;
          take(c);
          let n = 1;
          if (axis) {
            const [mx, my] = axis === "x" ? [2 * R + 1 - c.x, c.y] : [c.x, 2 * R + 1 - c.y];
            if (free4(mx, my)) { take(slot(mx, my)); n++; }
          }
          const f2 = countLoose().looseFar;
          if (f2 > farNow) { while (n--) undo(); } else farNow = f2;
        }
      }
      const { loose, looseFar } = countLoose();
      // core = the fastest of each trap, as many as its cluster brought; the rest are extra slots
      for (const k of [0, 1]) {
        const mine = cities.filter((c) => c.k === k), n = mine.filter((c) => !c.extra).length;
        mine.sort((a, b) => a.d[k] - b.d[k] || a.y - b.y || a.x - b.x).forEach((c, i) => { c.extra = i >= n; });
      }
      const coreCities = cities.filter((c) => !c.extra);
      const rows = [0, 1].map((k) => rowAverages(coreCities.filter((c) => c.k === k).map((c) => c.d[k])));
      const coreD = coreCities.map((c) => c.d[c.k]);
      const nCore = [0, 1].map((k) => coreCities.filter((c) => c.k === k).length);
      const extraPerTrap = [0, 1].map((k) => cities.filter((c) => c.extra && c.k === k).length);
      let under = 0;
      for (const c of cities) for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const x = c.x + i, y = c.y + j; if (x >= R - 6 && x <= R + 8 && y >= R - 6 && y <= R + 8) under++; }
      const bl = f.banners.map((b) => [b % S, (b / S) | 0]);
      // symmetry: share of the hive's pieces (cities, banners, traps, node, statues) whose mirror image
      // in the HQ's middle column (or row) is the same kind of piece; pieces straddling the axis that
      // can't be their own image (a 2x2 on a 3-wide middle) don't count either way. Best axis.
      const pieces = cities.map((c) => ["c", c.x, c.y, 2]).concat(bl.map(([x, y]) => ["b", x, y, 1]), traps.map(([x, y]) => ["t", x, y, 3]),
        extras.map((e) => ["e" + e.w, e.x, e.y, e.w]));
      let sym = 0, symAxis = null;
      for (const ax of ["x", "y"]) {
        const have = new Set(pieces.map(([t, x, y]) => t + x + "," + y));
        let n = 0, hit = 0;
        for (const [t, x, y, w] of pieces) {
          const [mx, my] = ax === "x" ? [2 * R + 3 - x - w, y] : [x, 2 * R + 3 - y - w];
          const a = ax === "x" ? x : y, m = ax === "x" ? mx : my;
          if (m !== a && Math.abs(m - a) < w) continue;   // overlaps its own image
          n++;
          if (have.has(t + mx + "," + my)) hit++;
        }
        const v = n ? hit / n : 0;
        if (v > sym) { sym = v; symAxis = ax; }
      }
      const rects = [[R - 6, R - 6, R + 8, R + 8]].concat(bl.map(([x, y]) => [x - 3, y - 3, x + 3, y + 3]));
      const order = [], dn = new Uint8Array(rects.length); dn[0] = 1;
      let frontier = [0];
      while (frontier.length) { const nf = []; for (const i of frontier) for (let j = 1; j < rects.length; j++) if (!dn[j] && touches(rects[i], rects[j])) { dn[j] = 1; nf.push(j); order.push(j - 1); } frontier = nf; }
      const d = {
        ox: ctx.ox, oy: ctx.oy, S, hq: [R, R], traps, banners: order.map((j) => bl[j]), fillers: [], extras, cities,
        holesLeft: [], missing, territory: terr.size, k: f.banners.length, ideal,
        stats: {
          perTrap: nCore, banners: f.banners.length, fillers: 0, extra: extraPerTrap[0] + extraPerTrap[1], extraPerTrap,
          total: cities.length,
          coreAvg: coreD.reduce((a, b) => a + b, 0) / coreD.length,
          coreAvgPerTrap: [0, 1].map((k) => { const v = cities.filter((c) => c.k === k && !c.extra).map((c) => c.d[k]); return v.reduce((a, b) => a + b, 0) / v.length; }),
          coreMax: Math.max(...coreD), rows, underHq: under, coreTiles: coreD.length * 4, connectors: f.connectors, coverOptimal: f.optimal,
          secs: [0, 1].map((k) => { const v = cities.filter((c) => c.k === k && !c.extra).map((c) => marchSecs(c.d[k])); return { avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v) }; }),
          secsAll: [0, 1].map((k) => { const v = cities.filter((c) => c.k === k).map((c) => marchSecs(c.d[k])); return { avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v), n: v.length }; }),
          hqShift: [ctx.ox + R - cx, ctx.oy + R - cy],
          sym, symAxis, symPair: !!f.mir, short: Math.max(0, minC - cities.length), loose, looseFar, polished: !!f.polished,
        },
      };
      const gd = toGameDesign(d);
      gd.stats.centre = gd.cities.reduce((a, c) => a + fertDist(c.x, c.y, 2), 0) / gd.cities.length;
      return gd;
    });
    // efficiency first: mean march time (KSMapper's rounded seconds, to 0.1 s), then fewer banners
    const eff = (d) => { const n = d.stats.perTrap; return Math.round(((n[0] * d.stats.secs[0].avg + n[1] * d.stats.secs[1].avg) / (n[0] + n[1])) * 10) / 10; };
    // efficiency first, but a banner is worth `bannerCost` seconds of average march time
    // and full asymmetry is worth `symCost` seconds (players read aligned, mirrored hives far more easily)
    const score = (d) => { const n = d.stats.perTrap; return (n[0] * d.stats.secs[0].avg + n[1] * d.stats.secs[1].avg) / (n[0] + n[1]) + opts.bannerCost * d.k + opts.symCost * (1 - d.stats.sym); };
    // a design with room for every statue and the node comes first, whatever its score; designs
    // within centreTie s of the best left: traps nearer the map centre first
    // then the ones with all the cities wanted
    // then the ones that hold every city (no loose city away from the HQ / node)
    const grp = (d) => 4 * d.missing.length + (d.stats.short ? 2 : 0) + (d.stats.looseFar ? 1 : 0);
    const order = (a, b) => grp(a) - grp(b) || score(a) - score(b) || a.k - b.k || a.stats.coreAvg - b.stats.coreAvg;
    const rank = (list) => {
      const out = [];
      for (const m of [...new Set(list.map(grp))].sort((a, b) => a - b))
        out.push(...tieRank(list.filter((d) => grp(d) === m).sort(order), score, (d) => d.stats.centre, opts.centreTie));
      return out;
    };
    designs.splice(0, designs.length, ...rank(designs));
    if (designs.some((d) => !d.missing.length)) for (let i = designs.length - 1; i >= 0; i--) if (designs[i].missing.length) designs.splice(i, 1);
    // the list follows the ranking; a design that is a better one moved by a tile or two (same traps
    // relative to the HQ, HQ within 2 tiles) is left out
    const out = [];
    const rel = (d) => d.traps.map((t) => (t[0] - d.hq[0]) + "," + (t[1] - d.hq[1])).join("|");
    for (const d of designs) {
      if (out.length >= opts.designs) break;
      if (out.some((e) => rel(e) === rel(d) && Math.max(Math.abs(e.hq[0] - d.hq[0]), Math.abs(e.hq[1] - d.hq[1])) <= 2)) continue;
      out.push(d);
    }
    return out;
  }

  function toGameDesign(d) {
    const G = ([x, y]) => [x + d.ox, y + d.oy];
    return {
      k: d.k, ideal: d.ideal,
      hq: G(d.hq),
      traps: d.traps.map(G),
      banners: d.banners.map(G),
      fillers: d.fillers.map(G),
      extras: d.extras.map((e) => ({ type: e.code === 4 ? "node" : "statue", x: e.x + d.ox, y: e.y + d.oy, w: e.w })),
      cities: d.cities.map((c) => ({ x: c.x + d.ox, y: c.y + d.oy, d: c.d.map((v) => Math.round(v * 100) / 100), k: c.k, extra: c.extra })),
      holesLeft: d.holesLeft.map((i) => [i % d.S + d.ox, ((i / d.S) | 0) + d.oy]),
      missing: d.missing, territory: d.territory, stats: d.stats,
    };
  }

  /* Slot labels: BTn-001... by distance to that trap, core slots first, extra slots after. */
  function labelCities(design) {
    const lab = new Map();
    for (let k = 0; k < 2; k++) {
      const mine = design.cities.filter((c) => c.k === k);
      const sorted = mine.filter((c) => !c.extra).sort((a, b) => a.d[k] - b.d[k]).concat(mine.filter((c) => c.extra).sort((a, b) => a.d[k] - b.d[k]));
      sorted.forEach((c, n) => lab.set(c, "BT" + (k + 1) + "-" + String(n + 1).padStart(3, "0")));
    }
    return lab;
  }

  /* ksmapper import CSV: type,X,Y,label,#color,seq (no header). */
  function toCsv(design, tag) {
    tag = tag || "HIVE";
    const rows = [];
    let seq = 1;
    rows.push(["hq", ...design.hq, tag, "#8e44ad", seq++]);
    design.traps.forEach((t, i) => rows.push(["beartrap", ...t, "BT" + (i + 1), "#c0392b", seq++]));
    design.banners.forEach((b) => rows.push(["banner", ...b, tag, "#80ff80", seq++]));
    design.fillers.forEach((b) => rows.push(["banner", ...b, tag + " fill", "#b0e0b0", seq++]));
    design.extras.forEach((e) => rows.push([e.type === "node" ? "obs3" : "obs2", e.x, e.y, e.type === "node" ? "Gathering node" : "Statue", "#7f8c8d", seq++]));
    const lab = labelCities(design);
    const sorted = design.cities.slice().sort((a, b) => lab.get(a).localeCompare(lab.get(b)));
    for (const c of sorted) rows.push(["city", c.x, c.y, lab.get(c), c.k === 0 ? (c.extra ? "#85c1e9" : "#3498db") : (c.extra ? "#f5cba7" : "#e67e22"), seq++]);
    return rows.map((r) => r.join(",")).join("\n") + "\n";
  }

  const api = { buildWorld, hqBlockReason, solve, toCsv, labelCities, idealAvg, idealPattern, rowAverages, marchSecs, MAP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Hive = api;
})(typeof self !== "undefined" ? self : this);
