const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine } = require("../src/core/engine");
const { clean } = require("../src/core/settings");

/** Windows-Attrappe: merkt sich Priorität/Kerne je Prozess */
function fakeWin(procs) {
  const os = new Map(procs.map((p) => [p.pid, { priority: "Normal", affinity: "255" }]));
  const w = {
    procs, os, gpuSet: [], power: "balanced", calls: 0,
    list: async () => w.procs.map((p) => ({ ram: 1, path: `C:\\P\\${p.name}.exe`, cpu: 0, title: "", ...p })),
    apply: async (actions) => actions.map((a) => {
      w.calls++;
      const cur = os.get(a.pid);
      if (!cur) return { pid: a.pid, error: "weg" };
      const before = { pid: a.pid, ...cur };
      if (a.priority) cur.priority = a.priority;
      if (a.affinity != null) cur.affinity = a.affinity;
      return before;
    }),
    gpu: async (p, pref) => w.gpuSet.push([p, pref]),
    describe: async (paths) => paths.map((p) => ({ path: p, description: p.includes("firefox") ? "Firefox" : null })),
    activePowerPlan: async () => w.power,
    performancePlan: async () => "high",
    setPowerPlan: async (g) => (w.power = g),
  };
  return w;
}
const settingsObj = (patch = {}) => ({ data: clean({ backgroundCores: 2, powerPlan: true, ...patch }, 8), update() {} });

test("Spiel startet → Spielmodus, Minecraft hoch, Firefox gedrosselt; Spiel endet → alles zurück", async () => {
  const win = fakeWin([{ pid: 12, name: "firefox" }]);
  const modes = [];
  const e = new Engine({ win, settings: settingsObj(), cpuCount: 8, onGameMode: (a, g) => modes.push([a, g]) });
  let snap = await e.tick();
  assert.equal(snap.active, false);
  assert.equal(win.os.get(12).priority, "Normal");

  win.procs.push({ pid: 10, name: "javaw", title: "Minecraft 1.21.11" });
  win.os.set(10, { priority: "Normal", affinity: "255" });
  snap = await e.tick();
  assert.equal(snap.active, true);
  assert.equal(snap.game, "Minecraft");
  assert.deepEqual(win.os.get(10), { priority: "High", affinity: "255" });
  assert.deepEqual(win.os.get(12), { priority: "BelowNormal", affinity: String(0xc0) });
  assert.equal(win.power, "high");
  assert.deepEqual(modes, [[true, "Minecraft"]]);
  assert.ok(win.gpuSet.some(([p, g]) => p.includes("javaw") && g === "high"));
  const calls = win.calls;
  await e.tick();
  assert.equal(win.calls, calls, "nichts doppelt setzen");

  win.procs.splice(win.procs.findIndex((p) => p.pid === 10), 1);
  snap = await e.tick();
  assert.equal(snap.active, false);
  assert.deepEqual(win.os.get(12), { priority: "Normal", affinity: "255" });
  assert.equal(win.power, "balanced");
  assert.equal(e.state.size, 0);
});

test("Beenden setzt alles zurück", async () => {
  const win = fakeWin([{ pid: 12, name: "firefox" }, { pid: 10, name: "javaw", title: "Minecraft" }]);
  const e = new Engine({ win, settings: settingsObj(), cpuCount: 8 });
  await e.tick();
  assert.equal(win.os.get(12).priority, "BelowNormal");
  await e.restoreAll();
  assert.deepEqual(win.os.get(12), { priority: "Normal", affinity: "255" });
  assert.deepEqual(win.os.get(10), { priority: "Normal", affinity: "255" });
  assert.equal(win.power, "balanced");
});

test("Oberflächen-Liste: nach exe zusammengefasst, Beschreibung als Name, Spiel oben", async () => {
  const win = fakeWin([{ pid: 12, name: "firefox", title: "Seite" }, { pid: 13, name: "firefox" }, { pid: 10, name: "javaw", title: "Minecraft" }, { pid: 5, name: "svchost" }, { pid: 20, name: "unsichtbar" }]);
  const e = new Engine({ win, settings: settingsObj(), cpuCount: 8 });
  await e.tick();
  const snap = await e.tick();
  assert.deepEqual(snap.programs.map((p) => [p.name, p.count]), [["Minecraft", 1], ["Firefox", 2]]);
  assert.equal(snap.programs[1].applied, 2);
});

test("Manuell aus: kein Eingriff, auch wenn ein Spiel läuft", async () => {
  const win = fakeWin([{ pid: 12, name: "firefox" }, { pid: 10, name: "javaw", title: "Minecraft" }]);
  const e = new Engine({ win, settings: settingsObj({ manual: "off" }), cpuCount: 8 });
  const snap = await e.tick();
  assert.equal(snap.active, false);
  assert.equal(win.calls, 0);
});
