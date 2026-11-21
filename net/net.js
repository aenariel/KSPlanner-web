/* KSPlanner banner network optimiser (step 3).
 *
 * Given an alliance's Badland HQ, builds a banner network that reaches one outpost of each of the
 * 12 kinds and captures resource nodes in a target balance, with as few banners as possible and
 * as few "empty" banners (banners no captured node depends on) as possible.
 *
 * Game rules (README): HQ 3x3 projects 15x15 centred on its middle tile; a banner 1x1 projects
 * 7x7 centred on itself; a banner's square must touch (corners count) the square of the HQ or of a
 * banner already chained to it, so two banners link when their tiles are at most 7 apart
 * (Chebyshev) and a banner links to the HQ when it is within 10..12 tiles of its lower-left tile.
 * Links are checked on owned tiles only (KSMapper's rule, stricter than the game's near an
 * outpost zone), so a plan is valid in both. A banner stands on a free tile. A resource node (2x2) counts when fully inside territory. An
 * outpost counts when territory touches its 15x15 no-build zone, whose tiles are never owned.
 * Coordinates are lower-left tiles. Other alliances appear only as enemy banners and HQs given in
 * opts.enemies: their squares are never ours and take no banner. opts.forced / opts.excluded list
 * outposts (lower-left tiles) the network must reach / must not count on.
 *
 * Method: pass 1 builds a network with as many resources as it can (the outposts reached on the
 * way, every bridge chosen to complete nodes), pass 2 takes away every banner the outposts, the
 * links and the resource targets don't need, then a local search removes and re-routes banners
 * while that lowers the cost (banners + emptyWeight per empty banner). Several variants run (order
 * of the work, choice of outposts) and the cheapest is kept.
 *
 * Runs in a browser worker or in Node (module.exports). Needs a world from Hive.buildWorld.
 */
