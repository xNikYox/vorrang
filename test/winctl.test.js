const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const W = require("../src/core/winctl");

test("Kern-Masken werden für .NET in Int64 umgerechnet und zurück", () => {
  const all64 = ((1n << 64n) - 1n).toString();
  assert.equal(W.toInt64(all64), "-1");
  assert.equal(W.fromInt64("-1"), all64);
  assert.equal(W.toInt64("192"), "192");
});

test("Befehle maskieren Anführungszeichen und bleiben einzeilig", () => {
  assert.equal(W.psq("C:\\O'Brien\\a.exe"), "'C:\\O''Brien\\a.exe'");
  const set = W.setCmd([{ pid: 12, priority: "BelowNormal", affinity: "192" }, { pid: "1;rm", priority: "High" }]);
  assert.match(set, /GetProcessById\(12\)/);
  assert.match(set, /GetProcessById\(0\)/); // keine eingeschleusten Befehle über die pid
  assert.match(set, /\[IntPtr\]\[int64\]192/);
  assert.doesNotMatch(set, /\n/);
  const gpu = W.gpuCmd("C:\\Spiele\\it's.exe", "high");
  assert.match(gpu, /'C:\\Spiele\\it''s\.exe'/);
  assert.match(gpu, /GpuPreference=2;/);
  assert.doesNotMatch(gpu, /-Force/); // vorhandene Einträge nie überschreiben
  assert.match(W.gpuCmd("C:\\a.exe", null), /Remove-ItemProperty/);
});

test("QoS-Skript: alte Vorrang-Richtlinien weg, neue mit Mindestrate", () => {
  const s = W.qosScript([{ name: "Vorrang-firefox", exe: "firefox.exe", bits: 5000000 }, { name: "Vorrang-x", exe: "x.exe", bits: 10 }], "C:\\t\\e.txt");
  assert.match(s, /Where-Object \{ \$_.Name -like 'Vorrang-\*' \}/);
  assert.match(s, /-AppPathNameMatchCondition 'firefox.exe' -ThrottleRateActionBitsPerSecond 5000000/);
  assert.match(s, /-ThrottleRateActionBitsPerSecond 8000 /);
});

test("PowerShell-Protokoll: Antworten werden der richtigen Anfrage zugeordnet", async () => {
  // Attrappe statt powershell.exe: antwortet auf jede Zeile mit Markierung und JSON
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vorrang-ps-"));
  const fake = path.join(dir, "fake-ps");
  fs.writeFileSync(fake, `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const m = /'@@(\\d+)@@'/.exec(line);
    if (!m) continue;
    process.stdout.write("Rauschen\\r\\n");
    if (line.includes("SCHWEIGEN")) continue;
    process.stdout.write("@@" + m[1] + "@@" + JSON.stringify({ n: Number(m[1]), echo: line.includes("Get-Process") }) + "\\r\\n");
  }
});`);
  fs.chmodSync(fake, 0o755);
  const ps = new W.PowerShell({ exe: fake, timeout: 1500 });
  const [a, b] = await Promise.all([ps.run(W.LIST_CMD), ps.run("'x'")]);
  assert.deepEqual(a, { n: 1, echo: true });
  assert.deepEqual(b, { n: 2, echo: false });
  await assert.rejects(ps.run("SCHWEIGEN"), /antwortet nicht/);
  assert.deepEqual(await ps.run("'y'"), { n: 4, echo: false }); // nach Zeitüberschreitung neu gestartet
  ps.stop();
});
