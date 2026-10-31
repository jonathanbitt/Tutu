import { $, escapeHtml, showBanner, toast, download, stamp } from "./app.js";
import { SUBJECTS } from "../config/subjects.js";
import { countData, exportFull, resetData, friendlyError } from "./anki-core.js";

const sel = $("#x-subject");
sel.innerHTML = SUBJECTS.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
const q = new URLSearchParams(location.search).get("materia");
if (SUBJECTS.some((s) => s.id === q)) sel.value = q;

let counts = null;                // [{ id, name, cards, events, topics }]
let backedUp = false;             // backup do escopo atual já baixado?
let working = false;

const scopeAll = () => document.querySelector('input[name="scope"]:checked').value === "all";
const targets = () => (scopeAll() ? SUBJECTS : SUBJECTS.filter((s) => s.id === sel.value));
const what = () => ({ cards: $("#x-cards").checked, events: $("#x-events").checked, topics: $("#x-topics").checked });

function updateGo() {
  const w = what();
  const any = w.cards || w.events || w.topics;
  $("#x-go").disabled = working || !any || !backedUp || !$("#x-saved").checked || $("#x-phrase").value.trim() !== "APAGAR" || !counts;
}

function renderNote() {
  const w = what(); const notes = [];
  if (w.cards && !w.events) notes.push("O histórico ficará sem os cartões correspondentes (os relatórios continuam contando as revisões antigas).");
  if (!w.cards && w.events) notes.push("Os cartões ficarão com o agendamento atual, mas sem histórico no relatório.");
  if (w.topics && !w.cards) notes.push("Os cartões que sobrarem ficarão “sem assunto”.");
  $("#x-note").textContent = notes.join(" ");
}

async function refreshCounts() {
  backedUp = false; $("#x-backup-msg").textContent = ""; counts = null; updateGo(); renderNote();
  $("#x-counts").innerHTML = '<span class="spinner"></span> Contando…';
  try {
    const list = targets();
    const res = await Promise.all(list.map((s) => countData(s.id).then((c) => ({ id: s.id, name: s.name, ...c }))));
    counts = res;
    const w = what();
    const sum = (k) => res.reduce((a, r) => a + r[k], 0);
    $("#x-counts").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Disciplina</th><th>Cartões</th><th>Histórico</th><th>Assuntos</th></tr></thead><tbody>` +
      res.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${r.cards}</td><td>${r.events}</td><td>${r.topics}</td></tr>`).join("") +
      `<tr><td><b>Total</b></td><td><b>${sum("cards")}</b></td><td><b>${sum("events")}</b></td><td><b>${sum("topics")}</b></td></tr></tbody></table></div>
      <p class="muted">Serão apagados: ${[w.cards && "cartões", w.events && "histórico", w.topics && "assuntos"].filter(Boolean).join(", ") || "nada (marque algo acima)"}.</p>`;
    showBanner($("#banner"), "");
  } catch (e) { $("#x-counts").innerHTML = ""; showBanner($("#banner"), friendlyError(e)); }
  updateGo();
}

document.querySelectorAll('input[name="scope"]').forEach((r) => (r.onchange = refreshCounts));
sel.onchange = refreshCounts;
["x-cards", "x-events", "x-topics"].forEach((id) => ($(`#${id}`).onchange = () => { renderNote(); refreshCounts(); }));
$("#x-saved").onchange = updateGo;
$("#x-phrase").oninput = updateGo;

$("#x-backup").onclick = async () => {
  if (!counts || working) return;
  working = true; $("#x-backup").disabled = true; backedUp = false; updateGo();
  try {
    const withData = counts.filter((c) => c.cards + c.events + c.topics > 0);
    if (!withData.length) { $("#x-backup-msg").textContent = "Não há dados para guardar."; backedUp = true; return; }
    let n = 0;
    for (const c of withData) {
      $("#x-backup-msg").innerHTML = `<span class="spinner"></span> Gerando ${escapeHtml(c.name)}…`;
      const data = await exportFull(c.id);
      // O arquivo precisa conter exatamente o que o servidor tem (contagem conferida antes de liberar a exclusão).
      if (data.cards.length !== c.cards || (data.events?.length ?? 0) !== c.events || data.topics.length !== c.topics)
        throw new Error(`Os dados de ${c.name} mudaram durante o backup. Recarregue a página e repita.`);
      download(`${c.id}-backup-completo-${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
      n++; if (n < withData.length) await new Promise((r) => setTimeout(r, 400));   // espaça os downloads (alguns navegadores bloqueiam rajadas)
    }
    backedUp = true;
    $("#x-backup-msg").textContent = `${n} arquivo(s) gerado(s). Confira a pasta de downloads.`;
  } catch (e) { showBanner($("#banner"), friendlyError(e)); $("#x-backup-msg").textContent = "Falhou; nada foi apagado."; }
  finally { working = false; $("#x-backup").disabled = false; updateGo(); }
};

$("#x-go").onclick = async () => {
  if ($("#x-go").disabled) return;
  const w = what(), list = targets();
  const label = list.length > 1 ? `TODAS as ${list.length} disciplinas` : `"${list[0].name}"`;
  if (!confirm(`Última confirmação.\n\nApagar definitivamente (${[w.cards && "cartões", w.events && "histórico", w.topics && "assuntos"].filter(Boolean).join(", ")}) de ${label}?\n\nNão há como desfazer, exceto restaurando o backup.`)) return;
  working = true; updateGo(); $("#x-backup").disabled = true;
  const out = $("#x-progress"); const total = { cards: 0, events: 0, topics: 0 };
  let current = "";
  try {
    for (const s of list) {
      current = s.name;
      await resetData(s.id, w, (label2, done, tot) => { out.innerHTML = `<span class="spinner"></span> ${escapeHtml(s.name)}: apagando ${escapeHtml(label2)} ${done}/${tot}…`; });
      const c = counts.find((x) => x.id === s.id);
      if (w.cards) total.cards += c.cards; if (w.events) total.events += c.events; if (w.topics) total.topics += c.topics;
    }
    out.textContent = `Concluído: ${total.cards} cartão(ões), ${total.events} evento(s) de histórico e ${total.topics} assunto(s) apagados.`;
    toast("Dados apagados."); showBanner($("#banner"), "");
    $("#x-phrase").value = ""; $("#x-saved").checked = false; backedUp = false;
    await refreshCounts();
    out.innerHTML += ` <a href="assuntos.html${list.length === 1 ? `?materia=${encodeURIComponent(list[0].id)}` : ""}">Criar a nova estrutura de assuntos</a> · <a href="carregar.html${list.length === 1 ? `?materia=${encodeURIComponent(list[0].id)}` : ""}">Carregar cartões</a>`;
  } catch (e) {
    out.textContent = "";
    showBanner($("#banner"), `Falha durante a exclusão (${current}): ${friendlyError(e)}\nParte dos dados pode ter sido apagada. Os números abaixo mostram o que restou; repetir a exclusão é seguro, e o backup baixado continua válido.`);
    await refreshCounts();
  } finally { working = false; $("#x-backup").disabled = false; updateGo(); }
};

refreshCounts();
