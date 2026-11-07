// Einstellungen und Regeln: eine JSON-Datei im Benutzerordner der App. Ungültiges wird beim Laden repariert.
const fs = require("node:fs");
const path = require("node:path");
const { LEVELS, PRIORITIES, defaultRules, presetRules, exeName } = require("./rules");

function defaults(cpuCount) {
  return {
    rules: defaultRules(),
    manual: "auto", // "auto" = Spielmodus, sobald ein Spiel läuft | "on" | "off"
    autoGameMode: true,
    alwaysThrottle: false, // Gedrosselte auch ohne laufendes Spiel drosseln
    backgroundCores: Math.max(1, Math.floor(cpuCount / 4)),
    powerPlan: false, // im Spielmodus Energiesparplan „Höchstleistung“
    autostart: true,
    startHidden: true,
    closeToTray: true,
    notify: true,
    interval: 3,
    showAll: false,
    qosApplied: [], // zuletzt mit Admin-Rechten gesetzte Upload-Limits
    presets: 2, // Stand der Vorgaben (2 = Discord/Spotify ergänzt)
    autoGames: true, // Spiele aus Steam/Epic/… automatisch erkennen
    trimRam: true, // beim Spielstart RAM der Gedrosselten freiräumen
    pauseServices: false, // Windows Update, Übermittlungsoptimierung, Suche pausieren (einmal Admin)
    pauseOneDrive: false,
    overlay: false,
    overlayPos: "top-right",
    overlayAlways: false, // auch ohne Spielmodus zeigen
    hotkeyToggle: "Control+Alt+V",
    hotkeyOverlay: "Control+Alt+O",
  };
}

const CORES = ["all", "background", "game"];
const OVERLAY_POS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const GPUS = ["high", "saving", "auto"];

function cleanRule(r, i) {
  if (!r || typeof r !== "object" || !String(r.exe || "").trim()) return null;
  const rule = {
    id: String(r.id || "r" + Date.now().toString(36) + i).replace(/[^\w-]/g, "").slice(0, 40) || "r" + i,
    name: String(r.name || r.exe).slice(0, 60),
    exe: exeName(r.exe).slice(0, 120),
    level: LEVELS[r.level] ? r.level : "normal",
    enabled: r.enabled !== false,
  };
  if (r.title) rule.title = String(r.title).slice(0, 120);
  if (r.priority === null || PRIORITIES.includes(r.priority)) rule.priority = r.priority;
  if (r.cores === null || CORES.includes(r.cores)) rule.cores = r.cores;
  else if (Array.isArray(r.cores)) rule.cores = r.cores.filter((c) => Number.isInteger(c) && c >= 0 && c < 64).slice(0, 64);
  if (r.gpu === null || GPUS.includes(r.gpu)) rule.gpu = r.gpu;
  if (Number(r.uploadMbit) > 0) rule.uploadMbit = Math.min(10000, Math.round(Number(r.uploadMbit) * 10) / 10);
  return rule;
}

function clean(raw, cpuCount) {
  const d = defaults(cpuCount);
  const s = { ...d, ...(raw && typeof raw === "object" ? raw : {}) };
  // Ältere Einstellungen: neue Vorgaben (Discord, Spotify) ergänzen, wenn es für das Programm noch keine Regel gibt
  if (raw && typeof raw === "object" && Array.isArray(raw.rules) && (Number(raw.presets) || 1) < 2) {
    const have = new Set(raw.rules.map((r) => exeName(r?.exe)));
    s.rules = [...raw.rules, ...presetRules().filter((r) => !have.has(r.exe))];
  }
  s.presets = 2;
  const seen = new Set();
  s.rules = (Array.isArray(s.rules) ? s.rules : d.rules).map(cleanRule).filter((r) => r && !seen.has(r.id) && seen.add(r.id));
  if (!["auto", "on", "off"].includes(s.manual)) s.manual = "auto";
  for (const k of ["autoGameMode", "alwaysThrottle", "powerPlan", "autostart", "startHidden", "closeToTray", "notify", "showAll", "autoGames", "trimRam", "pauseServices", "pauseOneDrive", "overlay", "overlayAlways"]) s[k] = !!s[k];
  if (!OVERLAY_POS.includes(s.overlayPos)) s.overlayPos = d.overlayPos;
  for (const k of ["hotkeyToggle", "hotkeyOverlay"]) s[k] = typeof s[k] === "string" && /^[\w+]{0,60}$/.test(s[k]) ? s[k] : d[k];
  s.backgroundCores = Math.max(1, Math.min(Math.max(1, cpuCount - 1), Number(s.backgroundCores) | 0 || d.backgroundCores));
  s.interval = Math.max(1, Math.min(30, Number(s.interval) || 3));
  if (!Array.isArray(s.qosApplied)) s.qosApplied = [];
  return s;
}

class Settings {
  constructor(dir, cpuCount) {
    this.file = path.join(dir, "einstellungen.json");
    this.cpuCount = cpuCount;
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      // erster Start oder kaputte Datei → Standard
    }
    this.data = clean(raw, cpuCount);
  }

  update(patch) {
    this.data = clean({ ...this.data, ...patch }, this.cpuCount);
    this.save();
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, clean, cleanRule, defaults };
