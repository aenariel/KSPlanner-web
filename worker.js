/* Runs the hive solver off the page's main thread. HiGHS (MIT, highs.js + highs.wasm) solves the exact core. */
importScripts("hive.js", "highs.js", "rowlib.js", "fence.js");
let world = null, highs = null;

async function load() {
  if (!world) {
    let res = await fetch("static_map.json");
    if (!res.ok) res = await fetch("../../data/static_map.json");
    world = Hive.buildWorld(await res.json());
  }
  if (!highs) {
    try { highs = await Module({ locateFile: (f) => f }); }
    catch (e) { highs = null; self.postMessage({ type: "warn", message: "Exact solver unavailable, using the greedy core: " + e }); }
  }
}

self.onmessage = async (e) => {
  if (e.data.kind === "fence") return fence(e.data);
  if (e.data.kind === "eval-init" || e.data.kind === "eval") return evalRun(e.data);
  const { hx, hy, opts } = e.data;
  try {
    await load();
    let last = 0;
    const designs = await Hive.solve(world, hx, hy, Object.assign({ library: self.ROWLIB }, opts), (p) => {
      const now = Date.now();
      if (p.stage !== "search" || now - last > 150) { last = now; self.postMessage({ type: "progress", p }); }
    }, highs);
    self.postMessage({ type: "done", designs: designs.map((d) => Object.assign(d, { csv: Hive.toCsv(d, opts.tag) })) });
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};

/* A helper worker of the fence designer's pool: one end-to-end run per message. */
let evalInput = null;
async function evalRun(m) {
  await load();
  if (m.kind === "eval-init") { evalInput = m.input; self.postMessage({ id: m.id, ready: !!highs }); return; }
  let plan = null;
  try { plan = Fence.designOnce(world, evalInput, m.opts, highs, null); } catch (err) { plan = null; }
  self.postMessage({ id: m.id, plan });
}

/* The pool: the design's independent runs (HQ placements, prune moves) spread over helper workers,
   up to 4 (one core left for the page). Same batches and order, so the same plan as one worker. */
async function makePool(input) {
  const size = Math.max(1, Math.min(4, (self.navigator && navigator.hardwareConcurrency || 2) - 1));
  if (size < 2 || typeof Worker === "undefined") return null;
  const pool = [];
  try {
    let seq = 0;
    const call = (w, msg) => new Promise((res, rej) => {
      const id = ++seq;
      const h = (e) => { if (e.data && e.data.id === id) { w.removeEventListener("message", h); res(e.data); } };
      w.addEventListener("message", h);
      w.addEventListener("error", rej, { once: true });
      w.postMessage(Object.assign({ id }, msg));
    });
    for (let i = 0; i < size; i++) pool.push(new Worker("worker.js"));
    const ready = await Promise.all(pool.map((w) => call(w, { kind: "eval-init", input })));
    if (!ready.every((r) => r.ready)) throw new Error("helper without solver");
    const evaluate = async (list) => {
      const out = new Array(list.length);
      let next = 0;
      await Promise.all(pool.map(async (w) => { while (next < list.length) { const i = next++; out[i] = (await call(w, { kind: "eval", opts: list[i] })).plan; } }));
      return out;
    };
    return { evaluate, size, close: () => pool.forEach((w) => w.terminate()) };
  } catch (err) {
    pool.forEach((w) => w.terminate());
    return null;
  }
}

async function fence({ input, opts }) {
  let pool = null;
  try {
    await load();
    if (!highs) throw new Error("The fence designer needs the exact solver, which did not load.");
    const onProgress = (p) => self.postMessage({ type: "progress", p });
    pool = await makePool(input);
    const plan = pool ? await Fence.designAsync(world, input, opts, highs, onProgress, pool.evaluate) : Fence.design(world, input, opts, highs, onProgress);
    if (pool) plan.notes.push("Runs spread over " + pool.size + " helper workers.");
    plan.csv = Fence.toCsv(plan);
    plan.steps = Fence.buildSteps(plan);
    self.postMessage({ type: "fence-done", plan });
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  } finally {
    if (pool) pool.close();
  }
}
