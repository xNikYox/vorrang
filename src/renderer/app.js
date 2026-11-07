// Oberfläche: Status, Kern-Aufteilung, Programme mit Stufen, Regeln, Einstellungen.
const api = window.vorrang;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const LEVEL_ORDER = ["game", "normal", "low", "minimal"];
let info = null;
let snap = null;
const iconCache = {};

const fmtRam = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + " GB" : Math.round(b / 1024 ** 2) + " MB");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function toast(text, ms = 3500) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------------- Tabs ---------------- */
$$(".tab").forEach((b) => b.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === b));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + b.dataset.tab));
  if (b.dataset.tab === "regeln") renderRules();
}));

/* ---------------- Status & Kerne ---------------- */
function renderHero() {
  const s = info.settings;
  const active = !!snap?.active;
  $("#hero").classList.toggle("on", active);
  $("#statusTitle").textContent = active ? "Spielmodus an" : s.manual === "off" ? "Spielmodus aus" : "Bereit";
  $("#statusSub").textContent = active
    ? (snap.game ? `${snap.game} hat Vorrang` : "Von Hand eingeschaltet")
    : s.manual === "off"
      ? "Alle Programme laufen normal"
      : s.autoGameMode ? "Schaltet sich ein, sobald ein Spiel startet" : "Automatik ist in den Einstellungen aus";
  $$("#modeSeg button").forEach((b) => b.classList.toggle("sel", b.dataset.mode === s.manual));
  renderCores(s.backgroundCores);
}

function renderCores(bg) {
  const n = info.cpuCount;
  const box = $("#cores");
  if (box.children.length !== n) box.innerHTML = Array.from({ length: n }, (_, i) => `<div class="core">${i}</div>`).join("");
  [...box.children].forEach((c, i) => c.classList.toggle("bg", i >= n - bg));
  const slider = $("#bgCores");
  slider.max = Math.max(1, n - 1);
  if (document.activeElement !== slider) slider.value = bg;
  $("#bgCoresOut").textContent = `${bg} von ${n} Kernen`;
}

/* ---------------- Messwerte & Messung ---------------- */
function spark(svg, values, max) {
  const v = values.map((x) => (x == null ? null : x));
  const top = max || Math.max(10, ...v.filter((x) => x != null)) * 1.15;
  const n = Math.max(2, v.length);
  const pts = v.map((x, i) => (x == null ? null : `${((i / (n - 1)) * 100).toFixed(1)},${(28 - (Math.min(x, top) / top) * 26 - 1).toFixed(1)}`)).filter(Boolean);
  $("polyline", svg).setAttribute("points", pts.join(" "));
}

function renderStats() {
  const m = snap?.metrics || {};
  const h = snap?.history || [];
  const fmt = { cpu: (v) => v + " %", game: (v) => v + " %", ram: (v) => v + " %", ping: (v) => v + " ms" };
  for (const el of $$("#stats .stat")) {
    const k = el.dataset.k;
    $("b", el).textContent = m[k] == null ? "–" : fmt[k](Math.round(m[k]));
    spark($("svg", el), h.map((p) => p[k]), k === "ping" ? 0 : 100);
  }
  $("#stats .stat[data-k=ping]").title = m.server ? "Server: " + m.server : "Ping zum Spielserver (sobald ein Spiel verbunden ist)";
  const b = $("#measureBtn");
  b.disabled = !!snap?.measuring || !snap?.game;
  b.title = snap?.game ? "Misst je 20 Sekunden ohne und mit Vorrang" : "Starte zuerst ein Spiel";
}

