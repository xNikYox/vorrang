// Vorrang – Hauptprozess: Fenster, Tray, Schleife, Autostart und Auto-Update.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, shell, globalShortcut, screen } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Settings, cleanRule } = require("./core/settings");
const { Engine } = require("./core/engine");
const { WinCtl } = require("./core/winctl");
const { qosPolicies, LEVELS } = require("./core/rules");
const { findRoots } = require("./core/games");

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.setAppUserModelId("de.xnikyox.vorrang");

const CPU_COUNT = Math.min(64, os.cpus().length || 1);
const IS_WIN = process.platform === "win32";
let settings, engine, win, tray, timer, netTimer, overlay;
let measureResult = null;
let quitting = false;
let restored = false;
const update = { status: "idle", percent: 0, version: null, error: null };
const icons = new Map(); // exe-Pfad → Data-URL

const asset = (f) => path.join(__dirname, "..", "build", f);

function createWindow(show) {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: "#0d1016",
    title: "Vorrang",
    icon: asset("icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0d1016", symbolColor: "#c9d1e0", height: 40 },
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => show && win.show());
  win.on("close", (e) => {
    if (!quitting && settings.data.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

function showWindow() {
  if (!win) createWindow(true);
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function send(channel, data) {
  if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send(channel, data);
}

/* ---------------- Overlay (immer im Vordergrund, klickt durch) ---------------- */
function overlayWanted() {
  const s = settings.data;
  return s.overlay && (s.overlayAlways || engine.active);
}

function placeOverlay() {
  const { workArea: a } = screen.getPrimaryDisplay();
  const w = 250;
  const h = 118;
  const m = 14;
  const [v, hz] = settings.data.overlayPos.split("-");
  overlay.setBounds({ x: hz === "left" ? a.x + m : a.x + a.width - w - m, y: v === "top" ? a.y + m : a.y + a.height - h - m, width: w, height: h });
}

function updateOverlay(snap) {
  if (!overlayWanted()) {
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    return;
  }
  if (!overlay || overlay.isDestroyed()) {
    overlay = new BrowserWindow({
      width: 250, height: 118, frame: false, transparent: true, resizable: false, movable: false, focusable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false,
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.setIgnoreMouseEvents(true);
    overlay.setVisibleOnAllWorkspaces(true);
    overlay.loadFile(path.join(__dirname, "renderer", "overlay.html"));
    overlay.webContents.once("did-finish-load", () => overlay && !overlay.isDestroyed() && overlay.webContents.send("overlay", engine.last));
  }
  placeOverlay();
  if (!overlay.isVisible()) overlay.showInactive();
  if (snap) overlay.webContents.send("overlay", snap);
}

/* ---------------- Tastenkürzel ---------------- */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const s = settings.data;
  const failed = [];
  const reg = (acc, fn) => {
    if (!acc) return;
    try {
      if (!globalShortcut.register(acc, fn)) failed.push(acc);
    } catch {
      failed.push(acc);
    }
  };
  reg(s.hotkeyToggle, () => setMode(engine.active ? "off" : "on"));
  reg(s.hotkeyOverlay, () => {
    settings.update({ overlay: !settings.data.overlay, ...(settings.data.overlay ? {} : { overlayAlways: true }) });
    updateOverlay(engine.last);
    send("info", info());
  });
  return failed;
}

/* ---------------- Tray ---------------- */
function trayImage(on) {
  return nativeImage.createFromPath(asset(on ? "tray-on.png" : "tray-off.png")).resize({ width: 16, height: 16 });
}

function updateTray() {
  if (!tray) return;
  const s = settings.data;
  const st = engine.active ? "Spielmodus an" + (engine.game ? " – " + engine.game : "") : "Spielmodus aus";
  tray.setImage(trayImage(engine.active));
  tray.setToolTip("Vorrang – " + st);
  const mode = (m) => () => setMode(m);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: st, enabled: false },
    { type: "separator" },
    { label: "Automatisch (bei Spielstart)", type: "radio", checked: s.manual === "auto", click: mode("auto") },
    { label: "Spielmodus immer an", type: "radio", checked: s.manual === "on", click: mode("on") },
    { label: "Spielmodus aus", type: "radio", checked: s.manual === "off", click: mode("off") },
    { type: "separator" },
    { label: "Vorrang öffnen", click: showWindow },
    ...(update.status === "ready" ? [{ label: `Update ${update.version} installieren`, click: installUpdate }] : []),
    { label: "Beenden", click: () => app.quit() },
  ]));
}

/* ---------------- Schleife ---------------- */
async function tick() {
  try {
    await engine.tick();
  } catch (e) {
    send("error", String(e.message || e));
  }
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(tick, (engine.measuring ? 1 : settings.data.interval) * 1000);
}

/** CPU-Auslastung gesamt seit dem letzten Aufruf (aus den Kern-Zeiten) */
let cpuPrev = null;
function systemCpu() {
  const now = os.cpus().reduce((a, c) => {
    const t = c.times;
    a.idle += t.idle;
    a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
  const prev = cpuPrev;
  cpuPrev = now;
  if (!prev || now.total <= prev.total) return null;
  return (1 - (now.idle - prev.idle) / (now.total - prev.total)) * 100;
}

/** Spiele-Bibliotheken (Steam, Epic, Battle.net) suchen – beim Start und alle 10 Minuten */
async function scanGameRoots() {
  if (!IS_WIN) return;
  const steamPath = await engine.win.steamPath().catch(() => null);
  engine.roots = findRoots({
    env: process.env,
    steamPath,
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    readDir: (d) => {
      try {
        return fs.readdirSync(d);
      } catch {
        return [];
      }
    },
  });
}

function setMode(m) {
  settings.update({ manual: m });
  updateTray();
  tick();
}

function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.data.autostart, args: ["--hidden"] });
}

