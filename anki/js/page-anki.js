import { $, $$, escapeHtml, showBanner, toast, download, stamp, readFileText, debounce, getPrefs, mountPrefsControls, topicSelectOptions, NONE } from "./app.js";
import {
  requireSubject, listCards, listTopics, createCard, updateCard, setSuspended, deleteCard, recordReview, findDuplicateFront, ensurePaths, migrateLegacyTopics,
  exportCards, exportFull, exportCardsCSV, previewBackupImport, applyBackupImport, importCSV, planCSVImport, friendlyError, AppError,
} from "./anki-core.js";
import { makeScheduler, previewReview, Grades } from "./fsrs.js";
import { countCards, reviewMetrics, formatPct, formatDuration } from "./statistics.js";
import { renderRichText, buildQueue, classifyCard, normalizeText, formatInterval, RATING_NAMES, STATE_NAMES, buildTree, cardPath, pathToText, descendantIds, parsePathString } from "./model.js";

const params = new URLSearchParams(location.search);
const sid = params.get("materia") || "";
let subject;
try { subject = requireSubject(sid); } catch (e) {
  showBanner($("#banner"), friendlyError(e) + "\nVolte à lista de disciplinas.");
  $("#title").textContent = "Disciplina não encontrada";
  throw e;
}
document.title = `${subject.name} — Flashcards`;
$("#title").textContent = subject.name;
$("#link-reports").href = `relatorios.html?materia=${encodeURIComponent(sid)}`;
$("#link-load").href = `carregar.html?materia=${encodeURIComponent(sid)}`;
$("#link-topics").href = `assuntos.html?materia=${encodeURIComponent(sid)}`;
$("#dlg-topics-link").href = `assuntos.html?materia=${encodeURIComponent(sid)}`;
mountPrefsControls($("#prefs"));

const scheduler = makeScheduler();
let cards = [];                 // fonte local; recarregada do Firestore ao abrir e após importações
let topics = [];                // árvore de assuntos
const byId = () => new Map(cards.map((c) => [c.id, c]));
const tagOf = (c) => pathToText(cardPath(c, buildTree(topics).byId));
const presetTopic = params.get("assunto") || "";   // ?assunto=<id> abre a revisão já filtrada

// Filtra cartões por assunto: "" = todos, NONE = sem assunto, id = o assunto e todos os subassuntos.
function filterByTopic(list, sel) {
  if (!sel) return list;
  const ids = new Set(topics.map((t) => t.id));
  if (sel === NONE) return list.filter((c) => !c.topicId || !ids.has(c.topicId));
  const set = descendantIds(sel, topics);
  return list.filter((c) => set.has(c.topicId));
}
function fillTopicSelects() {
  for (const [id, opts] of [["#r-topic", { allLabel: "Todos os assuntos", noneLabel: "Sem assunto" }], ["#f-topic", { allLabel: "Todos os assuntos", noneLabel: "Sem assunto" }]]) {
    const cur = $(id).value;
    $(id).innerHTML = topicSelectOptions(topics, opts);
    $(id).value = [...$(id).options].some((o) => o.value === cur) ? cur : "";
  }
}
const sessionPool = () => filterByTopic(cards, $("#r-topic").value);

function renderMigrate() {
  const legacy = cards.filter((c) => !c.topicId && (c.topic || c.subtopic));
  const box = $("#migrate-box");
  if (!legacy.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="banner warn"><b>${legacy.length} cartão(ões)</b> usam o assunto/subtópico antigo (texto). Converta para a nova estrutura em árvore.
    <div class="row" style="margin-top:.5rem"><button id="mig-go" class="primary">Converter agora</button></div></div>`;
  $("#mig-go").onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await migrateLegacyTopics(sid, cards); toast(`${r.migrated} cartão(ões) convertido(s); ${r.createdTopics} assunto(s) criado(s).`); await loadCards(); }
    catch (err) { toast(friendlyError(err), "error", 8000); showBanner($("#banner"), friendlyError(err)); e.target.disabled = false; }
  };
}

// ---------- Abas ----------
const tabs = { review: "#view-review", cards: "#view-cards", backup: "#view-backup" };
function showTab(name) {
  for (const [k, sel] of Object.entries(tabs)) {
    $(sel).hidden = k !== name;
    $(`#tab-${k}`).setAttribute("aria-selected", String(k === name));
  }
  if (name === "cards") renderCards();
}
Object.keys(tabs).forEach((k) => ($(`#tab-${k}`).onclick = () => {
  if (k !== "review" && session.active && !confirm("Há uma sessão em andamento. O que já foi avaliado está salvo. Sair da revisão?")) return;
  if (k !== "review" && session.active) endSession();
  showTab(k);
}));

