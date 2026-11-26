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
 * Coordinates are lower-left tiles. Other alliances appear as enemy banners and HQs given in
 * opts.enemies (their squares) and/or as a territory mask read by the scan (opts.mask, tile by
 * tile): that ground is never ours and takes no banner. opts.forced / opts.excluded list
 * outposts (lower-left tiles) the network must reach / must not count on.
 *
 * Method: pass 1 builds a network with as many resources as it can (the outposts reached on the
 * way, every bridge chosen to complete nodes), pass 2 takes away every banner the outposts, the
 * links and the resource targets don't need, then a local search removes and re-routes banners
 * while that lowers the cost (banners + emptyWeight per empty banner - surplusValue per node above
 * a type's minimum: the minimum is a floor, more is a bonus). Several variants run (order of the
 * work, choice of outposts) and the cheapest is kept. With a pasted network (opts.existing), step 0
 * first fixes its cheap errors (repairImport: a banner moved up to 2 tiles or one bridge), and one
 * variant in three starts from it, taking back its banners again after each bridge.
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
  /* Other alliances' ground: enemy banners and HQs (squares), and/or a territory mask from the
     scan (opts.mask = { key, runs }: tile runs per row, flat [y, x1, x2, ...], inclusive). Never
     ours, no banner on it (they built first), links can't cross it, nodes under it can't count. */
  function prepare(world, enemies, mask) {
    const base = prepareBase(world);
    const hasE = enemies && enemies.length, hasM = mask && mask.runs && mask.runs.length;
    if (!hasE && !hasM) return base;
    const key = (hasE ? JSON.stringify(enemies) : "") + "|" + (hasM ? mask.key || String(mask.runs.length) : "");
    if (world._netE && world._netE.key === key) return world._netE.P;
    const noOwn = base.noOwn.slice();
    if (hasE) for (const e of enemies) {
      const r = e.type === "hq" ? [e.x - 6, e.y - 6, e.x + 8, e.y + 8] : [e.x - 3, e.y - 3, e.x + 3, e.y + 3];
      for (let y = Math.max(0, r[1]); y <= Math.min(MAP - 1, r[3]); y++)
        for (let x = Math.max(0, r[0]); x <= Math.min(MAP - 1, r[2]); x++) noOwn[y * MAP + x] = 1;
    }
    let maskTiles = 0;
    if (hasM) {
      const R = mask.runs;
      for (let i = 0; i + 2 < R.length; i += 3) {
        const y = R[i], a = Math.max(0, R[i + 1]), b = Math.min(MAP - 1, R[i + 2]);
        if (y < 0 || y >= MAP) continue;
        for (let x = a; x <= b; x++) { if (!noOwn[y * MAP + x]) maskTiles++; noOwn[y * MAP + x] = 1; }
      }
    }
    const outposts = base.outposts.map((o) => Object.assign({}, o, { ring: o.ring.filter((c) => !noOwn[c]) }));
    const P = Object.assign({}, base, { noOwn, outposts, zI: integralOf(noOwn), enemies: hasE ? enemies.length : 0, maskTiles });
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
    const P = prepare(world, opts.enemies, opts.mask);
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
  function outpostSpots(st, F, o, slack) {
    slack = slack || 0;
    let best = 0;
    const all = [];
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
      if (!best || l < best) best = l;
      all.push([x, y, l]);
    }
    if (!best) return null;
    const spots = all.filter((p) => p[2] === best).map((p) => [p[0], p[1]]);
    // detours: spots 1..slack levels further, for chains that pass by resources
    const detours = slack ? all.filter((p) => p[2] > best && p[2] <= best + slack).map((p) => [p[0], p[1]]) : [];
    return { lvl: best, spots, detours };
  }

  function netBox(st, extra) {
    let x1 = st.hx - 10, y1 = st.hy - 10, x2 = st.hx + 12, y2 = st.hy + 12;
    for (const [x, y] of st.banners) { if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
    if (extra) for (const r of extra) { x1 = Math.min(x1, r[0]); y1 = Math.min(y1, r[1]); x2 = Math.max(x2, r[2]); y2 = Math.max(y2, r[3]); }
    return [x1, y1, x2, y2];
  }

  const DETOUR = 2;   // outpost chains may run up to this many banners longer to pass by resources

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
  function connectOutposts(st, opts, rand, noise, focus) {
    for (let guard = 0; guard < st.goals.length + 1; guard++) {
      const todo = [];
      for (const g of st.goals) if (!goalMet(st, g)) for (const o of g.list) todo.push(o);
      if (!todo.length) return true;
      // with a focus: only the outposts near it (a kind has outposts all over the map; boxes around
      // all of them make the distance field cover most of the map)
      if (focus) {
        const d = (o) => Math.max(focus[0] - (o.fx + o.fz), o.fx - focus[2], focus[1] - (o.fy + o.fz), o.fy - focus[3], 0);
        const close = todo.filter((o) => d(o) <= 40);
        if (!close.length) return false;
        todo.length = 0; todo.push(...close);
      }
      const near = todo.map((o) => [o.fx - 12, o.fy - 12, o.fx + o.fz + 11, o.fy + o.fz + 11]);
      // with a focus: only the area where banners were taken away and the outposts to reach
      const box = focus ? near.reduce((b, r) => [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])], focus.slice()) : netBox(st, near);
      // stop a few layers after the first outpost zone is in reach (room for the seeded noise)
      let firstAt = 0;
      // a few layers past the first outpost zone in reach: room for the noise and for detours
      const extra = Math.max(noise ? 4 : 0, DETOUR);
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
        const s = outpostSpots(st, F, o, DETOUR);
        if (!s) continue;
        const c = s.lvl + noise * rand() * Math.sqrt(s.lvl);
        if (c < pickCost) { pickCost = c; pick = { o, s }; }
      }
      if (!pick) return false;
      let best = null, bestG = -1e9;
      // shortest chains, and chains 1..DETOUR banners longer: one only wins if what it captures on
      // the way is worth more than its extra banners
      const tries = sample(pick.s.spots, opts.pathSamples || 8, rand).concat(sample(pick.s.detours || [], opts.detourSamples || 6, rand));
      for (const p of tries) {
        const path = pathTo(st, F, p[0], p[1], val, rand);
        const g = trialGain(st, path, val) - pathCost(st, path) + rand() * 1e-3;
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

  const emptyW = (opts) => (opts.emptyWeight != null ? opts.emptyWeight : 0.5);
  // a node above a type's minimum is a bonus worth this many banners (0 = worthless)
  const surplusV = (opts) => (opts.surplusValue != null ? opts.surplusValue : 0.5);
  function surplusOf(st, T) { let s = 0; for (let t = 0; t < 4; t++) s += Math.max(0, st.count[t] - T[t]); return s; }

  /* Cost of a network: banners (the ones already built count opts.existingCost), plus emptyWeight
     per empty banner, minus surplusValue per node above the minimum of its type. */
  function costOf(st, A, opts) {
    const empty = A.need.filter((l) => !l.length).length;
    let c = 0;
    for (const [x, y] of st.banners) c += bCost(st, x, y);
    return c + emptyW(opts) * empty - surplusV(opts) * surplusOf(st, targetsOf(opts));
  }

  // verbose logging (one line per step) when opts.verbose; quiet otherwise
  const logOf = (opts) => (opts && opts.verbose ? (...a) => console.log("[net]", ...a) : () => {});

  // ---------------------------------------------------------------- pass 2: prune
  /* Take banners away one at a time while that lowers the cost: never a link (articulation), never
     the only banner reaching an outpost, never below a type's minimum. What a banner is worth: its
     cost, plus emptyWeight if it is empty, minus surplusValue per node only it completes (every
     such node is above the minimum, or the banner could not go). When no single banner can go,
     dead-end chains (a leaf and the banners with two links behind it) are tried as a whole. */
  function prune(st, opts) {
    const T = targetsOf(opts), w = emptyW(opts), sv = surplusV(opts);
    for (;;) {
      const A = analyse(st);
      let best = -1, bestKey = -1e9;
      for (let i = 0; i < st.banners.length; i++) {
        if (A.art[i] || A.keeps[i].length) continue;
        const lost = [0, 0, 0, 0];
        for (const nd of A.need[i]) lost[st.P.nodes[nd].t]++;
        if (TYPES.some((_, t) => st.count[t] - lost[t] < T[t])) continue;
        const nl = lost[0] + lost[1] + lost[2] + lost[3];
        const gain = bCost(st, st.banners[i][0], st.banners[i][1]) + (nl ? 0 : w) - sv * nl;
        if (gain <= 1e-9) continue;
        const key = gain - A.adj[i].length * 1e-3;
        if (key > bestKey) { bestKey = key; best = i; }
      }
      if (best >= 0) { removeBannerAt(st, best); continue; }
      if (!pruneChain(st, opts, A, T)) return;
    }
  }

  /* Dead-end chains: from each leaf, the banners with exactly two links behind it (none holding an
     outpost alone). Every prefix from the leaf is tried by lifting its squares; the best one that
     lowers the cost and keeps every minimum is removed. */
  function pruneChain(st, opts, A, T) {
    const n = st.banners.length, w = emptyW(opts), sv = surplusV(opts);
    const total = () => st.count[0] + st.count[1] + st.count[2] + st.count[3];
    let best = null, bestGain = 1e-9;
    for (let i = 0; i < n; i++) {
      if (A.adj[i].length !== 1 || A.keeps[i].length || !A.reach[i]) continue;
      const chain = [i];
      let prev = i, cur = A.adj[i][0];
      while (cur < n && A.adj[cur].length === 2 && !A.keeps[cur].length && chain.length < 12) {
        chain.push(cur);
        const nx = A.adj[cur][0] === prev ? A.adj[cur][1] : A.adj[cur][0];
        prev = cur; cur = nx;
      }
      if (chain.length < 2) continue;
      const before = total();
      let cost = 0, empties = 0;
      const lifted = [];
      for (let k = 0; k < chain.length; k++) {
        const [x, y] = st.banners[chain[k]];
        sqAdd(st, x - 3, y - 3, x + 3, y + 3, -1, null);
        lifted.push(chain[k]);
        cost += bCost(st, x, y);
        if (!A.need[chain[k]].length) empties++;
        if (k === 0) continue;
        if (TYPES.some((_, t) => st.count[t] < T[t])) break;
        const gain = cost + w * empties - sv * (before - total());
        if (gain > bestGain) { bestGain = gain; best = lifted.slice(); }
      }
      for (const j of lifted) { const [x, y] = st.banners[j]; sqAdd(st, x - 3, y - 3, x + 3, y + 3, 1, null); }
    }
    if (!best) return false;
    best.sort((a, b) => b - a);
    for (const j of best) removeBannerAt(st, j);
    return true;
  }

  /* Move a banner to another tile (keeps its index). */
  function moveBanner(st, i, nx, ny) {
    const [x, y] = st.banners[i];
    sqAdd(st, x - 3, y - 3, x + 3, y + 3, -1, null);
    st.occ[y * MAP + x] = 0; st.bid[y * MAP + x] = -1;
    st.banners[i] = [nx, ny];
    st.occ[ny * MAP + nx] = 1; st.bid[ny * MAP + nx] = i;
    sqAdd(st, nx - 3, ny - 3, nx + 3, ny + 3, 1, null);
  }

  /* Empty banners moved up to maxD tiles where they complete nodes, as long as the network stays
     whole (every banner chained, outposts, minimums) and the cost drops. */
  function shiftEmpties(st, opts, maxD) {
    maxD = maxD || 3;
    const log = logOf(opts), t0 = Date.now();
    const total = () => st.count[0] + st.count[1] + st.count[2] + st.count[3];
    let moves = 0, tried = 0;
    for (let pass = 0; pass < 3; pass++) {
      let A = analyse(st), cost = costOf(st, A, opts), any = false;
      for (let i = 0; i < st.banners.length; i++) {
        if (A.need[i].length || A.keeps[i].length) continue;
        const [x, y] = st.banners[i];
        // lift it (empty: no node depends on it), then rank the spots around by nodes completed
        sqAdd(st, x - 3, y - 3, x + 3, y + 3, -1, null);
        st.occ[y * MAP + x] = 0;
        const base = total(), spots = [];
        for (let dy = -maxD; dy <= maxD; dy++) for (let dx = -maxD; dx <= maxD; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= MAP || ny >= MAP || !placeable(st, ny * MAP + nx)) continue;
          sqAdd(st, nx - 3, ny - 3, nx + 3, ny + 3, 1, null);
          const gain = total() - base;
          sqAdd(st, nx - 3, ny - 3, nx + 3, ny + 3, -1, null);
          if (gain > 0) spots.push([gain, Math.max(Math.abs(dx), Math.abs(dy)), nx, ny]);
        }
        st.occ[y * MAP + x] = 1;
        sqAdd(st, x - 3, y - 3, x + 3, y + 3, 1, null);
        spots.sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]));
        for (const [, , nx, ny] of spots.slice(0, 6)) {
          tried++;
          moveBanner(st, i, nx, ny);
          const c = check(st, opts);
          const nc = c.errors.length ? 1e9 : costOf(st, c.A, opts);
          if (nc < cost - 1e-9) { cost = nc; A = c.A; moves++; any = true; break; }
          moveBanner(st, i, x, y);
        }
      }
      if (!any) break;
    }
    log("shift empties: " + moves + " moved (" + tried + " spots tried) in " + (Date.now() - t0) + " ms");
    return moves;
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

  /* Nodes not yet captured inside `area` that one more banner, linked to the network, would
     complete; and the tiles of banner i's square that other squares also cover. */
  function reachIn(st, area) {
    const F = field(st, [area[0] - 8, area[1] - 8, area[2] + 8, area[3] + 8], 1);
    let n = 0;
    for (const nd of st.P.nodes) {
      if (st.full[nd.i] || nd.x < area[0] || nd.y < area[1] || nd.x > area[2] || nd.y > area[3]) continue;
      const sp = nodeSpots(st, F, nd);
      if (sp && sp.lvl === 1) n++;
    }
    return n;
  }
  function overlapOf(st, x, y) {
    let n = 0;
    for (let yy = Math.max(0, y - 3); yy <= Math.min(MAP - 1, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(MAP - 1, x + 3); xx++) if (st.cov[yy * MAP + xx] > 1) n++;
    return n;
  }
  // whole-network figures, for reports and tests
  function spreadMetrics(st) {
    let overlap = 0;
    for (const [x, y] of st.banners) overlap += overlapOf(st, x, y);
    return { overlap, reach: reachIn(st, netBox(st)) };
  }

  /* Last touch (Pedro, 26 Nov): each new banner may move up to maxD tiles when the network loses
     nothing (no errors, same or lower cost) and the new spot leaves more uncaptured nodes within
     reach of one more banner, or as many with less overlap with the other squares. Banners already
     built stay where they are. */
  function spreadNew(st, opts, maxD, near) {
    maxD = maxD || 3;
    // with `near` (tile indices that changed), only the new banners within 10 tiles of them
    const nearPts = near ? [...near].map((c) => [c % MAP, (c / MAP) | 0]) : null;
    const log = logOf(opts), t0 = Date.now();
    const c0 = check(st, opts);
    if (c0.errors.length) return 0;
    let cost = costOf(st, c0.A, opts);
    const before = opts.verbose ? spreadMetrics(st) : null;
    let moves = 0, tried = 0;
    const better = (a, b) => a.reach > b.reach || (a.reach === b.reach && a.overlap < b.overlap);
    for (let pass = 0; pass < 2; pass++) {
      let any = false;
      for (let i = 0; i < st.banners.length; i++) {
        const [x, y] = st.banners[i];
        if (st.existing.has(y * MAP + x)) continue;
        if (nearPts && !nearPts.some(([px, py]) => Math.abs(px - x) <= 10 && Math.abs(py - y) <= 10)) continue;
        const area = [x - maxD - 12, y - maxD - 12, x + maxD + 12, y + maxD + 12];
        let bestS = { reach: reachIn(st, area), overlap: overlapOf(st, x, y) }, best = null, bestCost = cost;
        for (let dy = -maxD; dy <= maxD; dy++) for (let dx = -maxD; dx <= maxD; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= MAP || ny >= MAP || !placeable(st, ny * MAP + nx)) continue;
          moveBanner(st, i, nx, ny);
          // it must still link to something
          if (linksHQ(st, nx, ny) || st.banners.some(([bx, by], j) => j !== i && linkB(st, bx, by, nx, ny))) {
            const sc = { reach: reachIn(st, area), overlap: overlapOf(st, nx, ny) };
            if (better(sc, bestS)) {
              tried++;
              const c = check(st, opts);
              const nc = c.errors.length ? 1e9 : costOf(st, c.A, opts);
              if (nc <= cost + 1e-9) { best = [nx, ny]; bestS = sc; bestCost = nc; }
            }
          }
          moveBanner(st, i, x, y);
        }
        if (best) { moveBanner(st, i, best[0], best[1]); cost = bestCost; moves++; any = true; }
      }
      if (!any) break;
    }
    if (before) { const after = spreadMetrics(st); log("spread: " + moves + " new banners moved (" + tried + " checked), overlap " + before.overlap + " -> " + after.overlap + " tiles, nodes within one more banner " + before.reach + " -> " + after.reach + ", " + (Date.now() - t0) + " ms"); }
    return moves;
  }

  /* Back to pass 1 from the finished network (Pedro, 26 Nov: "volto ao passo 1"): spread the new
     banners, grow resource chains from the network as it now stands (its moved banners are new
     places to grow from), prune, a short local search; kept when the cost drops, else back to the
     best. Repeats until tEnd. */
  function cycles(world, st, opts, rand, tEnd, cap, log) {
    const quiet = Object.assign({}, opts, { verbose: false });
    let best = snapshot(st), bestCost = costOf(st, analyse(st), opts);
    let n = 0, kept = 0;
    const t0 = Date.now();
    while (Date.now() < tEnd - 1500) {
      n++;
      if (opts.spread !== false) spreadNew(st, quiet);
      const b0 = st.banners.length;
      growResources(st, opts, rand, cap);
      const grown = st.banners.length - b0;
      prune(st, opts);
      shiftEmpties(st, quiet);
      const left = tEnd - Date.now();
      if (left > 300) improve(world, st, quiet, rand, Math.max(300, Math.min(left, Math.round((opts.improveMs || 30000) * 0.2))));
      const c = check(st, opts);
      const nc = c.errors.length ? 1e9 : costOf(st, c.A, opts);
      log("cycle " + n + ": grew " + grown + " banners, back to " + st.banners.length + ", cost " + (nc >= 1e9 ? "errors" : nc.toFixed(2)) + " (best " + bestCost.toFixed(2) + ")");
      if (nc < bestCost - 1e-9) { bestCost = nc; best = snapshot(st); kept++; }
      else resetTo(st, best);
    }
    log("cycles: " + n + " run, " + kept + " kept, best cost " + bestCost.toFixed(2) + ", " + (Date.now() - t0) + " ms");
  }

  // ---------------------------------------------------------------- pass 3: local search
  /* Two moves, in rounds, for the time given:
     1. take one banner away with whatever it cuts off (a whole arm when it is a link), re-link what
        went missing (outposts, then short types) with chains near where the arm was, prune;
     2. add one banner next to the network where it completes nodes, then prune (with the extra
        nodes, banners elsewhere may stop being needed).
     A move is kept when the cost drops, or when it stays the same for a different network (up to
     opts.sidewaysSteps in a row, never back to a network already seen): such neutral steps let one
     arm give way to another (A loses 4 banners and 3 wood, B gains 5 banners, 3 wood and 2 stone)
     before the next move cashes in the extra (the stone lets a third arm shrink). The best network
     seen is the one kept. */
  /* budget: { tries } (a fixed number of tries: the same network on any machine) or, for older
     callers, a number of milliseconds. */
  function improve(world, st, opts, rand, budget) {
    const t0 = Date.now(), log = logOf(opts);
    const T = targetsOf(opts);
    const sigOf = () => st.banners.map(([x, y]) => y * MAP + x).sort((a, b) => a - b).join(",");
    let cost = costOf(st, analyse(st), opts);
    let best = { cost, banners: snapshot(st) };
    const seen = new Set([sigOf()]);
    const maxSide = opts.sidewaysSteps != null ? opts.sidewaysSteps : 25;
    const stats = { tries: 0, gains: 0, sideways: 0, addTries: 0, adds: 0, rounds: 0, spread: 0, restoreTries: 0, restored: 0 };
    let lastSpread = new Set(st.banners.map(([x, y]) => y * MAP + x));
    let side = 0;
    const out = typeof budget === "object" ? () => stats.tries + stats.addTries + stats.restoreTries >= budget.tries : () => Date.now() - t0 > budget;
    // keep the state as it is now? (cost already checked: no errors)
    const accept = (nc) => {
      if (nc < cost - 1e-9) return "gain";
      if (nc <= cost + 1e-9 && side < maxSide) { const g = sigOf(); if (!seen.has(g)) { seen.add(g); return "side"; } }
      return null;
    };
    const took = (kind, nc) => {
      if (kind === "gain") { stats.gains++; side = 0; seen.add(sigOf()); } else { stats.sideways++; side++; }
      cost = nc;
      if (cost < best.cost - 1e-9) best = { cost, banners: snapshot(st) };
    };
    const evalNow = () => { const c = check(st, opts); return c.errors.length ? null : costOf(st, c.A, opts); };
    for (let changed = true; changed && !out();) {
      changed = false; stats.rounds++;
      // move 1: an arm away, re-linked locally (move 2 also runs every 40 tries: a round can take
      // the whole time on a big network)
      const addMove = () => addOne(st, opts, rand, out, (nc) => { const k = accept(nc); if (k) { took(k, nc); stats.adds++; } return !!k; }, stats);
      let sinceAdd = 0;
      for (const i of st.banners.map((_, k) => k).sort(() => rand() - 0.5)) {
        if (out()) break;
        if (++sinceAdd >= 40) { sinceAdd = 0; if (addMove()) changed = true; if (out()) break; }
        if (i >= st.banners.length) continue;
        stats.tries++;
        const before = snapshot(st);
        const gone = new Set(before.map(([x, y]) => y * MAP + x));
        removeBannerAt(st, i);
        dropCut(st);
        for (const [x, y] of st.banners) gone.delete(y * MAP + x);
        let fx1 = MAP, fy1 = MAP, fx2 = 0, fy2 = 0;
        for (const c of gone) { const x = c % MAP, y = (c / MAP) | 0; fx1 = Math.min(fx1, x); fy1 = Math.min(fy1, y); fx2 = Math.max(fx2, x); fy2 = Math.max(fy2, y); }
        repair(st, opts, rand, T, [fx1 - 7, fy1 - 7, fx2 + 7, fy2 + 7]);
        prune(st, opts);
        const nc = evalNow();
        const k = nc == null ? null : accept(nc);
        if (k) { took(k, nc); changed = true; } else resetTo(st, before);
      }
      // move 2: one banner more where it completes nodes, then prune
      if (!out() && addMove()) changed = true;
      // move 3: put back banners of the current network that went down (a new one may then go)
      if (!out() && restoreExisting(st, opts, out, (nc) => { const k = accept(nc); if (k) { took(k, nc); stats.restored++; } return !!k; }, stats)) changed = true;
      // move 3: new banners near what changed this round spread out (less overlap, more nodes within
      // reach of one more banner), never at a cost; the next round's moves can use what that opens
      if (!out() && opts.spread !== false && opts.spreadInSearch) {
        const now = new Set(st.banners.map(([x, y]) => y * MAP + x)), diff = new Set();
        for (const c of now) if (!lastSpread.has(c)) diff.add(c);
        for (const c of lastSpread) if (!now.has(c)) diff.add(c);
        if (diff.size) {
          const moved = spreadNew(st, Object.assign({}, opts, { verbose: false }), 3, diff);
          if (moved) {
            stats.spread += moved; changed = true;
            cost = costOf(st, analyse(st), opts); seen.add(sigOf());
            if (cost < best.cost - 1e-9) best = { cost, banners: snapshot(st) };
          }
        }
        lastSpread = new Set(st.banners.map(([x, y]) => y * MAP + x));
      }
    }
    if (best.cost < cost - 1e-9) resetTo(st, best.banners);
    const ms = Date.now() - t0;
    log("pass 3: " + stats.rounds + " round(s), " + stats.tries + " arm tries (" + stats.gains + " gains, " + stats.sideways + " neutral steps), " +
      stats.addTries + " one-more tries (" + stats.adds + " kept), " + stats.restoreTries + " restore tries (" + stats.restored + " kept), " + stats.spread + " banners spread, best cost " + best.cost.toFixed(2) + ", " + ms + " ms");
    return { tries: stats.tries + stats.addTries + stats.restoreTries, gains: stats.gains, sideways: stats.sideways, adds: stats.adds, spread: stats.spread, ms };
  }

  /* Move 3 of the local search: banners of the current network that are down (taken away by an
     earlier step) go back, one linked group at a time, then the network is pruned (a new banner
     doing the same job can then go); kept when keep(cost) says so. */
  function restoreExisting(st, opts, out, keep, stats) {
    if (!st.existing.size) return false;
    const here = new Set(st.banners.map(([x, y]) => y * MAP + x));
    const down = [];
    for (const c of st.existing) if (!here.has(c) && placeable(st, c)) down.push([c % MAP, (c / MAP) | 0]);
    if (!down.length) return false;
    const gid = down.map(() => -1), groups = [];
    for (let i = 0; i < down.length; i++) {
      if (gid[i] >= 0) continue;
      const list = [i]; gid[i] = groups.length;
      for (let k = 0; k < list.length; k++) for (let j = 0; j < down.length; j++) {
        if (gid[j] < 0 && linkB(st, down[list[k]][0], down[list[k]][1], down[j][0], down[j][1])) { gid[j] = groups.length; list.push(j); }
      }
      groups.push(list.map((q) => down[q]));
    }
    let any = false;
    for (const g of groups) {
      if (out()) break;
      if (!g.some(([x, y]) => linksHQ(st, x, y) || st.banners.some(([bx, by]) => linkB(st, bx, by, x, y)))) continue;
      stats.restoreTries++;
      const before = snapshot(st);
      for (const [x, y] of g) if (placeable(st, y * MAP + x)) addBanner(st, x, y, null);
      prune(st, opts);
      const c = check(st, opts);
      const nc = c.errors.length ? null : costOf(st, c.A, opts);
      if (nc != null && keep(nc)) any = true;
      else resetTo(st, before);
    }
    return any;
  }

  /* Move 2 of the local search: every free tile one link away from the network whose square
     completes nodes, best first; each is added, the network pruned, and kept if `keep(cost)` says so. */
  function addOne(st, opts, rand, out, keep, stats) {
    const box = netBox(st);
    const F = field(st, [box[0] - 8, box[1] - 8, box[2] + 8, box[3] + 8], 1);
    const total = () => st.count[0] + st.count[1] + st.count[2] + st.count[3];
    const seenSpot = new Set(), cands = [];
    for (const n of st.P.nodes) {
      if (st.full[n.i] || n.x < F.x0 || n.y < F.y0 || n.x >= F.x0 + F.W || n.y >= F.y0 + F.H) continue;
      const s = nodeSpots(st, F, n);
      if (!s || s.lvl !== 1) continue;
      for (const [x, y] of s.spots) {
        const c = y * MAP + x;
        if (seenSpot.has(c)) continue;
        seenSpot.add(c);
        const base = total();
        sqAdd(st, x - 3, y - 3, x + 3, y + 3, 1, null);
        const gain = total() - base;
        sqAdd(st, x - 3, y - 3, x + 3, y + 3, -1, null);
        if (gain > 0) cands.push([gain + rand() * 0.1, x, y]);
      }
    }
    cands.sort((a, b) => b[0] - a[0]);
    let any = false;
    for (const [, x, y] of cands.slice(0, opts.addTries || 40)) {
      if (out()) break;
      if (!placeable(st, y * MAP + x)) continue;
      stats.addTries++;
      const before = snapshot(st);
      addBanner(st, x, y, null);
      prune(st, opts);
      const c = check(st, opts);
      const nc = c.errors.length ? null : costOf(st, c.A, opts);
      if (nc != null && keep(nc)) any = true;
      else resetTo(st, before);
    }
    return any;
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

  /* Bring back what is missing: outpost kinds first (nearest), then nodes of short types. With a
     focus box (where banners were just taken away), the distance fields only cover that area and
     its surroundings (much faster); the whole network is the fallback when nothing is found there. */
  function repair(st, opts, rand, T, focus) {
    if (!connectOutposts(st, opts, rand, 0, focus) && focus) connectOutposts(st, opts, rand, 0);
    const sv = Math.min(0.5, surplusV(opts) * 0.5);
    for (let guard = 0; guard < 60; guard++) {
      const short = TYPES.map((_, t) => st.count[t] < T[t]);
      if (!short.some(Boolean)) return;
      // short types first; surplus nodes on the way are a small bonus
      const val = (n) => (short[n.t] && st.count[n.t] < T[n.t] ? 1 : sv);
      let best = null, bestR = -1;
      for (const area of focus ? [focus, null] : [null]) {
        for (let depth = 3; depth <= 12 && !best; depth += 3) {
          const box = area || netBox(st);
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
        if (best) break;
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
  /* The banners cut off from the HQ, in groups that link among themselves; for each, the banners of
     the group standing on ground that can't hold one (enemy, unseen, terrain): the likely cause. */
  function cutGroupsOf(st, A) {
    const n = st.banners.length, seen = new Uint8Array(n), groups = [];
    for (let i = 0; i < n; i++) {
      if (A.reach[i] || seen[i]) continue;
      const list = [i]; seen[i] = 1;
      for (let k = 0; k < list.length; k++) for (const j of A.adj[list[k]]) if (j < n && !A.reach[j] && !seen[j]) { seen[j] = 1; list.push(j); }
      const banners = list.map((j) => st.banners[j].slice());
      const bad = banners.filter(([x, y]) => st.P.noOwn[y * MAP + x] || (st.world.block[y * MAP + x] & 2));
      groups.push({ banners, bad });
    }
    return groups.sort((a, b) => b.banners.length - a.banners.length);
  }

  /* Which of an alliance's banners chain to its Badland HQ (hx, hy) and which only to one of its
     Plains HQs (lower-left tiles). Banners that chain to neither stay with the Badland network
     (they show as cut off there). Same link rules as everything else (owned tiles only). */
  function splitNetworks(world, hx, hy, plainsHqs, banners, opts) {
    const t0 = Date.now(), log = logOf(opts);
    const st = rebuild(world, hx, hy, banners, opts || {});
    const A = analyse(st), n = st.banners.length;
    const fromPlains = new Uint8Array(n), queue = [];
    for (const [px, py] of plainsHqs || []) {
      const sq = [px - 6, py - 6, px + 8, py + 8];
      for (let i = 0; i < n; i++) {
        const [x, y] = st.banners[i];
        if (!fromPlains[i] && Math.abs(x - (px + 1)) <= 11 && Math.abs(y - (py + 1)) <= 11 && rectsLink(st.P, sq, bRect(x, y))) { fromPlains[i] = 1; queue.push(i); }
      }
    }
    for (let k = 0; k < queue.length; k++) for (const j of A.adj[queue[k]]) if (j < n && !fromPlains[j]) { fromPlains[j] = 1; queue.push(j); }
    const badland = [], plains = [];
    let both = 0, loose = 0, looseP = 0;
    // banners chained to neither go with the nearer network (its chained banners and its HQ)
    const near = (x, y, pts) => pts.reduce((m, [px, py]) => Math.min(m, Math.max(Math.abs(px - x), Math.abs(py - y))), 1e9);
    const bPts = [[hx + 1, hy + 1]], pPts = (plainsHqs || []).map(([px, py]) => [px + 1, py + 1]);
    for (let i = 0; i < n; i++) { if (A.reach[i]) bPts.push(st.banners[i]); else if (fromPlains[i]) pPts.push(st.banners[i]); }
    for (let i = 0; i < n; i++) {
      const b = st.banners[i].slice();
      if (A.reach[i]) { badland.push(b); if (fromPlains[i]) both++; }
      else if (fromPlains[i]) plains.push(b);
      else if (pPts.length && near(b[0], b[1], pPts) < near(b[0], b[1], bPts)) { plains.push(b); looseP++; }
      else { badland.push(b); loose++; }
    }
    log("split: " + badland.length + " banners with the Badland HQ (" + both + " also chained to Plains, " + loose + " cut off), " + plains.length + " with the Plains HQ (" + looseP + " of them cut off but nearer to it), " + (Date.now() - t0) + " ms");
    return { badland, plains, both, loose, looseP };
  }

  /* Step 0, for a pasted network: fix what keeps its banners from standing or chaining, when that is
     cheap. (1) Move a banner up to 2 tiles: one standing on ground that can't hold a banner, or a cut
     off one near the chained network; kept when more banners chain to the HQ, or one fewer stands on
     bad ground, without losing any. (2) Else one new banner as a bridge to a cut-off group, kept when
     it brings back at least 2 banners. Repeats while something is fixed. */
  function repairImport(world, hx, hy, banners, opts) {
    const t0 = Date.now(), log = logOf(opts);
    const st = rebuild(world, hx, hy, banners, opts || {});
    const badAt = (x, y) => !!(st.P.noOwn[y * MAP + x] || (st.world.block[y * MAP + x] & 2));
    // more banners chained, then fewer on bad ground, then more nodes captured
    const score = (A) => { let r = 0, b = 0; for (let i = 0; i < st.banners.length; i++) { if (A.reach[i]) r++; const [x, y] = st.banners[i]; if (badAt(x, y)) b++; } return { r, b, nodes: st.count[0] + st.count[1] + st.count[2] + st.count[3] }; };
    const better = (a, b) => a.r > b.r || (a.r === b.r && (a.b < b.b || (a.b === b.b && a.nodes > b.nodes)));
    const fixes = [];
    let A = analyse(st), sc = score(A);
    const before = { chained: sc.r, bad: sc.b, banners: st.banners.length };
    log("step 0: " + sc.r + " of " + st.banners.length + " banners chained to the HQ, " + sc.b + " on ground that can't hold one");
    for (let round = 0; round < 30; round++) {
      const n = st.banners.length;
      if (sc.r === n && !sc.b) break;
      // banners worth moving: on bad ground, or cut off within reach of the chained network
      const chained = st.banners.filter((_, i) => A.reach[i]);
      const nearNet = (x, y) => (Math.abs(x - (st.hx + 1)) <= 13 && Math.abs(y - (st.hy + 1)) <= 13) || chained.some(([bx, by]) => Math.abs(bx - x) <= 9 && Math.abs(by - y) <= 9);
      const cands = [];
      for (let i = 0; i < n; i++) { const [x, y] = st.banners[i]; if (badAt(x, y) || (!A.reach[i] && nearNet(x, y))) cands.push(i); }
      let best = null, bestSc = sc, tries = 0;
      for (const i of cands) {
        const [x, y] = st.banners[i];
        for (let d = 1; d <= 2; d++) for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= MAP || ny >= MAP || !placeable(st, ny * MAP + nx)) continue;
          tries++;
          moveBanner(st, i, nx, ny);
          const s2 = score(analyse(st));
          if (better(s2, bestSc)) { bestSc = s2; best = { i, from: [x, y], to: [nx, ny] }; }
          moveBanner(st, i, x, y);
        }
      }
      if (best) {
        moveBanner(st, best.i, best.to[0], best.to[1]);
        fixes.push({ type: "move", from: best.from, to: best.to, reconnects: bestSc.r - sc.r, offBadGround: sc.b - bestSc.b });
        log("step 0: move " + best.from.join(",") + " -> " + best.to.join(",") + ": " + (bestSc.r - sc.r) + " more banners chained, " + (sc.b - bestSc.b) + " fewer on bad ground (" + tries + " spots tried)");
        A = analyse(st); sc = bestSc;
        continue;
      }
      // a bridge: one new banner linking the chained network and a cut-off group
      const groups = [], gid = new Int32Array(n).fill(-1);
      for (let i = 0; i < n; i++) {
        if (A.reach[i] || gid[i] >= 0) continue;
        const list = [i]; gid[i] = groups.length;
        for (let k = 0; k < list.length; k++) for (const j of A.adj[list[k]]) if (j < n && !A.reach[j] && gid[j] < 0) { gid[j] = groups.length; list.push(j); }
        groups.push(list);
      }
      let bridge = null, bridgeN = 1;
      const seenSpot = new Set();
      for (let i = 0; i < n; i++) {
        if (A.reach[i]) continue;
        const [x, y] = st.banners[i];
        if (!nearNet(x, y) && !chained.some(([bx, by]) => Math.abs(bx - x) <= 14 && Math.abs(by - y) <= 14)) continue;
        for (let ny = y - 7; ny <= y + 7; ny++) for (let nx = x - 7; nx <= x + 7; nx++) {
          const c = ny * MAP + nx;
          if (nx < 0 || ny < 0 || nx >= MAP || ny >= MAP || seenSpot.has(c) || !placeable(st, c)) continue;
          seenSpot.add(c);
          if (!linksHQ(st, nx, ny) && !chained.some(([bx, by]) => linkB(st, bx, by, nx, ny))) continue;
          const hit = new Set();
          for (let j = 0; j < n; j++) if (!A.reach[j] && gid[j] >= 0 && !hit.has(gid[j]) && linkB(st, st.banners[j][0], st.banners[j][1], nx, ny)) hit.add(gid[j]);
          let back = 0; for (const g of hit) back += groups[g].length;
          if (back > bridgeN) { bridgeN = back; bridge = [nx, ny]; }
        }
      }
      if (!bridge) break;
      addBanner(st, bridge[0], bridge[1], null);
      A = analyse(st);
      const s2 = score(A);
      fixes.push({ type: "bridge", at: bridge, reconnects: s2.r - sc.r - 1 });
      log("step 0: bridge " + bridge.join(",") + ": " + (s2.r - sc.r - 1) + " banners chained again");
      sc = s2;
    }
    const after = { chained: sc.r, bad: sc.b, banners: st.banners.length };
    log("step 0 done: " + fixes.length + " fix(es), " + after.chained + " of " + after.banners + " chained, " + after.bad + " on bad ground, " + (Date.now() - t0) + " ms");
    return { banners: st.banners.map((b) => b.slice()), fixes, before, after, ms: Date.now() - t0 };
  }

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
    // banners standing on other alliances' ground (only a pasted network can: the data disagree)
    const onEnemy = st.banners.filter(([x, y]) => st.P.noOwn[y * MAP + x]).map((b) => b.slice());
    const cutGroups = cutGroupsOf(st, c.A);
    const warnings = st.warnings.slice();
    if (onEnemy.length) warnings.push(onEnemy.length + " banner(s) stand on enemy ground or unseen tiles (" +
      onEnemy.slice(0, 6).map((b) => b.join(",")).join(" ") + (onEnemy.length > 6 ? " …" : "") + "): the map data and this network disagree");
    return {
      goals, captured, warnings, onEnemy, cutGroups,
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
    const log = logOf(opts), t0 = Date.now();
    const mine = opts.seedBanners || opts.existing || [];
    if (mode === 2) seedExisting(st, mine, cap);
    log("variant " + v + " (" + ["outposts first", "resources first", "from the current network"][mode] + "): start with " + st.banners.length + " banners");
    const ok = connectOutposts(st, opts, rand, v < 2 ? 0 : 1.5);
    // the bridges may chain banners of the current network that were cut off: take them back
    if (mode === 2) { const b0 = st.banners.length; seedExisting(st, mine, cap); log("variant " + v + ": outposts linked, " + (st.banners.length - b0) + " current banners chained again"); }
    growResources(st, opts, rand, cap);
    if (mode === 2) seedExisting(st, mine, cap);
    const pass1 = summary(st, opts);
    log("variant " + v + ": pass 1 " + pass1.banners + " banners, nodes " + TYPES.map((t) => pass1.nodes[t]).join("/") + " (" + (Date.now() - t0) + " ms)");
    prune(st, opts);
    shiftEmpties(st, opts);
    // spread the new banners before the search, so its moves start from what that opens
    if (opts.spread !== false && opts.spreadInSearch) spreadNew(st, opts);
    const pass2 = summary(st, opts);
    log("variant " + v + ": pass 2 " + pass2.banners + " banners, " + pass2.empty + " empty, cost " + pass2.cost.toFixed(2) + " (" + (Date.now() - t0) + " ms)");
    // pass 3 budget: opts.improveTries (default 600), or opts.improveMs for older callers
    const tries = opts.improveTries != null ? opts.improveTries : (opts.improveMs != null ? null : 600);
    if (tries !== 0 && opts.improveMs !== 0) {
      const total = opts.improveMs || 30000, tEnd = Date.now() + total;
      // cycles back to pass 1: only with a time budget, off by default (worse at 15-30 s)
      const useCycles = !!opts.cycles && tries == null;
      const r = improve(world, st, opts, rand, tries != null ? { tries } : useCycles ? Math.round(total * 0.4) : total);
      shiftEmpties(st, opts);
      log("variant " + v + ": pass 3 " + r.tries + " tries, " + r.gains + " gains, " + r.sideways + " neutral, " + r.adds + " added (" + (Date.now() - t0) + " ms)");
      if (useCycles) cycles(world, st, opts, rand, tEnd, cap, (m) => log("variant " + v + ": " + m));
    }
    // last chance for banners already built: put back any group that lowers the cost
    {
      let cost = costOf(st, analyse(st), opts);
      restoreExisting(st, opts, () => false, (nc) => { if (nc < cost - 1e-9) { cost = nc; return true; } return false; }, { restoreTries: 0 });
    }
    if (opts.spread !== false) spreadNew(st, opts);
    const s = summary(st, opts);
    s.spread = spreadMetrics(st);
    log("variant " + v + ": done, " + s.banners + " banners, " + s.empty + " empty, cost " + s.cost.toFixed(2) + ", nodes " + TYPES.map((t) => s.nodes[t]).join("/"));
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

  /* Step 0 before the variants: with a pasted network, fix its cheap errors and start from that. */
  function withRepair(world, hx, hy, opts) {
    if (!opts.existing || !opts.existing.length || opts.repairImport === false) return { opts, repair: null };
    const repair = repairImport(world, hx, hy, opts.existing, opts);
    return { opts: Object.assign({}, opts, { seedBanners: repair.banners }), repair };
  }

  function solve(world, hx, hy, opts, onProgress) {
    opts = opts || {};
    const R = withRepair(world, hx, hy, opts);
    opts = R.opts;
    const variants = opts.variants || 4;
    const results = [];
    const t0 = Date.now();
    for (let v = 0; v < variants; v++) {
      results.push(runVariant(world, hx, hy, opts, v));
      if (onProgress) onProgress({ variant: v + 1, of: variants, ms: Date.now() - t0 });
    }
    const out = rank(results);
    out.repair = R.repair;
    return out;
  }

  /* Why an HQ can't be used here (null when it can). */
  function hqProblem(world, hx, hy, opts) {
    if (!Number.isFinite(hx) || !Number.isFinite(hy) || hx < 6 || hy < 6 || hx + 8 >= MAP || hy + 8 >= MAP) return "outside the map or too close to its edge";
    if (hx >= 300 && hx <= 899 && hy >= 300 && hy <= 899) return "this tool works from the Badland HQ; this one is in Plains or Fertile Land";
    return null;
  }

  /* KSMapper CSV in build order; with `removed` (banners of the current network taken down), those
     are added at the end under `oldTag`, in red. */
  function toCsv(hq, design, emptyFlags, tag, existing, removed, oldTag) {
    const have = new Set((existing || []).map(([x, y]) => x + "," + y));
    const rows = [["hq", hq[0], hq[1], tag, "#8e44ad", 1]];
    design.forEach(([x, y], i) => {
      const built = have.has(x + "," + y);
      const col = built ? (emptyFlags[i] ? "#80ff00" : "#80ff80") : (emptyFlags[i] ? "#ffff00" : "#ffff80");
      rows.push(["banner", x, y, tag, col, i + 2]);
    });
    if (removed && removed.length) removed.forEach(([x, y], k) => rows.push(["banner", x, y, oldTag || "OLD", "#ff3030", design.length + 2 + k]));
    return rows.map((r) => r.join(",")).join("\n") + "\n";
  }

  const api = { solve, runVariant, rank, evaluate, toCsv, targetsOf, hqProblem, splitNetworks, repairImport, withRepair, KINDS, TYPES, NODE_RATE, MAP,
    _internal: { makeState, growResources, connectOutposts, prune, improve, analyse, field, rng, summary, check, addBanner, linkB, linksHQ, shiftEmpties, spreadNew, spreadMetrics } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Net = api;
})(typeof self !== "undefined" ? self : this);
