// Camada de dados (Firestore). Genérica: recebe o id da disciplina e usa
//   subjects/{id}/cards/{cardId}
//   subjects/{id}/review_events/{eventId}
//   subjects/{id}/topics/{topicId}        (árvore de assuntos: name, parentId, order)
// Nada aqui depende de uma disciplina específica.
//
// Regras de consistência:
//  - TODA escrita usa runTransaction. Ao contrário de setDoc/writeBatch (que ficam em fila e "parecem"
//    concluídos offline), uma transação só resolve após confirmação do servidor e falha se estiver offline.
//  - A revisão grava cartão + evento na MESMA transação, com verificação de reviewCount (concorrência
//    otimista) para impedir revisão duplicada (clique duplo, dois dispositivos).
//  - Operações em lote (mover cartões, migrar, apagar) rodam em blocos; cada bloco é atômico. Se a rede cair
//    no meio, os blocos anteriores já estão gravados e o erro informa isso; repetir a operação é seguro.
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, doc, getDocs, getCountFromServer, runTransaction, query, orderBy, where,
} from "firebase/firestore";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";
import { SUBJECTS, getSubject } from "../config/subjects.js";
import {
  validateCardInput, newId, toISO, buildBackup, normalizeText, planBackupImport, csvToCardInputs, toCSV,
  SCHEMA_VERSION, TOPIC_LIMITS, buildTree, topicPath, flattenTree, descendantIds, validateTopicName, validateMove,
  planReorder, planEnsurePaths, planLegacyMigration, pathKey, pathToText,
} from "./model.js";
import { buildNewCardDoc, buildReviewWrite, emptyFsrsState, derivedFields } from "./fsrs.js";

export class AppError extends Error {
  constructor(message, code = "app") { super(message); this.code = code; }
}

let _db = null;
export function getDb() {
  if (!isFirebaseConfigured()) throw new AppError("Firebase ainda não configurado. Preencha js/firebase-config.js (veja o README).", "not-configured");
  if (!_db) _db = getFirestore(initializeApp(firebaseConfig));
  return _db;
}

export function requireSubject(id) {
  const s = getSubject(id);
  if (!s) throw new AppError(`Disciplina desconhecida: "${id}". Verifique config/subjects.js.`, "unknown-subject");
  return s;
}

const cardsCol = (sid) => collection(getDb(), "subjects", sid, "cards");
const eventsCol = (sid) => collection(getDb(), "subjects", sid, "review_events");
const topicsCol = (sid) => collection(getDb(), "subjects", sid, "topics");
const cardRef = (sid, id) => doc(getDb(), "subjects", sid, "cards", id);
const eventRef = (sid, id) => doc(getDb(), "subjects", sid, "review_events", id);
const topicRef = (sid, id) => doc(getDb(), "subjects", sid, "topics", id);

export function friendlyError(e) {
  if (e instanceof AppError) return e.message;
  const code = e?.code || "";
  if (code.includes("unavailable") || /offline|network|Failed to get/i.test(e?.message || ""))
    return "Sem conexão com o servidor. Nada foi salvo (operações em lote podem ter gravado blocos anteriores; confira antes de repetir). Verifique a internet.";
  if (code.includes("permission-denied")) return "O Firestore recusou a operação (regras de segurança). Verifique firestore.rules.";
  if (code.includes("deadline-exceeded") || code === "timeout") return "O servidor demorou demais para responder. Nada foi confirmado; confira e tente novamente.";
  if (code.includes("aborted") || code.includes("failed-precondition")) return "Conflito ao salvar. Recarregue a página e tente novamente.";
  if (code.includes("resource-exhausted")) return "Cota do Firebase esgotada por hoje. Tente novamente mais tarde.";
  return `Erro inesperado: ${e?.message || e}`;
}

function withTimeout(promise, ms = 20000) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error("Tempo esgotado"), { code: "timeout" })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Executa `writeFn(tx, item)` para cada item, em transações de até `size` itens.
async function writeChunks(items, writeFn, size = 200) {
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    await withTimeout(runTransaction(getDb(), async (tx) => { chunk.forEach((it) => writeFn(tx, it)); }), 60000);
  }
}

