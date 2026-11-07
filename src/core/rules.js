// Regeln und Plan: Welche Programme bekommen welche Priorität und welche CPU-Kerne?
// Reine Logik ohne Windows-Aufrufe, damit sie sich überall testen lässt.

/** Stufen, die man pro Programm wählt. null = nicht anfassen. */
const LEVELS = {
  game: { label: "Vorrang", priority: "High", cores: "all", gpu: "high" },
  normal: { label: "Normal", priority: null, cores: null, gpu: null },
  low: { label: "Gedrosselt", priority: "BelowNormal", cores: "background", gpu: null, memPriority: 2 },
  minimal: { label: "Minimal", priority: "Idle", cores: "background", gpu: "saving", memPriority: 1 },
};

/** Erlaubte Prioritäten (Echtzeit absichtlich nicht: kann Windows einfrieren) */
const PRIORITIES = ["Idle", "BelowNormal", "Normal", "AboveNormal", "High"];

/** Programme, die nie angefasst werden – sonst hakt Windows selbst */
const PROTECTED = new Set([
  "system", "idle", "registry", "memory compression", "smss", "csrss", "wininit", "winlogon", "services", "lsass",
  "lsaiso", "svchost", "dwm", "fontdrvhost", "audiodg", "msmpeng", "securityhealthservice", "sgrmbroker",
  "searchindexer", "spoolsv", "conhost", "vorrang",
]);

const exeName = (name) => {
  const n = String(name || "").trim().toLowerCase();
  return n.endsWith(".exe") ? n : n + ".exe";
};
const isProtected = (proc) => proc.pid <= 4 || PROTECTED.has(String(proc.name || "").toLowerCase().replace(/\.exe$/, ""));

/** Standard-Regeln beim ersten Start */
function defaultRules() {
  return [
    { id: "minecraft", name: "Minecraft", exe: "javaw.exe", title: "minecraft|mytic", level: "game", enabled: true },
    { id: "firefox", name: "Firefox", exe: "firefox.exe", level: "low", enabled: true },
    { id: "chrome", name: "Google Chrome", exe: "chrome.exe", level: "low", enabled: true },
    { id: "msedge", name: "Microsoft Edge", exe: "msedge.exe", level: "low", enabled: true },
    ...presetRules(),
  ];
}

/** Vorgaben ab Version 1.1: Discord und Spotify nur leicht drosseln, damit Sprache und Musik nicht stocken */
function presetRules() {
  return [
    { id: "discord", name: "Discord", exe: "discord.exe", level: "low", cores: null, enabled: true }, // alle Kerne, nur niedrigere Priorität
    { id: "spotify", name: "Spotify", exe: "spotify.exe", level: "low", enabled: true },
  ];
}

/** Regel aufbereiten: Stufe + eigene Abweichungen (priority/cores/gpu/uploadMbit) */
function effective(rule) {
  const base = LEVELS[rule.level] || LEVELS.normal;
  const pick = (k) => (rule[k] !== undefined && rule[k] !== "level" ? rule[k] : base[k]);
  const priority = pick("priority");
  return {
    priority: PRIORITIES.includes(priority) ? priority : null,
    cores: pick("cores") ?? null, // "all" | "background" | "game" | [Kernnummern] | null
    gpu: pick("gpu") ?? null, // "high" | "saving" | "auto" | null
    uploadMbit: Number(rule.uploadMbit) > 0 ? Number(rule.uploadMbit) : null,
    memPriority: base.memPriority || null, // Speicher-Priorität 1 (sehr niedrig) … 5 (normal); Windows lagert Niedrige zuerst aus
  };
}

/** Passt der Prozess zur Regel? Titel-Teile mit | getrennt, Groß/klein egal. */
function matches(proc, rule) {
  if (!rule.enabled || isProtected(proc)) return false;
  if (exeName(proc.name) !== exeName(rule.exe)) return false;
  if (!rule.title) return true;
  const title = String(proc.title || "").toLowerCase();
  return rule.title.toLowerCase().split("|").map((s) => s.trim()).filter(Boolean).some((s) => title.includes(s));
}

/**
 * Prozesse den Regeln zuordnen → Map pid → Regel. sticky (pid → Regel-ID) merkt sich frühere Treffer, damit ein Spiel
 * nicht herausfällt, wenn sich kurz sein Fenstertitel ändert (z. B. beim Laden).
 * auto = { isGame(proc), rule(proc) }: automatisch erkannte Spiele, wenn keine eigene Regel passt (nur mit Fenster).
 */
function assign(procs, rules, sticky = new Map(), auto = null) {
  const out = new Map();
  const alive = new Set(procs.map((p) => p.pid));
  for (const pid of [...sticky.keys()]) if (!alive.has(pid)) sticky.delete(pid);
  for (const p of procs) {
    let rule = rules.find((r) => matches(p, r));
    if (!rule && sticky.has(p.pid)) {
      const id = sticky.get(p.pid);
      rule = rules.find((r) => r.id === id && r.enabled && exeName(r.exe) === exeName(p.name));
      if (!rule && auto && String(id).startsWith("auto-") && !rules.some((r) => r.enabled && exeName(r.exe) === exeName(p.name))) rule = auto.rule(p);
    }
    if (!rule && auto && p.title && !isProtected(p) && !rules.some((r) => r.enabled && exeName(r.exe) === exeName(p.name)) && auto.isGame(p)) rule = auto.rule(p);
    if (rule) {
      out.set(p.pid, rule);
      if (rule.title || rule.auto) sticky.set(p.pid, rule.id);
    }
  }
  return out;
}

/** Läuft gerade ein Spiel (Regel mit Stufe Vorrang)? → Name des Spiels oder null */
function runningGame(assigned) {
  for (const rule of assigned.values()) if (rule.level === "game") return rule.name;
  return null;
}