function renderMeasure(r) {
  const box = $("#measure");
  if (!r) return;
  box.hidden = false;
  if (r.running) {
    box.innerHTML = `<div class="mhead"><b>Messe ${esc(r.phase)} …</b><span class="hint">Bitte normal weiterspielen</span></div><div class="mbar"><i></i></div>`;
    $(".mbar i", box).style.width = Math.round(r.part * 100) + "%"; // per Skript: Inline-Styles verbietet die CSP
    return;
  }
  if (r.error) {
    box.innerHTML = `<div class="mhead"><b>Messung abgebrochen</b><button class="icon-btn" id="measureClose" aria-label="Schließen">✕</button></div><p class="hint">${esc(r.error)}</p>`;
  } else {
    const { before: a, after: b } = r;
    const cell = (x, y, better, unit) => {
      if (x == null || y == null) return `<div>${y == null ? "–" : y + unit}</div>`;
      const d = Math.round((y - x) * 10) / 10;
      const good = better === "up" ? d > 0 : d < 0;
      return `<div>${y}${unit} <span class="${d === 0 ? "" : good ? "up" : "down"}">${d > 0 ? "+" : ""}${d}</span></div>`;
    };
    box.innerHTML = `<div class="mhead"><b>Ergebnis: ${esc(r.game)}</b><button class="icon-btn" id="measureClose" aria-label="Schließen">✕</button></div>
      <div class="mgrid">
        <div class="h"></div><div class="h">Spiel-CPU</div><div class="h">Ping</div><div class="h">Ping-Schwankung</div>
        <div>Ohne Vorrang</div><div>${a.game ?? "–"} %</div><div>${a.ping ?? "–"} ms</div><div>${a.jitter ?? "–"} ms</div>
        <div><b>Mit Vorrang</b></div>${cell(a.game, b.game, "up", " %")}${cell(a.ping, b.ping, "down", " ms")}${cell(a.jitter, b.jitter, "down", " ms")}
      </div>
      <p class="hint">Mehr Spiel-CPU = mehr Rechenzeit fürs Spiel. Die Wirkung ist am größten, wenn nebenbei viel läuft (Browser, Downloads, Discord).</p>`;
  }
  $("#measureClose")?.addEventListener("click", () => (box.hidden = true));
}

$("#measureBtn").addEventListener("click", async () => {
  renderMeasure({ running: true, phase: "ohne Vorrang", part: 0 });
  $("#measureBtn").disabled = true;
  const r = await api.measure();
  renderMeasure(r.error ? { error: r.error } : r.result);
  renderStats();
});

$("#bgCores").addEventListener("input", (e) => renderCores(Number(e.target.value)));
$("#bgCores").addEventListener("change", async (e) => {
  info = await api.saveSettings({ backgroundCores: Number(e.target.value) });
  renderHero();
});
$$("#modeSeg button").forEach((b) => b.addEventListener("click", async () => {
  info = await api.saveSettings({ manual: b.dataset.mode });
  snap = info.snapshot || snap;
  renderHero();
}));

/* ---------------- Programme ---------------- */
function levelSeg(current, onPick) {
  const seg = document.createElement("div");
  seg.className = "seg levels";
  for (const lv of LEVEL_ORDER) {
    const b = document.createElement("button");
    b.dataset.level = lv;
    b.textContent = info.levels[lv];
    b.classList.toggle("sel", lv === (current || "normal"));
    b.addEventListener("click", () => onPick(lv));
    seg.append(b);
  }
  return seg;
}

async function loadIcons(programs) {
  const missing = programs.map((p) => p.path).filter((p) => p && !(p in iconCache));
  if (!missing.length) return;
  for (const p of missing) iconCache[p] = null;
  Object.assign(iconCache, await api.icons(missing));
  renderPrograms();
}

function renderPrograms() {
  if (!snap) return;
  const q = $("#search").value.trim().toLowerCase();
  const list = snap.programs.filter((p) => !q || p.name.toLowerCase().includes(q) || p.exe.includes(q));
  const box = $("#programs");
  const rows = new Map($$(".prog", box).map((r) => [r.dataset.key, r]));
  const tpl = $("#tplProgram");
  list.forEach((p, i) => {
    let row = rows.get(p.key);
    if (!row) {
      row = tpl.content.firstElementChild.cloneNode(true);
      row.dataset.key = p.key;
    }
    rows.delete(p.key);
    row.classList.toggle("game", p.level === "game");
    const ico = $(".ico", row);
    const src = p.path && iconCache[p.path];
    if (src && ico.dataset.src !== src) {
      ico.innerHTML = `<img alt="" src="${src}">`;
      ico.dataset.src = src;
    } else if (!src && !ico.dataset.src) ico.textContent = p.name.slice(0, 1).toUpperCase();
    $(".pname b", row).textContent = p.name;
    const sub = $(".pname small", row);
    const parts = [p.exe + (p.count > 1 ? ` · ${p.count} Prozesse` : "")];
    if (p.applied && snap.active) parts.push(p.level === "game" ? "bekommt Vorrang" : "gedrosselt");
    sub.innerHTML = esc(parts.join(" · ")) + (p.auto ? ` <span class="badge" title="Aus einer Spiele-Bibliothek erkannt – wähle eine Stufe, um das zu ändern">automatisch erkannt</span>` : "") + (p.errors.length ? ` · <span class="warn" title="${esc(p.errors.join("\n"))}">kein Zugriff (läuft als Admin?)</span>` : "");
    $(".bar i", row).style.width = Math.min(100, p.cpu) + "%";
    $(".cpu", row).textContent = p.cpu.toFixed(1) + " %";
    $(".ram", row).textContent = fmtRam(p.ram);
    const old = $(".levels", row);
    if (old.dataset.level !== (p.level || "normal") || old.dataset.auto !== String(p.auto)) {
      const seg = levelSeg(p.level, (lv) => setProgramLevel(p, lv));
      seg.dataset.level = p.level || "normal";
      seg.dataset.auto = String(p.auto);
      old.replaceWith(seg);
    }
    if (box.children[i] !== row) box.insertBefore(row, box.children[i] || null);
  });
  for (const r of rows.values()) r.remove();
  $("#programsEmpty").hidden = list.length > 0;
  loadIcons(list);
}