/* ---------------- Auto-Update ---------------- */
let autoUpdater = null;
function setupUpdater() {
  if (!app.isPackaged) return;
  ({ autoUpdater } = require("electron-updater"));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const set = (patch) => {
    Object.assign(update, patch);
    send("update", update);
    updateTray();
  };
  autoUpdater.on("checking-for-update", () => set({ status: "checking", error: null }));
  autoUpdater.on("update-available", (i) => set({ status: "downloading", version: i.version, percent: 0 }));
  autoUpdater.on("update-not-available", () => set({ status: "current" }));
  autoUpdater.on("download-progress", (p) => set({ status: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (i) => {
    set({ status: "ready", version: i.version });
    if (settings.data.notify && Notification.isSupported()) {
      new Notification({ title: "Vorrang", body: `Update ${i.version} ist bereit – wird beim Beenden installiert.`, icon: asset("icon.png") }).show();
    }
  });
  autoUpdater.on("error", (e) => set({ status: "error", error: String(e?.message || e).slice(0, 200) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 4 * 3600 * 1000);
}

async function installUpdate() {
  if (!autoUpdater || update.status !== "ready") return;
  quitting = true;
  await engine.restoreAll();
  restored = true;
  autoUpdater.quitAndInstall(true, true);
}

/* ---------------- IPC ---------------- */
function info() {
  return {
    version: app.getVersion(),
    platform: process.platform,
    cpuCount: CPU_COUNT,
    cpuModel: os.cpus()[0]?.model?.trim() || "",
    levels: Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, v.label])),
    settings: settings.data,
    snapshot: engine.last,
    update,
    qosPending: JSON.stringify(qosPolicies(settings.data.rules)) !== JSON.stringify(settings.data.qosApplied),
    servicesReady: engine.servicesReady,
    gameRoots: engine.roots.length,
    measure: measureResult,
  };
}

ipcMain.handle("info", () => info());

ipcMain.handle("rules:save", async (_e, rules) => {
  settings.update({ rules: Array.isArray(rules) ? rules.map(cleanRule).filter(Boolean) : settings.data.rules });
  await tick();
  return info();
});

ipcMain.handle("settings:save", async (_e, patch) => {
  const allowed = ["manual", "autoGameMode", "alwaysThrottle", "backgroundCores", "powerPlan", "autostart", "startHidden", "closeToTray", "notify", "interval", "showAll",
    "autoGames", "trimRam", "pauseOneDrive", "overlay", "overlayPos", "overlayAlways", "hotkeyToggle", "hotkeyOverlay"];
  const p = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
  const wasPower = settings.data.powerPlan;
  settings.update(p);
  if ("autostart" in p) applyAutostart();
  if ("interval" in p) schedule();
  let hotkeyError = null;
  if ("hotkeyToggle" in p || "hotkeyOverlay" in p) {
    const failed = registerHotkeys();
    if (failed.length) hotkeyError = `Tastenkürzel ${failed.join(", ")} ist schon belegt oder ungültig.`;
  }
  if ("pauseOneDrive" in p && !settings.data.pauseOneDrive && engine.oneDrivePath) {
    const od = engine.oneDrivePath;
    engine.oneDrivePath = null;
    engine.win.startOneDrive(od);
  }
  if ("powerPlan" in p && wasPower !== settings.data.powerPlan && engine.active) await engine.powerPlan(settings.data.powerPlan).catch(() => {});
  updateTray();
  await tick();
  updateOverlay(engine.last);
  return { ...info(), hotkeyError };
});

/** Dienste-Pause an/aus: richtet die geschützte Aufgabe ein bzw. entfernt sie (einmal Admin) */
ipcMain.handle("services:set", async (_e, on) => {
  if (!IS_WIN) return { result: "Nur unter Windows möglich.", info: info() };
  if (!on && engine.servicesPaused) await engine.unboost();
  const result = await engine.win.setupServices(!on);
  if (result === "ok") {
    engine.servicesReady = !!on;
    settings.update({ pauseServices: !!on });
  } else engine.servicesReady = await engine.win.servicesReady().catch(() => false);
  return { result, info: info() };
});

ipcMain.handle("measure", async () => {
  if (engine.measuring) return { error: "Es läuft schon eine Messung." };
  try {
    schedule();
    const promise = engine.measure({ progress: (phase, part) => send("measure", { phase, part }) });
    schedule(); // jetzt jede Sekunde messen
    measureResult = { ...(await promise), at: Date.now() };
    return { result: measureResult };
  } catch (e) {
    return { error: String(e.message || e) };
  } finally {
    schedule();
    tick();
  }
});

ipcMain.handle("qos:apply", async () => {
  if (!IS_WIN) return { result: "Nur unter Windows möglich.", info: info() };
  const policies = qosPolicies(settings.data.rules);
  const result = await engine.win.applyQos(policies);
  if (result === "ok") settings.update({ qosApplied: policies });
  return { result, info: info() };
});

ipcMain.handle("icons", async (_e, paths) => {
  const out = {};
  for (const p of (Array.isArray(paths) ? paths : []).slice(0, 80)) {
    if (typeof p !== "string" || !/\.exe$/i.test(p)) continue;
    if (!icons.has(p)) {
      try {
        icons.set(p, (await app.getFileIcon(p, { size: "normal" })).toDataURL());
      } catch {
        icons.set(p, null);
      }
    }
    out[p] = icons.get(p);
  }
  return out;
});

ipcMain.handle("update:check", () => autoUpdater?.checkForUpdates().catch(() => {}) && true);
ipcMain.handle("update:install", () => installUpdate());

/* ---------------- Start ---------------- */
app.on("second-instance", showWindow);

app.whenReady().then(() => {
  settings = new Settings(app.getPath("userData"), CPU_COUNT);
  engine = new Engine({
    win: IS_WIN ? new WinCtl() : fakeWin(),
    settings,
    cpuCount: CPU_COUNT,
    sys: { cpu: systemCpu, mem: () => ({ used: os.totalmem() - os.freemem(), total: os.totalmem() }) },
    onState: (snap) => {
      send("state", snap);
      updateOverlay(snap);
    },
    onGameMode: (active, game, extra = {}) => {
      updateTray();
      if (settings.data.notify && Notification.isSupported()) {
        const more = [];
        if (extra.freed > 50e6) more.push(`${Math.round(extra.freed / 1e6)} MB RAM freigeräumt`);
        if (extra.services) more.push("Windows Update & Suche pausiert");
        if (extra.oneDrive) more.push("OneDrive pausiert");
        new Notification({
          title: active ? "Spielmodus an" : "Spielmodus aus",
          body: active ? `${game || "Spiel"} hat jetzt Vorrang.` + (more.length ? " " + more.join(" · ") + "." : "") : "Alle Programme laufen wieder normal.",
          icon: asset("icon.png"),
          silent: true,
        }).show();
      }
    },
  });
  const hidden = process.argv.includes("--hidden") && settings.data.startHidden;
  tray = new Tray(trayImage(false));
  tray.on("click", showWindow);
  createWindow(!hidden);
  applyAutostart();
  updateTray();
  setupUpdater();
  registerHotkeys();
  tick();
  schedule();
  let netBusy = false;
  netTimer = setInterval(async () => {
    if (netBusy) return;
    netBusy = true;
    await engine.netTick().catch(() => {});
    netBusy = false;
  }, 3000);
  scanGameRoots();
  setInterval(scanGameRoots, 10 * 60 * 1000);
  if (IS_WIN) {
    engine.win.servicesReady().then((ready) => {
      engine.servicesReady = ready;
      // Nach einem Absturz im Spielmodus: pausierte Dienste wieder starten
      if (ready) engine.win.services(false).catch(() => {});
    }).catch(() => {});
  }
});

app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("window-all-closed", () => {
  // läuft im Tray weiter
});

app.on("before-quit", (e) => {
  quitting = true;
  if (restored || !engine) return;
  e.preventDefault();
  clearInterval(timer);
  clearInterval(netTimer);
  engine.restoreAll().finally(() => {
    restored = true;
    engine.win.stop?.();
    app.quit();
  });
});

/** Außerhalb von Windows (Entwicklung): keine Eingriffe, nur leere Liste */
function fakeWin() {
  return {
    list: async () => [],
    apply: async () => [],
    gpu: async () => {},
    describe: async () => [],
    activePowerPlan: async () => null,
    performancePlan: async () => null,
    setPowerPlan: async () => {},
    applyQos: async () => "Nur unter Windows möglich.",
    trim: async () => ({ freed: 0, n: 0 }),
    connections: async () => [],
    ping: async () => null,
    servicesReady: async () => false,
    services: async () => {},
    steamPath: async () => null,
    stop() {},
  };
}
