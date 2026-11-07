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

/** C#-Hilfe für die Speicher-Priorität (Get/SetProcessInformation, ProcessMemoryPriority) */
const MEMPRIO_TYPE =
  "if(-not ('VorrangPrio' -as [type])){Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class VorrangPrio { " +
  "[StructLayout(LayoutKind.Sequential)] struct MPI { public uint P; } " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool SetProcessInformation(IntPtr h, int cls, ref MPI i, int size); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool GetProcessInformation(IntPtr h, int cls, ref MPI i, int size); " +
  "public static int Get(IntPtr h) { MPI m = new MPI(); return GetProcessInformation(h, 0, ref m, 4) ? (int)m.P : -1; } " +
  "public static bool Set(IntPtr h, int p) { MPI m = new MPI(); m.P = (uint)p; return SetProcessInformation(h, 0, ref m, 4); } }'}; ";

/** Befehl: Priorität/Kerne/Speicher-Priorität setzen, vorher die alten Werte lesen (für das Zurücksetzen) */
function setCmd(actions) {
  const parts = actions.map((a) => {
    const pid = a.pid | 0;
    const prio = a.priority ? `$p.PriorityClass=${psq(a.priority)};` : "";
    const aff = a.affinity != null ? `$p.ProcessorAffinity=[IntPtr][int64]${toInt64(a.affinity)};` : "";
    const mp = Math.max(1, Math.min(5, a.memPriority | 0));
    // Speicher-Priorität eigenständig: klappt sie nicht (Zugriff), sollen Priorität und Kerne trotzdem gesetzt werden
    const mem = a.memPriority
      ? `try{$h=$p.Handle;$o.memPriority=[VorrangPrio]::Get($h);$o.memPriorityOk=[VorrangPrio]::Set($h,${mp})}catch{$o.memPriority=$null;$o.memPriorityOk=$false};`
      : "";
    return `try{$p=[Diagnostics.Process]::GetProcessById(${pid});$o=[pscustomobject]@{i=${pid};priority=$p.PriorityClass.ToString();affinity=([int64]$p.ProcessorAffinity).ToString();memPriority=$null;memPriorityOk=$null};${prio}${aff}${mem}$o}catch{[pscustomobject]@{i=${pid};error=$_.Exception.Message}}`;
  });
  const needType = actions.some((a) => a.memPriority);
  return `${needType ? MEMPRIO_TYPE : ""}$r=@(${parts.join(";")}); ConvertTo-Json -InputObject $r -Compress -Depth 2`;
}

const GPU_KEY = "HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences";
const GPU_VALUE = { auto: "GpuPreference=0;", saving: "GpuPreference=1;", high: "GpuPreference=2;" };

