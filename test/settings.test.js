const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Settings, clean } = require("../src/core/settings");

test("Standard beim ersten Start, kaputte Datei → Standard", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vorrang-test-"));
  const s = new Settings(dir, 16);
  assert.equal(s.data.rules[0].id, "minecraft");
  assert.equal(s.data.backgroundCores, 4);
  fs.writeFileSync(path.join(dir, "einstellungen.json"), "{kaputt");
  assert.equal(new Settings(dir, 16).data.manual, "auto");
  s.update({ manual: "on", backgroundCores: 99 });
  const again = new Settings(dir, 16);
  assert.equal(again.data.manual, "on");
  assert.equal(again.data.backgroundCores, 15); // mindestens 1 Kern bleibt fürs Spiel
});

test("Regeln werden bereinigt", () => {
  const s = clean({ rules: [
    { id: "a", exe: "Firefox", level: "quatsch", priority: "RealTime", cores: [1, "x", 70], gpu: "mega", uploadMbit: "3.33" },
    { id: "a", exe: "doppelt.exe" },
    { exe: "" },
    { id: "b", exe: "x.exe", priority: null, cores: "background" },
  ] }, 8);
  assert.equal(s.rules.length, 2);
  assert.deepEqual(s.rules[0], { id: "a", name: "Firefox", exe: "firefox.exe", level: "normal", enabled: true, cores: [1], uploadMbit: 3.3 });
  assert.equal(s.rules[1].priority, null);
  assert.equal(s.rules[1].cores, "background");
});
