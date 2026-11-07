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
    sub.innerHTML = esc(parts.join(" · ")) + (p.errors.length ? ` · <span class="warn" title="${esc(p.errors.join("\n"))}">kein Zugriff (läuft als Admin?)</span>` : "");
    $(".bar i", row).style.width = Math.min(100, p.cpu) + "%";
    $(".cpu", row).textContent = p.cpu.toFixed(1) + " %";
    $(".ram", row).textContent = fmtRam(p.ram);
    const old = $(".levels", row);
    if (old.dataset.level !== (p.level || "normal")) {
      const seg = levelSeg(p.level, (lv) => setProgramLevel(p, lv));
      seg.dataset.level = p.level || "normal";
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
  else if (level !== "normal") {
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
  $("#version").textContent = info.version;
  $("#cpuName").textContent = info.cpuModel ? "· " + info.cpuModel : "";
  renderUpdate(info.update);
}

$$("[data-set]").forEach((el) => el.addEventListener("change", async () => {
  const k = el.dataset.set;
  info = await api.saveSettings({ [k]: el.type === "checkbox" ? el.checked : Number(el.value) });
  renderHero();
}));

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
  renderPrograms();
  renderSettings();
  if ($("#page-regeln").classList.contains("active")) renderRules();
}

api.onState((s) => {
  snap = s;
  renderHero();
  renderPrograms();
});
api.onUpdate((u) => {
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
