// Kleines Overlay: Spiel-CPU, CPU gesamt, RAM, Ping
const $ = (id) => document.getElementById(id);
const pct = (v) => (v == null ? "–" : Math.round(v) + "%");
function color(el, v, mid, bad) {
  el.className = v == null ? "" : v >= bad ? "bad" : v >= mid ? "mid" : "good";
}
window.vorrang.onOverlay((s) => {
  if (!s) return;
  const m = s.metrics || {};
  $("ov").classList.toggle("idle", !s.active);
  $("game").textContent = s.active ? (s.game || "Spielmodus an") : "Spielmodus aus";
  $("gameCpu").textContent = pct(m.game);
  $("cpu").textContent = pct(m.cpu);
  $("ram").textContent = pct(m.ram);
  $("ping").textContent = m.ping == null ? "–" : m.ping + " ms";
  color($("cpu"), m.cpu, 75, 92);
  color($("ram"), m.ram, 80, 92);
  color($("ping"), m.ping, 60, 120);
});
