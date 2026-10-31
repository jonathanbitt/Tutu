import { $, escapeHtml, showBanner, toast, readFileText } from "./app.js";
import { SUBJECTS } from "../config/subjects.js";
import { listTopics, planCSVImport, importCSV, friendlyError } from "./anki-core.js";
import { flattenTree, parsePathString, pathToText } from "./model.js";

const q = new URLSearchParams(location.search);
const sel = $("#l-subject");
sel.innerHTML = SUBJECTS.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
if (SUBJECTS.some((s) => s.id === q.get("materia"))) sel.value = q.get("materia");
const syncLinks = () => {
  $("#link-cards").href = `anki.html?materia=${encodeURIComponent(sel.value)}`;
  $("#link-topics").href = `assuntos.html?materia=${encodeURIComponent(sel.value)}`;
};
sel.onchange = () => { syncLinks(); invalidate(); loadPaths(); };
syncLinks();

let ready = null;   // { sid, text, defaults } do último "validar" bem-sucedido
let busy = false;
const defaults = () => ({ path: parsePathString($("#l-topic").value) });
function invalidate() { ready = null; $("#l-go").disabled = true; }
["l-text", "l-topic"].forEach((id) => ($(`#${id}`).oninput = invalidate));

// Sugestões do campo "assunto padrão": caminhos que já existem na disciplina.
async function loadPaths() {
  try {
    const topics = await listTopics(sel.value);
    $("#dl-paths").innerHTML = flattenTree(topics).map((n) => `<option value="${escapeHtml(pathToText(n.path, " > "))}">`).join("");
  } catch { $("#dl-paths").innerHTML = ""; }
}
loadPaths();

$("#l-file").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { $("#l-text").value = await readFileText(f); invalidate(); toast(`Arquivo "${f.name}" carregado. Clique em Validar.`); }
  catch (err) { showBanner($("#banner"), friendlyError(err)); }
};
$("#l-clear").onclick = () => { $("#l-text").value = ""; $("#l-file").value = ""; $("#l-preview").innerHTML = ""; invalidate(); };
$("#l-sample").onclick = () => {
  $("#l-text").value = 'frente;verso;assunto;subtopico\nQual o fato gerador do ITBI?;Transmissão inter vivos, a qualquer título, de bens imóveis.;Tributos > Impostos > Impostos em espécie;\n"Defina tributo (CTN, art. 3º)";"Toda prestação pecuniária compulsória, em moeda,\nque não constitua sanção de ato ilícito, instituída em lei e cobrada mediante atividade administrativa plenamente vinculada.";Tributos > Conceito;';
  invalidate();
};

$("#l-check").onclick = async () => {
  showBanner($("#banner"), "");
  const box = $("#l-preview"); invalidate();
  const text = $("#l-text").value;
  if (!text.trim()) { showBanner(box, "Cole o texto ou escolha um arquivo primeiro."); return; }
  box.innerHTML = '<span class="spinner"></span> Validando e comparando com os cartões existentes…';
  try {
    const d = defaults();
    const plan = await planCSVImport(sel.value, text, d);   // mesma função usada na importação: prévia = resultado
    if (plan.errors.length) {
      showBanner(box, `${plan.errors.length} problema(s); nada será importado até corrigir:\n${plan.errors.slice(0, 10).join("\n")}${plan.errors.length > 10 ? `\n… e mais ${plan.errors.length - 10}` : ""}`);
      return;
    }
    if (plan.topicErrors.length) { showBanner(box, `Assuntos inválidos:\n${plan.topicErrors.slice(0, 8).join("\n")}`); return; }
    const rows = plan.fresh.slice(0, 8).map((c) => `<div class="card-item"><div class="front">${escapeHtml(c.front)}</div><div class="meta">${escapeHtml(pathToText(c.path) || "sem assunto")}</div><div style="white-space:pre-wrap">${escapeHtml(c.back.slice(0, 200))}</div></div>`).join("");
    box.innerHTML = `<div class="banner ok">${plan.fresh.length} cartão(ões) novo(s) a importar em <b>${escapeHtml(SUBJECTS.find((s) => s.id === sel.value).name)}</b>.
      ${plan.newTopics.length ? `<br>${plan.newTopics.length} assunto(s) novo(s) serão criados: ${escapeHtml(plan.newTopics.slice(0, 6).map((t) => t.name).join(", "))}${plan.newTopics.length > 6 ? "…" : ""}` : ""}
      ${plan.dupDb ? `<br>${plan.dupDb} já existe(m) e será(ão) ignorado(s).` : ""}${plan.dupFile ? `<br>${plan.dupFile} repetido(s) no próprio texto será(ão) ignorado(s).` : ""}</div>${rows}${plan.fresh.length > 8 ? `<p class="muted">Mostrando 8 de ${plan.fresh.length}.</p>` : ""}`;
    if (plan.fresh.length) { ready = { sid: sel.value, text, defaults: d }; $("#l-go").disabled = false; }
    else box.innerHTML += '<div class="empty">Nada novo para importar.</div>';
  } catch (e) { showBanner(box, friendlyError(e)); }
};

$("#l-go").onclick = async () => {
  if (!ready || busy) return;
  busy = true; $("#l-go").disabled = true; $("#l-msg").innerHTML = '<span class="spinner"></span> Gravando…';
  try {
    const r = await importCSV(ready.sid, ready.text, new Date(), ready.defaults);
    toast(`${r.imported} cartão(ões) importado(s); ${r.skipped} ignorado(s); ${r.createdTopics} assunto(s) criado(s).`);
    $("#l-msg").textContent = `Concluído: ${r.imported} importado(s), ${r.skipped} ignorado(s), ${r.createdTopics} assunto(s) criado(s).`;
    $("#l-preview").innerHTML = ""; $("#l-text").value = ""; $("#l-file").value = ""; ready = null; loadPaths();
  } catch (e) {
    const m = friendlyError(e); toast(m, "error", 8000); showBanner($("#banner"), m + "\nConfira na aba Cartões antes de repetir (duplicados são ignorados).");
    $("#l-msg").textContent = ""; $("#l-go").disabled = false;
  } finally { busy = false; }
};