async function setProgramLevel(p, level) {
  const rules = structuredClone(info.settings.rules);
  const rule = rules.find((r) => r.id === p.rule);
  if (rule) rule.level = level;
  else if (level !== "normal" || p.auto) { // auch „Normal“ speichern, wenn ein erkanntes Spiel keins ist
    rules.push({ id: p.exe.replace(/\.exe$/, "").replace(/[^\w-]/g, "") + "-" + Date.now().toString(36).slice(-4), name: p.name, exe: p.exe, level, enabled: true });
  } else return;
  info = await api.saveRules(rules);
  snap = info.snapshot || snap;
  renderAll();
  toast(`${p.name}: ${info.levels[level]}`);
}

$("#search").addEventListener("input", renderPrograms);
$("#showAll").addEventListener("change", async (e) => {
  info = await api.saveSettings({ showAll: e.target.checked });
  snap = info.snapshot || snap;
  renderPrograms();
});

/* ---------------- Regeln ---------------- */
const opt = (v, label, cur) => `<option value="${v}"${String(cur) === v ? " selected" : ""}>${label}</option>`;

function renderRules() {
  const box = $("#rules");
  box.innerHTML = "";
  for (const r of info.settings.rules) box.append(ruleCard(r));
  if (!info.settings.rules.length) box.innerHTML = `<p class="empty">Noch keine Regeln. Wähle in „Programme“ eine Stufe oder füge eine Regel hinzu.</p>`;
  $("#qosBanner").hidden = !info.qosPending;
}

