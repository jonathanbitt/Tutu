import { $, $$, escapeHtml, showBanner, toast, topicSelectOptions, NONE } from "./app.js";
import { SUBJECTS } from "../config/subjects.js";
import {
  listCards, listTopics, createTopic, renameTopic, moveTopic, reorderTopic, deleteTopic, ensurePaths, moveCards,
  migrateLegacyTopics, friendlyError,
} from "./anki-core.js";
import { buildTree, flattenTree, countByTopic, descendantIds, parseOutline, planEnsurePaths, cardPath, pathToText, topicPath, classifyCard } from "./model.js";

const params = new URLSearchParams(location.search);
const subjSel = $("#a-subject");
subjSel.innerHTML = `<option value="">Selecione…</option>` + SUBJECTS.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
let sid = SUBJECTS.some((s) => s.id === params.get("materia")) ? params.get("materia") : "";
subjSel.value = sid;
subjSel.onchange = () => { location.search = subjSel.value ? `?materia=${encodeURIComponent(subjSel.value)}` : ""; };

let topics = [], cards = [];
let selected = null;                 // id do nó | NONE | null
const collapsed = new Set();
const picked = new Set();            // ids de cartões marcados
let busy = false;

// Executa uma ação com trava (evita clique duplo) e mensagens de erro padronizadas.
async function run(fn) {
  if (busy) return;
  busy = true; document.body.style.cursor = "progress";
  try { showBanner($("#banner"), ""); await fn(); }
  catch (e) { const m = friendlyError(e); toast(m, "error", 7000); showBanner($("#banner"), m); }
  finally { busy = false; document.body.style.cursor = ""; }
}

async function reload() {
  [cards, topics] = await Promise.all([listCards(sid), listTopics(sid)]);
  if (selected && selected !== NONE && !topics.some((t) => t.id === selected)) selected = null;
  for (const id of [...picked]) if (!cards.some((c) => c.id === id)) picked.delete(id);
  render();
}

