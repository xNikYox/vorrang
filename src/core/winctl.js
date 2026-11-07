// Windows-Anbindung über eine dauerhaft laufende PowerShell (ein Prozess, Befehle je Zeile über stdin).
// Prozessliste, Priorität und CPU-Kerne setzen, Grafikkarten-Wahl (Registry), Energiesparplan, Upload-Limits (QoS, mit Admin).
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Text als PowerShell-String in einfachen Anführungszeichen */
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/** Kern-Maske (vorzeichenlos, als Text) → Int64 für .NET */
const toInt64 = (mask) => BigInt.asIntN(64, BigInt(mask)).toString();
/** Int64 aus .NET → vorzeichenlose Maske als Text */
const fromInt64 = (v) => (v == null || v === "" ? null : BigInt.asUintN(64, BigInt(v)).toString());

const LIST_CMD =
  "$r=@(Get-Process | ForEach-Object { $c=$null; try { $c=$_.TotalProcessorTime.TotalSeconds } catch {}; " +
  "[pscustomobject]@{i=$_.Id;n=$_.ProcessName;p=$_.Path;c=$c;t=$_.MainWindowTitle;w=$_.WorkingSet64} }); " +
  "ConvertTo-Json -InputObject $r -Compress -Depth 2";

/** Befehl: Priorität/Kerne setzen, vorher die alten Werte lesen (für das Zurücksetzen) */
function setCmd(actions) {
  const parts = actions.map((a) => {
    const pid = a.pid | 0;
    const prio = a.priority ? `$p.PriorityClass=${psq(a.priority)};` : "";
    const aff = a.affinity != null ? `$p.ProcessorAffinity=[IntPtr][int64]${toInt64(a.affinity)};` : "";
    return `try{$p=[Diagnostics.Process]::GetProcessById(${pid});$o=[pscustomobject]@{i=${pid};priority=$p.PriorityClass.ToString();affinity=([int64]$p.ProcessorAffinity).ToString()};${prio}${aff}$o}catch{[pscustomobject]@{i=${pid};error=$_.Exception.Message}}`;
  });
  return `$r=@(${parts.join(";")}); ConvertTo-Json -InputObject $r -Compress -Depth 2`;
}

const GPU_KEY = "HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences";
const GPU_VALUE = { auto: "GpuPreference=0;", saving: "GpuPreference=1;", high: "GpuPreference=2;" };

/** Befehl: Grafikkarten-Wahl für eine exe setzen (null/"none" = Eintrag entfernen) */
function gpuCmd(exePath, pref) {
  if (!GPU_VALUE[pref]) return `Remove-ItemProperty -Path ${psq(GPU_KEY)} -Name ${psq(exePath)} -ErrorAction SilentlyContinue; '"ok"'`;
  // Kein New-Item -Force auf vorhandene Schlüssel: das würde andere Einträge löschen
  return `if(!(Test-Path ${psq(GPU_KEY)})){New-Item -Path ${psq(GPU_KEY)} | Out-Null}; Set-ItemProperty -Path ${psq(GPU_KEY)} -Name ${psq(exePath)} -Value ${psq(GPU_VALUE[pref])}; '"ok"'`;
}

/** Befehl: Datei-Beschreibungen (z. B. „Firefox“) für mehrere exe-Pfade */
function infoCmd(paths) {
  const list = paths.map(psq).join(",");
  return `$r=@(foreach($f in @(${list})){ $d=$null; try { $d=(Get-Item -LiteralPath $f).VersionInfo.FileDescription } catch {}; [pscustomobject]@{p=$f;d=$d} }); ConvertTo-Json -InputObject $r -Compress -Depth 2`;
}

/** Skript für die Upload-Limits (läuft mit Admin-Rechten): alte Vorrang-Richtlinien weg, neue anlegen */
function qosScript(policies, resultFile) {
  const lines = [
    "$ErrorActionPreference='Stop'",
    "try {",
    "  Get-NetQosPolicy -PolicyStore localhost -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'Vorrang-*' } | ForEach-Object { Remove-NetQosPolicy -Name $_.Name -PolicyStore localhost -Confirm:$false }",
    ...policies.map((p) => `  New-NetQosPolicy -Name ${psq(p.name)} -AppPathNameMatchCondition ${psq(p.exe)} -ThrottleRateActionBitsPerSecond ${Math.max(8000, p.bits | 0)} -PolicyStore localhost | Out-Null`),
    `  'ok' | Set-Content -LiteralPath ${psq(resultFile)} -Encoding UTF8`,
    "} catch {",
    `  ('Fehler: ' + $_.Exception.Message) | Set-Content -LiteralPath ${psq(resultFile)} -Encoding UTF8`,
    "}",
  ];
  return lines.join("\r\n");
}

/** Dauerhafte PowerShell: Anfragen nacheinander, Antwort an einer Markierung erkennbar */
class PowerShell {
  constructor({ exe = "powershell.exe", timeout = 20000 } = {}) {
    this.exe = exe;
    this.timeout = timeout;
    this.queue = Promise.resolve();
    this.seq = 0;
    this.child = null;
  }