function ruleCard(r) {
  const el = document.createElement("div");
  el.className = "rule" + (r.enabled ? "" : " off");
  const cur = (k) => (r[k] === undefined ? "level" : r[k] === null ? "none" : r[k]);
  const cores = Array.isArray(r.cores) ? r.cores.join(",") : cur("cores");
  el.innerHTML = `
    <div class="rule-head">
      <input class="name" value="${esc(r.name)}" aria-label="Name">
      <input type="checkbox" class="switch" ${r.enabled ? "checked" : ""} title="Regel an/aus">
      <button class="icon-btn" title="Regel löschen" aria-label="Regel löschen">✕</button>
    </div>
    <div class="grid2">
      <label class="field">Programm (exe)<input data-k="exe" value="${esc(r.exe)}" placeholder="firefox.exe"></label>
      <label class="field">Fenstertitel enthält (optional)<input data-k="title" value="${esc(r.title || "")}" placeholder="z. B. minecraft|mytic"></label>
    </div>
    <div class="lv"></div>
    <details class="fine">
      <summary>Feinheiten</summary>
      <div class="grid2">
        <label class="field">Priorität<select data-k="priority">
          ${opt("level", "wie Stufe", cur("priority"))}${opt("High", "Hoch", cur("priority"))}${opt("AboveNormal", "Höher als normal", cur("priority"))}
          ${opt("Normal", "Normal", cur("priority"))}${opt("BelowNormal", "Niedriger als normal", cur("priority"))}${opt("Idle", "Niedrig", cur("priority"))}${opt("none", "nicht ändern", cur("priority"))}
        </select></label>
        <label class="field">CPU-Kerne<select data-k="cores">
          ${opt("level", "wie Stufe", cores)}${opt("all", "alle Kerne", cores)}${opt("game", "nur Spiel-Kerne", cores)}${opt("background", "nur Kerne der Gedrosselten", cores)}${opt("none", "nicht ändern", cores)}
          ${Array.isArray(r.cores) ? opt(cores, "Kerne " + cores, cores) : ""}
        </select></label>
        <label class="field">Grafikkarte<select data-k="gpu">
          ${opt("level", "wie Stufe", cur("gpu"))}${opt("high", "Hohe Leistung", cur("gpu"))}${opt("saving", "Stromsparen", cur("gpu"))}${opt("auto", "Windows entscheidet", cur("gpu"))}${opt("none", "nicht ändern", cur("gpu"))}
        </select></label>
        <label class="field">Upload-Limit (Mbit/s, leer = keins)<input data-k="uploadMbit" type="number" min="0" step="0.5" value="${r.uploadMbit || ""}" placeholder="z. B. 5"></label>
      </div>
    </details>`;
  const seg = levelSeg(r.level, (lv) => {
    r.level = lv;
    $$("button", seg).forEach((b) => b.classList.toggle("sel", b.dataset.level === lv));
    saveRule(r);
  });
  $(".lv", el).replaceWith(seg);
  $(".name", el).addEventListener("change", (e) => saveRule(Object.assign(r, { name: e.target.value.trim() || r.exe })));
  $(".switch", el).addEventListener("change", (e) => {
    r.enabled = e.target.checked;
    el.classList.toggle("off", !r.enabled);
    saveRule(r);
  });
  $(".icon-btn", el).addEventListener("click", async () => {
    info = await api.saveRules(info.settings.rules.filter((x) => x.id !== r.id));
    renderRules();
    toast(`Regel „${r.name}“ gelöscht`);
  });
  $$("[data-k]", el).forEach((f) => f.addEventListener("change", () => {
    const k = f.dataset.k;
    const v = f.value.trim();
    if (k === "exe") r.exe = v || r.exe;
    else if (k === "title") v ? (r.title = v) : delete r.title;
    else if (k === "uploadMbit") Number(v) > 0 ? (r.uploadMbit = Number(v)) : delete r.uploadMbit;
    else if (v === "level") delete r[k];
    else if (v === "none") r[k] = null;
    else if (k === "cores" && /^\d+(,\d+)*$/.test(v)) r.cores = v.split(",").map(Number);
    else r[k] = v;
    saveRule(r);
  }));
  return el;
}

async function saveRule(r) {
  const rules = info.settings.rules.map((x) => (x.id === r.id ? r : x));
  info = await api.saveRules(rules);
  $("#qosBanner").hidden = !info.qosPending;
}

$("#addRule").addEventListener("click", async () => {
  const id = "regel-" + Date.now().toString(36);
  info = await api.saveRules([...info.settings.rules, { id, name: "Neue Regel", exe: "programm.exe", level: "low", enabled: true }]);
  renderRules();
  const card = $("#rules").lastElementChild;
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  $('[data-k="exe"]', card)?.select();
});

$("#qosApply").addEventListener("click", async () => {
  const b = $("#qosApply");
  b.disabled = true;
  b.textContent = "Warte auf Windows …";
  try {
    const r = await api.applyQos();
    info = r.info;
    toast(r.result === "ok" ? "Upload-Limits übernommen" : r.result, 6000);
  } finally {
    b.disabled = false;
    b.textContent = "Übernehmen";
    $("#qosBanner").hidden = !info.qosPending;
  }
});

/* ---------------- Einstellungen ---------------- */
function renderSettings() {
  const s = info.settings;
  $$("[data-set]").forEach((el) => {
    const k = el.dataset.set;
    if (el.type === "checkbox") el.checked = !!s[k];
    else el.value = String(s[k]);
  });
  $("#showAll").checked = !!s.showAll;
  $("#servicesSwitch").checked = !!s.pauseServices;
  $$("[data-hotkey]").forEach((el) => {
    if (document.activeElement !== el) el.value = showKey(s[el.dataset.hotkey]);
  });
  $("#rootsText").textContent = "Steam, Epic, Battle.net, Riot, Xbox, EA, Ubisoft, GOG" + (info.gameRoots ? ` · ${info.gameRoots} Bibliotheken gefunden` : "");
  $("#version").textContent = info.version;
  $("#cpuName").textContent = info.cpuModel ? "· " + info.cpuModel : "";
  renderUpdate(info.update);
}

