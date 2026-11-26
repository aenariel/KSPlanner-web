/* Runs the banner network solver off the page's main thread. The variants are spread over helper
   workers (up to 4, one core left free); with fewer cores they run here, one after another. */
// hive.js: repo (web/hive), public site (its root, this page in net/) or a single-folder artifact
for (const src of ["../hive/hive.js", "../hive.js", "hive.js"]) { try { importScripts(src); break; } catch (e) {} }
importScripts("net.js");
let world = null;

async function load() {
  if (world) return;
  world = Hive.buildWorld(await fetchMap());
}

async function fetchMap() {
  for (const src of ["static_map.json", "../static_map.json", "../../data/static_map.json"]) {
    try { const res = await fetch(src); if (res.ok) return await res.json(); } catch (e) {}
  }
  throw new Error("map data not found");
}

const errText = (err) => String((err && err.message) || err);

self.onmessage = async (e) => {
  const m = e.data;
  if (m.kind === "variant") {
    try {
      await load();
      const o = Object.assign({}, m.opts, { onTries: (n) => self.postMessage({ id: m.id, tries: n }) });
      self.postMessage({ id: m.id, res: Net.runVariant(world, m.hx, m.hy, o, m.v) });
    } catch (err) {
      self.postMessage({ id: m.id, error: errText(err) });
    }
    return;
  }
  if (m.kind === "evaluate") {
    try {
      await load();
      const t0 = Date.now();
      const current = Net.evaluate(world, m.hx, m.hy, m.banners, m.opts);
      // step 0 preview: what would be fixed first when the CSV's network has cut-off or misplaced banners
      const repair = (current.cutGroups && current.cutGroups.length) || (current.onEnemy && current.onEnemy.length) ? Net.repairImport(world, m.hx, m.hy, m.banners, m.opts) : null;
      console.log("[net] current network scored in " + (Date.now() - t0) + " ms" + (repair ? ", step 0: " + repair.fixes.length + " fix(es)" : ""));
      self.postMessage({ type: "current", current, repair });
    } catch (err) {
      self.postMessage({ type: "error", message: errText(err) });
    }
    return;
  }
  // a whole run
  const { hx, hy } = m;
  let opts = m.opts, repair = null;
  const helpers = [];
  try {
    await load();
    const t0 = Date.now();
    // step 0: fix the pasted network's cheap errors once; every variant starts from the fixed one
    ({ opts, repair } = Net.withRepair(world, hx, hy, opts));
    const n = opts.variants;
    const cores = (self.navigator && navigator.hardwareConcurrency) || 2;
    let size = Math.max(1, Math.min(n, 4, cores - 1));
    if (size >= 2 && typeof Worker !== "undefined") {
      try { for (let i = 0; i < size; i++) helpers.push(new Worker("worker.js")); }
      catch (err) { helpers.forEach((w) => w.terminate()); helpers.length = 0; }
    }
    if (helpers.length < 2) size = 1;
    self.postMessage({ type: "start", workers: size });
    const results = [];
    const done = (v) => self.postMessage({ type: "progress", done: results.length, of: n, v, ms: Date.now() - t0 });
    if (size === 1) {
      for (let v = 0; v < n; v++) {
        const o = Object.assign({}, opts, { onTries: (t) => self.postMessage({ type: "tries", v, n: t }) });
        results.push(Net.runVariant(world, hx, hy, o, v)); done(v);
      }
    } else {
      let next = 0, seq = 0;
      const call = (w, v) => new Promise((res, rej) => {
        const id = ++seq;
        const h = (ev) => {
          if (!ev.data || ev.data.id !== id) return;
          // progress from the helper: tries done in this variant
          if (ev.data.tries != null) { self.postMessage({ type: "tries", v, n: ev.data.tries }); return; }
          w.removeEventListener("message", h); ev.data.error ? rej(new Error(ev.data.error)) : res(ev.data.res);
        };
        w.addEventListener("message", h);
        w.addEventListener("error", (ev) => rej(new Error(ev.message || "helper worker failed")), { once: true });
        w.postMessage({ kind: "variant", id, hx, hy, opts, v });
      });
      await Promise.all(helpers.map(async (w) => {
        while (next < n) { const v = next++; results.push(await call(w, v)); done(v); }
      }));
    }
    self.postMessage({ type: "done", results: Net.rank(results), repair, workers: size, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ type: "error", message: errText(err) });
  } finally {
    helpers.forEach((w) => w.terminate());
  }
};