(function (root) {
  "use strict";
  const MAP = 1200;
  const KINDS = ["Builder's Guild 1", "Builder's Guild 3", "Armory 2", "Armory 4", "Scholar's 1", "Scholar's 3",
    "Arsenal 2", "Arsenal 4", "Forager 1", "Harvest 1", "Drill Camp 2", "Frontier 3"];
  const TYPES = ["bread", "wood", "stone", "iron"];
  const NODE_RATE = 3600;   // per hour, every node, everywhere

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

  // ---------------------------------------------------------------- static data
  function prepare(world, enemies) {
    const base = prepareBase(world);
    if (!enemies || !enemies.length) return base;
    const key = JSON.stringify(enemies);
    if (world._netE && world._netE.key === key) return world._netE.P;
    // other alliances' territory: never ours, no banner on it (they built first)
    const noOwn = base.noOwn.slice();
    for (const e of enemies) {
      const r = e.type === "hq" ? [e.x - 6, e.y - 6, e.x + 8, e.y + 8] : [e.x - 3, e.y - 3, e.x + 3, e.y + 3];
      for (let y = Math.max(0, r[1]); y <= Math.min(MAP - 1, r[3]); y++)
        for (let x = Math.max(0, r[0]); x <= Math.min(MAP - 1, r[2]); x++) noOwn[y * MAP + x] = 1;
    }
    const outposts = base.outposts.map((o) => Object.assign({}, o, { ring: o.ring.filter((c) => !noOwn[c]) }));
    const P = Object.assign({}, base, { noOwn, outposts, zI: integralOf(noOwn), enemies: enemies.length });
    world._netE = { key, P };
    return P;
  }

  function integralOf(mask) {
    const zI = new Int32Array((MAP + 1) * (MAP + 1));
    for (let y = 0; y < MAP; y++) {
      let row = 0;
      for (let x = 0; x < MAP; x++) { row += mask[y * MAP + x]; zI[(y + 1) * (MAP + 1) + x + 1] = zI[y * (MAP + 1) + x + 1] + row; }
    }
    return zI;
  }

  function prepareBase(world) {
    if (world._net) return world._net;
    const N = MAP * MAP;
    const noOwn = new Uint8Array(N);         // outpost no-build zones: never owned
    const nodeAt = new Int32Array(N).fill(-1);
    const ns = world.nodeSize || 2;
    const nodes = world.nodes.map((n, i) => ({ i, type: n.type, t: TYPES.indexOf(n.type), x: n.x, y: n.y }));
    for (const n of nodes) for (let dy = 0; dy < ns; dy++) for (let dx = 0; dx < ns; dx++) nodeAt[(n.y + dy) * MAP + n.x + dx] = n.i;
    const outposts = [];
    for (const s of world.structures) {
      const k = KINDS.indexOf(s.name);
      if (k < 0) continue;
      const fz = s.forbidden_zone;
      const fx = Math.round(s.x + s.size / 2 - fz / 2), fy = Math.round(s.y + s.size / 2 - fz / 2);
      for (let y = fy; y < fy + fz; y++) for (let x = fx; x < fx + fz; x++) noOwn[y * MAP + x] = 1;
      outposts.push({ k, name: s.name, x: s.x, y: s.y, fx, fy, fz, ring: [] });
    }
    for (const o of outposts) {
      for (let y = o.fy - 1; y <= o.fy + o.fz; y++) for (let x = o.fx - 1; x <= o.fx + o.fz; x++) {
        if (x >= o.fx && x < o.fx + o.fz && y >= o.fy && y < o.fy + o.fz) continue;
        if (x < 0 || y < 0 || x >= MAP || y >= MAP) continue;
        if (!noOwn[y * MAP + x]) o.ring.push(y * MAP + x);
      }
    }
    world._net = { noOwn, nodeAt, nodes, outposts, ns, zI: integralOf(noOwn) };
    return world._net;
  }

  function zoneSum(P, x1, y1, x2, y2) {
    x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(MAP - 1, x2); y2 = Math.min(MAP - 1, y2);
    if (x1 > x2 || y1 > y2) return 0;
    const W1 = MAP + 1, I = P.zI;
    return I[(y2 + 1) * W1 + x2 + 1] - I[y1 * W1 + x2 + 1] - I[(y2 + 1) * W1 + x1] + I[y1 * W1 + x1];
  }

  /* Two squares (inclusive rects) link when an owned tile of one touches (corners count) an owned
     tile of the other. Tiles of outpost zones are never owned (KSMapper's rule; the game's own
     check, on whole squares, is looser, so this holds in both). */
  function rectsLink(P, a, b) {
    if (Math.max(a[0], b[0]) - Math.min(a[2], b[2]) > 1 || Math.max(a[1], b[1]) - Math.min(a[3], b[3]) > 1) return false;
    const u = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
    if (!zoneSum(P, u[0], u[1], u[2], u[3])) return true;
    // the tiles of a within 1 of b, then a neighbour of each in b
    const x1 = Math.max(a[0], b[0] - 1), x2 = Math.min(a[2], b[2] + 1), y1 = Math.max(a[1], b[1] - 1), y2 = Math.min(a[3], b[3] + 1);
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
      if (x < 0 || y < 0 || x >= MAP || y >= MAP || P.noOwn[y * MAP + x]) continue;
      for (let yy = Math.max(b[1], y - 1); yy <= Math.min(b[3], y + 1); yy++)
        for (let xx = Math.max(b[0], x - 1); xx <= Math.min(b[2], x + 1); xx++)
          if (xx >= 0 && yy >= 0 && xx < MAP && yy < MAP && !P.noOwn[yy * MAP + xx]) return true;
    }
    return false;
  }
  const bRect = (x, y) => [x - 3, y - 3, x + 3, y + 3];

  /* What the network must reach: per kind, every forced outpost of that kind, or else any outpost
     of the kind that is not excluded. Kinds switched off (opts.offKinds, names) are left out unless
     one of their outposts is forced. A kind whose outposts are all excluded is left out (warning). */
  function goalsOf(P, opts) {
    const key = (o) => o.x + "," + o.y;
    const forced = new Set((opts.forced || []).map((q) => q[0] + "," + q[1]));
    const excluded = new Set((opts.excluded || []).map((q) => q[0] + "," + q[1]));
    const off = new Set(opts.offKinds || []);
    const goals = [], warnings = [];
    for (let k = 0; k < KINDS.length; k++) {
      const all = P.outposts.filter((o) => o.k === k);
      const f = all.filter((o) => forced.has(key(o)));
      if (f.length) {
        for (const o of f) goals.push({ k, list: [o], forced: true });
        if (off.has(KINDS[k])) warnings.push(KINDS[k] + " is switched off, but its forced outpost is still reached");
        continue;
      }
      if (off.has(KINDS[k])) continue;
      const ok = all.filter((o) => !excluded.has(key(o)) && o.ring.length);
      if (ok.length) goals.push({ k, list: ok, forced: false });
      else warnings.push("every " + KINDS[k] + " is excluded or inside enemy territory: left out");
    }
    for (const g of goals) if (g.forced && !g.list[0].ring.length) warnings.push("forced " + KINDS[g.k] + " " + key(g.list[0]) + " is surrounded by enemy territory");
    return { goals, warnings };
  }

  // ---------------------------------------------------------------- network state
  function makeState(world, hx, hy, opts) {
    opts = opts || {};
    const P = prepare(world, opts.enemies);
    const G = goalsOf(P, opts);
    const st = {
      world, P, hx, hy, goals: G.goals, warnings: G.warnings,
      // banners the alliance already has: cheaper to keep (opts.existingCost, in banners)
      existing: new Set((opts.existing || []).map(([x, y]) => y * MAP + x)),
      exCost: opts.existingCost != null ? opts.existingCost : 1,
      cov: new Uint16Array(MAP * MAP),       // how many squares (HQ + banners) cover each tile
      occ: new Uint8Array(MAP * MAP),        // HQ and banner tiles
      bid: new Int32Array(MAP * MAP).fill(-1),
      banners: [],                           // [x, y]
      full: new Uint8Array(P.nodes.length),  // node fully covered
      count: [0, 0, 0, 0],
    };
    for (let y = hy; y < hy + 3; y++) for (let x = hx; x < hx + 3; x++) st.occ[y * MAP + x] = 1;
    sqAdd(st, hx - 6, hy - 6, hx + 8, hy + 8, 1, null);
    return st;
  }

  function cellOwned(st, c) { return st.cov[c] > 0 && !st.P.noOwn[c]; }

  function nodeFull(st, n) {
    const ns = st.P.ns;
    for (let dy = 0; dy < ns; dy++) for (let dx = 0; dx < ns; dx++) if (!cellOwned(st, (n.y + dy) * MAP + n.x + dx)) return false;
    return true;
  }

  // add d to the coverage of a rectangle; updates the captured nodes (and lists changes in `log`)
  function sqAdd(st, x1, y1, x2, y2, d, log) {
    x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(MAP - 1, x2); y2 = Math.min(MAP - 1, y2);
    const touched = [];
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
      const c = y * MAP + x;
      const was = st.cov[c];
      st.cov[c] = was + d;
      if ((was === 0) !== (st.cov[c] === 0)) { const n = st.P.nodeAt[c]; if (n >= 0) touched.push(n); }
    }
    for (const i of touched) {
      const n = st.P.nodes[i];
      const f = nodeFull(st, n) ? 1 : 0;
      if (f !== st.full[i]) { st.full[i] = f; st.count[n.t] += f ? 1 : -1; if (log) log.push(f ? i : ~i); }
    }
  }

  function addBanner(st, x, y, log) {
    const c = y * MAP + x;
    st.occ[c] = 1; st.bid[c] = st.banners.length; st.banners.push([x, y]);
    sqAdd(st, x - 3, y - 3, x + 3, y + 3, 1, log);
  }

  function removeBannerAt(st, idx) {
    const [x, y] = st.banners[idx];
    sqAdd(st, x - 3, y - 3, x + 3, y + 3, -1, null);
    st.occ[y * MAP + x] = 0; st.bid[y * MAP + x] = -1;
    const last = st.banners.pop();
    if (idx < st.banners.length) { st.banners[idx] = last; st.bid[last[1] * MAP + last[0]] = idx; }
  }

  function placeable(st, c) { return !(st.world.block[c] & 2) && !st.occ[c] && !st.P.noOwn[c]; }

  function linksHQ(st, x, y) {
    if (!(x >= st.hx - 10 && x <= st.hx + 12 && y >= st.hy - 10 && y <= st.hy + 12)) return false;
    return rectsLink(st.P, [st.hx - 6, st.hy - 6, st.hx + 8, st.hy + 8], bRect(x, y));
  }
  function linkB(st, ax, ay, bx, by) {
    return Math.abs(ax - bx) <= 7 && Math.abs(ay - by) <= 7 && rectsLink(st.P, bRect(ax, ay), bRect(bx, by));
  }
  // near an outpost zone the box test of the field is only a hint: check against real neighbours
  function nearZone(st, x, y) { return zoneSum(st.P, x - 4, y - 4, x + 4, y + 4) > 0; }

  function outpostReached(st, o) { for (const c of o.ring) if (st.cov[c] > 0) return true; return false; }

  function goalMet(st, g) { return g.list.some((o) => outpostReached(st, o)); }
  function goalsMet(st) { return st.goals.every((g) => goalMet(st, g)); }

  // ---------------------------------------------------------------- distance field
  /* Banner distance field over a box: lvl = number of new banners needed so that a banner stands
     on that tile (1 = links to the network now). Layer by layer with an integral image. */
  function field(st, box, maxDepth, stop) {
    const x0 = Math.max(0, box[0]), y0 = Math.max(0, box[1]), x1 = Math.min(MAP - 1, box[2]), y1 = Math.min(MAP - 1, box[3]);
    const W = x1 - x0 + 1, H = y1 - y0 + 1;
    const lvl = new Int16Array(W * H);
    const ok = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (placeable(st, (y0 + y) * MAP + x0 + x)) ok[y * W + x] = 1;
    const I = new Int32Array((W + 1) * (H + 1));
    const W1 = W + 1;
    const integral = (mark) => {
      for (let y = 0; y < H; y++) {
        let row = 0;
        for (let x = 0; x < W; x++) {
          row += mark(y * W + x);
          I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row;
        }
      }
    };
    const boxSum = (x, y, r) => {
      const ax = Math.max(0, x - r), ay = Math.max(0, y - r), bx = Math.min(W - 1, x + r), by = Math.min(H - 1, y + r);
      return I[(by + 1) * W1 + bx + 1] - I[ay * W1 + bx + 1] - I[(by + 1) * W1 + ax] + I[ay * W1 + ax];
    };
    // level 1: links to the HQ or to a banner
    const src = new Uint8Array(W * H);
    for (const [bx, by] of st.banners) if (bx >= x0 && bx <= x1 && by >= y0 && by <= y1) src[(by - y0) * W + bx - x0] = 1;
    integral((i) => src[i]);
    let added = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!ok[i]) continue;
      const gx = x0 + x, gy = y0 + y;
      if (linksHQ(st, gx, gy)) { lvl[i] = 1; added++; continue; }
      if (boxSum(x, y, 7) > 0) {
        if (nearZone(st, gx, gy) && !st.banners.some(([bx, by]) => linkB(st, bx, by, gx, gy))) continue;
        lvl[i] = 1; added++;
      }
    }
    let depth = 1;
    while (added && depth < maxDepth && !(stop && stop(lvl, depth, x0, y0, W))) {
      const d = depth;
      integral((i) => (lvl[i] === d ? 1 : 0));
      added = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!ok[i] || lvl[i]) continue;
        if (boxSum(x, y, 7) > 0) {
          const gx = x0 + x, gy = y0 + y;
          if (nearZone(st, gx, gy)) {
            let ok2 = false;
            for (let dy = -7; dy <= 7 && !ok2; dy++) for (let dx = -7; dx <= 7; dx++) {
              const qx = x + dx, qy = y + dy;
              if (qx < 0 || qy < 0 || qx >= W || qy >= H || lvl[qy * W + qx] !== d) continue;
              if (linkB(st, gx + dx, gy + dy, gx, gy)) { ok2 = true; break; }
            }
            if (!ok2) continue;
          }
          lvl[i] = d + 1; added++;
        }
      }
      depth++;
    }
    return { x0, y0, W, H, lvl, depth,
      at(x, y) { return (x < x0 || y < y0 || x >= x0 + W || y >= y0 + H) ? 0 : lvl[(y - y0) * W + x - x0]; } };
  }

  // ---------------------------------------------------------------- gains and paths
  /* Value of what a set of new banners would capture (applied on the state, then undone). */
  function trialGain(st, path, val) {
    const log = [];
    for (const [x, y] of path) sqAdd(st, x - 3, y - 3, x + 3, y + 3, 1, log);
    let g = 0;
    for (const e of log) g += e >= 0 ? val(st.P.nodes[e]) : -val(st.P.nodes[~e]);
    for (const [x, y] of path) sqAdd(st, x - 3, y - 3, x + 3, y + 3, -1, null);
    return g;
  }

  /* Banner chain from the network to (x, y) through the field, each step the predecessor that
     captures most (ties: the one nearer the network side, then seeded noise). */
  function pathTo(st, F, x, y, val, rand) {
    const path = [[x, y]];
    let lv = F.at(x, y);
    const log = [];
    sqAdd(st, x - 3, y - 3, x + 3, y + 3, 1, log);
    let cx = x, cy = y;
    while (lv > 1) {
      let best = null, bestG = -1e9;
      for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
        const qx = cx + dx, qy = cy + dy;
        if (F.at(qx, qy) !== lv - 1) continue;
        if (!linkB(st, qx, qy, cx, cy)) continue;
        let g = 0;
        // value of the nodes this square completes, given the path so far
        const l2 = [];
        sqAdd(st, qx - 3, qy - 3, qx + 3, qy + 3, 1, l2);
        for (const e of l2) g += e >= 0 ? val(st.P.nodes[e]) : 0;
        sqAdd(st, qx - 3, qy - 3, qx + 3, qy + 3, -1, null);
        g += (1 - bCost(st, qx, qy)) + rand() * 1e-3;
        if (g > bestG) { bestG = g; best = [qx, qy]; }
      }
      if (!best) break;
      path.push(best);
      sqAdd(st, best[0] - 3, best[1] - 3, best[0] + 3, best[1] + 3, 1, log);
      cx = best[0]; cy = best[1]; lv--;
    }
    for (const [px, py] of path) sqAdd(st, px - 3, py - 3, px + 3, py + 3, -1, null);
    return path.reverse();
  }

  // positions whose square completes node n (given the current coverage), with their level
  function nodeSpots(st, F, n) {
    const ns = st.P.ns;
    let mx1 = 1e9, my1 = 1e9, mx2 = -1, my2 = -1;
    for (let dy = 0; dy < ns; dy++) for (let dx = 0; dx < ns; dx++) {
      const x = n.x + dx, y = n.y + dy;
      if (cellOwned(st, y * MAP + x)) continue;
      mx1 = Math.min(mx1, x); my1 = Math.min(my1, y); mx2 = Math.max(mx2, x); my2 = Math.max(my2, y);
    }
    if (mx2 < 0) return null;
    let best = 0;
    const spots = [];
    for (let y = my2 - 3; y <= my1 + 3; y++) for (let x = mx2 - 3; x <= mx1 + 3; x++) {
      const l = F.at(x, y);
      if (!l) continue;
      if (!best || l < best) { best = l; spots.length = 0; }
      if (l === best) spots.push([x, y]);
    }
    return best ? { lvl: best, spots } : null;
  }

  // positions whose square touches outpost o's zone, with their level
  function outpostSpots(st, F, o) {
    let best = 0;
    const spots = [];
    for (let y = o.fy - 4; y <= o.fy + o.fz + 3; y++) for (let x = o.fx - 4; x <= o.fx + o.fz + 3; x++) {
      if (x >= o.fx && x < o.fx + o.fz && y >= o.fy && y < o.fy + o.fz) continue;
      const l = F.at(x, y);
      if (!l) continue;
      // the square must hold an owned ring tile
      let touches = false;
      for (let yy = y - 3; yy <= y + 3 && !touches; yy++) for (let xx = x - 3; xx <= x + 3; xx++) {
        if (xx < o.fx - 1 || xx > o.fx + o.fz || yy < o.fy - 1 || yy > o.fy + o.fz) continue;
        if (xx >= o.fx && xx < o.fx + o.fz && yy >= o.fy && yy < o.fy + o.fz) continue;
        if (xx >= 0 && yy >= 0 && xx < MAP && yy < MAP && !st.P.noOwn[yy * MAP + xx]) { touches = true; break; }
      }
      if (!touches) continue;
      if (!best || l < best) { best = l; spots.length = 0; }
      if (l === best) spots.push([x, y]);
    }
    return best ? { lvl: best, spots } : null;
  }

  function netBox(st, extra) {
    let x1 = st.hx - 10, y1 = st.hy - 10, x2 = st.hx + 12, y2 = st.hy + 12;
    for (const [x, y] of st.banners) { if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
    if (extra) for (const r of extra) { x1 = Math.min(x1, r[0]); y1 = Math.min(y1, r[1]); x2 = Math.max(x2, r[2]); y2 = Math.max(y2, r[3]); }
    return [x1, y1, x2, y2];
  }

  // ---------------------------------------------------------------- targets
  /* Minimum nodes per type: the base type's hourly amount (each node 3600/h), the others by the
     ratio (bread:wood:stone:iron). Default 3:3:2:1 on 50k iron. */
  function targetsOf(opts) {
    const r = opts.ratio || [3, 3, 2, 1];
    const bt = Math.max(0, TYPES.indexOf(opts.baseType || "iron"));
    const per = opts.basePerHour != null ? opts.basePerHour : 50000;
    const nb = Math.ceil(per / NODE_RATE);
    if (!r[bt]) return TYPES.map(() => 0);
    return TYPES.map((_, t) => Math.ceil(nb * r[t] / r[bt] - 1e-9));
  }

  function makeVal(st, T, surplusW) {
    return (n) => (st.count[n.t] < T[n.t] ? 1 : surplusW);
  }

  function sample(list, k, rand) {
    if (list.length <= k) return list;
    const a = list.slice();
    for (let i = 0; i < k; i++) { const j = i + Math.floor(rand() * (a.length - i)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a.slice(0, k);
  }

  // ---------------------------------------------------------------- pass 1: build
  function connectOutposts(st, opts, rand, noise) {
    for (let guard = 0; guard < st.goals.length + 1; guard++) {
      const todo = [];
      for (const g of st.goals) if (!goalMet(st, g)) for (const o of g.list) todo.push(o);
      if (!todo.length) return true;
      const box = netBox(st, todo.map((o) => [o.fx - 12, o.fy - 12, o.fx + o.fz + 11, o.fy + o.fz + 11]));
      // stop a few layers after the first outpost zone is in reach (room for the seeded noise)
      let firstAt = 0;
      const extra = noise ? 4 : 0;
      const F = field(st, [box[0] - 8, box[1] - 8, box[2] + 8, box[3] + 8], 160, (lvl, d, x0, y0, W) => {
        if (firstAt) return d >= firstAt + extra;
        const H = lvl.length / W;
        for (const o of todo) {
          for (let y = o.fy - 4; y <= o.fy + o.fz + 3; y++) {
            const ly = y - y0; if (ly < 0 || ly >= H) continue;
            for (let x = o.fx - 4; x <= o.fx + o.fz + 3; x++) {
              const lx = x - x0; if (lx < 0 || lx >= W) continue;
              if (lvl[ly * W + lx] === d && !(x >= o.fx && x < o.fx + o.fz && y >= o.fy && y < o.fy + o.fz)) { firstAt = d; return d >= firstAt + extra; }
            }
          }
        }
        return false;
      });
      const T = targetsOf(opts), val = makeVal(st, T, 0.4);
      // nearest kind first (seeded noise picks among near ties)
      let pick = null, pickCost = 1e9;
      for (const o of todo) {
        const s = outpostSpots(st, F, o);
        if (!s) continue;
        const c = s.lvl + noise * rand() * Math.sqrt(s.lvl);
        if (c < pickCost) { pickCost = c; pick = { o, s }; }
      }
      if (!pick) return false;
      let best = null, bestG = -1e9;
      for (const p of sample(pick.s.spots, opts.pathSamples || 8, rand)) {
        const path = pathTo(st, F, p[0], p[1], val, rand);
        const g = trialGain(st, path, val) + (path.length - pathCost(st, path)) + rand() * 1e-3;
        if (g > bestG) { bestG = g; best = path; }
      }
      for (const [x, y] of best) addBanner(st, x, y, null);
    }
    return goalsMet(st);
  }

  /* Greedy resources: add the chain with the best value per banner while it beats minRatio. */
  function growResources(st, opts, rand, maxBanners) {
    const T = targetsOf(opts);
    const minRatio = opts.minRatio != null ? opts.minRatio : 0.3;
    const depth = opts.growDepth || 5;
    for (let guard = 0; guard < 400 && st.banners.length < maxBanners; guard++) {
      const val = makeVal(st, T, opts.surplusWeight != null ? opts.surplusWeight : 0.4);
      const box = netBox(st);
      const F = field(st, [box[0] - 7 * depth, box[1] - 7 * depth, box[2] + 7 * depth, box[3] + 7 * depth], depth);
      const cands = [];
      for (const n of st.P.nodes) {
        if (st.full[n.i]) continue;
        if (n.x < F.x0 || n.y < F.y0 || n.x >= F.x0 + F.W || n.y >= F.y0 + F.H) continue;
        const s = nodeSpots(st, F, n);
        if (!s) continue;
        cands.push({ n, s, est: val(n) / s.lvl });
      }
      if (!cands.length) break;
      cands.sort((a, b) => b.est - a.est);
      let best = null, bestR = -1;
      for (const c of cands.slice(0, opts.growTop || 40)) {
        for (const p of sample(c.s.spots, 4, rand)) {
          const path = pathTo(st, F, p[0], p[1], val, rand);
          if (st.banners.length + path.length > maxBanners) continue;
          const g = trialGain(st, path, val);
          const r = g / pathCost(st, path) + rand() * 1e-4;
          if (r > bestR) { bestR = r; best = path; }
        }
      }
      if (!best || bestR < minRatio) break;
      for (const [x, y] of best) addBanner(st, x, y, null);
    }
  }

  // ---------------------------------------------------------------- analysis
  /* For each banner: the nodes that need it (a tile only it covers), articulation (removing it
     cuts banners from the HQ), and the outpost kinds only it keeps. */
  function analyse(st) {
    const B = st.banners, n = B.length;
    const adj = Array.from({ length: n + 1 }, () => []);   // node n = HQ
    for (let i = 0; i < n; i++) {
      if (linksHQ(st, B[i][0], B[i][1])) { adj[i].push(n); adj[n].push(i); }
      for (let j = i + 1; j < n; j++) {
        if (linkB(st, B[i][0], B[i][1], B[j][0], B[j][1])) { adj[i].push(j); adj[j].push(i); }
      }
    }
    // articulation points (iterative Tarjan from the HQ)
    const disc = new Int32Array(n + 1).fill(-1), low = new Int32Array(n + 1), art = new Uint8Array(n + 1);
    const reach = new Uint8Array(n + 1);
    let t = 0;
    const stack = [[n, -1, 0]];
    disc[n] = low[n] = t++; reach[n] = 1;
    let rootKids = 0;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, parent] = top;
      if (top[2] < adj[u].length) {
        const v = adj[u][top[2]++];
        if (v === parent) continue;
        if (disc[v] < 0) {
          disc[v] = low[v] = t++; reach[v] = 1;
          if (u === n) rootKids++;
          stack.push([v, u, 0]);
        } else low[u] = Math.min(low[u], disc[v]);
      } else {
        stack.pop();
        if (stack.length) {
          const p = stack[stack.length - 1][0];
          low[p] = Math.min(low[p], low[u]);
          if (p !== n && low[u] >= disc[p]) art[p] = 1;
        }
      }
    }
    // nodes that need each banner
    const need = Array.from({ length: n }, () => []);
    const P = st.P, ns = P.ns;
    for (const nd of P.nodes) {
      if (!st.full[nd.i]) continue;
      const by = new Set();
      for (let dy = 0; dy < ns; dy++) for (let dx = 0; dx < ns; dx++) {
        const x = nd.x + dx, y = nd.y + dy, c = y * MAP + x;
        if (st.cov[c] !== 1) continue;
        // the one square covering it: the HQ's or a banner within 3
        if (x >= st.hx - 6 && x <= st.hx + 8 && y >= st.hy - 6 && y <= st.hy + 8) continue;
        for (let yy = y - 3; yy <= y + 3; yy++) for (let xx = x - 3; xx <= x + 3; xx++) {
          if (xx < 0 || yy < 0 || xx >= MAP || yy >= MAP) continue;
          const b = st.bid[yy * MAP + xx];
          if (b >= 0) by.add(b);
        }
      }
      for (const b of by) need[b].push(nd.i);
    }
    // goals (outposts to reach) only one banner keeps
    const keeps = Array.from({ length: n }, () => []);
    for (let gi = 0; gi < st.goals.length; gi++) {
      let sole = -2;   // -2 none seen, -1 several / HQ, >=0 the only banner
      for (const o of st.goals[gi].list) {
        for (const c of o.ring) {
          if (st.cov[c] === 0) continue;
          if (st.cov[c] > 1) { sole = -1; break; }
          const x = c % MAP, y = (c / MAP) | 0;
          if (x >= st.hx - 6 && x <= st.hx + 8 && y >= st.hy - 6 && y <= st.hy + 8) { sole = -1; break; }
          let b = -1;
          for (let yy = y - 3; yy <= y + 3 && b < 0; yy++) for (let xx = x - 3; xx <= x + 3; xx++) {
            if (xx < 0 || yy < 0 || xx >= MAP || yy >= MAP) continue;
            const q = st.bid[yy * MAP + xx];
            if (q >= 0) { b = q; break; }
          }
          if (sole === -2) sole = b; else if (sole !== b) { sole = -1; break; }
        }
        if (sole === -1) break;
      }
      if (sole >= 0) keeps[sole].push(gi);
    }
    return { adj, art, reach, need, keeps };
  }

  // what a banner on (x, y) costs: 1, or less where the alliance already has one
  function bCost(st, x, y) { return st.existing.has(y * MAP + x) ? st.exCost : 1; }
  function pathCost(st, path) { let c = 0; for (const [x, y] of path) c += bCost(st, x, y); return c; }

  function costOf(st, A, opts) {
    const empty = A.need.filter((l) => !l.length).length;
    let c = 0;
    for (const [x, y] of st.banners) c += bCost(st, x, y);
    return c + (opts.emptyWeight != null ? opts.emptyWeight : 0.5) * empty;
  }

  // ---------------------------------------------------------------- pass 2: prune
  function prune(st, opts) {
    const T = targetsOf(opts);
    for (;;) {
      const A = analyse(st);
      let best = -1, bestKey = 1e9;
      for (let i = 0; i < st.banners.length; i++) {
        if (A.art[i] || A.keeps[i].length) continue;
        const lost = [0, 0, 0, 0];
        for (const nd of A.need[i]) lost[st.P.nodes[nd].t]++;
        if (TYPES.some((_, t) => st.count[t] - lost[t] < T[t])) continue;
        // empty first; then the least lost (keeps slack), surplus-relative
        let key = 0;
        for (let t = 0; t < 4; t++) if (lost[t]) key += lost[t] / Math.max(1, st.count[t] - T[t] + 1);
        key += A.adj[i].length * 1e-3;
        key += (1 - bCost(st, st.banners[i][0], st.banners[i][1])) * 2;   // a banner already there goes last
        if (key < bestKey) { bestKey = key; best = i; }
      }
      if (best < 0) return;
      removeBannerAt(st, best);
    }
  }

  // ---------------------------------------------------------------- checks
  function check(st, opts) {
    const T = targetsOf(opts);
    const A = analyse(st);
    const errors = [];
    const cut = st.banners.filter((_, i) => !A.reach[i]).length;
    if (cut) errors.push(cut + " banner(s) not chained to the HQ");
    for (const g of st.goals) if (!goalMet(st, g)) errors.push("outpost not reached: " + KINDS[g.k] + (g.forced ? " (forced, " + g.list[0].x + "," + g.list[0].y + ")" : ""));
    TYPES.forEach((ty, t) => { if (st.count[t] < T[t]) errors.push(ty + " short: " + st.count[t] + " of " + T[t] + " nodes"); });
    return { errors, A };
  }

  function snapshot(st) { return st.banners.map((b) => b.slice()); }

  function rebuild(world, hx, hy, banners, opts) {
    const st = makeState(world, hx, hy, opts);
    for (const [x, y] of banners) addBanner(st, x, y, null);
    return st;
  }

  function resetTo(st, banners) {
    st.cov.fill(0); st.occ.fill(0); st.bid.fill(-1); st.full.fill(0); st.count = [0, 0, 0, 0]; st.banners = [];
    const { hx, hy } = st;
    for (let y = hy; y < hy + 3; y++) for (let x = hx; x < hx + 3; x++) st.occ[y * MAP + x] = 1;
    sqAdd(st, hx - 6, hy - 6, hx + 8, hy + 8, 1, null);
    for (const [x, y] of banners) addBanner(st, x, y, null);
  }

  // ---------------------------------------------------------------- pass 3: local search
  /* Take one banner away and re-link what falls off with the cheapest chains, then prune; kept
     when the cost drops. Also tries moving each empty banner to a spot that completes a node. */
  function improve(world, st, opts, rand, budgetMs) {
    const t0 = Date.now();
    const T = targetsOf(opts);
    let A = analyse(st), cost = costOf(st, A, opts);
    let tries = 0, gains = 0;
    const order = () => st.banners.map((_, i) => i).sort(() => rand() - 0.5);
    let improved = true;
    while (improved && Date.now() - t0 < budgetMs) {
      improved = false;
      for (const i of order()) {
        if (Date.now() - t0 > budgetMs) break;
        if (i >= st.banners.length) continue;
        tries++;
        const before = snapshot(st);
        removeBannerAt(st, i);
        // drop what is cut off from the HQ, then rebuild needs
        dropCut(st);
        repair(st, opts, rand, T);
        prune(st, opts);
        const c = check(st, opts);
        const nc = c.errors.length ? 1e9 : costOf(st, c.A, opts);
        if (nc < cost - 1e-9) { cost = nc; improved = true; gains++; }
        else resetTo(st, before);
      }
    }
    return { tries, gains, ms: Date.now() - t0 };
  }

  function dropCut(st) {
    for (;;) {
      const A = analyse(st);
      const cut = [];
      for (let i = 0; i < st.banners.length; i++) if (!A.reach[i]) cut.push(i);
      if (!cut.length) return;
      cut.sort((a, b) => b - a);
      for (const i of cut) removeBannerAt(st, i);
    }
  }

  /* Bring back what is missing: outpost kinds first (nearest), then nodes of short types. */
  function repair(st, opts, rand, T) {
    connectOutposts(st, opts, rand, 0);
    for (let guard = 0; guard < 60; guard++) {
      const short = TYPES.map((_, t) => st.count[t] < T[t]);
      if (!short.some(Boolean)) return;
      const val = (n) => (short[n.t] && st.count[n.t] < T[n.t] ? 1 : 0.05);
      let depth = 3, best = null, bestR = -1;
      for (; depth <= 12 && !best; depth += 3) {
        const box = netBox(st);
        const F = field(st, [box[0] - 7 * depth, box[1] - 7 * depth, box[2] + 7 * depth, box[3] + 7 * depth], depth);
        for (const n of st.P.nodes) {
          if (st.full[n.i] || !short[n.t]) continue;
          if (n.x < F.x0 || n.y < F.y0 || n.x >= F.x0 + F.W || n.y >= F.y0 + F.H) continue;
          const s = nodeSpots(st, F, n);
          if (!s) continue;
          const path = pathTo(st, F, s.spots[0][0], s.spots[0][1], val, rand);
          const r = trialGain(st, path, val) / path.length;
          if (r > bestR) { bestR = r; best = path; }
        }
      }
      if (!best) return;
      for (const [x, y] of best) addBanner(st, x, y, null);
    }
  }

  // ---------------------------------------------------------------- build order
  function buildOrder(st) {
    const B = st.banners, n = B.length, seen = new Uint8Array(n), out = [];
    let frontier = [];
    for (let i = 0; i < n; i++) if (linksHQ(st, B[i][0], B[i][1])) { seen[i] = 1; frontier.push(i); }
    while (frontier.length) {
      const next = [];
      for (const i of frontier) {
        out.push(i);
        for (let j = 0; j < n; j++) if (!seen[j] && linkB(st, B[i][0], B[i][1], B[j][0], B[j][1])) { seen[j] = 1; next.push(j); }
      }
      frontier = next;
    }
    return out;
  }

  // ---------------------------------------------------------------- evaluation of any network
  function summary(st, opts) {
    const c = check(st, opts);
    const T = targetsOf(opts);
    const empty = c.A.need.map((l) => !l.length);
    const reached = [];
    for (const o of st.P.outposts) if (outpostReached(st, o)) reached.push({ name: o.name, x: o.x, y: o.y });
    const goals = st.goals.map((g) => {
      const hit = g.list.filter((o) => outpostReached(st, o));
      return { kind: KINDS[g.k], forced: g.forced, met: hit.length > 0, at: hit.map((o) => [o.x, o.y]) };
    });
    const captured = [];
    for (const nd of st.P.nodes) if (st.full[nd.i]) captured.push([nd.x, nd.y, nd.t]);
    return {
      goals, captured, warnings: st.warnings,
      kept: st.banners.filter(([x, y]) => st.existing.has(y * MAP + x)).length,
      banners: st.banners.length,
      empty: empty.filter(Boolean).length,
      cost: costOf(st, c.A, opts),
      nodes: TYPES.reduce((m, ty, t) => (m[ty] = st.count[t], m), {}),
      perHour: TYPES.reduce((m, ty, t) => (m[ty] = st.count[t] * NODE_RATE, m), {}),
      targets: TYPES.reduce((m, ty, t) => (m[ty] = T[t], m), {}),
      outposts: reached,
      errors: c.errors,
      emptyFlags: empty,
    };
  }

  function evaluate(world, hx, hy, banners, opts) {
    return summary(rebuild(world, hx, hy, banners, opts || {}), opts || {});
  }

  // ---------------------------------------------------------------- solve
  /* The current network's banners that chain to the HQ, in chain order (others are left out). */
  function seedExisting(st, banners, cap) {
    let left = banners.filter(([x, y]) => placeable(st, y * MAP + x));
    for (let grew = true; grew && left.length && st.banners.length < cap;) {
      grew = false;
      const rest = [];
      for (const [x, y] of left) {
        if (st.banners.length >= cap) break;
        if (linksHQ(st, x, y) || st.banners.some(([bx, by]) => linkB(st, bx, by, x, y))) { addBanner(st, x, y, null); grew = true; }
        else rest.push([x, y]);
      }
      left = rest;
    }
  }

  /* One variant end to end, in turn: connect the outposts first; grow resources around the HQ
     first; and, with a current network (opts.existing), start from its banners that chain to the
     HQ. From the third variant on, seeded noise varies which outpost of a kind is taken. */
  function runVariant(world, hx, hy, opts, v) {
    const cap = opts.maxBanners || 285;
    const rand = rng((opts.seed || 1) * 7919 + v);
    const st = makeState(world, hx, hy, opts);
    // 0: outposts first, 1: resources around the HQ first, 2 (with a current network): start from it
    const hasEx = st.existing.size > 0;
    const mode = hasEx ? v % 3 : v % 2;
    if (mode === 1) growResources(st, opts, rand, cap);
    if (mode === 2) seedExisting(st, opts.existing, cap);
    const ok = connectOutposts(st, opts, rand, v < 2 ? 0 : 1.5);
    growResources(st, opts, rand, cap);
    const pass1 = summary(st, opts);
    prune(st, opts);
    const pass2 = summary(st, opts);
    if (opts.improveMs !== 0) improve(world, st, opts, rand, opts.improveMs || 30000);
    const s = summary(st, opts);
    const order = buildOrder(st);
    s.design = order.map((i) => st.banners[i].slice());
    s.emptyFlags = order.map((i) => s.emptyFlags[i]);
    s.variant = v; s.mode = ["outposts first", "resources first", "from the current network"][mode];
    s.pass1 = { banners: pass1.banners, nodes: pass1.nodes };
    s.pass2 = { banners: pass2.banners, empty: pass2.empty, cost: pass2.cost };
    s.reachedAll = ok;
    return s;
  }

  function rank(results) {
    return results.sort((a, b) => (a.errors.length - b.errors.length) || (a.cost - b.cost) || (a.banners - b.banners));
  }

  function solve(world, hx, hy, opts, onProgress) {
    opts = opts || {};
    const variants = opts.variants || 4;
    const results = [];
    const t0 = Date.now();
    for (let v = 0; v < variants; v++) {
      results.push(runVariant(world, hx, hy, opts, v));
      if (onProgress) onProgress({ variant: v + 1, of: variants, ms: Date.now() - t0 });
    }
    return rank(results);
  }

  /* Why an HQ can't be used here (null when it can). */
  function hqProblem(world, hx, hy, opts) {
    if (!Number.isFinite(hx) || !Number.isFinite(hy) || hx < 6 || hy < 6 || hx + 8 >= MAP || hy + 8 >= MAP) return "outside the map or too close to its edge";
    if (hx >= 300 && hx <= 899 && hy >= 300 && hy <= 899) return "this tool works from the Badland HQ; this one is in Plains or Fertile Land";
    return null;
  }

  function toCsv(hq, design, emptyFlags, tag, existing) {
    const have = new Set((existing || []).map(([x, y]) => x + "," + y));
    const rows = [["hq", hq[0], hq[1], tag, "#8e44ad", 1]];
    design.forEach(([x, y], i) => {
      const built = have.has(x + "," + y);
      const col = built ? (emptyFlags[i] ? "#80ff00" : "#80ff80") : (emptyFlags[i] ? "#ffff00" : "#ffff80");
      rows.push(["banner", x, y, tag, col, i + 2]);
    });
    return rows.map((r) => r.join(",")).join("\n") + "\n";
  }

  const api = { solve, runVariant, rank, evaluate, toCsv, targetsOf, hqProblem, KINDS, TYPES, NODE_RATE, MAP,
    _internal: { makeState, growResources, connectOutposts, prune, improve, analyse, field, rng, summary, check } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Net = api;
})(typeof self !== "undefined" ? self : this);