$$("[data-set]").forEach((el) => el.addEventListener("change", async () => {
  const k = el.dataset.set;
  info = await api.saveSettings({ [k]: el.type === "checkbox" ? el.checked : el.dataset.type === "text" ? el.value : Number(el.value) });
  renderHero();
}));

$("#servicesSwitch").addEventListener("change", async (e) => {
  const on = e.target.checked;
  e.target.disabled = true;
  toast("Windows fragt nach Admin-Rechten …", 8000);
  try {
    const r = await api.setServices(on);
    info = r.info;
    toast(r.result === "ok" ? (on ? "Windows-Dienste werden im Spielmodus pausiert" : "Dienste-Pause entfernt") : r.result, 6000);
  } finally {
    e.target.disabled = false;
    e.target.checked = !!info.settings.pauseServices;
  }
});

/* Tastenkürzel aufnehmen: Feld anklicken, Kombination drücken; Entf = keins, Esc = abbrechen */
const KEY_NAMES = { Control: "Strg", Alt: "Alt", Shift: "Umschalt", Super: "Win" };
const showKey = (acc) => (acc ? acc.split("+").map((k) => KEY_NAMES[k] || k).join(" + ") : "keins");
function accelerator(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) key = e.code;
  else if (/^Numpad\d$/.test(e.code)) key = "num" + e.code.slice(6);
  else if (["Home", "End", "PageUp", "PageDown", "Insert", "Pause"].includes(e.code)) key = e.code;
  if (!key) return null;
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  if (!mods.length && !/^F\d/.test(key)) return null; // ohne Strg/Alt nur F-Tasten
  return [...mods, key].join("+");
}
$$("[data-hotkey]").forEach((el) => {
  el.addEventListener("focus", () => (el.value = "Tasten drücken …"));
  el.addEventListener("blur", () => (el.value = showKey(info.settings[el.dataset.hotkey])));
  el.addEventListener("keydown", async (e) => {
    e.preventDefault();
    if (e.key === "Escape") return el.blur();
    let acc;
    if (e.key === "Backspace" || e.key === "Delete") acc = "";
    else if (!(acc = accelerator(e))) return;
    info = await api.saveSettings({ [el.dataset.hotkey]: acc });
    if (info.hotkeyError) toast(info.hotkeyError, 5000);
    el.blur();
  });
});

function renderUpdate(u) {
  const t = $("#updateText");
  const b = $("#updateBtn");
  b.disabled = false;
  b.textContent = "Nach Updates suchen";
  const texts = {
    idle: "Updates kommen automatisch.",
    checking: "Suche nach Updates …",
    current: "Du hast die neueste Version.",
    downloading: `Lade Version ${u.version || ""} … ${u.percent || 0} %`,
    ready: `Version ${u.version} ist bereit.`,
    error: "Update-Prüfung fehlgeschlagen.",
  };
  t.textContent = texts[u.status] || texts.idle;
  if (u.status === "ready") b.textContent = "Neu starten & installieren";
  if (u.status === "checking" || u.status === "downloading") b.disabled = true;
}

$("#updateBtn").addEventListener("click", () => (info.update.status === "ready" ? api.installUpdate() : api.checkUpdate()));

/* ---------------- Start ---------------- */
function renderAll() {
  renderHero();
  renderStats();
  renderPrograms();
  renderSettings();
  if ($("#page-regeln").classList.contains("active")) renderRules();
}

api.onState((s) => {
  snap = s;
  renderHero();
  renderStats();
  renderPrograms();
});
api.onMeasure((m) => renderMeasure({ running: true, ...m }));
api.onInfo((i) => {
  info = i;
  renderSettings();
});
api.onUpdate((u) => {
  if (!info) return;
  info.update = u;
  renderUpdate(u);
});
api.onError((e) => toast("Fehler: " + e, 5000));

(async () => {
  info = await api.info();
  snap = info.snapshot;
  if (info.platform !== "win32") toast("Vorrang greift nur unter Windows ein – hier läuft nur die Vorschau.", 6000);
  renderAll();
})();