// ---------- Migração dos assuntos antigos ----------
function renderMigrate() {
  const legacy = cards.filter((c) => !c.topicId && (c.topic || c.subtopic));
  const box = $("#migrate-box");
  if (!legacy.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="banner warn"><b>${legacy.length} cartão(ões)</b> ainda usam o assunto/subtópico antigo (texto). Converta para a nova estrutura: os nomes viram assuntos (assunto › subtópico) e os cartões são ligados a eles.
    <div class="row" style="margin-top:.5rem"><button id="mig-go" class="primary">Converter agora</button></div></div>`;
  $("#mig-go").onclick = () => run(async () => {
    const r = await migrateLegacyTopics(sid, cards);
    toast(`${r.migrated} cartão(ões) convertido(s); ${r.createdTopics} assunto(s) criado(s).`);
    await reload();
  });
}

// ---------- Árvore ----------
function render() {
  $("#a-body").hidden = false;
  renderMigrate();
  const counts = countByTopic(cards, topics);
  const flat = flattenTree(topics);
  const hasKids = new Set(flat.map((n) => n.parentId).filter(Boolean));
  let html = "", skip = null;
  for (const n of flat) {
    if (skip !== null && n.depth > skip) continue;
    skip = null;
    if (collapsed.has(n.id)) skip = n.depth;
    const isSel = selected === n.id;
    const own = counts.own.get(n.id), tot = counts.total.get(n.id);
    html += `<div class="tnode ${isSel ? "sel" : ""}" data-id="${escapeHtml(n.id)}" style="margin-left:${n.depth * 1.25}rem">
      <div class="trow" data-act="select">
        <button class="tog ${hasKids.has(n.id) ? "" : "leaf"}" data-act="toggle" aria-label="Expandir ou recolher">${collapsed.has(n.id) ? "▸" : "▾"}</button>
        <span class="tname">${escapeHtml(n.name)}</span>
        <span class="tcount">${tot === own ? own : `${own} (${tot})`}</span>
      </div>
      ${isSel ? actionsHtml(n.id) : ""}
    </div>`;
  }
  const noneSel = selected === NONE;
  html += `<div class="tnode ${noneSel ? "sel" : ""}" data-id="${NONE}" style="margin-top:.5rem">
    <div class="trow" data-act="select"><span class="tog leaf tog"></span><span class="tname"><i>Sem assunto</i></span><span class="tcount">${counts.none}</span></div></div>`;
  if (!flat.length) html = `<div class="empty">Nenhum assunto ainda. Use “Criar vários de uma vez” ou “+ Assunto principal”.</div>` + html;
  $("#tree").innerHTML = html;
  $("#tree").insertAdjacentHTML("beforeend", `<p class="muted" style="margin-top:.5rem">Números: cartões diretos (entre parênteses, com subassuntos).</p>`);
  renderCards();
}

function actionsHtml() {
  return `<div class="tactions">
    <button class="small" data-act="add">+ Subassunto</button><button class="small" data-act="rename">Renomear</button>
    <button class="small" data-act="move">Mover</button><button class="small" data-act="up" aria-label="Subir">↑</button>
    <button class="small" data-act="down" aria-label="Descer">↓</button><button class="small danger" data-act="delete">Excluir</button></div>`;
}

$("#tree").onclick = (ev) => {
  const btn = ev.target.closest("[data-act]"); const node = ev.target.closest(".tnode");
  if (!btn || !node) return;
  const id = node.dataset.id, act = btn.dataset.act;
  if (act === "toggle") { ev.stopPropagation(); collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); return render(); }
  if (act === "select") { selected = selected === id ? null : id; picked.clear(); return render(); }
  const t = topics.find((x) => x.id === id); if (!t) return;
  if (act === "add") return run(async () => {
    const name = prompt(`Novo subassunto de "${t.name}":`); if (name === null) return;
    const n = await createTopic(sid, name, id, topics); collapsed.delete(id);
    toast(`"${n.name}" criado.`); await reload();
  });
  if (act === "rename") return run(async () => {
    const name = prompt("Novo nome:", t.name); if (name === null || name.trim() === t.name) return;
    await renameTopic(sid, id, name, topics); toast("Renomeado."); await reload();
  });
  if (act === "move") return openMove(t);
  if (act === "up" || act === "down") return run(async () => { await reorderTopic(sid, id, act, topics); await reload(); });
  if (act === "delete") return run(async () => {
    const ids = descendantIds(id, topics);
    const n = cards.filter((c) => ids.has(c.topicId)).length;
    const { byId } = buildTree(topics);
    const parent = t.parentId && byId.get(t.parentId);
    const msg = `Excluir "${t.name}"${ids.size > 1 ? ` e seus ${ids.size - 1} subassunto(s)` : ""}?\n\n` +
      (n ? `Os ${n} cartão(ões) desses assuntos NÃO serão apagados: ficarão em ${parent ? `"${parent.name}"` : "“Sem assunto”"}.\n\n` : "Não há cartões nesses assuntos.\n\n") + "Esta ação não pode ser desfeita.";
    if (!confirm(msg)) return;
    const r = await deleteTopic(sid, id, topics);
    selected = r.movedTo; toast(`${r.deletedTopics} assunto(s) excluído(s); ${r.movedCards} cartão(ões) movido(s).`); await reload();
  });
};

// ---------- Mover assunto ----------
let moving = null;
function openMove(t) {
  moving = t;
  $("#mv-title").textContent = `Mover "${t.name}"`;
  $("#mv-dest").innerHTML = `<option value="">(Nível principal)</option>` + topicSelectOptions(topics, { exclude: descendantIds(t.id, topics) });
  $("#mv-dest").value = t.parentId ?? "";
  $("#mv-error").hidden = true; $("#dlg-move").showModal();
}
$("#mv-cancel").onclick = () => $("#dlg-move").close();
$("#move-form").onsubmit = async (ev) => {
  ev.preventDefault();
  if (busy || !moving) return; busy = true; $("#mv-ok").disabled = true;
  try {
    await moveTopic(sid, moving.id, $("#mv-dest").value || null, topics);
    $("#dlg-move").close(); toast("Assunto movido."); await reload();
  } catch (e) { const el = $("#mv-error"); el.textContent = friendlyError(e); el.hidden = false; }
  finally { busy = false; $("#mv-ok").disabled = false; }
};

// ---------- Criar vários ----------
$("#o-clear").onclick = () => { $("#o-text").value = ""; $("#o-msg").textContent = ""; };
$("#o-go").onclick = () => run(async () => {
  const { paths, errors } = parseOutline($("#o-text").value);
  if (errors.length) { showBanner($("#banner"), `Corrija antes de criar:\n${errors.slice(0, 8).join("\n")}${errors.length > 8 ? `\n… e mais ${errors.length - 8}` : ""}`); return; }
  if (!paths.length) { toast("Digite pelo menos um assunto.", "error"); return; }
  const plan = planEnsurePaths(paths, topics, sid);
  if (plan.errors.length) { showBanner($("#banner"), plan.errors.join("\n")); return; }
  if (!plan.created.length) { toast("Todos esses assuntos já existem."); return; }
  if (!confirm(`Criar ${plan.created.length} assunto(s) novo(s)? (${paths.length - plan.created.length} já existiam e serão reaproveitados.)`)) return;
  const r = await ensurePaths(sid, paths);
  $("#o-text").value = ""; $("#o-msg").textContent = `${r.created.length} criado(s).`;
  toast(`${r.created.length} assunto(s) criado(s).`); await reload();
});
$("#t-add-root").onclick = () => run(async () => {
  const name = prompt("Nome do novo assunto principal:"); if (name === null) return;
  const n = await createTopic(sid, name, null, topics); toast(`"${n.name}" criado.`); await reload();
});
$("#t-expand").onclick = () => { collapsed.clear(); render(); };
$("#t-collapse").onclick = () => { topics.forEach((t) => collapsed.add(t.id)); render(); };

// ---------- Cartões do assunto selecionado ----------
function visibleCards() {
  if (!selected) return [];
  if (selected === NONE) { const ids = new Set(topics.map((t) => t.id)); return cards.filter((c) => !c.topicId || !ids.has(c.topicId)); }
  const ids = $("#cp-sub").checked ? descendantIds(selected, topics) : new Set([selected]);
  return cards.filter((c) => ids.has(c.topicId));
}

function renderCards() {
  const panel = $("#cards-panel");
  panel.hidden = !selected;
  if (!selected) return;
  const { byId } = buildTree(topics);
  const list = visibleCards();
  const name = selected === NONE ? "Sem assunto" : pathToText(topicPath(selected, byId));
  $("#cp-title").textContent = `Cartões — ${name}`;
  $("#cp-sub").parentElement.hidden = selected === NONE;
  $("#cp-study").hidden = selected === NONE;
  $("#cp-study").href = `anki.html?materia=${encodeURIComponent(sid)}&assunto=${encodeURIComponent(selected)}`;
  const keep = $("#cp-dest").value;
  $("#cp-dest").innerHTML = topicSelectOptions(topics, { allLabel: "Escolher destino…", noneLabel: "Sem assunto" });
  if ([...$("#cp-dest").options].some((o) => o.value === keep)) $("#cp-dest").value = keep;
  const shown = list.slice(0, 300);
  $("#cp-list").innerHTML = shown.length ? shown.map((c) => {
    const k = classifyCard(c);
    const state = k === "new" ? "Novo" : k === "suspended" ? "Suspenso" : `${c.reviewCount} revisão(ões)`;
    return `<label class="card-pick"><input type="checkbox" data-id="${escapeHtml(c.id)}" ${picked.has(c.id) ? "checked" : ""}>
      <span><span class="front">${escapeHtml(c.front)}</span><span class="meta">${escapeHtml(pathToText(cardPath(c, byId)) || "sem assunto")} · ${state}</span></span></label>`;
  }).join("") + (list.length > 300 ? `<p class="muted">Mostrando 300 de ${list.length}. Mova em etapas.</p>` : "")
    : `<div class="empty">Nenhum cartão aqui.</div>`;
  updateSelCount();
}
function updateSelCount() {
  $("#cp-count").textContent = `${picked.size} selecionado(s)`;
  $("#cp-move").disabled = picked.size === 0;
}
$("#cp-sub").onchange = () => { picked.clear(); renderCards(); };
$("#cp-list").onchange = (ev) => {
  const cb = ev.target.closest("input[data-id]"); if (!cb) return;
  cb.checked ? picked.add(cb.dataset.id) : picked.delete(cb.dataset.id); updateSelCount();
};
$("#cp-all").onclick = () => { visibleCards().slice(0, 300).forEach((c) => picked.add(c.id)); renderCards(); };
$("#cp-none").onclick = () => { picked.clear(); renderCards(); };
$("#cp-move").onclick = () => run(async () => {
  const dest = $("#cp-dest").value === NONE ? null : $("#cp-dest").value;
  if (!dest && $("#cp-dest").value !== NONE) { toast("Escolha o destino.", "error"); return; }
  const { byId } = buildTree(topics);
  const label = dest ? pathToText(topicPath(dest, byId)) : "Sem assunto";
  if (!confirm(`Mover ${picked.size} cartão(ões) para "${label}"?`)) return;
  const n = await moveCards(sid, [...picked], dest);
  picked.clear(); toast(`${n} cartão(ões) movido(s).`); await reload();
});

// ---------- Início ----------
if (sid) {
  $("#link-cards").href = `anki.html?materia=${encodeURIComponent(sid)}`;
  $("#link-load").href = `carregar.html?materia=${encodeURIComponent(sid)}`;
  run(reload);
} else {
  showBanner($("#banner"), "Selecione uma disciplina para gerenciar os assuntos.", "warn");
}
