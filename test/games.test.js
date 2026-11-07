const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../src/core/games");
const R = require("../src/core/rules");

const files = {
  "C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf": `"libraryfolders"\n{\n "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" }\n "1" { "path" "D:\\\\SteamLibrary" }\n}`,
  "C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests\\a.item": JSON.stringify({ InstallLocation: "E:\\Spiele\\Fortnite" }),
  "C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests\\kaputt.item": "{",
  "C:\\Users\\n\\AppData\\Roaming\\Battle.net\\Battle.net.config": JSON.stringify({ Client: { Install: { DefaultInstallPath: "F:/Blizzard" } } }),
};
const io = {
  env: { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramData: "C:\\ProgramData", APPDATA: "C:\\Users\\n\\AppData\\Roaming" },
  readFile: (p) => files[p] ?? null,
  readDir: (d) => Object.keys(files).filter((f) => f.startsWith(d + "\\")).map((f) => f.slice(d.length + 1)),
};

test("Bibliotheken von Steam, Epic und Battle.net werden gefunden", () => {
  assert.deepEqual(G.findRoots(io).sort(), [
    "c:\\program files (x86)\\steam\\steamapps\\common\\",
    "d:\\steamlibrary\\steamapps\\common\\",
    "e:\\spiele\\fortnite\\",
    "f:\\blizzard\\",
  ]);
  assert.deepEqual(G.findRoots({ env: {}, readFile: () => null, readDir: () => [] }), []);
});

test("Spiele erkennen, Launcher und Hilfsprogramme nicht", () => {
  const roots = G.findRoots(io);
  const p = (name, path) => ({ pid: 100, name, path, title: "x" });
  assert.equal(G.isGame(p("cs2", "D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe"), roots), true);
  assert.equal(G.isGame(p("FortniteClient-Win64-Shipping", "E:\\Spiele\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe"), roots), true);
  assert.equal(G.isGame(p("Overwatch", "F:\\Blizzard\\Overwatch\\_retail_\\Overwatch.exe"), roots), true);
  assert.equal(G.isGame(p("VALORANT-Win64-Shipping", "C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe"), []), true);
  assert.equal(G.isGame(p("UnityCrashHandler64", "D:\\SteamLibrary\\steamapps\\common\\X\\UnityCrashHandler64.exe"), roots), false);
  assert.equal(G.isGame(p("RiotClientServices", "C:\\Riot Games\\Riot Client\\RiotClientServices.exe"), []), false);
  assert.equal(G.isGame(p("EasyAntiCheat_EOS", "E:\\Spiele\\Fortnite\\EasyAntiCheat_EOS.exe"), roots), false);
  assert.equal(G.isGame(p("firefox", "C:\\Program Files\\Mozilla Firefox\\firefox.exe"), roots), false);
  assert.equal(G.isGame(p("x", null), roots), false);
});

test("Zuordnung: erkannte Spiele nur mit Fenster, eigene Regeln gehen vor", () => {
  const auto = { isGame: (p) => G.isGame(p, []), rule: (p) => G.autoRule(p, "Valorant") };
  const path = "C:\\Riot Games\\VALORANT\\live\\VALORANT-Win64-Shipping.exe";
  const sticky = new Map();
  let a = R.assign([{ pid: 7, name: "VALORANT-Win64-Shipping", path, title: "" }], [], sticky, auto);
  assert.equal(a.size, 0); // noch kein Fenster
  a = R.assign([{ pid: 7, name: "VALORANT-Win64-Shipping", path, title: "VALORANT" }], [], sticky, auto);
  assert.equal(a.get(7).id, "auto-valorant-win64-shipping");
  assert.equal(a.get(7).level, "game");
  assert.equal(R.runningGame(a), "Valorant");
  a = R.assign([{ pid: 7, name: "VALORANT-Win64-Shipping", path, title: "" }], [], sticky, auto); // Fenster kurz weg
  assert.equal(a.get(7).id, "auto-valorant-win64-shipping");
  // „ist kein Spiel“: eigene Regel mit Stufe Normal
  const own = [{ id: "v", name: "V", exe: "valorant-win64-shipping.exe", level: "normal", enabled: true }];
  a = R.assign([{ pid: 7, name: "VALORANT-Win64-Shipping", path, title: "VALORANT" }], own, sticky, auto);
  assert.equal(a.get(7).id, "v");
  assert.equal(R.runningGame(a), null);
});
