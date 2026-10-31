import { $, escapeHtml, showBanner, mountPrefsControls } from "./app.js";
import { SUBJECTS, assertSubjectsValid } from "../config/subjects.js";
import { listCards, friendlyError } from "./anki-core.js";
import { countCards } from "./statistics.js";

assertSubjectsValid();
mountPrefsControls($("#prefs"));

const sel = $("#subject-select");
sel.innerHTML += SUBJECTS.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
sel.onchange = () => { if (sel.value) location.href = `anki.html?materia=${encodeURIComponent(sel.value)}`; };

async function loadSummary() {
  const box = $("#summary");
  // Uma leitura por disciplina; falha de uma não derruba as outras.
  const results = await Promise.allSettled(SUBJECTS.map((s) => listCards(s.id)));
  let failures = 0, firstError = null;
  const now = new Date();
  box.innerHTML = SUBJECTS.map((s, i) => {
    const r = results[i];
    const href = `anki.html?materia=${encodeURIComponent(s.id)}`;
    if (r.status === "rejected") { failures++; firstError ??= r.reason; return `<a class="subject-row" href="${href}"><strong>${escapeHtml(s.name)}</strong><span class="muted">não foi possível carregar</span></a>`; }
    const c = countCards(r.value, now);
    return `<a class="subject-row" href="${href}"><strong>${escapeHtml(s.name)}</strong>
      <span class="nums"><span>Novos <b>${c.new}</b></span><span>Pendentes <b>${c.dueNow}</b></span><span>Cartões <b>${c.total}</b></span></span></a>`;
  }).join("");
  if (failures) showBanner($("#banner"), friendlyError(firstError) + (failures < SUBJECTS.length ? `\n(${failures} disciplina(s) sem dados nesta carga.)` : ""));
}

loadSummary().catch((e) => showBanner($("#banner"), friendlyError(e)));
