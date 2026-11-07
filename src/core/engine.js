// Die Schleife: alle paar Sekunden Prozesse lesen, Spielmodus bestimmen, Priorität/Kerne setzen oder zurücksetzen,
// Grafikkarten-Wahl und Energiesparplan pflegen. Ohne Electron, damit sie sich mit einer Attrappe testen lässt.
const R = require("./rules");

const G = require("./games");
const net = require("node:net");

const HISTORY = 120; // Messpunkte im Verlauf

class Engine {
  constructor({ win, settings, cpuCount, onState = () => {}, onGameMode = () => {}, onRamWarning = () => {}, sys = null, tcpPing = null }) {
    this.onRamWarning = onRamWarning;
    this.win = win;
    this.settings = settings; // Settings-Objekt (data, update)
    this.cpuCount = cpuCount;
    this.onState = onState;
    this.onGameMode = onGameMode;
    this.sys = sys || { cpu: () => null, mem: () => ({ used: 0, total: 0 }) };
    this.tcpPing = tcpPing || tcpConnectTime;
    this.state = new Map(); // pid → { orig, applied }
    this.sticky = new Map();
    this.prevCpu = new Map();
    this.prevAt = 0;
    this.gpuDone = new Map(); // exe-Pfad → gesetzte Wahl
    this.descriptions = new Map(); // exe-Pfad → Beschreibung
    this.errors = new Map(); // pid → Fehlertext (z. B. Zugriff verweigert)
    this.roots = []; // Spiele-Bibliotheken (Steam, Epic, …)
    this.servicesReady = false;
    this.servicesPaused = false;
    this.oneDrivePath = null;
    this.active = false;
    this.game = null;
    this.gamePids = [];
    this.powerBefore = null;
    this.last = null;
    this.running = false;
    this.force = null; // "on" | "off" während der Messung
    this.measuring = false;
    this.sample = null;
    this.history = [];
    this.net = { target: null, targetAt: 0, ping: null, fails: 0, at: 0 };
    this.ramReady = false;
    this.ramWatching = false;
    this.ram = { trims: 0, freed: 0, lastTrim: 0, highSince: 0, warnedAt: 0 };
  }

  /** Regel-Zuordnung inkl. automatisch erkannter Spiele */
  assign(procs) {
    const s = this.settings.data;
    const auto = s.autoGames
      ? { isGame: (p) => G.isGame(p, this.roots), rule: (p) => G.autoRule(p, this.descriptions.get(p.path) || null) }
      : null;
    return R.assign(procs, s.rules, this.sticky, auto);
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

      const assigned = this.assign(procs);
      const game = R.runningGame(assigned);
      this.gamePids = [...assigned].filter(([, r]) => r.level === "game").map(([pid]) => pid);
      const active = this.force ? this.force === "on" : R.gameModeActive(s, game);
      let changed = false;
      if (active !== this.active || game !== this.game) {
        changed = active !== this.active;
        this.active = active;
        this.game = game;
        if (changed) await this.powerPlan(active).catch(() => {});
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
      if (changed) {
        const extra = this.measuring ? {} : await this.boost(active, procs, assigned).catch(() => ({}));
        if (!this.measuring) this.onGameMode(active, game, extra);
      }
      await this.gpu(procs, assigned).catch(() => {});
      await this.describe(procs).catch(() => {});

      this.metrics(usage);
      if (!this.measuring) await this.ramCare(procs, assigned).catch(() => {});
      this.last = this.snapshot(procs, assigned, usage);
      this.onState(this.last);
      return this.last;
    } finally {
      this.running = false;
    }
  }

  /**
   * Zusätzlich beim An-/Ausschalten: RAM der Gedrosselten freiräumen, Windows-Dienste und OneDrive pausieren
   * bzw. wieder starten. → { freed (Bytes), services, oneDrive }
   */
  async boost(on, procs, assigned) {
    const s = this.settings.data;
    const out = {};
    if (on) {
      if (s.trimRam) {
        const pids = [...assigned].filter(([, r]) => r.level === "low" || r.level === "minimal").map(([pid]) => pid);
        out.freed = (await this.win.trim(pids).catch(() => ({ freed: 0 }))).freed || 0;
      }
      if (s.pauseServices && this.servicesReady && !this.servicesPaused) {
        await this.win.services(true).then(() => (this.servicesPaused = out.services = true)).catch(() => {});
      }
      if (s.standbyPurge && this.ramReady && !this.ramWatching) {
        await this.win.ramWatch(true).then(() => (this.ramWatching = out.standby = true)).catch(() => {});
      }
      if (s.pauseOneDrive && !this.oneDrivePath) {
        const od = procs.find((p) => String(p.name).toLowerCase() === "onedrive" && p.path);
        if (od) {
          this.oneDrivePath = od.path;
          await this.win.stopOneDrive(od.path).catch(() => {});
          out.oneDrive = true;
        }
      }
    } else await this.unboost();
    return out;
  }

