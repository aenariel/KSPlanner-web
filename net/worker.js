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
      self.postMessage({ id: m.id, res: Net.runVariant(world, m.hx, m.hy, m.opts, m.v) });
    } catch (err) {
      self.postMessage({ id: m.id, error: errText(err) });
    }
    return;
  }
  if (m.kind === "evaluate") {
    try {
      await load();
      self.postMessage({ type: "current", current: Net.evaluate(world, m.hx, m.hy, m.banners, m.opts) });
    } catch (err) {
      self.postMessage({ type: "error", message: errText(err) });
    }
    return;
  }
  // a whole run
  const { hx, hy, opts } = m;
  const helpers = [];
  try {
    await load();
    const t0 = Date.now();
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
    const done = () => self.postMessage({ type: "progress", done: results.length, of: n, ms: Date.now() - t0 });
    if (size === 1) {
      for (let v = 0; v < n; v++) { results.push(Net.runVariant(world, hx, hy, opts, v)); done(); }
    } else {
      let next = 0, seq = 0;
      const call = (w, v) => new Promise((res, rej) => {
        const id = ++seq;
        const h = (ev) => { if (ev.data && ev.data.id === id) { w.removeEventListener("message", h); ev.data.error ? rej(new Error(ev.data.error)) : res(ev.data.res); } };
        w.addEventListener("message", h);
        w.addEventListener("error", (ev) => rej(new Error(ev.message || "helper worker failed")), { once: true });
        w.postMessage({ kind: "variant", id, hx, hy, opts, v });
      });
      await Promise.all(helpers.map(async (w) => {
        while (next < n) { const v = next++; results.push(await call(w, v)); done(); }
      }));
    }
    self.postMessage({ type: "done", results: Net.rank(results), workers: size, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ type: "error", message: errText(err) });
  } finally {
    helpers.forEach((w) => w.terminate());
  }
};
