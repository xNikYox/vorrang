// Die Schleife: alle paar Sekunden Prozesse lesen, Spielmodus bestimmen, Priorität/Kerne setzen oder zurücksetzen,
// Grafikkarten-Wahl und Energiesparplan pflegen. Ohne Electron, damit sie sich mit einer Attrappe testen lässt.
const R = require("./rules");

class Engine {
  constructor({ win, settings, cpuCount, onState = () => {}, onGameMode = () => {} }) {
    this.win = win;
    this.settings = settings; // Settings-Objekt (data, update)
    this.cpuCount = cpuCount;
    this.onState = onState;
    this.onGameMode = onGameMode;
    this.state = new Map(); // pid → { orig, applied }
    this.sticky = new Map();
    this.prevCpu = new Map();
    this.prevAt = 0;
    this.gpuDone = new Map(); // exe-Pfad → gesetzte Wahl
    this.descriptions = new Map(); // exe-Pfad → Beschreibung
    this.errors = new Map(); // pid → Fehlertext (z. B. Zugriff verweigert)
    this.active = false;
    this.game = null;
    this.powerBefore = null;
    this.last = null;
    this.running = false;
  }

  async tick() {
    if (this.running) return this.last;
    this.running = true;
    try {
      const s = this.settings.data;
      const procs = await this.win.list();
      const at = Date.now();
      const usage = R.cpuUsage(this.prevCpu, procs, (at - this.prevAt) / 1000, this.cpuCount);
      this.prevCpu = new Map(procs.map((p) => [p.pid, p.cpu]));
      this.prevAt = at;

      const assigned = R.assign(procs, s.rules, this.sticky);
      const game = R.runningGame(assigned);
      const active = R.gameModeActive(s, game);
      if (active !== this.active || game !== this.game) {
        const was = this.active;
        this.active = active;
        this.game = game;
        if (active !== was) {
          await this.powerPlan(active).catch(() => {});
          this.onGameMode(active, game);
        }
      }

      const desired = R.plan(procs, assigned, s, this.cpuCount, active);
      const actions = R.diff(procs, desired, this.state);
      if (actions.length) {
        const results = await this.win.apply(actions);
        for (const a of actions) {
          const r = results.find((x) => x.pid === a.pid);
          if (r?.error) this.errors.set(a.pid, r.error);
          else this.errors.delete(a.pid);
          R.record(this.state, a, r);
        }
      }
      await this.gpu(procs, assigned).catch(() => {});
      await this.describe(procs).catch(() => {});

      this.last = this.snapshot(procs, assigned, usage);
      this.onState(this.last);
      return this.last;
    } finally {
      this.running = false;
    }
  }

  /** Grafikkarten-Wahl: dauerhafte Windows-Einstellung je exe-Pfad, gilt ab dem nächsten Programmstart */
  async gpu(procs, assigned) {
    const want = new Map();
    for (const p of procs) {
      const rule = assigned.get(p.pid);
      if (!p.path) continue;
      if (rule) want.set(p.path, R.effective(rule).gpu);
      else if (!want.has(p.path) && this.gpuDone.has(p.path)) want.set(p.path, null); // Regel entfernt → Eintrag weg
    }
    for (const [exePath, pref] of want) {
      const key = pref || "none";
      if (this.gpuDone.get(exePath) === key) continue;
      if (!pref && !this.gpuDone.has(exePath)) {
        this.gpuDone.set(exePath, key); // nie gesetzt → nichts entfernen
        continue;
      }
      await this.win.gpu(exePath, pref);
      this.gpuDone.set(exePath, key);
    }
  }

  async describe(procs) {
    const missing = [...new Set(procs.map((p) => p.path).filter((p) => p && !this.descriptions.has(p)))].slice(0, 40);
    if (!missing.length) return;
    for (const p of missing) this.descriptions.set(p, null);
    for (const d of await this.win.describe(missing)) this.descriptions.set(d.path, d.description);
  }

  async powerPlan(on) {
    if (on && this.settings.data.powerPlan) {
      const target = await this.win.performancePlan();
      if (!target) return;
      const now = await this.win.activePowerPlan();
      if (now && now !== target) {
        this.powerBefore = now;
        await this.win.setPowerPlan(target);
      }
    } else if (!on && this.powerBefore) {
      const before = this.powerBefore;
      this.powerBefore = null;
      await this.win.setPowerPlan(before);
    }
  }

  /** Alles auf die ursprünglichen Werte zurück (beim Beenden) */
  async restoreAll() {
    const actions = [];
    for (const [pid, s] of this.state) if (s.orig) actions.push({ pid, restore: true, priority: s.orig.priority, affinity: s.orig.affinity });
    if (actions.length) {
      const results = await this.win.apply(actions).catch(() => []);
      for (const a of actions) R.record(this.state, a, results.find((x) => x.pid === a.pid));
    }
    await this.powerPlan(false).catch(() => {});
  }

  /** Für die Oberfläche: Programme nach exe zusammengefasst */
  snapshot(procs, assigned, usage) {
    const s = this.settings.data;
    const groups = new Map();
    for (const p of procs) {
      if (R.isProtected(p)) continue;
      const exe = R.exeName(p.name);
      const rule = assigned.get(p.pid) || null;
      const key = rule ? exe + "#" + rule.id : exe;
      let g = groups.get(key);
      if (!g) {
        g = { key, exe, name: null, path: p.path, title: "", count: 0, cpu: 0, ram: 0, rule: rule?.id || null, level: rule?.level || null, applied: 0, errors: [] };
        groups.set(key, g);
      }
      g.count++;
      g.cpu += usage.get(p.pid) || 0;
      g.ram += p.ram;
      if (!g.path && p.path) g.path = p.path;
      if (!g.title && p.title) g.title = p.title;
      if (this.state.has(p.pid)) g.applied++;
      const err = this.errors.get(p.pid);
      if (err && !g.errors.includes(err)) g.errors.push(err);
    }
    for (const g of groups.values()) {
      const rule = g.rule && s.rules.find((r) => r.id === g.rule);
      g.name = rule?.name || this.descriptions.get(g.path) || g.exe.replace(/\.exe$/, "");
      g.cpu = Math.round(g.cpu * 10) / 10;
    }
    const programs = [...groups.values()]
      .filter((g) => s.showAll || g.rule || g.title || g.cpu >= 1)
      .sort((a, b) => (b.level === "game") - (a.level === "game") || b.cpu - a.cpu || b.ram - a.ram);
    return { at: Date.now(), active: this.active, game: this.game, cpuCount: this.cpuCount, programs, total: groups.size };
  }
}

module.exports = { Engine };
