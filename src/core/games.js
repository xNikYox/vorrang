// Spiele automatisch erkennen: Programme aus Steam-, Epic-, Battle.net-, Riot-, Xbox-, EA-, Ubisoft- und GOG-Ordnern.
// Launcher, Absturz-Melder, Updater und Anti-Cheat-Hilfen zählen nicht als Spiel.
const path = require("node:path");

/** Typische Spiele-Ordner (Teil des Pfads, klein geschrieben) */
const PATTERNS = [
  "\\steamapps\\common\\", "\\epic games\\", "\\riot games\\", "\\xboxgames\\", "\\ea games\\",
  "\\ubisoft game launcher\\games\\", "\\gog galaxy\\games\\", "\\gog games\\",
];

/** Launcher und Hilfsprogramme, die in Spiele-Ordnern liegen, aber keine Spiele sind */
const LAUNCHERS = new Set([
  "steam", "steamservice", "epicgameslauncher", "battle.net", "agent", "riotclientservices", "riotclientux", "riotclientuxrender",
  "riot client", "eadesktop", "eabackgroundservice", "origin", "upc", "ubisoftconnect", "galaxyclient", "galaxyclient helper",
]);
const HELPER = /launcher|crash|helper|updater|update|setup|install|redist|dxsetup|anticheat|beservice|^vgc$|vgtray|cefprocess|cefsubprocess|webhelper|overlay|report|bootstrap|uninst|prereq/i;

const stem = (name) => String(name || "").toLowerCase().replace(/\.exe$/, "");
const dir = (p) => {
  const s = String(p || "").trim().replace(/\//g, "\\").replace(/\\+$/, "");
  return s ? s.toLowerCase() + "\\" : null;
};

/**
 * Installationsordner der Spiele-Bibliotheken finden. io = { readFile(p) → Text | null, readDir(p) → Namen | [], env,
 * steamPath (aus der Registry, optional) }. Ergebnis: klein geschriebene Ordner mit \ am Ende.
 */
function findRoots(io) {
  const env = io.env || {};
  const roots = new Set();
  const join = (...p) => path.win32.join(...p);

  // Steam: alle Bibliotheken aus libraryfolders.vdf
  const steamDirs = [io.steamPath, env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Steam"), env.ProgramFiles && join(env.ProgramFiles, "Steam")].filter(Boolean);
  for (const steam of steamDirs) {
    const vdf = io.readFile(join(steam, "steamapps", "libraryfolders.vdf"));
    if (!vdf) continue;
    roots.add(dir(join(steam, "steamapps", "common")));
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(dir(join(m[1].replace(/\\\\/g, "\\"), "steamapps", "common")));
  }

  // Epic: ein Manifest (*.item, JSON) je Spiel mit InstallLocation
  if (env.ProgramData) {
    const manifests = join(env.ProgramData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
    for (const f of io.readDir(manifests)) {
      if (!/\.item$/i.test(f)) continue;
      try {
        const loc = JSON.parse(io.readFile(join(manifests, f)) || "{}").InstallLocation;
        if (loc) roots.add(dir(loc));
      } catch {
        // kaputtes Manifest
      }
    }
  }

  // Battle.net: Standard-Installationsordner aus der Konfiguration
  if (env.APPDATA) {
    try {
      const cfg = JSON.parse(io.readFile(join(env.APPDATA, "Battle.net", "Battle.net.config")) || "{}");
      const loc = cfg?.Client?.Install?.DefaultInstallPath;
      if (loc) roots.add(dir(loc));
    } catch {
      // keine oder kaputte Konfiguration
    }
  }
  roots.delete(null);
  return [...roots];
}

/** Ist der Prozess ein Spiel? Braucht den Pfad; Launcher/Hilfsprogramme nie. */
function isGame(proc, roots = []) {
  const p = String(proc.path || "").toLowerCase().replace(/\//g, "\\");
  if (!p) return false;
  const name = stem(proc.name);
  if (LAUNCHERS.has(name) || HELPER.test(name)) return false;
  return roots.some((r) => p.startsWith(r)) || PATTERNS.some((x) => p.includes(x));
}

/** Regel für ein automatisch erkanntes Spiel (nicht gespeichert; eigene Regeln gehen immer vor) */
function autoRule(proc, name) {
  return { id: "auto-" + stem(proc.name).replace(/[^\w-]/g, ""), name: name || stem(proc.name), exe: stem(proc.name) + ".exe", level: "game", enabled: true, auto: true };
}

module.exports = { findRoots, isGame, autoRule, PATTERNS };