  start() {
    const child = spawn(this.exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.buf = "";
    child.waiting = null;
    child.stdout.on("data", (d) => {
      child.buf += d;
      let i;
      while ((i = child.buf.indexOf("\n")) >= 0) {
        const line = child.buf.slice(0, i).replace(/\r$/, "");
        child.buf = child.buf.slice(i + 1);
        const m = /^@@(\d+)@@(.*)$/.exec(line);
        if (m && child.waiting && child.waiting.id === Number(m[1])) {
          const w = child.waiting;
          child.waiting = null;
          w.done(m[2]);
        }
      }
    });
    const fail = () => {
      if (this.child === child) this.child = null;
      if (child.waiting) child.waiting.fail(new Error("PowerShell beendet"));
    };
    child.on("exit", fail);
    child.on("error", fail);
    child.stdin.on("error", () => {});
    child.stdin.write("$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n");
    this.child = child;
    return child;
  }

  /** Einen einzeiligen Befehl ausführen, dessen Ausgabe JSON ist → geparstes Ergebnis */
  run(cmd) {
    const job = this.queue.then(() => new Promise((resolve, reject) => {
      const child = this.child || this.start();
      const id = ++this.seq;
      const timer = setTimeout(() => {
        child.waiting = null;
        if (this.child === child) this.child = null; // nächste Anfrage startet eine frische PowerShell
        child.kill();
        reject(new Error("PowerShell antwortet nicht"));
      }, this.timeout);
      child.waiting = {
        id,
        done: (text) => {
          clearTimeout(timer);
          try {
            resolve(text.trim() ? JSON.parse(text) : null);
          } catch (e) {
            reject(e);
          }
        },
        fail: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      // Ausgabe in eine Zeile mit Markierung; Zeilenumbrüche im Befehl würden ihn zerteilen
      child.stdin.write(`Write-Output ('@@${id}@@' + ((& { ${cmd.replace(/[\r\n]+/g, " ")} }) -join ''))\n`);
    }));
    this.queue = job.catch(() => {});
    return job;
  }

  stop() {
    if (this.child) this.child.kill();
    this.child = null;
  }
}

class WinCtl {
  constructor(ps = new PowerShell()) {
    this.ps = ps;
  }

  /** Laufende Prozesse: [{ pid, name, path, cpu, title, ram }] */
  async list() {
    const r = (await this.ps.run(LIST_CMD)) || [];
    return r.map((p) => ({ pid: p.i, name: p.n, path: p.p || null, cpu: typeof p.c === "number" ? p.c : null, title: p.t || "", ram: Number(p.w) || 0 }));
  }

  /** Priorität/Kerne setzen → [{ pid, priority, affinity } (Werte davor) | { pid, error }] */
  async apply(actions) {
    if (!actions.length) return [];
    const r = (await this.ps.run(setCmd(actions))) || [];
    return r.map((x) => (x.error ? { pid: x.i, error: x.error } : { pid: x.i, priority: x.priority, affinity: fromInt64(x.affinity) }));
  }

  async gpu(exePath, pref) {
    await this.ps.run(gpuCmd(exePath, pref));
  }

  async describe(paths) {
    if (!paths.length) return [];
    return ((await this.ps.run(infoCmd(paths))) || []).map((x) => ({ path: x.p, description: x.d || null }));
  }

  /** Energiesparplan: aktuellen lesen (GUID) */
  async activePowerPlan() {
    const out = await execText("powercfg", ["/getactivescheme"]);
    return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(out)?.[1] || null;
  }

  /** Energiesparplan „Höchstleistung“ (oder „Ultimative Leistung“) – null, wenn es keinen gibt */
  async performancePlan() {
    const out = await execText("powercfg", ["/list"]);
    for (const guid of ["e9a42b02-d5df-448d-aa00-03f14749eb61", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"]) if (out.toLowerCase().includes(guid)) return guid;
    return null;
  }

  async setPowerPlan(guid) {
    await execText("powercfg", ["/setactive", guid]);
  }

  /** Upload-Limits mit Admin-Rechten setzen (Windows fragt einmal nach) → "ok" oder Fehlertext */
  async applyQos(policies) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vorrang-"));
    const script = path.join(dir, "qos.ps1");
    const result = path.join(dir, "ergebnis.txt");
    fs.writeFileSync(script, "﻿" + qosScript(policies, result), "utf8");
    try {
      await execText("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psq('"' + script + '"')}`]);
    } catch {
      return "Abgebrochen – ohne Admin-Rechte lassen sich keine Upload-Limits setzen.";
    } finally {
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 2000);
    }
    try {
      return fs.readFileSync(result, "utf8").replace(/^﻿/, "").trim() || "Keine Antwort";
    } catch {
      return "Abgebrochen – ohne Admin-Rechte lassen sich keine Upload-Limits setzen.";
    }
  }

  stop() {
    this.ps.stop();
  }
}

function execText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

module.exports = { WinCtl, PowerShell, psq, toInt64, fromInt64, setCmd, gpuCmd, infoCmd, qosScript, LIST_CMD, GPU_KEY };