/** Ist der Spielmodus an? manual: "on" | "off" | "auto" */
function gameModeActive(settings, game) {
  if (settings.manual === "on") return true;
  if (settings.manual === "off") return false;
  return settings.autoGameMode !== false && !!game;
}

/** Kern-Maske (BigInt) für n logische Kerne. backgroundCores = wie viele (die letzten) Kerne Hintergrund-Programme bekommen. */
function coreMask(cores, cpuCount, backgroundCores) {
  const n = Math.max(1, Math.min(64, cpuCount | 0));
  const all = (1n << BigInt(n)) - 1n;
  const bg = Math.max(1, Math.min(n, backgroundCores | 0 || Math.max(1, Math.floor(n / 4))));
  const bgMask = ((1n << BigInt(bg)) - 1n) << BigInt(n - bg);
  if (cores === "all") return all;
  if (cores === "background") return bgMask;
  if (cores === "game") return n - bg > 0 ? all & ~bgMask : all; // die Kerne, die der Hintergrund nicht hat
  if (Array.isArray(cores)) {
    let m = 0n;
    for (const c of cores) if (Number.isInteger(c) && c >= 0 && c < n) m |= 1n << BigInt(c);
    return m || all;
  }
  return null;
}

/**
 * Soll-Zustand: pid → { priority, affinity } für alle zugeordneten Prozesse. Nur im Spielmodus – sonst leer (alles
 * zurück auf die ursprünglichen Werte). Mit settings.alwaysThrottle werden Gedrosselte auch ohne Spiel gedrosselt.
 */
function plan(procs, assigned, settings, cpuCount, active) {
  const desired = new Map();
  for (const p of procs) {
    const rule = assigned.get(p.pid);
    if (!rule) continue;
    const isGame = rule.level === "game";
    if (!active && !(settings.alwaysThrottle && !isGame)) continue;
    const e = effective(rule);
    const affinity = e.cores ? coreMask(e.cores, cpuCount, settings.backgroundCores) : null;
    const mem = settings.memPriority !== false ? e.memPriority : null;
    if (!e.priority && affinity == null && !mem) continue;
    const want = { priority: e.priority, affinity: affinity == null ? null : affinity.toString(), rule: rule.id };
    if (mem) want.memPriority = mem;
    desired.set(p.pid, want);
  }
  return desired;
}

/**
 * Abgleich mit dem, was schon gesetzt ist. state: pid → { orig: {priority, affinity} | null, applied: {priority, affinity} }.
 * Ergebnis: Liste { pid, priority?, affinity?, restore? } – restore = auf den gemerkten Ursprung zurück.
 */
function diff(procs, desired, state) {
  const alive = new Set(procs.map((p) => p.pid));
  for (const pid of [...state.keys()]) if (!alive.has(pid)) state.delete(pid);
  const actions = [];
  for (const [pid, want] of desired) {
    const cur = state.get(pid)?.applied || {};
    const a = { pid };
    if (want.priority && want.priority !== cur.priority) a.priority = want.priority;
    if (want.affinity != null && want.affinity !== cur.affinity) a.affinity = want.affinity;
    if (want.memPriority && want.memPriority !== cur.memPriority) a.memPriority = want.memPriority;
    if (a.priority || a.affinity != null || a.memPriority) actions.push(a);
  }
  for (const [pid, s] of state) {
    if (desired.has(pid) || !s.orig) continue;
    const a = { pid, restore: true, priority: s.orig.priority, affinity: s.orig.affinity };
    if (s.applied.memPriority && s.orig.memPriority && !s.memFailed) a.memPriority = s.orig.memPriority;
    actions.push(a);
  }
  return actions;
}

/** Ergebnis einer Aktion in den Zustand übernehmen (orig = Werte vor der ersten Änderung) */
function record(state, action, result) {
  if (!result || result.error) return;
  if (action.restore) {
    state.delete(action.pid);
    return;
  }
  const s = state.get(action.pid) || { orig: { priority: result.priority, affinity: result.affinity, memPriority: result.memPriority ?? null }, applied: {} };
  if (action.priority) s.applied.priority = action.priority;
  if (action.affinity != null) s.applied.affinity = action.affinity;
  if (action.memPriority) {
    s.applied.memPriority = action.memPriority; // auch bei Fehler merken: nicht jede Runde neu versuchen
    if (result.memPriorityOk === false) s.memFailed = true;
  }
  state.set(action.pid, s);
}

/** Gewünschte Upload-Limits (QoS-Richtlinien) aus den Regeln: [{ name, exe, bits }] */
function qosPolicies(rules) {
  return rules
    .filter((r) => r.enabled && effective(r).uploadMbit)
    .map((r) => ({ name: "Vorrang-" + String(r.id).replace(/[^\w-]/g, ""), exe: exeName(r.exe), bits: Math.round(effective(r).uploadMbit * 1e6) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** CPU-Auslastung je Prozess aus zwei Messungen (CPU-Sekunden) in Prozent der Gesamtleistung */
function cpuUsage(prev, procs, seconds, cpuCount) {
  const out = new Map();
  for (const p of procs) {
    const before = prev.get(p.pid);
    if (before == null || p.cpu == null || seconds <= 0) continue;
    out.set(p.pid, Math.max(0, Math.min(100, ((p.cpu - before) / seconds / Math.max(1, cpuCount)) * 100)));
  }
  return out;
}

module.exports = { presetRules, LEVELS, PRIORITIES, PROTECTED, exeName, isProtected, defaultRules, effective, matches, assign, runningGame, gameModeActive, coreMask, plan, diff, record, qosPolicies, cpuUsage };