/** Befehl: Grafikkarten-Wahl für eine exe setzen (null/"none" = Eintrag entfernen) */
function gpuCmd(exePath, pref) {
  const body = !GPU_VALUE[pref]
    ? `if(Test-Path ${psq(GPU_KEY)}){Remove-ItemProperty -LiteralPath ${psq(GPU_KEY)} -Name ${psq(exePath)} -ErrorAction SilentlyContinue}`
    : // Schlüssel nur anlegen, wenn er fehlt (-Force legt auch DirectX darüber an); vorhandene Schlüssel nie neu anlegen –
      // New-Item -Force würde sonst alle anderen Einträge löschen
      `if(!(Test-Path ${psq(GPU_KEY)})){New-Item -Path ${psq(GPU_KEY)} -Force | Out-Null}; Set-ItemProperty -LiteralPath ${psq(GPU_KEY)} -Name ${psq(exePath)} -Value ${psq(GPU_VALUE[pref])} -ErrorAction Stop`;
  return `try{ ${body}; '"ok"' }catch{ ConvertTo-Json -InputObject ('Fehler: ' + $_.Exception.Message) -Compress }`;
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

/** Befehl: Arbeitsspeicher von Prozessen an Windows zurückgeben (EmptyWorkingSet) → { freed (Bytes), n } */
function trimCmd(pids) {
  const list = pids.map((p) => p | 0).filter((p) => p > 4).join(",");
  return "if(-not ('Vorrang.Mem' -as [type])){Add-Type -Namespace Vorrang -Name Mem -MemberDefinition '[DllImport(\"psapi.dll\")] public static extern bool EmptyWorkingSet(IntPtr h);'}; " +
    `$f=[int64]0; $n=0; foreach($i in @(${list || "0"})){ try{ $p=[Diagnostics.Process]::GetProcessById($i); $b=$p.WorkingSet64; if([Vorrang.Mem]::EmptyWorkingSet($p.Handle)){ $p.Refresh(); $f+=[Math]::Max(0,$b-$p.WorkingSet64); $n++ } }catch{} }; ` +
    "ConvertTo-Json -InputObject ([pscustomobject]@{freed=$f;n=$n}) -Compress";
}

/** Befehl: bestehende TCP-Verbindungen der Prozesse → [{ a: Adresse, p: Port, o: pid }] */
function connCmd(pids) {
  const list = pids.map((p) => p | 0).filter((p) => p > 4).join(",");
  return `$r=@(Get-NetTCPConnection -State Established -OwningProcess ${list || "0"} -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -ne '127.0.0.1' -and $_.RemoteAddress -ne '::1' } | ForEach-Object { [pscustomobject]@{a=$_.RemoteAddress;p=$_.RemotePort;o=$_.OwningProcess} }); ConvertTo-Json -InputObject $r -Compress -Depth 2`;
}

/** Befehl: ICMP-Ping (ohne Admin) → Millisekunden oder null */
function pingCmd(host) {
  return `$t=$null; try{ $r=(New-Object Net.NetworkInformation.Ping).Send(${psq(host)}, 1000); if($r.Status -eq 'Success'){ $t=$r.RoundtripTime } }catch{}; ConvertTo-Json -InputObject $t -Compress`;
}

/* ---- Windows-Dienste pausieren: Skript + zwei geplante Aufgaben mit Admin-Rechten (einmal einrichten) ---- */
const SERVICES = ["wuauserv", "BITS", "DoSvc", "WSearch"]; // Update, Hintergrund-Downloads, Übermittlungsoptimierung, Suche
const TASK_PATH = "\\Vorrang\\";
const TASK_PAUSE = "Dienste pausieren";
const TASK_RESUME = "Dienste fortsetzen";

/** Das Skript, das die Aufgaben ausführen (liegt in ProgramData, nur Admins dürfen es ändern) */
function servicesScript() {
  return [
    "param([string]$mode)",
    "$state = Join-Path $PSScriptRoot 'pausiert.txt'",
    `$names = @(${SERVICES.map(psq).join(",")})`,
    "if ($mode -eq 'pause') {",
    "  $run = @(Get-Service -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } | ForEach-Object { $_.Name })",
    "  if (Test-Path $state) { $run = @($run + @(Get-Content $state)) | Where-Object { $_ } | Select-Object -Unique }",
    "  Set-Content -Path $state -Value $run",
    "  foreach ($n in $run) { Stop-Service -Name $n -Force -NoWait -ErrorAction SilentlyContinue }",
    // bis zu 15 s warten, bis alle gestoppt sind (manche brauchen etwas)
    "  $end = (Get-Date).AddSeconds(15)",
    "  while ((Get-Date) -lt $end -and @(Get-Service -Name $run -ErrorAction SilentlyContinue | Where-Object { $_.Status -ne 'Stopped' }).Count) { Start-Sleep -Milliseconds 500 }",
    "} elseif ($mode -eq 'resume') {",
    "  if (Test-Path $state) {",
    "    foreach ($n in @(Get-Content $state)) { if ($n) { Start-Service -Name $n -ErrorAction SilentlyContinue } }",
    "    Remove-Item $state -Force",
    "  }",
    "}",
  ].join("\r\n");
}

/* ---- RAM: Standby-Liste leeren (wie ISLC) – braucht Admin, läuft als Aufgabe ---- */
const TASK_RAM_START = "RAM-Waechter starten";
const TASK_RAM_STOP = "RAM-Waechter stoppen";
const TASK_RAM_NOW = "Standby jetzt leeren";
const RAM_STATUS_FILE = "ram-status.json";

/** C#: Recht aktivieren, Standby-Liste leeren, Speicherlisten lesen (freier + Standby-RAM in Bytes) */
const RAM_CS =
  "using System; using System.Runtime.InteropServices; public static class VorrangRam { " +
  "[StructLayout(LayoutKind.Sequential, Pack = 4)] struct TP { public int Count; public long Luid; public int Attr; } " +
  "[DllImport(\"advapi32.dll\", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint acc, out IntPtr tok); " +
  "[DllImport(\"advapi32.dll\", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string sys, string name, out long luid); " +
  "[DllImport(\"advapi32.dll\", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr tok, bool dis, ref TP n, int len, IntPtr p, IntPtr r); " +
  "[DllImport(\"kernel32.dll\")] static extern IntPtr GetCurrentProcess(); " +
  "[DllImport(\"ntdll.dll\")] static extern int NtSetSystemInformation(int cls, ref int info, int len); " +
  "[DllImport(\"ntdll.dll\")] static extern int NtQuerySystemInformation(int cls, IntPtr info, int len, out int ret); " +
  "public static bool Enable(string name) { IntPtr t; if (!OpenProcessToken(GetCurrentProcess(), 0x28, out t)) return false; TP tp = new TP(); tp.Count = 1; tp.Attr = 2; long l; " +
  "if (!LookupPrivilegeValue(null, name, out l)) return false; tp.Luid = l; if (!AdjustTokenPrivileges(t, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return false; return Marshal.GetLastWin32Error() == 0; } " +
  "public static int Purge() { int c = 4; return NtSetSystemInformation(80, ref c, 4); } " + // 80 = SystemMemoryListInformation, 4 = MemoryPurgeStandbyList
  "public static long[] Lists() { int size = 256; IntPtr b = Marshal.AllocHGlobal(size); try { int ret; if (NtQuerySystemInformation(80, b, size, out ret) != 0) return null; " +
  "long ps = 4096; long zero = Marshal.ReadIntPtr(b, 0).ToInt64(); long free = Marshal.ReadIntPtr(b, IntPtr.Size).ToInt64(); long standby = 0; " +
  "for (int i = 0; i < 8; i++) standby += Marshal.ReadIntPtr(b, IntPtr.Size * (5 + i)).ToInt64(); return new long[] { (zero + free) * ps, standby * ps }; } finally { Marshal.FreeHGlobal(b); } } }";

/**
 * Das RAM-Skript: "start" = Wächter (alle 3 s: ist weniger als 1 GB frei und mehr als 1 GB im Standby → leeren;
 * endet, wenn "stop" kommt, Vorrang nicht mehr läuft oder nach 8 h), "now" = einmal leeren, "stop".
 * Schreibt den Stand nach ram-status.json (für die Anzeige in Vorrang).
 */
function ramScript() {
  return [
    "param([string]$mode)",
    "$flag = Join-Path $PSScriptRoot 'waechter.an'",
    `$status = Join-Path $PSScriptRoot '${RAM_STATUS_FILE}'`,
    "if ($mode -eq 'stop') { Remove-Item -LiteralPath $flag -Force -ErrorAction SilentlyContinue; exit 0 }",
    `Add-Type -TypeDefinition ${psq(RAM_CS)}`,
    "$priv = [VorrangRam]::Enable('SeProfileSingleProcessPrivilege')",
    "$purges = 0; $freed = [int64]0; $last = $null",
    "function Now { [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }",
    "function Write-Status($l, $running) {",
    "  $o = [pscustomobject]@{ at = (Now); running = $running; priv = $priv; free = $null; standby = $null; purges = $purges; freed = $freed; last = $last }",
    "  if ($l) { $o.free = $l[0]; $o.standby = $l[1] }",
    "  $o | ConvertTo-Json -Compress | Set-Content -LiteralPath $status -Encoding UTF8",
    "}",
    "function Purge-Now {",
    "  $b = [VorrangRam]::Lists(); $r = [VorrangRam]::Purge()",
    "  if ($r -eq 0) { $script:purges++; $script:last = (Now); $a = [VorrangRam]::Lists(); if ($a -and $b) { $script:freed += [Math]::Max([int64]0, $a[0] - $b[0]) } }",
    "  return $r",
    "}",
    "if ($mode -eq 'now') { $r = Purge-Now; Write-Status ([VorrangRam]::Lists()) $false; exit 0 }",
    "Set-Content -LiteralPath $flag -Value (Get-Date -Format o)",
    "$until = (Get-Date).AddHours(8)",
    "while ((Test-Path -LiteralPath $flag) -and (Get-Date) -lt $until -and (Get-Process -Name 'Vorrang' -ErrorAction SilentlyContinue)) {",
    "  $l = [VorrangRam]::Lists()",
    "  if ($l -and $l[1] -ge 1GB -and $l[0] -lt 1GB -and (-not $last -or ((Now) - $last) -ge 10000)) { [void](Purge-Now); $l = [VorrangRam]::Lists() }",
    "  Write-Status $l $true",
    "  Start-Sleep -Seconds 3",
    "}",
    "Remove-Item -LiteralPath $flag -Force -ErrorAction SilentlyContinue",
    "Write-Status ([VorrangRam]::Lists()) $false",
  ].join("\r\n");
}

const ALL_TASKS = [TASK_PAUSE, TASK_RESUME, TASK_RAM_START, TASK_RAM_STOP, TASK_RAM_NOW];

/** Datei-Inhalt sicher ins Skript bringen (Base64 – keine Probleme mit Anführungszeichen) */
const writeFile = (target, text) =>
  `  [IO.File]::WriteAllText(${target}, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, "utf8").toString("base64")}')), (New-Object Text.UTF8Encoding $true))`;

/** Einrichtungs-Skript (läuft mit Admin): Ordner + Skript + Rechte + Aufgaben für den angemeldeten Benutzer */
function servicesSetupScript(user, resultFile, remove = false) {
  const dir = "$env:ProgramData\\Vorrang";
  const action = (file, mode) => `(New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $dir '${file}') + '" ${mode}'))`;
  const reg = (name, file, mode, settings = "$settings") =>
    `  Register-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(name)} -Action ${action(file, mode)} -Principal $principal -Settings ${settings} -Force | Out-Null`;
  const lines = [
    "$ErrorActionPreference='Stop'",
    "try {",
    `  $dir = "${dir}"`,
    ...(remove
      ? [
          `  foreach ($t in @(${ALL_TASKS.map(psq).join(", ")})) { Unregister-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }`,
          "  if (Test-Path (Join-Path $dir 'dienste.ps1')) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'dienste.ps1') resume }",
          "  if (Test-Path (Join-Path $dir 'ram.ps1')) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'ram.ps1') stop }",
          "  Start-Sleep -Seconds 4",
          "  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue",
        ]
      : [
          "  New-Item -ItemType Directory -Path $dir -Force | Out-Null",
          // Nur Admins und SYSTEM dürfen schreiben – sonst könnte jedes Programm Skripte mit Admin-Rechten ausführen lassen
          "  & icacls.exe $dir /setowner '*S-1-5-32-544' /T /C | Out-Null",
          "  & icacls.exe $dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null",
          writeFile("(Join-Path $dir 'dienste.ps1')", servicesScript()),
          writeFile("(Join-Path $dir 'ram.ps1')", ramScript()),
          `  $principal = New-ScheduledTaskPrincipal -UserId ${psq(user)} -LogonType Interactive -RunLevel Highest`,
          "  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances Queue",
          "  $long = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 9) -MultipleInstances IgnoreNew",
          reg(TASK_PAUSE, "dienste.ps1", "pause"),
          reg(TASK_RESUME, "dienste.ps1", "resume"),
          reg(TASK_RAM_START, "ram.ps1", "start", "$long"),
          reg(TASK_RAM_STOP, "ram.ps1", "stop"),
          reg(TASK_RAM_NOW, "ram.ps1", "now"),
        ]),
    `  'ok' | Set-Content -LiteralPath ${psq(resultFile)} -Encoding UTF8`,
    "} catch {",
    `  ('Fehler: ' + $_.Exception.Message) | Set-Content -LiteralPath ${psq(resultFile)} -Encoding UTF8`,
    "}",
  ];
  return lines.join("\r\n");
}

/** Dauerhafte PowerShell: Anfragen nacheinander, Antwort an einer Markierung erkennbar */
class PowerShell {
  constructor({ exe = "powershell.exe", args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], timeout = 20000 } = {}) {
    this.exe = exe;
    this.args = args;
    this.timeout = timeout;
    this.queue = Promise.resolve();
    this.seq = 0;
    this.child = null;
  }

  start() {
    const child = spawn(this.exe, this.args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
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
    return r.map((x) => {
      if (x.error) return { pid: x.i, error: x.error };
      const out = { pid: x.i, priority: x.priority, affinity: fromInt64(x.affinity) };
      if (x.memPriorityOk != null) {
        out.memPriority = x.memPriority > 0 ? x.memPriority : null;
        out.memPriorityOk = x.memPriorityOk === true;
      }
      return out;
    });
  }

  async gpu(exePath, pref) {
    const r = await this.ps.run(gpuCmd(exePath, pref));
    if (r !== "ok") throw new Error(r || "Grafikkarten-Wahl fehlgeschlagen");
  }

  async describe(paths) {
    if (!paths.length) return [];
    return ((await this.ps.run(infoCmd(paths))) || []).map((x) => ({ path: x.p, description: x.d || null }));
  }

  /** RAM der Prozesse freiräumen → { freed, n } */
  async trim(pids) {
    if (!pids.length) return { freed: 0, n: 0 };
    return (await this.ps.run(trimCmd(pids))) || { freed: 0, n: 0 };
  }

  /** Verbindungen der Prozesse (eigene PowerShell, damit die Hauptschleife nicht wartet) */
  async connections(pids) {
    if (!pids.length) return [];
    return ((await this.net().run(connCmd(pids))) || []).map((c) => ({ address: c.a, port: c.p, pid: c.o }));
  }

  async ping(host) {
    const ms = await this.net().run(pingCmd(host));
    return typeof ms === "number" ? ms : null;
  }

  net() {
    if (!this.netPs) this.netPs = new PowerShell({ timeout: 10000 });
    return this.netPs;
  }

  /** Steam-Ordner aus der Registry (für die Spiele-Bibliotheken) */
  async steamPath() {
    const r = await this.ps.run("$v=$null; try { $v=(Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -ErrorAction Stop).SteamPath } catch {}; ConvertTo-Json -InputObject $v -Compress");
    return typeof r === "string" && r ? r.replace(/\//g, "\\") : null;
  }

  /** Dienste-Aufgaben eingerichtet? */
  async servicesReady() {
    return taskExists(TASK_PAUSE);
  }

  /** RAM-Aufgaben eingerichtet? (fehlen nach einem Update von 1.1, bis man die Admin-Einrichtung erneut bestätigt) */
  async ramReady() {
    return taskExists(TASK_RAM_START);
  }

  /** RAM-Wächter starten/stoppen (Standby-Liste automatisch leeren) */
  async ramWatch(on) {
    await execText("schtasks.exe", ["/run", "/tn", TASK_PATH + (on ? TASK_RAM_START : TASK_RAM_STOP)]);
  }

  /** Standby-Liste jetzt einmal leeren */
  async ramPurgeNow() {
    await execText("schtasks.exe", ["/run", "/tn", TASK_PATH + TASK_RAM_NOW]);
  }

  /** Stand des RAM-Wächters (oder null) */
  ramStatus() {
    try {
      const file = path.join(process.env.ProgramData || "C:\\ProgramData", "Vorrang", RAM_STATUS_FILE);
      return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\ufeff/, ""));
    } catch {
      return null;
    }
  }

  /** Dienste-Aufgaben einrichten oder entfernen (Windows fragt einmal nach Admin-Rechten) → "ok" | Fehlertext */
  async setupServices(remove = false) {
    const user = (process.env.USERDOMAIN ? process.env.USERDOMAIN + "\\" : "") + os.userInfo().username;
    return this.elevated((result) => servicesSetupScript(user, result, remove), "dienste");
  }

  /** Dienste pausieren / fortsetzen über die eingerichtete Aufgabe (ohne Nachfrage) */
  async services(pause) {
    await execText("schtasks.exe", ["/run", "/tn", TASK_PATH + (pause ? TASK_PAUSE : TASK_RESUME)]);
  }

  /** OneDrive beenden (gibt den Pfad zurück, um es später wieder zu starten) */
  async stopOneDrive(exePath) {
    await execText(exePath, ["/shutdown"]).catch(() => {});
  }

  startOneDrive(exePath) {
    spawn(exePath, ["/background"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
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
    return this.elevated((result) => qosScript(policies, result), "qos");
  }

  /** Skript mit Admin-Rechten ausführen (UAC-Abfrage); das Skript schreibt "ok" oder den Fehler in eine Datei */
  async elevated(build, name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vorrang-"));
    const script = path.join(dir, name + ".ps1");
    const result = path.join(dir, "ergebnis.txt");
    fs.writeFileSync(script, "\ufeff" + build(result), "utf8");
    const denied = "Abgebrochen – ohne Admin-Rechte geht das nicht.";
    try {
      await execText("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psq('"' + script + '"')}`]);
    } catch {
      return denied;
    } finally {
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 2000);
    }
    try {
      return fs.readFileSync(result, "utf8").replace(/^\ufeff/, "").trim() || "Keine Antwort";
    } catch {
      return denied;
    }
  }

  stop() {
    this.ps.stop();
    this.netPs?.stop();
  }
}

async function taskExists(name) {
  try {
    await execText("schtasks.exe", ["/query", "/tn", TASK_PATH + name]);
    return true;
  } catch {
    return false;
  }
}

function execText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

module.exports = { WinCtl, PowerShell, psq, toInt64, fromInt64, setCmd, gpuCmd, infoCmd, qosScript, trimCmd, connCmd, pingCmd, servicesScript, servicesSetupScript, ramScript, RAM_CS, SERVICES, TASK_PATH, TASK_PAUSE, TASK_RESUME, TASK_RAM_START, TASK_RAM_STOP, TASK_RAM_NOW, ALL_TASKS, LIST_CMD, GPU_KEY };
