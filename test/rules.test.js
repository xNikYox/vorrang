const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../src/core/rules");

const proc = (pid, name, title = "", cpu = 0) => ({ pid, name, title, cpu, path: `C:\\P\\${name}.exe`, ram: 1 });

test("Minecraft wird nur mit passendem Fenstertitel erkannt, danach auch beim Titelwechsel", () => {
  const rules = R.defaultRules();
  const sticky = new Map();
  let a = R.assign([proc(10, "javaw", "Minecraft 1.21.11"), proc(11, "javaw", ""), proc(12, "firefox")], rules, sticky);
  assert.equal(a.get(10).id, "minecraft");
  assert.equal(a.has(11), false); // anderes Java-Programm
  assert.equal(a.get(12).id, "firefox");
  assert.equal(R.runningGame(a), "Minecraft");
  a = R.assign([proc(10, "javaw", "")], rules, sticky); // Titel kurz leer (Laden)
  assert.equal(a.get(10).id, "minecraft");
  a = R.assign([proc(13, "JAVAW", "Mytic Client 2.35")], rules, new Map());
  assert.equal(a.get(13).id, "minecraft");
});

test("geschützte Windows-Prozesse werden nie angefasst", () => {
  const rules = [{ id: "x", name: "x", exe: "svchost.exe", level: "low", enabled: true }, { id: "y", name: "y", exe: "csrss", level: "minimal", enabled: true }];
  assert.equal(R.assign([proc(500, "svchost"), proc(501, "csrss"), proc(4, "System")], rules).size, 0);
});

test("Kern-Masken: Gedrosselte auf die hinteren Kerne, Spiel-Kerne = Rest", () => {
  assert.equal(R.coreMask("all", 8, 2), 0xffn);
  assert.equal(R.coreMask("background", 8, 2), 0xc0n);
  assert.equal(R.coreMask("game", 8, 2), 0x3fn);
  assert.equal(R.coreMask("background", 1, 4), 1n); // nie 0 Kerne
  assert.equal(R.coreMask([0, 2, 99], 4, 1), 0b101n);
  assert.equal(R.coreMask("all", 64, 8), (1n << 64n) - 1n);
  assert.equal(R.coreMask(null, 8, 2), null);
});

test("Plan nur im Spielmodus; alwaysThrottle drosselt auch ohne Spiel (Spiel aber nicht)", () => {
  const rules = R.defaultRules();
  const procs = [proc(10, "javaw", "Minecraft"), proc(12, "firefox")];
  const a = R.assign(procs, rules);
  const s = { backgroundCores: 2 };
  const on = R.plan(procs, a, s, 8, true);
  assert.deepEqual(on.get(10), { priority: "High", affinity: "255", rule: "minecraft" });
  assert.deepEqual(on.get(12), { priority: "BelowNormal", affinity: String(0xc0), rule: "firefox" });
  assert.equal(R.plan(procs, a, s, 8, false).size, 0);
  const always = R.plan(procs, a, { ...s, alwaysThrottle: true }, 8, false);
  assert.equal(always.has(10), false);
  assert.equal(always.get(12).priority, "BelowNormal");
});

test("Feinheiten überschreiben die Stufe; null = nicht ändern; Echtzeit geht nie", () => {
  assert.deepEqual(R.effective({ level: "low", priority: "Idle", cores: null }), { priority: "Idle", cores: null, gpu: null, uploadMbit: null });
  assert.equal(R.effective({ level: "game", priority: "RealTime" }).priority, null);
  assert.equal(R.effective({ level: "minimal", uploadMbit: 2.5 }).uploadMbit, 2.5);
});

test("Spielmodus: Automatik, immer an, aus", () => {
  assert.equal(R.gameModeActive({ manual: "auto", autoGameMode: true }, "Minecraft"), true);
  assert.equal(R.gameModeActive({ manual: "auto", autoGameMode: true }, null), false);
  assert.equal(R.gameModeActive({ manual: "auto", autoGameMode: false }, "Minecraft"), false);
  assert.equal(R.gameModeActive({ manual: "on" }, null), true);
  assert.equal(R.gameModeActive({ manual: "off" }, "Minecraft"), false);
});

test("Abgleich: nur Änderungen, danach zurück auf die Ursprungswerte, tote Prozesse vergessen", () => {
  const state = new Map();
  const procs = [proc(12, "firefox")];
  const want = new Map([[12, { priority: "BelowNormal", affinity: "192" }]]);
  let acts = R.diff(procs, want, state);
  assert.deepEqual(acts, [{ pid: 12, priority: "BelowNormal", affinity: "192" }]);
  R.record(state, acts[0], { pid: 12, priority: "Normal", affinity: "255" });
  assert.deepEqual(R.diff(procs, want, state), []); // schon gesetzt
  acts = R.diff(procs, new Map(), state);
  assert.deepEqual(acts, [{ pid: 12, restore: true, priority: "Normal", affinity: "255" }]);
  R.record(state, acts[0], { pid: 12, priority: "BelowNormal", affinity: "192" });
  assert.equal(state.size, 0);
  R.record(state, { pid: 12, priority: "Idle" }, { pid: 12, priority: "Normal", affinity: "255" });
  assert.deepEqual(R.diff([], new Map(), state), []);
  assert.equal(state.size, 0);
});

test("Fehler (z. B. Zugriff verweigert) werden nicht als gesetzt gemerkt", () => {
  const state = new Map();
  R.record(state, { pid: 9, priority: "High" }, { pid: 9, error: "Zugriff verweigert" });
  assert.equal(state.size, 0);
});

test("Upload-Limits als QoS-Richtlinien", () => {
  const rules = [
    { id: "firefox", exe: "firefox.exe", level: "low", enabled: true, uploadMbit: 5 },
    { id: "obs", exe: "obs64", level: "normal", enabled: false, uploadMbit: 2 },
    { id: "a b", exe: "x.exe", level: "low", enabled: true },
  ];
  assert.deepEqual(R.qosPolicies(rules), [{ name: "Vorrang-firefox", exe: "firefox.exe", bits: 5000000 }]);
});

test("CPU-Auslastung in Prozent der Gesamtleistung", () => {
  const u = R.cpuUsage(new Map([[1, 10], [2, 5]]), [{ pid: 1, cpu: 14 }, { pid: 2, cpu: null }, { pid: 3, cpu: 1 }], 2, 4);
  assert.equal(u.get(1), 50);
  assert.equal(u.has(2), false);
  assert.equal(u.has(3), false);
});