// ---------- Carregamento ----------
async function loadCards() {
  $("#home-msg").innerHTML = '<span class="spinner"></span> Carregando cartões…';
  $("#btn-start").disabled = true;
  try {
    [cards, topics] = await Promise.all([listCards(sid), listTopics(sid)]);
    showBanner($("#banner"), "");
  } catch (e) {
    showBanner($("#banner"), friendlyError(e));
    $("#home-msg").textContent = "Falha ao carregar. Verifique a conexão.";
    $("#home-stats").innerHTML = `<div class="empty">Não foi possível carregar os cartões.<br><button id="btn-retry">Tentar novamente</button></div>`;
    $("#btn-retry").onclick = loadCards;
    return false;
  }
  fillTopicSelects();
  if (presetTopic && !loadCards.presetDone) { loadCards.presetDone = true; if ([...$("#r-topic").options].some((o) => o.value === presetTopic)) $("#r-topic").value = presetTopic; }
  renderMigrate(); renderHome(); renderCards();
  return true;
}

function renderHome() {
  const pool = sessionPool();
  const c = countCards(pool, new Date());
  const newLimit = getPrefs().newPerSession;
  const queue = buildQueue(pool, new Date(), newLimit);
  const stat = (n, l) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`;
  $("#home-stats").innerHTML = stat(c.total, "Cartões") + stat(c.new, "Novos") + stat(c.learning, "Aprendizagem") + stat(c.review, "Revisão") +
    stat(c.dueNow, "Devidos agora") + stat(c.overdue, "Vencidos") + stat(c.dueToday, "Previstos hoje") + stat(c.suspended, "Suspensos");
  $("#btn-start").disabled = queue.length === 0;
  $("#home-msg").textContent = !cards.length ? "Nenhum cartão ainda. Crie o primeiro na aba Cartões."
    : queue.length ? `${queue.length} cartão(ões) na sessão (limite de novos: ${newLimit}).` : (pool.length ? "Nenhuma revisão pendente. Bom trabalho!" : "Nenhum cartão neste assunto.");
}

// ---------- Sessão de revisão ----------
const session = { active: false, queue: [], done: 0, total: 0, current: null, preview: null, shownAt: 0, hiddenDuring: false, busy: false, events: [] };
document.addEventListener("visibilitychange", () => { if (document.hidden && session.active) session.hiddenDuring = true; });

function startSession() {
  const ids = buildQueue(sessionPool(), new Date(), getPrefs().newPerSession);
  if (!ids.length) return;
  Object.assign(session, { active: true, queue: ids, done: 0, total: ids.length, current: null, preview: null, busy: false, events: [], startedAt: Date.now() });
  $("#review-home").hidden = true; $("#review-summary").hidden = true; $("#review-session").hidden = false;
  nextCard();
}

function nextCard() {
  const map = byId();
  const id = session.queue.shift();
  if (!id) return finishSession();
  session.current = map.get(id);
  if (!session.current) return nextCard();
  session.preview = null; session.busy = false; session.hiddenDuring = document.hidden; session.shownAt = performance.now();
  const c = session.current;
  const tag = tagOf(c);
  $("#flash").innerHTML = `${tag ? `<span class="tag">${escapeHtml(tag)}</span>` : ""}${renderRichText(c.front)}`;
  $("#btn-show").hidden = false; $("#btn-show").disabled = false; $("#rate").hidden = true; $("#sess-msg").textContent = "";
  $("#sess-state").textContent = STATE_NAMES[c.fsrs.state];
  updateProgress();
}

function updateProgress() {
  const remaining = session.queue.length + (session.current ? 1 : 0);
  $("#sess-progress").textContent = `Concluídos ${session.done} · Restantes ${remaining}`;
  $("#sess-bar").style.width = `${Math.min(100, (session.done / Math.max(1, session.done + remaining)) * 100)}%`;
}

function reveal() {
  if (!session.current || session.preview) return;
  const now = new Date();
  session.preview = previewReview(scheduler, session.current, now);
  const c = session.current;
  const tag = tagOf(c);
  $("#flash").innerHTML = `${tag ? `<span class="tag">${escapeHtml(tag)}</span>` : ""}${renderRichText(c.front)}<hr>${renderRichText(c.back)}`;
  $("#rate").innerHTML = Grades.map((g) => `<button class="r${g}" data-g="${g}">${RATING_NAMES[g]}<small>${formatInterval(now, session.preview[g].due)}</small></button>`).join("");
  $("#rate").hidden = false; $("#btn-show").hidden = true;
  $$("#rate button").forEach((b) => (b.onclick = () => rate(Number(b.dataset.g))));
}

async function rate(g) {
  if (session.busy || !session.preview) return;       // trava contra clique duplo
  session.busy = true;
  $$("#rate button").forEach((b) => (b.disabled = true));
  $("#sess-msg").innerHTML = '<span class="spinner"></span> Salvando…';
  let duration = Math.round(performance.now() - session.shownAt);
  if (session.hiddenDuring || duration > 10 * 60 * 1000) duration = null;   // só tempo confiável
  try {
    const { card, event } = await recordReview(sid, session.current, session.preview[g], duration);
    const idx = cards.findIndex((x) => x.id === card.id);
    if (idx >= 0) cards[idx] = card;
    session.events.push(event);
    session.done++;
    // Cartão em (re)aprendizagem com nova data nos próximos 20 min volta ao fim da fila desta sessão.
    if ((card.fsrs.state === 1 || card.fsrs.state === 3) && new Date(card.due) - Date.now() <= 20 * 60 * 1000) session.queue.push(card.id);
    session.current = null;
    nextCard();
  } catch (e) {
    // NÃO avança: o cartão continua na tela e nada foi gravado.
    session.busy = false;
    $$("#rate button").forEach((b) => (b.disabled = false));
    $("#sess-msg").textContent = "";
    const msg = friendlyError(e);
    toast(msg, "error", 7000);
    showBanner($("#banner"), msg);
    if (e instanceof AppError && (e.code === "conflict" || e.code === "not-found")) {
      session.busy = true; $$("#rate button").forEach((b) => (b.disabled = true));
      $("#sess-msg").innerHTML = '<button class="small" id="btn-reload">Recarregar cartões</button>';
      $("#btn-reload").onclick = async () => { endSession(); await loadCards(); };
    }
  }
}

function endSession() {
  session.active = false; session.current = null;
  $("#review-session").hidden = true; $("#review-home").hidden = false;
  renderHome();
}

function finishSession() {
  session.active = false;
  $("#review-session").hidden = true;
  const m = reviewMetrics(session.events);
  const box = $("#review-summary");
  box.hidden = false;
  box.innerHTML = `<div class="panel"><h2 style="margin-top:0">Sessão concluída</h2>
    <div class="stats">
      <div class="stat"><b>${m.total}</b><span>Avaliações</span></div>
      <div class="stat"><b>${m.again}</b><span>De novo</span></div><div class="stat"><b>${m.hard}</b><span>Difícil</span></div>
      <div class="stat"><b>${m.good}</b><span>Bom</span></div><div class="stat"><b>${m.easy}</b><span>Fácil</span></div>
      <div class="stat"><b>${formatPct(m.accuracy)}</b><span>Taxa de acerto</span></div>
      <div class="stat"><b>${formatDuration(m.studyMs)}</b><span>Tempo medido</span></div>
    </div><div class="row" style="margin-top:1rem"><button id="btn-back" class="primary">Voltar</button></div></div>`;
  $("#btn-back").onclick = () => { box.hidden = true; $("#review-home").hidden = false; renderHome(); };
}

$("#btn-start").onclick = startSession;
$("#btn-show").onclick = reveal;
$("#btn-end").onclick = () => {
  if (session.done === 0 && !confirm("Encerrar sem avaliar nenhum cartão?")) return;
  const had = session.events.length;
  session.active = false; session.current = null;
  if (had) { session.queue = []; finishSession(); } else endSession();
};
document.addEventListener("keydown", (e) => {
  if (!session.active || !session.current || e.target.closest("input,textarea,select,dialog")) return;
  if (!session.preview && (e.key === " " || e.key === "Enter")) { e.preventDefault(); reveal(); }
  else if (session.preview && ["1", "2", "3", "4"].includes(e.key)) rate(Number(e.key));
});

// ---------- Lista / gerenciamento de cartões ----------
function filteredCards() {
  const q = normalizeText($("#f-search").value), status = $("#f-status").value;
  return filterByTopic(cards, $("#f-topic").value).filter((c) => {
    if (q && !normalizeText(`${c.front} ${c.back}`).includes(q)) return false;
    if (status === "history") return c.reviewCount > 0;
    if (status && classifyCard(c) !== status) return false;
    return true;
  });
}

function renderCards() {
  const list = filteredCards();
  $("#cards-count").textContent = `${list.length} de ${cards.length} cartão(ões)`;
  if (!cards.length) { $("#cards-list").innerHTML = `<div class="empty">Nenhum cartão nesta disciplina ainda.</div>`; return; }
  if (!list.length) { $("#cards-list").innerHTML = `<div class="empty">Nenhum cartão corresponde aos filtros.</div>`; return; }
  $("#cards-list").innerHTML = list.slice(0, 300).map((c) => {
    const k = classifyCard(c);
    const badge = k === "new" ? '<span class="badge new">Novo</span>' : k === "suspended" ? '<span class="badge susp">Suspenso</span>' : `<span class="badge">${STATE_NAMES[c.fsrs.state]}</span>`;
    const due = k === "new" || k === "suspended" ? "" : ` · próxima: ${new Date(c.due).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`;
    const tag = tagOf(c);
    return `<div class="card-item" data-id="${escapeHtml(c.id)}">
      <div class="front">${escapeHtml(c.front)}</div>
      <div class="meta">${badge}${tag ? escapeHtml(tag) + " · " : ""}${c.reviewCount} revisão(ões)${due}</div>
      <div class="row"><button class="small" data-act="edit">Editar</button>
      <button class="small" data-act="susp">${c.suspended ? "Reativar" : "Suspender"}</button>
      <button class="small danger" data-act="del">Excluir</button></div></div>`;
  }).join("") + (list.length > 300 ? `<p class="muted">Mostrando 300 de ${list.length}. Refine a pesquisa.</p>` : "");
}

$("#f-search").oninput = debounce(renderCards, 150);
$("#f-topic").onchange = renderCards;
$("#r-topic").onchange = renderHome;
$("#f-status").onchange = renderCards;

$("#cards-list").onclick = async (ev) => {
  const btn = ev.target.closest("button[data-act]"); if (!btn) return;
  const id = btn.closest(".card-item").dataset.id;
  const card = byId().get(id); if (!card) return;
  const act = btn.dataset.act;
  btn.disabled = true;
  try {
    if (act === "edit") openDialog(card);
    else if (act === "susp") {
      await setSuspended(sid, id, !card.suspended);
      card.suspended = !card.suspended;
      toast(card.suspended ? "Cartão suspenso." : "Cartão reativado."); renderCards(); renderHome();
    } else if (act === "del") {
      if (!confirm(`Excluir este cartão?\n\n"${card.front.slice(0, 120)}"\n\nO histórico de revisões dele é mantido para as estatísticas. Esta ação não pode ser desfeita.`)) return;
      await deleteCard(sid, id);
      cards = cards.filter((c) => c.id !== id);
      toast("Cartão excluído."); renderCards(); renderHome();
    }
  } catch (e) { toast(friendlyError(e), "error", 7000); showBanner($("#banner"), friendlyError(e)); }
  finally { btn.disabled = false; }
};

// ---------- Diálogo de cartão ----------
let editing = null, saving = false;
function openDialog(card = null) {
  editing = card;
  $("#dlg-title").textContent = card ? "Editar cartão" : "Novo cartão";
  $("#c-front").value = card?.front ?? ""; $("#c-back").value = card?.back ?? "";
  $("#c-topic").innerHTML = topicSelectOptions(topics, { noneLabel: "Sem assunto" });
  const known = new Set(topics.map((t) => t.id)), fsel = $("#f-topic").value;
  $("#c-topic").value = card ? (card.topicId && known.has(card.topicId) ? card.topicId : NONE) : (known.has(fsel) ? fsel : NONE);
  $("#c-newpath").value = "";
  $("#c-reset").checked = false; $("#reset-wrap").hidden = !card;
  $("#dlg-error").hidden = true; $("#dlg-save").disabled = false; saving = false;
  $("#dlg-card").showModal();
}
$("#btn-new").onclick = () => openDialog();
$("#dlg-cancel").onclick = () => $("#dlg-card").close();
$("#card-form").onsubmit = async (ev) => {
  ev.preventDefault();
  if (saving) return; saving = true; $("#dlg-save").disabled = true;
  const input = { front: $("#c-front").value, back: $("#c-back").value, topicId: $("#c-topic").value === NONE ? null : $("#c-topic").value };
  const fail = (m) => { const el = $("#dlg-error"); el.textContent = m; el.hidden = false; saving = false; $("#dlg-save").disabled = false; };
  try {
    const newPath = parsePathString($("#c-newpath").value);
    if (newPath.length) {                         // caminho novo digitado: cria/reaproveita os assuntos antes de salvar o cartão
      const r = await ensurePaths(sid, [newPath]);
      topics = r.topics; input.topicId = [...r.idByPath.values()][0]; fillTopicSelects();
    }
    const dup = findDuplicateFront(cards, input.front, editing?.id);
    if (dup && !confirm("Já existe um cartão com a mesma frente nesta disciplina. Salvar mesmo assim?")) { saving = false; $("#dlg-save").disabled = false; return; }
    if (editing) {
      if ($("#c-reset").checked && !confirm("Reiniciar o agendamento deste cartão? Ele voltará a ser novo (o histórico de revisões é mantido).")) { saving = false; $("#dlg-save").disabled = false; return; }
      const updated = await updateCard(sid, editing.id, input, { resetSchedule: $("#c-reset").checked });
      cards[cards.findIndex((c) => c.id === editing.id)] = updated;
      toast("Cartão atualizado.");
    } else {
      cards.push(await createCard(sid, input));
      toast("Cartão criado.");
    }
    $("#dlg-card").close(); renderCards(); renderHome();
  } catch (e) { fail(friendlyError(e)); }
};

// ---------- Backup ----------
async function doExport(fn, name, ext, mime) {
  try { const data = await fn(sid); download(`${sid}-${name}-${stamp()}.${ext}`, typeof data === "string" ? data : JSON.stringify(data, null, 2), mime); toast("Arquivo gerado."); }
  catch (e) { toast(friendlyError(e), "error", 7000); }
}
$("#exp-full").onclick = () => doExport(exportFull, "backup-completo", "json", "application/json");
$("#exp-cards").onclick = () => doExport(exportCards, "cartoes", "json", "application/json");
$("#exp-csv").onclick = () => doExport(exportCardsCSV, "cartoes", "csv", "text/csv");

$("#imp-file").onchange = async (ev) => {
  const file = ev.target.files[0]; const box = $("#imp-preview"); box.innerHTML = "";
  if (!file) return;
  try {
    const text = await readFileText(file);
    if (/\.csv$/i.test(file.name)) return await previewCSV(text, box);
    let parsed; try { parsed = JSON.parse(text); } catch { throw new AppError("O arquivo não é um JSON válido. Nada foi importado."); }
    await previewJSON(parsed, box, false);
  } catch (e) { showBanner(box, friendlyError(e)); }
};

async function previewCSV(text, box) {
  const plan = await planCSVImport(sid, text);
  if (plan.errors.length) { showBanner(box, `CSV com problemas; nada será importado:\n${plan.errors.slice(0, 8).join("\n")}${plan.errors.length > 8 ? `\n… e mais ${plan.errors.length - 8}` : ""}`); return; }
  if (plan.topicErrors.length) { showBanner(box, `Assuntos inválidos; nada será importado:\n${plan.topicErrors.slice(0, 8).join("\n")}`); return; }
  box.innerHTML = `<div class="banner warn">${plan.fresh.length} cartão(ões) novo(s) e ${plan.newTopics.length} assunto(s) novo(s) serão criados (${plan.dupDb + plan.dupFile} frente(s) repetida(s) ignorada(s)).</div><button id="imp-go" class="primary" ${plan.fresh.length ? "" : "disabled"}>Confirmar importação</button>`;
  $("#imp-go").onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await importCSV(sid, text); toast(`${r.imported} importado(s), ${r.skipped} ignorado(s) por duplicidade; ${r.createdTopics} assunto(s) criado(s).`); box.innerHTML = ""; await loadCards(); }
    catch (err) { toast(friendlyError(err), "error", 8000); showBanner(box, friendlyError(err)); }
  };
}

async function previewJSON(parsed, box, overwrite) {
  const { plan } = await previewBackupImport(sid, parsed, { overwrite });
  if (plan.fatal.length) { showBanner(box, plan.fatal.join("\n")); return; }
  const lines = [`Novos assuntos: ${plan.newTopics.length} (juntados a assuntos iguais já existentes: ${plan.mergedTopics})`, `Novos cartões: ${plan.newCards.length}`, `Cartões já existentes (mesmo id): ${plan.conflicts.length + plan.overwrites.length}`,
    `Eventos de histórico novos: ${plan.newEvents.length} (já existentes ignorados: ${plan.skippedEvents})`];
  if (plan.orphanEvents.length) lines.push(`Aviso: ${plan.orphanEvents.length} evento(s) de cartões que não existem (mantidos para estatística).`);
  const bad = [...plan.invalidTopics, ...plan.invalidCards, ...plan.invalidEvents];
  const writeCount = plan.newCards.length + plan.overwrites.length + plan.newEvents.length + plan.newTopics.length;
  box.innerHTML = `<div class="banner ${plan.ok ? "warn" : "error"}">${lines.map(escapeHtml).join("<br>")}
    ${bad.length ? `<br><b>${bad.length} item(ns) inválido(s) — importação bloqueada:</b><br>${bad.slice(0, 6).map((b) => escapeHtml(`#${b.index} ${b.id ?? ""}: ${b.errors.join("; ")}`)).join("<br>")}` : ""}</div>
    ${plan.conflicts.length + plan.overwrites.length ? `<label class="inline"><input type="checkbox" id="imp-over" ${overwrite ? "checked" : ""}> Sobrescrever os cartões existentes com o conteúdo e agendamento do arquivo</label>` : ""}
    <div class="row" style="margin-top:.5rem"><button id="imp-go" class="primary" ${plan.ok && writeCount ? "" : "disabled"}>Confirmar importação</button></div>`;
  const over = $("#imp-over");
  if (over) over.onchange = () => {
    if (over.checked && !confirm("Sobrescrever substitui texto e agendamento dos cartões existentes pelos do arquivo. Faça um backup completo antes. Continuar?")) { over.checked = false; return; }
    previewJSON(parsed, box, over.checked).catch((e) => showBanner(box, friendlyError(e)));
  };
  $("#imp-go").onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await applyBackupImport(sid, plan); toast(`Importado: ${r.cards} cartão(ões), ${r.events} evento(s).`); box.innerHTML = ""; $("#imp-file").value = ""; await loadCards(); }
    catch (err) { toast(friendlyError(err), "error", 8000); showBanner(box, friendlyError(err)); }
  };
}

// ---------- Início ----------
showTab("review");
loadCards();