// ---------- Leitura ----------
export async function listCards(sid) {
  requireSubject(sid);
  const snap = await withTimeout(getDocs(cardsCol(sid)));
  return snap.docs.map((d) => ({ ...d.data(), id: d.id })).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

export async function listTopics(sid) {
  requireSubject(sid);
  const snap = await withTimeout(getDocs(topicsCol(sid)));
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}

export async function listEvents(sid, { fromISO = null, toISOExclusive = null } = {}) {
  requireSubject(sid);
  const parts = [];
  if (fromISO) parts.push(where("reviewedAt", ">=", fromISO));
  if (toISOExclusive) parts.push(where("reviewedAt", "<", toISOExclusive));
  const q = parts.length ? query(eventsCol(sid), ...parts, orderBy("reviewedAt")) : query(eventsCol(sid), orderBy("reviewedAt"));
  const snap = await withTimeout(getDocs(q), 30000);
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}

export async function countEvents(sid) {
  requireSubject(sid);
  const snap = await withTimeout(getCountFromServer(eventsCol(sid)));
  return snap.data().count;
}

// Contagens exatas no servidor (para a página de limpeza).
export async function countData(sid) {
  requireSubject(sid);
  const [c, e, t] = await Promise.all([cardsCol(sid), eventsCol(sid), topicsCol(sid)].map((col) => withTimeout(getCountFromServer(col)).then((s) => s.data().count)));
  return { cards: c, events: e, topics: t };
}

// ---------- Assuntos (árvore) ----------
export async function createTopic(sid, name, parentId, topics, now = new Date()) {
  requireSubject(sid);
  parentId = parentId || null;
  const v = validateTopicName(name, parentId, topics);
  if (!v.ok) throw new AppError(v.errors.join(" "), "validation");
  const { byId } = buildTree(topics);
  if (parentId && !byId.has(parentId)) throw new AppError("Assunto pai não encontrado (talvez excluído em outro dispositivo). Recarregue.", "not-found");
  if ((parentId ? topicPath(parentId, byId).length : 0) + 1 > TOPIC_LIMITS.maxDepth) throw new AppError(`Limite de ${TOPIC_LIMITS.maxDepth} níveis atingido.`, "validation");
  const order = 1 + Math.max(-1, ...topics.filter((t) => (t.parentId ?? null) === parentId).map((t) => t.order ?? 0));
  const iso = toISO(now);
  const node = { id: newId("t"), subject: sid, name: v.value, parentId, order, createdAt: iso, updatedAt: iso, schemaVersion: SCHEMA_VERSION };
  await withTimeout(runTransaction(getDb(), async (tx) => {
    if (parentId && !(await tx.get(topicRef(sid, parentId))).exists()) throw new AppError("Assunto pai não existe mais. Recarregue.", "not-found");
    tx.set(topicRef(sid, node.id), node);
  }));
  return node;
}

export async function renameTopic(sid, id, name, topics, now = new Date()) {
  requireSubject(sid);
  const node = topics.find((t) => t.id === id);
  if (!node) throw new AppError("Assunto não encontrado.", "not-found");
  const v = validateTopicName(name, node.parentId ?? null, topics, id);
  if (!v.ok) throw new AppError(v.errors.join(" "), "validation");
  await withTimeout(runTransaction(getDb(), async (tx) => {
    if (!(await tx.get(topicRef(sid, id))).exists()) throw new AppError("Assunto não existe mais. Recarregue.", "not-found");
    tx.update(topicRef(sid, id), { name: v.value, updatedAt: toISO(now) });
  }));
}

export async function moveTopic(sid, id, newParentId, topics, now = new Date()) {
  requireSubject(sid);
  newParentId = newParentId || null;
  const v = validateMove(id, newParentId, topics);
  if (!v.ok) throw new AppError(v.errors.join(" "), "validation");
  const order = 1 + Math.max(-1, ...topics.filter((t) => (t.parentId ?? null) === newParentId).map((t) => t.order ?? 0));
  await withTimeout(runTransaction(getDb(), async (tx) => {
    if (!(await tx.get(topicRef(sid, id))).exists()) throw new AppError("Assunto não existe mais. Recarregue.", "not-found");
    if (newParentId && !(await tx.get(topicRef(sid, newParentId))).exists()) throw new AppError("Destino não existe mais. Recarregue.", "not-found");
    tx.update(topicRef(sid, id), { parentId: newParentId, order, updatedAt: toISO(now) });
  }));
}

export async function reorderTopic(sid, id, direction, topics) {
  requireSubject(sid);
  const updates = planReorder(id, direction, topics);
  if (!updates.length) return false;
  await withTimeout(runTransaction(getDb(), async (tx) => { updates.forEach((u) => tx.update(topicRef(sid, u.id), { order: u.order })); }));
  return true;
}

// Exclui o assunto e TODOS os subassuntos. Os cartões deles NÃO são apagados: passam para o pai do assunto excluído
// (ou ficam sem assunto, se for raiz). Primeiro move os cartões, depois apaga os nós (estado intermediário sempre válido).
export async function deleteTopic(sid, id, topics, now = new Date()) {
  requireSubject(sid);
  const { byId } = buildTree(topics);
  const node = byId.get(id);
  if (!node) throw new AppError("Assunto não encontrado.", "not-found");
  const ids = descendantIds(id, topics);
  const target = node.parentId && byId.has(node.parentId) ? node.parentId : null;
  const cards = (await listCards(sid)).filter((c) => ids.has(c.topicId));
  const iso = toISO(now);
  await writeChunks(cards, (tx, c) => tx.update(cardRef(sid, c.id), { topicId: target, updatedAt: iso }));
  await writeChunks([...ids], (tx, tid) => tx.delete(topicRef(sid, tid)));
  return { movedCards: cards.length, deletedTopics: ids.size, movedTo: target };
}

// Garante que os caminhos existam (cria o que faltar). Devolve { idByPath(Map pathKey->id), created }.
export async function ensurePaths(sid, paths, now = new Date()) {
  requireSubject(sid);
  const topics = await listTopics(sid);
  const plan = planEnsurePaths(paths, topics, sid, now);
  if (plan.errors.length) throw new AppError(`Assuntos inválidos:\n${plan.errors.slice(0, 8).join("\n")}`, "validation");
  await writeChunks(plan.created, (tx, t) => tx.set(topicRef(sid, t.id), t));
  return { idByPath: plan.idByPath, created: plan.created, topics: plan.topics };
}

export async function moveCards(sid, cardIds, topicId, now = new Date()) {
  requireSubject(sid);
  topicId = topicId || null;
  const iso = toISO(now);
  const size = 200;
  for (let i = 0; i < cardIds.length; i += size) {
    const chunk = cardIds.slice(i, i + size);
    await withTimeout(runTransaction(getDb(), async (tx) => {
      if (topicId && !(await tx.get(topicRef(sid, topicId))).exists()) throw new AppError("O assunto de destino não existe mais. Recarregue.", "not-found");
      chunk.forEach((id) => tx.update(cardRef(sid, id), { topicId, updatedAt: iso }));
    }), 60000);
  }
  return cardIds.length;
}

// Converte assunto/subtópico em texto (versão 1) para a árvore. Só mexe em cartões sem topicId.
export async function migrateLegacyTopics(sid, cards, now = new Date()) {
  requireSubject(sid);
  const plan = planLegacyMigration(cards);
  if (!plan.assignments.length) return { migrated: 0, createdTopics: 0 };
  const { idByPath, created } = await ensurePaths(sid, plan.paths, now);
  const iso = toISO(now);
  await writeChunks(plan.assignments, (tx, a) => tx.update(cardRef(sid, a.cardId), { topicId: idByPath.get(pathKey(a.path)), topic: "", subtopic: "", updatedAt: iso }));
  return { migrated: plan.assignments.length, createdTopics: created.length };
}

// ---------- Escrita de cartões ----------
export function findDuplicateFront(cards, front, ignoreId = null) {
  const n = normalizeText(front);
  return cards.find((c) => c.id !== ignoreId && normalizeText(c.front) === n) || null;
}

export async function createCard(sid, input, now = new Date()) {
  requireSubject(sid);
  const v = validateCardInput(input);
  if (!v.ok) throw new AppError(v.errors.join(" "), "validation");
  const id = newId("c");
  const docData = buildNewCardDoc({ id, subject: sid, input: v.value, now });
  await withTimeout(runTransaction(getDb(), async (tx) => {
    const ref = cardRef(sid, id);
    if (v.value.topicId && !(await tx.get(topicRef(sid, v.value.topicId))).exists()) throw new AppError("O assunto escolhido não existe mais. Recarregue.", "not-found");
    if ((await tx.get(ref)).exists()) throw new AppError("Id de cartão já existe.", "duplicate");
    tx.set(ref, docData);
  }));
  return docData;
}

// Editar conteúdo PRESERVA o agendamento. `resetSchedule` só com pedido explícito (o histórico é mantido).
export async function updateCard(sid, id, input, { resetSchedule = false, now = new Date() } = {}) {
  requireSubject(sid);
  const v = validateCardInput(input);
  if (!v.ok) throw new AppError(v.errors.join(" "), "validation");
  let result;
  await withTimeout(runTransaction(getDb(), async (tx) => {
    const ref = cardRef(sid, id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new AppError("Cartão não encontrado (talvez excluído em outro dispositivo).", "not-found");
    if (v.value.topicId && !(await tx.get(topicRef(sid, v.value.topicId))).exists()) throw new AppError("O assunto escolhido não existe mais. Recarregue.", "not-found");
    const cur = snap.data();
    // topic/subtopic (texto antigo) são zerados: o assunto agora é só o topicId.
    const patch = { front: v.value.front, back: v.value.back, topicId: v.value.topicId, topic: "", subtopic: "", updatedAt: toISO(now) };
    if (resetSchedule) { const f = emptyFsrsState(now); Object.assign(patch, { fsrs: f, ...derivedFields(f, cur.reviewCount) }); }
    tx.update(ref, patch);
    result = { ...cur, ...patch, id };
  }));
  return result;
}

export async function setSuspended(sid, id, suspended, now = new Date()) {
  requireSubject(sid);
  await withTimeout(runTransaction(getDb(), async (tx) => {
    const ref = cardRef(sid, id);
    if (!(await tx.get(ref)).exists()) throw new AppError("Cartão não encontrado.", "not-found");
    tx.update(ref, { suspended: !!suspended, updatedAt: toISO(now) });
  }));
}

// Exclui APENAS o cartão. O histórico de revisões é preservado.
export async function deleteCard(sid, id) {
  requireSubject(sid);
  await withTimeout(runTransaction(getDb(), async (tx) => { tx.delete(cardRef(sid, id)); }));
}

// ---------- Revisão (atômica) ----------
export async function recordReview(sid, cardDoc, chosen, durationMs = null) {
  requireSubject(sid);
  const { event, cardUpdate, expectedReviewCount } = buildReviewWrite({ cardDoc, chosen, durationMs });
  await withTimeout(runTransaction(getDb(), async (tx) => {
    const ref = cardRef(sid, cardDoc.id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new AppError("Cartão não existe mais. Nada foi registrado.", "not-found");
    if (snap.data().reviewCount !== expectedReviewCount)
      throw new AppError("Este cartão já foi revisado em outro lugar. Nada foi registrado; recarregue.", "conflict");
    tx.update(ref, cardUpdate);
    tx.set(eventRef(sid, event.id), event);
  }));
  return { card: { ...cardDoc, ...cardUpdate }, event };
}

// ---------- Exportação / importação ----------
export async function exportCards(sid) {
  const [cards, topics] = await Promise.all([listCards(sid), listTopics(sid)]);
  return buildBackup({ subject: sid, cards, topics, kind: "cards" });
}
export async function exportFull(sid) {
  const [cards, events, topics] = await Promise.all([listCards(sid), listEvents(sid), listTopics(sid)]);
  return buildBackup({ subject: sid, cards, events, topics, kind: "full" });
}
export async function exportCardsCSV(sid) {
  const [cards, topics] = await Promise.all([listCards(sid), listTopics(sid)]);
  const { byId } = buildTree(topics);
  const pathOf = (c) => (c.topicId && byId.has(c.topicId) ? topicPath(c.topicId, byId) : [c.topic, c.subtopic].filter(Boolean));
  return toCSV([["frente", "verso", "assunto", "subtopico"], ...cards.map((c) => [c.front, c.back, pathToText(pathOf(c), " > "), ""])]);
}

export async function previewBackupImport(sid, parsed, { overwrite = false } = {}) {
  const [cards, events, topics] = await Promise.all([listCards(sid), listEvents(sid), listTopics(sid)]);
  return { plan: planBackupImport(parsed, sid, cards, new Set(events.map((e) => e.id)), { overwrite, existingTopics: topics }), cards };
}

// Só grava se o plano estiver ok (sem itens inválidos). Ordem: assuntos -> cartões -> eventos.
export async function applyBackupImport(sid, plan) {
  requireSubject(sid);
  if (!plan.ok) throw new AppError("A importação contém itens inválidos e não foi aplicada.", "validation");
  const cards = [...plan.newCards, ...plan.overwrites];
  await writeChunks(plan.newTopics, (tx, t) => tx.set(topicRef(sid, t.id), { ...t, subject: sid }));
  await writeChunks(cards, (tx, c) => tx.set(cardRef(sid, c.id), { ...c, subject: sid }));
  await writeChunks(plan.newEvents, (tx, e) => tx.set(eventRef(sid, e.id), { ...e, subject: sid }));
  return { cards: cards.length, events: plan.newEvents.length, topics: plan.newTopics.length };
}

// Planeja a importação de CSV/texto (sem gravar): usada pela prévia e pela importação, para não divergirem.
// defaults.path = caminho padrão (lista de nomes) para linhas sem assunto.
export async function planCSVImport(sid, text, defaults = {}) {
  requireSubject(sid);
  const parsed = csvToCardInputs(text, defaults);
  if (parsed.errors.length) return { errors: parsed.errors, fresh: [], dupDb: 0, dupFile: 0, newTopics: [], topicErrors: [] };
  const [existing, topics] = await Promise.all([listCards(sid), listTopics(sid)]);
  const known = new Set(existing.map((c) => normalizeText(c.front)));
  const fresh = []; let dupDb = 0, dupFile = 0;
  const seen = new Set();
  for (const inp of parsed.inputs) {
    const n = normalizeText(inp.front);
    if (known.has(n)) dupDb++; else if (seen.has(n)) dupFile++; else { seen.add(n); fresh.push(inp); }
  }
  const plan = planEnsurePaths(fresh.map((f) => f.path).filter((p) => p.length), topics, sid);
  return { errors: [], fresh, dupDb, dupFile, newTopics: plan.created, topicErrors: plan.errors };
}

// Importa cartões novos (sem agendamento) criando os assuntos que faltarem.
export async function importCSV(sid, text, now = new Date(), defaults = {}) {
  requireSubject(sid);
  const plan = await planCSVImport(sid, text, defaults);
  if (plan.errors.length) throw new AppError(`Nada foi importado:\n${plan.errors.slice(0, 10).join("\n")}`, "validation");
  if (plan.topicErrors.length) throw new AppError(`Assuntos inválidos, nada foi importado:\n${plan.topicErrors.slice(0, 8).join("\n")}`, "validation");
  const paths = plan.fresh.map((f) => f.path).filter((p) => p.length);
  const { idByPath, created } = paths.length ? await ensurePaths(sid, paths, now) : { idByPath: new Map(), created: [] };
  const docs = plan.fresh.map((inp) => buildNewCardDoc({ id: newId("c"), subject: sid, input: { front: inp.front, back: inp.back, topicId: inp.path.length ? idByPath.get(pathKey(inp.path)) : null }, now }));
  await writeChunks(docs, (tx, c) => tx.set(cardRef(sid, c.id), c));
  return { imported: docs.length, skipped: plan.dupDb + plan.dupFile, createdTopics: created.length };
}

// ---------- Apagar dados (página limpar.html) ----------
// scope: { cards, events, topics } (booleanos). onProgress(rotulo, feitos, total).
// Se os assuntos forem apagados e os cartões mantidos, os cartões ficam "sem assunto" (topicId = null).
export async function resetData(sid, scope, onProgress = () => {}) {
  requireSubject(sid);
  const done = { cards: 0, events: 0, topics: 0, detached: 0 };
  const idsOf = async (col) => (await withTimeout(getDocs(col), 60000)).docs.map((d) => d.id);
  if (scope.topics && !scope.cards) {
    const withTopic = (await listCards(sid)).filter((c) => c.topicId);
    let n = 0;
    await writeChunks(withTopic, (tx, c) => { tx.update(cardRef(sid, c.id), { topicId: null, updatedAt: toISO() }); }, 200);
    n = withTopic.length; done.detached = n; onProgress("cartões sem assunto", n, n);
  }
  const steps = [["cards", "cartões", cardsCol, cardRef], ["events", "histórico", eventsCol, eventRef], ["topics", "assuntos", topicsCol, topicRef]];
  for (const [key, label, colFn, refFn] of steps) {
    if (!scope[key]) continue;
    const ids = await idsOf(colFn(sid));
    onProgress(label, 0, ids.length);
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      await withTimeout(runTransaction(getDb(), async (tx) => { chunk.forEach((id) => tx.delete(refFn(sid, id))); }), 60000);
      done[key] += chunk.length; onProgress(label, done[key], ids.length);
    }
  }
  return done;
}

export { SUBJECTS, flattenTree };
