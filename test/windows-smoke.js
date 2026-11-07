// Praxistest auf echtem Windows (läuft in GitHub Actions vor jedem Release):
// Prozessliste, Priorität + Kerne setzen und zurücksetzen, Grafikkarten-Eintrag, Datei-Beschreibung.
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const os = require("node:os");
const { WinCtl } = require("../src/core/winctl");

(async () => {
  const win = new WinCtl();
  const child = spawn("ping", ["-n", "60", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
  try {
    const t0 = Date.now();
    const list = await win.list();
    console.log(`Prozessliste: ${list.length} Prozesse in ${Date.now() - t0} ms`);
    const me = list.find((p) => p.pid === child.pid);
    assert.ok(me, "Testprozess fehlt in der Liste");
    assert.equal(me.name.toLowerCase(), "ping");
    assert.ok(me.path && /ping\.exe$/i.test(me.path), "Pfad fehlt");

    const n = Math.min(64, os.cpus().length);
    const last = (1n << BigInt(n - 1)).toString();
    const [before] = await win.apply([{ pid: child.pid, priority: "BelowNormal", affinity: last }]);
    assert.equal(before.priority, "Normal");
    const read = () => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `$p=Get-Process -Id ${child.pid}; ConvertTo-Json @{prio=$p.PriorityClass.ToString(); aff=([int64]$p.ProcessorAffinity).ToString()} -Compress`]).toString());
    let now = read();
    assert.equal(now.prio, "BelowNormal");
    assert.equal(now.aff, last);
    await win.apply([{ pid: child.pid, restore: true, priority: before.priority, affinity: before.affinity }]);
    now = read();
    assert.equal(now.prio, "Normal");
    assert.equal(BigInt.asUintN(64, BigInt(now.aff)).toString(), before.affinity);
    console.log("Priorität + Kerne setzen und zurücksetzen: ok");

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
    console.log("Windows-Praxistest bestanden.");
  } finally {
    child.kill();
    win.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