  /**
   * Im Spielmodus: wird der RAM knapp (über 85 %), die Gedrosselten erneut freiräumen (höchstens einmal pro Minute);
   * über 90 % für mehr als 6 s → Hinweis mit den größten RAM-Fressern (höchstens alle 10 Minuten).
   */
  async ramCare(procs, assigned) {
    const s = this.settings.data;
    const used = this.current?.ram;
    if (!this.active || used == null) {
      this.ram.highSince = 0;
      return;
    }
    const now = Date.now();
    if (s.autoTrim && used >= 85 && now - this.ram.lastTrim >= 60000) {
      this.ram.lastTrim = now;
      const pids = [...assigned].filter(([, r]) => r.level === "low" || r.level === "minimal").map(([pid]) => pid);
      if (pids.length) {
        const r = await this.win.trim(pids).catch(() => ({ freed: 0 }));
        this.ram.trims++;
        this.ram.freed += r.freed || 0;
      }
    }
    if (used >= 90) {
      if (!this.ram.highSince) this.ram.highSince = now;
      if (s.ramWarn && now - this.ram.highSince >= 6000 && now - this.ram.warnedAt >= 600000) {
        this.ram.warnedAt = now;
        const gamePids = new Set(this.gamePids);
        this.onRamWarning(used, topRam(procs.filter((p) => !gamePids.has(p.pid)), this, 3));
      }
    } else this.ram.highSince = 0;
  }

  /** Dienste und OneDrive wieder starten */
  async unboost() {
    if (this.ramWatching) {
      this.ramWatching = false;
      await this.win.ramWatch(false).catch(() => {});
    }
    if (this.servicesPaused) {
      this.servicesPaused = false;
      await this.win.services(false).catch(() => {});
    }
    if (this.oneDrivePath) {
      const p = this.oneDrivePath;
      this.oneDrivePath = null;
      try {
        this.win.startOneDrive(p);
      } catch {
        // OneDrive nicht mehr da
      }
    }
  }

  /** Messwerte für Verlauf, Overlay und Messung */
  metrics(usage) {
    let game = 0;
    for (const pid of this.gamePids) game += usage.get(pid) || 0;
    const mem = this.sys.mem();
    const point = {
      t: Date.now(),
      cpu: round1(this.sys.cpu()),
      game: this.gamePids.length ? round1(game) : null,
      ram: mem.total ? round1((mem.used / mem.total) * 100) : null,
      ping: this.gamePids.length ? this.net.ping : null,
    };
    this.history.push(point);
    if (this.history.length > HISTORY) this.history.shift();
    if (this.sample) this.sample.push(point);
    this.current = { ...point, ramUsed: mem.used, ramTotal: mem.total, server: this.net.target ? this.net.target.address + ":" + this.net.target.port : null };
  }

  /**
   * Ping zum Spielserver (läuft neben der Schleife): Verbindung des Spiels suchen, dann ICMP-Ping; blockiert der
   * Server ICMP, alle 15 s die Zeit für einen TCP-Verbindungsaufbau messen.
   */
  async netTick() {
    const pids = this.gamePids;
    const now = Date.now();
    if (!pids.length) {
      this.net = { target: null, targetAt: 0, ping: null, fails: 0, at: 0 };
      return;
    }
    if (!this.net.target || now - this.net.targetAt > 15000) {
      const conns = await this.win.connections(pids).catch(() => []);
      this.net.targetAt = now;
      const pick = conns.find((c) => c.port !== 443 && c.port !== 80) || conns[0] || null;
      if (!pick || !this.net.target || pick.address !== this.net.target.address) {
        this.net.target = pick;
        this.net.fails = 0;
        this.net.ping = null;
      }
    }
    const t = this.net.target;
    if (!t) return;
    let ms = null;
    if (this.net.fails < 3) {
      ms = await this.win.ping(t.address).catch(() => null);
      this.net.fails = ms == null ? this.net.fails + 1 : 0;
    } else if (now - this.net.at > 15000) {
      this.net.at = now;
      ms = await this.tcpPing(t.address, t.port).catch(() => null);
    } else return;
    this.net.ping = ms == null ? null : Math.round(ms);
    if (this.pingSample && ms != null) this.pingSample.push(ms);
  }

