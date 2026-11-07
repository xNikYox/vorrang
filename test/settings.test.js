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
  const s = clean({ presets: 2, rules: [
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

test("Update von 1.0: Discord und Spotify werden ergänzt, eigene Regeln bleiben", () => {
  const s = clean({ rules: [{ id: "mein-discord", exe: "Discord.exe", level: "minimal" }] }, 8);
  assert.deepEqual(s.rules.map((r) => r.id), ["mein-discord", "spotify"]);
  assert.equal(s.rules[0].level, "minimal");
  assert.equal(s.presets, 2);
  // danach nicht nochmal ergänzen, auch wenn der User Spotify löscht
  assert.deepEqual(clean({ ...s, rules: s.rules.slice(0, 1) }, 8).rules.map((r) => r.id), ["mein-discord"]);
  const fresh = clean(null, 8);
  assert.equal(fresh.rules.find((r) => r.id === "discord").cores, null); // Discord: alle Kerne, nur niedrigere Priorität
});

test("neue Einstellungen werden geprüft", () => {
  const s = clean({ overlayPos: "mitte", hotkeyToggle: "Control+Alt+V; rm", hotkeyOverlay: "", trimRam: 0 }, 8);
  assert.equal(s.overlayPos, "top-right");
  assert.equal(s.hotkeyToggle, "Control+Alt+V");
  assert.equal(s.hotkeyOverlay, ""); // leer = kein Tastenkürzel
  assert.equal(s.trimRam, false);
  assert.equal(clean(null, 8).autoGames, true);
});
