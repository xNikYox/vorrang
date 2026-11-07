// Praxistest auf echtem Windows (läuft in GitHub Actions vor jedem Release):
// Prozessliste, Priorität + Kerne setzen und zurücksetzen, Grafikkarten-Eintrag, Datei-Beschreibung.
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const { WinCtl, TASK_PATH, TASK_PAUSE } = require("../src/core/winctl");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const win = new WinCtl();
  const child = spawn("ping", ["-n", "60", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
  try {
    const t0 = Date.now();
    const list = await win.list();
    console.log(`Prozessliste: ${list.length} Prozesse in ${Date.now() - t0} ms (erster Aufruf, PowerShell startet)`);
    const t1 = Date.now();
    await win.list();
    const warm = Date.now() - t1;
    console.log(`Prozessliste erneut: ${warm} ms`);
    assert.ok(warm < 3000, "Prozessliste zu langsam für die Schleife");
    const me = list.find((p) => p.pid === child.pid);
    assert.ok(me, "Testprozess fehlt in der Liste");
    assert.equal(me.name.toLowerCase(), "ping");
    assert.ok(me.path && /ping\.exe$/i.test(me.path), "Pfad fehlt");

    const n = Math.min(64, os.cpus().length);
    const last = (1n << BigInt(n - 1)).toString();
    const read = () => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `$p=Get-Process -Id ${child.pid}; ConvertTo-Json @{prio=$p.PriorityClass.ToString(); aff=([int64]$p.ProcessorAffinity).ToString()} -Compress`]).toString());
    const start = read();
    const target = start.prio === "Idle" ? "BelowNormal" : "Idle";
    const [before] = await win.apply([{ pid: child.pid, priority: target, affinity: last }]);
    assert.equal(before.priority, start.prio);
    let now = read();
    assert.equal(now.prio, target);
    assert.equal(now.aff, last);
    await win.apply([{ pid: child.pid, restore: true, priority: before.priority, affinity: before.affinity }]);
    now = read();
    assert.equal(now.prio, start.prio);
    assert.equal(BigInt.asUintN(64, BigInt(now.aff)).toString(), before.affinity);
    console.log("Priorität + Kerne setzen und zurücksetzen: ok");

    // Speicher-Priorität: setzen, auslesen (über den Vorher-Wert der nächsten Änderung), zurücksetzen
    const [m0] = await win.apply([{ pid: child.pid, memPriority: 3 }]);
    assert.equal(m0.memPriorityOk, true, "Speicher-Priorität setzen: " + JSON.stringify(m0));
    const orig = m0.memPriority;
    assert.ok(orig >= 1 && orig <= 5, "Ausgangswert lesbar: " + orig);
    const other = orig === 1 ? 2 : 1;
    const [m1] = await win.apply([{ pid: child.pid, memPriority: other }]);
    assert.equal(m1.memPriority, 3, "Speicher-Priorität 3 wurde nicht übernommen");
    const [m2] = await win.apply([{ pid: child.pid, memPriority: orig }]);
    assert.equal(m2.memPriority, other);
    console.log(`Speicher-Priorität: Ausgangswert ${orig}, 3 und ${other} gesetzt, zurück auf ${orig}`);
    console.log("Speicher-Priorität setzen und zurücksetzen: ok");

    const [err] = await win.apply([{ pid: 999999, priority: "High" }]);
    assert.ok(err.error, "Fehler bei unbekanntem Prozess erwartet");

    const fakePath = "C:\\Vorrang-Test\\it's game.exe";
    await win.gpu(fakePath, "high");
    const reg = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences", "/v", fakePath]).toString();
    assert.match(reg, /GpuPreference=2;/);
    await win.gpu(fakePath, null);
    assert.throws(() => execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences", "/v", fakePath], { stdio: "pipe" }));
    console.log("Grafikkarten-Eintrag setzen und entfernen: ok");

    const [d] = await win.describe([me.path]);
    console.log("Beschreibung von ping.exe:", d.description);
    assert.ok(d.description);

    console.log("Energiesparplan aktiv:", await win.activePowerPlan(), "· Höchstleistung:", await win.performancePlan());

    // RAM freiräumen
    const t = await win.trim([child.pid, process.pid]);
    assert.ok(t.n >= 1, "EmptyWorkingSet hat bei keinem Prozess geklappt");
    console.log(`RAM freiräumen: ${t.n} Prozesse, ${Math.round(t.freed / 1e6)} MB`);

    // Verbindungen eines Prozesses + Ping
    const sock = net.connect({ host: "github.com", port: 443 });
    await new Promise((res, rej) => (sock.once("connect", res), sock.once("error", rej)));
    const conns = await win.connections([process.pid]);
    sock.destroy();
    assert.ok(conns.some((c) => c.port === 443 && c.pid === process.pid), "eigene Verbindung nicht gefunden: " + JSON.stringify(conns));
    console.log("Verbindungen gefunden:", conns.length, "· Ping zu", conns[0].address + ":", await win.ping(conns[0].address), "ms (ICMP kann gesperrt sein)");
    console.log("Steam-Pfad:", await win.steamPath());

    // Dienste-Pause: einrichten (Admin), Skript direkt ausführen, wieder entfernen
    const setup = await win.setupServices(false);
    assert.equal(setup, "ok", "Einrichtung: " + setup);
    assert.equal(await win.servicesReady(), true);
    const dir = process.env.ProgramData + "\\Vorrang";
    const script = dir + "\\dienste.ps1";
    assert.ok(fs.existsSync(script));
    const acl = execFileSync("icacls", [dir]).toString();
    console.log("Rechte:", acl.replace(/\s+/g, " ").trim());
    assert.doesNotMatch(acl, /(BUILTIN\\Users|VORDEFINIERT\\Benutzer):\(OI\)\(CI\)\((F|M|W)/, "Benutzer dürfen das Skript nicht ändern");
    const svc = () => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", "ConvertTo-Json @(Get-Service wuauserv,BITS,DoSvc,WSearch -ErrorAction SilentlyContinue | ForEach-Object { @{n=$_.Name;s=$_.Status.ToString()} }) -Compress"]).toString() || "[]");
    // BITS sicher laufen lassen, damit auch ein Dienst mit Auslöser-Start geprüft wird
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Start-Service BITS,wuauserv -ErrorAction SilentlyContinue"]);
    console.log("Dienste vorher:", JSON.stringify(svc()));
    const tp = Date.now();
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "pause"]);
    console.log(`Pausieren dauerte ${Date.now() - tp} ms`);
    const paused = fs.existsSync(dir + "\\pausiert.txt") ? fs.readFileSync(dir + "\\pausiert.txt", "utf8").split(/\r?\n/).filter(Boolean) : [];
    let mid = svc();
    for (let i = 0; i < 10 && paused.some((n) => mid.find((x) => x.n === n)?.s === "Running"); i++) {
      await wait(2000);
      mid = svc();
    }
    console.log("pausiert:", paused, "· Dienste:", JSON.stringify(mid));
    for (const n of paused) assert.notEqual(mid.find((x) => x.n === n)?.s, "Running", n + " läuft nach 20 s noch (oder wurde von Windows neu gestartet)");
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "resume"]);
    await wait(3000);
    const after = svc();
    console.log("Dienste danach:", JSON.stringify(after));
    for (const n of paused) assert.equal(after.find((x) => x.n === n)?.s, "Running", n + " wurde nicht wieder gestartet");
    assert.ok(!fs.existsSync(dir + "\\pausiert.txt"));
    try {
      await win.services(true);
      console.log("Aufgabe per schtasks gestartet:", execFileSync("schtasks", ["/query", "/tn", TASK_PATH + TASK_PAUSE, "/v", "/fo", "list"]).toString().match(/(Last Result|Letztes Ergebnis):.*$/m)?.[0]);
      await wait(4000);
      await win.services(false);
      await wait(3000);
    } catch (e) {
      console.log("schtasks /run (ohne angemeldeten Benutzer evtl. nicht möglich):", e.message);
    }
    // RAM: Standby-Liste einmal leeren, dann Wächter (braucht einen laufenden „Vorrang“-Prozess)
    assert.equal(await win.ramReady(), true);
    const ram = dir + "\\ram.ps1";
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ram, "now"]);
    let st = win.ramStatus();
    console.log("Standby leeren:", JSON.stringify(st));
    assert.equal(st.priv, true, "Recht zum Leeren fehlt");
    assert.equal(st.purges, 1, "Leeren fehlgeschlagen");
    assert.ok(st.free > 0 && st.standby >= 0);
    const fakeApp = require("node:path").join(require("node:os").tmpdir(), "Vorrang.exe");
    fs.copyFileSync(process.execPath, fakeApp);
    const app = spawn(fakeApp, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
    await wait(1500);
    const watcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ram, "start"], { stdio: "ignore", windowsHide: true });
    let running = false;
    for (let i = 0; i < 20 && !running; i++) {
      await wait(1000);
      st = win.ramStatus();
      running = !!st?.running;
    }
    assert.ok(running, "Wächter läuft nicht: " + JSON.stringify(st));
    console.log("Wächter läuft:", JSON.stringify(st));
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ram, "stop"]);
    const ended = await new Promise((res) => {
      const t = setTimeout(() => res(false), 15000);
      watcher.once("exit", () => (clearTimeout(t), res(true)));
    });
    assert.ok(ended, "Wächter endet nicht nach stop");
    assert.equal(win.ramStatus().running, false);
    app.kill();
    try {
      await win.ramWatch(true);
      await wait(3000);
      await win.ramWatch(false);
      console.log("RAM-Aufgaben per schtasks gestartet");
    } catch (e) {
      console.log("schtasks /run RAM (ohne angemeldeten Benutzer evtl. nicht möglich):", e.message);
    }
    console.log("RAM: Standby leeren und Wächter: ok");

    assert.equal(await win.setupServices(true), "ok");
    assert.equal(await win.servicesReady(), false);
    assert.ok(!fs.existsSync(dir), "Ordner nicht entfernt");
    console.log("Dienste-Pause einrichten, pausieren, fortsetzen, entfernen: ok");
    console.log("Windows-Praxistest bestanden.");
  } finally {
    child.kill();
    win.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