  /**
   * Vorher/Nachher-Messung: erst ohne, dann mit Vorrang je `seconds` Sekunden. progress(phase, Anteil 0..1).
   * → { game, before: Werte, after: Werte } mit Werten { game, cpu, ping, jitter, n }
   */
  async measure({ seconds = 20, settle = 3, progress = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    if (this.measuring) throw new Error("Es läuft schon eine Messung.");
    if (!this.game) throw new Error("Starte zuerst ein Spiel – gemessen wird, wie viel Leistung es bekommt.");
    const game = this.game;
    this.measuring = true;
    try {
      const phase = async (mode, label, from) => {
        this.force = mode;
        await sleep(settle * 1000);
        this.sample = [];
        this.pingSample = [];
        for (let i = 0; i < seconds; i++) {
          await sleep(1000);
          if (!this.gamePids.length) throw new Error("Das Spiel wurde während der Messung beendet.");
          progress(label, from + ((i + 1) / seconds) * 0.5);
        }
        const r = summarize(this.sample, this.pingSample);
        this.sample = null;
        this.pingSample = null;
        return r;
      };
      const before = await phase("off", "ohne Vorrang", 0);
      const after = await phase("on", "mit Vorrang", 0.5);
      return { game, seconds, before, after };
    } finally {
      this.force = null;
      this.sample = null;
      this.pingSample = null;
      this.measuring = false;
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
    await this.unboost();
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
        g = { key, exe, name: null, path: p.path, title: "", count: 0, cpu: 0, ram: 0, rule: rule?.id || null, level: rule?.level || null, auto: !!rule?.auto, applied: 0, errors: [] };
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
      if (g.auto) g.rule = null; // automatisch erkannt: keine gespeicherte Regel
      g.cpu = Math.round(g.cpu * 10) / 10;
    }
    const programs = [...groups.values()]
      .filter((g) => s.showAll || g.rule || g.title || g.cpu >= 1)
      .sort((a, b) => (b.level === "game") - (a.level === "game") || b.cpu - a.cpu || b.ram - a.ram);
    return {
      at: Date.now(), active: this.active, game: this.game, cpuCount: this.cpuCount, programs, total: groups.size,
      measuring: this.measuring, metrics: this.current || null, history: this.history.slice(-60),
      boost: { services: this.servicesPaused, oneDrive: !!this.oneDrivePath, standby: this.ramWatching },
      ram: {
        top: topRam(procs, this, 10),
        used: this.current?.ramUsed || 0,
        total: this.current?.ramTotal || 0,
        trims: this.ram.trims,
        freed: this.ram.freed,
        watcher: this.win.ramStatus?.() || null,
      },
    };
  }
}

/** Die größten RAM-Fresser, nach Programm zusammengefasst: [{ exe, name, ram, count, level }] */
function topRam(procs, engine, n) {
  const groups = new Map();
  const rules = engine.settings.data.rules;
  for (const p of procs) {
    if (R.isProtected(p)) continue;
    const exe = R.exeName(p.name);
    const g = groups.get(exe) || { exe, name: null, path: p.path, ram: 0, count: 0, level: null };
    g.ram += p.ram || 0;
    g.count++;
    if (!g.path && p.path) g.path = p.path;
    groups.set(exe, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.ram - a.ram)
    .slice(0, n)
    .map((g) => {
      const rule = rules.find((r) => r.enabled && R.exeName(r.exe) === g.exe);
      return { ...g, name: rule?.name || engine.descriptions.get(g.path) || g.exe.replace(/\.exe$/, ""), level: rule?.level || null };
    });
}

const round1 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Mittelwerte einer Messphase; Schwankung = mittlere Abweichung zwischen aufeinanderfolgenden Pings */
function summarize(points, pings) {
  const game = avg(points.map((p) => p.game).filter((v) => v != null));
  const cpu = avg(points.map((p) => p.cpu).filter((v) => v != null));
  const jit = pings.length > 1 ? avg(pings.slice(1).map((v, i) => Math.abs(v - pings[i]))) : null;
  return { game: round1(game), cpu: round1(cpu), ping: round1(avg(pings)), jitter: round1(jit), n: points.length };
}

/** Zeit für einen TCP-Verbindungsaufbau (Ersatz, wenn der Server keinen Ping beantwortet) */
function tcpConnectTime(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const sock = net.connect({ host, port, timeout });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(Number(process.hrtime.bigint() - t0) / 1e6));
    sock.once("timeout", () => done(null));
    sock.once("error", () => done(null));
  });
}

module.exports = { Engine, summarize };
