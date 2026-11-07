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
    trimmed: [], servicesCalls: [], oneDrive: [], pings: [], conns: [],
    trim: async (pids) => (w.trimmed.push(pids), { freed: pids.length * 100e6, n: pids.length }),
    services: async (pause) => w.servicesCalls.push(pause),
    stopOneDrive: async (p) => w.oneDrive.push(["stop", p]),
    startOneDrive: (p) => w.oneDrive.push(["start", p]),
    connections: async () => w.conns,
    ping: async (host) => (w.pings.push(host), w.pingMs ?? null),
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

test("Spielstart-Boost: RAM der Gedrosselten, Dienste und OneDrive pausieren – danach wieder an", async () => {
  const win = fakeWin([{ pid: 12, name: "firefox" }, { pid: 30, name: "OneDrive" }, { pid: 31, name: "discord" }]);
  const events = [];
  const e = new Engine({ win, settings: settingsObj({ pauseServices: true, pauseOneDrive: true }), cpuCount: 8, onGameMode: (a, g, x) => events.push([a, g, x]) });
  e.servicesReady = true;
  await e.tick();
  win.procs.push({ pid: 10, name: "javaw", title: "Minecraft" });
  win.os.set(10, { priority: "Normal", affinity: "255" });
  const snap = await e.tick();
  assert.deepEqual(win.trimmed, [[12, 31]]); // nur Gedrosselte, nicht das Spiel
  assert.deepEqual(win.servicesCalls, [true]);
  assert.deepEqual(win.oneDrive, [["stop", "C:\\P\\OneDrive.exe"]]);
  assert.deepEqual(events[0], [true, "Minecraft", { freed: 200e6, services: true, oneDrive: true }]);
  assert.deepEqual(snap.boost, { services: true, oneDrive: true });
  win.procs.splice(win.procs.findIndex((p) => p.pid === 10), 1);
  await e.tick();
  assert.deepEqual(win.servicesCalls, [true, false]);
  assert.deepEqual(win.oneDrive.at(-1), ["start", "C:\\P\\OneDrive.exe"]);
});

test("Dienste werden ohne Einrichtung nicht angefasst; Beenden startet Pausiertes wieder", async () => {
  const win = fakeWin([{ pid: 10, name: "javaw", title: "Minecraft" }]);
  const e = new Engine({ win, settings: settingsObj({ pauseServices: true }), cpuCount: 8 });
  await e.tick();
  assert.deepEqual(win.servicesCalls, []);
  e.servicesReady = true;
  e.servicesPaused = true;
  await e.restoreAll();
  assert.deepEqual(win.servicesCalls, [false]);
});

test("Spiele aus Steam & Co. bekommen automatisch Vorrang (abschaltbar)", async () => {
  const procs = [{ pid: 50, name: "cs2", title: "Counter-Strike 2", path: "D:\\SteamLibrary\\steamapps\\common\\cs2\\cs2.exe" }];
  const win = fakeWin(procs);
  const e = new Engine({ win, settings: settingsObj(), cpuCount: 8 });
  await e.tick();
  const snap = await e.tick();
  assert.equal(snap.active, true);
  assert.equal(win.os.get(50).priority, "High");
  assert.equal(snap.programs[0].auto, true);
  assert.equal(snap.programs[0].rule, null);
  const off = new Engine({ win: fakeWin(procs), settings: settingsObj({ autoGames: false }), cpuCount: 8 });
  assert.equal((await off.tick()).active, false);
});

test("Messwerte, Ping zum Spielserver und Ersatz per TCP, wenn ICMP blockiert ist", async () => {
  const win = fakeWin([{ pid: 10, name: "javaw", title: "Minecraft" }]);
  win.conns = [{ address: "203.0.113.5", port: 443, pid: 10 }, { address: "203.0.113.9", port: 25565, pid: 10 }];
  win.pingMs = 23;
  const tcp = [];
  const e = new Engine({ win, settings: settingsObj(), cpuCount: 8, sys: { cpu: () => 41.26, mem: () => ({ used: 8, total: 32 }) }, tcpPing: async (h, p) => (tcp.push([h, p]), 31) });
  await e.tick();
  await e.netTick();
  assert.deepEqual(win.pings, ["203.0.113.9"]); // Spielserver, nicht die Web-Verbindung
  const snap = await e.tick();
  assert.deepEqual([snap.metrics.cpu, snap.metrics.ram, snap.metrics.ping, snap.metrics.server], [41.3, 25, 23, "203.0.113.9:25565"]);
  win.pingMs = null;
  for (let i = 0; i < 3; i++) await e.netTick();
  assert.equal(e.net.ping, null);
  await e.netTick();
  assert.deepEqual(tcp, [["203.0.113.9", 25565]]);
  assert.equal(e.net.ping, 31);
  await e.netTick(); // innerhalb von 15 s kein weiterer Verbindungsaufbau
  assert.equal(tcp.length, 1);
});

test("Vorher/Nachher-Messung: erst ohne, dann mit Vorrang, danach wieder normal", async () => {
  const win = fakeWin([{ pid: 12, name: "firefox" }, { pid: 10, name: "javaw", title: "Minecraft" }]);
  let cpu = 50;
  const e = new Engine({ win, settings: settingsObj(), cpuCount: 8, sys: { cpu: () => cpu, mem: () => ({ used: 1, total: 2 }) } });
  const modes = [];
  e.onGameMode = (a) => modes.push(a);
  await e.tick();
  assert.equal(win.os.get(12).priority, "BelowNormal");
  assert.deepEqual(modes, [true]); // normaler Spielstart
  modes.length = 0;
  const seen = [];
  const res = await e.measure({ seconds: 3, settle: 0, progress: (label, f) => seen.push([label, f]), sleep: async () => {
    await e.tick();
    seen.push(["prio", win.os.get(12).priority]);
    cpu += 1;
  } });
  assert.equal(res.game, "Minecraft");
  assert.ok(seen.some(([l, v]) => l === "prio" && v === "Normal"), "ohne Vorrang zurückgesetzt");
  assert.ok(res.after.cpu > res.before.cpu);
  assert.equal(seen.filter(([l]) => l !== "prio").at(-1)[1], 1);
  assert.deepEqual(modes, [], "keine Hinweise/Dienste während der Messung");
  assert.equal(e.force, null);
  await e.tick();
  assert.equal(win.os.get(12).priority, "BelowNormal");
  await assert.rejects(new Engine({ win: fakeWin([]), settings: settingsObj(), cpuCount: 8 }).measure(), /Starte zuerst ein Spiel/);
});
