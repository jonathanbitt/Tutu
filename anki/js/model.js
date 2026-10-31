// Funções PURAS (sem Firebase, sem DOM): validação, datas, classificação, texto, CSV, importação.
// Podem ser testadas em Node. Convenção de datas: TODO instante é guardado como string
// ISO-8601 em UTC (ex.: "2026-10-23T13:05:00.000Z"). Essas strings ordenam
// cronologicamente de forma lexicográfica, o que permite consultas por intervalo no Firestore.
// A conversão para o dia LOCAL do usuário acontece apenas na hora de apresentar/agrupar.

export const SCHEMA_VERSION = 2;          // 2 = árvore de assuntos (topicId). 1 = assuntos como texto.
export const SUPPORTED_SCHEMAS = [1, 2];
export const RATING_NAMES = { 1: "De novo", 2: "Difícil", 3: "Bom", 4: "Fácil" };
export const STATE_NAMES = { 0: "Novo", 1: "Aprendizagem", 2: "Revisão", 3: "Reaprendizagem" };
export const LIMITS = { text: 20000, topic: 120 };

// ---------- Datas ----------
export function toISO(d = new Date()) { return new Date(d).toISOString(); }

// "YYYY-MM-DD" do dia local (fuso do navegador, ou do `timeZone` informado, ex.: "America/Sao_Paulo").
export function dayKey(iso, timeZone) {
  const d = new Date(iso);
  if (timeZone) return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Início (00:00) e fim (início do dia seguinte) do dia local contendo `d`.
export function localDayBounds(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return { start, end };
}

// Converte "YYYY-MM-DD" (dia local) em Date local às 00:00.
export function parseDayKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function weekKey(key) { // segunda-feira da semana do dia local
  const d = parseDayKey(key);
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift);
  return dayKey(d.toISOString());
}
export function monthKey(key) { return key.slice(0, 7); }

// ---------- Classificação de cartões ----------
export function classifyCard(card) {
  if (card.suspended) return "suspended";
  const st = card.fsrs?.state ?? 0;
  if (st === 0) return "new";
  if (st === 2) return "review";
  return "learning"; // 1 = aprendizagem, 3 = reaprendizagem
}

export function isDue(card, now = new Date()) {
  return !card.suspended && (card.fsrs?.state ?? 0) !== 0 && card.due <= toISO(now);
}

// ---------- Fila de revisão ----------
// Cartões devidos (data <= agora), do mais antigo ao mais recente, seguidos de até `newLimit` cartões novos
// na ordem de criação. Suspensos nunca entram. Só cartões efetivamente avaliados saem do estado "novo".
export function buildQueue(cards, now = new Date(), newLimit = 20) {
  const due = cards.filter((c) => isDue(c, now)).sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.id < b.id ? -1 : 1));
  const fresh = cards.filter((c) => classifyCard(c) === "new")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, newLimit));
  return [...due, ...fresh].map((c) => c.id);
}

// ---------- Validação ----------
export function validateCardInput(input) {
  const errors = [];
  const front = String(input?.front ?? "").replace(/\r\n/g, "\n").trim();
  const back = String(input?.back ?? "").replace(/\r\n/g, "\n").trim();
  if (!front) errors.push("A frente do cartão é obrigatória.");
  if (!back) errors.push("O verso do cartão é obrigatório.");
  if (front.length > LIMITS.text) errors.push(`A frente excede ${LIMITS.text} caracteres.`);
  if (back.length > LIMITS.text) errors.push(`O verso excede ${LIMITS.text} caracteres.`);
  // Assunto = id de um nó da árvore (ou null = sem assunto). A existência do nó é verificada por quem grava.
  const topicId = input?.topicId ? String(input.topicId) : null;
  if (topicId && (topicId.includes("/") || topicId.length > 60)) errors.push("topicId inválido.");
  // Campos antigos (assunto/subtópico em texto) só são aceitos para ler documentos/backups da versão 1.
  for (const k of ["topic", "subtopic"]) if (String(input?.[k] ?? "").length > LIMITS.topic) errors.push(`${k} excede ${LIMITS.topic} caracteres.`);
  return { ok: errors.length === 0, errors, value: { front, back, topicId } };
}

export function normalizeText(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function newId(prefix = "c") {
  const rnd = (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "");
  return `${prefix}_${rnd.slice(0, 20)}`;
}

// ---------- Texto seguro ----------
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Formatação básica sem aceitar HTML: escapa tudo e só então converte **negrito**, *itálico* e `código`.
// Quebras de linha são preservadas via CSS (white-space: pre-wrap). Nenhuma tag do usuário é interpretada.
export function renderRichText(s) {
  let h = escapeHtml(s);
  h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return h;
}

// ---------- Intervalos legíveis ----------
export function formatInterval(fromDate, toDate) {
  const ms = new Date(toDate) - new Date(fromDate);
  const min = ms / 60000;
  if (min < 1) return "<1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)} h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)} d`;
  const mo = d / 30.4375;
  const fmt = (n) => (Math.round(n * 10) / 10).toString().replace(".", ",");
  if (mo < 12) return `${fmt(mo)} ${fmt(mo) === "1" ? "mês" : "meses"}`;
  const y = d / 365.25;
  return `${fmt(y)} ${fmt(y) === "1" ? "ano" : "anos"}`;
}

// ---------- CSV (separador ; ou , detectado; aspas duplas) ----------
export function toCSV(rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[";,\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(";")).join("\r\n");
}

export function parseCSV(text) {
  const src = String(text).replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0];
  // Separador: tab (colado de planilha), ";" ou ","; vence o mais frequente na 1ª linha (empate: tab > ; > ,).
  const cnt = { "\t": (firstLine.match(/\t/g) || []).length, ";": (firstLine.match(/;/g) || []).length, ",": (firstLine.match(/,/g) || []).length };
  let sep = ",", best = 0;
  for (const s of ["\t", ";", ","]) if (cnt[s] > best) { best = cnt[s]; sep = s; }
  const rows = [];
  let row = [], cur = "", inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (inQ) throw new Error("CSV malformado: aspas não fechadas.");
  row.push(cur);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

// ---------- Árvore de assuntos ----------
// Cada nó: { id, subject, name, parentId|null, order, createdAt, updatedAt, schemaVersion }.
// O "caminho" de um assunto é a lista de nomes da raiz até o nó, ex.: ["Tributos","Impostos","Impostos em espécie"].
export const TOPIC_LIMITS = { name: 120, maxDepth: 8 };
export const PATH_SEP = " › ";

// "A > B › C" -> ["A","B","C"]  (aceita ">" e "›" como separadores de nível)
export function parsePathString(s) {
  return String(s ?? "").split(/[>›]/).map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean);
}
export function pathToText(path, sep = PATH_SEP) { return path.join(sep); }
export function pathKey(path) { return path.map(normalizeText).join("\u0001"); }

export function checkTopicNameFormat(name) {
  const errors = [];
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!n) errors.push("O nome é obrigatório.");
  if (n.length > TOPIC_LIMITS.name) errors.push(`O nome excede ${TOPIC_LIMITS.name} caracteres.`);
  if (/[>›]/.test(n)) errors.push('O nome não pode conter ">" nem "›" (separam os níveis).');
  return { errors, value: n };
}

export function buildTree(topics) {
  const byId = new Map(topics.map((t) => [t.id, t]));
  const children = new Map();                       // parentId|null -> nós ordenados
  for (const t of topics) {
    const p = t.parentId && byId.has(t.parentId) ? t.parentId : null;   // órfão é tratado como raiz
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(t);
  }
  const cmp = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, "pt-BR") || (a.id < b.id ? -1 : 1);
  for (const arr of children.values()) arr.sort(cmp);
  return { byId, children };
}

export function topicPath(id, byId) {
  const out = []; const seen = new Set();
  let cur = id ? byId.get(id) : null;
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : null; }
  return out;
}

// Lista em ordem de árvore (pai antes dos filhos): [{ id, name, parentId, depth, path, pathText }]
export function flattenTree(topics) {
  const { byId, children } = buildTree(topics);
  const out = [];
  const walk = (parentId, depth, path) => {
    for (const t of children.get(parentId) || []) {
      const p = [...path, t.name];
      out.push({ id: t.id, name: t.name, parentId: t.parentId && byId.has(t.parentId) ? t.parentId : null, depth, path: p, pathText: pathToText(p), order: t.order ?? 0 });
      walk(t.id, depth + 1, p);
    }
  };
  walk(null, 0, []);
  return out;
}

export function descendantIds(id, topics) {
  const { children } = buildTree(topics);
  const out = new Set([id]); const stack = [id];
  while (stack.length) for (const c of children.get(stack.pop()) || []) if (!out.has(c.id)) { out.add(c.id); stack.push(c.id); }
  return out;
}

function subtreeHeight(id, children) {         // 1 = folha
  let h = 1;
  for (const c of children.get(id) || []) h = Math.max(h, 1 + subtreeHeight(c.id, children));
  return h;
}

export function wouldCycle(id, newParentId, topics) {
  return !!newParentId && descendantIds(id, topics).has(newParentId);
}

export function validateTopicName(name, parentId, topics, ignoreId = null) {
  const { errors, value } = checkTopicNameFormat(name);
  const key = normalizeText(value);
  if (value && topics.some((t) => t.id !== ignoreId && (t.parentId ?? null) === (parentId ?? null) && normalizeText(t.name) === key))
    errors.push(`Já existe "${value}" neste nível.`);
  return { ok: errors.length === 0, errors, value };
}

// Mover o nó `id` para baixo de `newParentId` (null = raiz).
export function validateMove(id, newParentId, topics) {
  const errors = [];
  const { byId, children } = buildTree(topics);
  const node = byId.get(id);
  if (!node) return { ok: false, errors: ["Assunto não encontrado."] };
  if (newParentId && !byId.has(newParentId)) errors.push("Destino não encontrado.");
  if (newParentId === id || wouldCycle(id, newParentId, topics)) errors.push("Não é possível mover um assunto para dentro dele mesmo ou de um subassunto seu.");
  const depth = newParentId ? topicPath(newParentId, byId).length : 0;
  if (depth + subtreeHeight(id, children) > TOPIC_LIMITS.maxDepth) errors.push(`Passaria do limite de ${TOPIC_LIMITS.maxDepth} níveis.`);
  const nm = validateTopicName(node.name, newParentId ?? null, topics, id);
  if (!nm.ok) errors.push(...nm.errors);
  return { ok: errors.length === 0, errors };
}

// Reordenar entre irmãos: devolve as atualizações { id, order } (normaliza a ordem 0..n-1 e troca com o vizinho).
export function planReorder(id, direction, topics) {
  const { byId, children } = buildTree(topics);
  const node = byId.get(id); if (!node) return [];
  const parentId = node.parentId && byId.has(node.parentId) ? node.parentId : null;
  const sibs = [...(children.get(parentId) || [])];
  const i = sibs.findIndex((t) => t.id === id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= sibs.length) return [];
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  return sibs.map((t, k) => ({ id: t.id, order: k })).filter((u) => (byId.get(u.id).order ?? 0) !== u.order);
}

// Colar uma estrutura com recuo:
//   Tributos
//     Impostos
//       Impostos em espécie
// Aceita marcadores "- ", "* ", "• ". Devolve os caminhos de TODOS os nós (pais incluídos).
export function parseOutline(text) {
  const items = [], errors = [];
  String(text ?? "").replace(/\r\n?/g, "\n").split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    const m = raw.match(/^([ \t]*)(?:[-*•]\s+)?(.*)$/);
    items.push({ line: i + 1, indent: m[1].replace(/\t/g, "  ").length, name: m[2].trim().replace(/\s+/g, " ") });
  });
  // Recuo uniforme do bloco inteiro é ignorado (subtrai o menor recuo); a unidade é o menor degrau restante.
  const base = items.length ? Math.min(...items.map((x) => x.indent)) : 0;
  const unit = Math.min(...items.map((x) => x.indent - base).filter((x) => x > 0), Infinity);
  const paths = [], stack = []; let prev = -1;
  for (const it of items) {
    const level = it.indent === base ? 0 : (it.indent - base) / unit;
    if (!Number.isInteger(level)) { errors.push(`Linha ${it.line}: recuo inconsistente.`); continue; }
    if (level > prev + 1) { errors.push(`Linha ${it.line}: "${it.name}" pula um nível de recuo.`); continue; }
    const f = checkTopicNameFormat(it.name);
    if (f.errors.length) { errors.push(`Linha ${it.line}: ${f.errors.join(" ")}`); continue; }
    if (level + 1 > TOPIC_LIMITS.maxDepth) { errors.push(`Linha ${it.line}: passa do limite de ${TOPIC_LIMITS.maxDepth} níveis.`); continue; }
    stack.length = level; stack[level] = f.value; prev = level;
    paths.push(stack.slice(0, level + 1));
  }
  return { paths, errors };
}

// Garante que cada caminho exista (encontra ou cria nós), SEM gravar. Comparação sem acento/maiúscula entre irmãos.
export function planEnsurePaths(paths, existingTopics, subject, now = new Date()) {
  const topics = existingTopics.map((t) => ({ ...t }));
  const created = [], errors = [], idByPath = new Map();
  const iso = toISO(now);
  for (const path of paths) {
    if (!path.length) continue;
    if (path.length > TOPIC_LIMITS.maxDepth) { errors.push(`Caminho com mais de ${TOPIC_LIMITS.maxDepth} níveis: ${pathToText(path)}`); continue; }
    let parentId = null, ok = true;
    for (const raw of path) {
      const f = checkTopicNameFormat(raw);
      if (f.errors.length) { errors.push(`"${raw}": ${f.errors.join(" ")}`); ok = false; break; }
      const key = normalizeText(f.value);
      let node = topics.find((t) => (t.parentId ?? null) === parentId && normalizeText(t.name) === key);
      if (!node) {
        const order = 1 + Math.max(-1, ...topics.filter((t) => (t.parentId ?? null) === parentId).map((t) => t.order ?? 0));
        node = { id: newId("t"), subject, name: f.value, parentId, order, createdAt: iso, updatedAt: iso, schemaVersion: SCHEMA_VERSION };
        topics.push(node); created.push(node);
      }
      parentId = node.id;
    }
    if (ok) idByPath.set(pathKey(path), parentId);
  }
  return { created, idByPath, errors, topics };
}

// Caminho para exibir um cartão (usa a árvore; cai no texto antigo se o cartão ainda não foi migrado).
export function cardPath(card, byId) {
  if (card.topicId && byId.has(card.topicId)) return topicPath(card.topicId, byId);
  return [card.topic, card.subtopic].map((x) => String(x ?? "").trim()).filter(Boolean);
}

// Contagem de cartões por nó: own (direto) e total (com subassuntos). `none` = sem assunto.
export function countByTopic(cards, topics) {
  const { byId } = buildTree(topics);
  const own = new Map(topics.map((t) => [t.id, 0]));
  let none = 0;
  for (const c of cards) { if (c.topicId && own.has(c.topicId)) own.set(c.topicId, own.get(c.topicId) + 1); else none++; }
  const total = new Map(own);
  for (const t of topics) {
    const n = own.get(t.id); if (!n) continue;
    const seen = new Set([t.id]); let cur = t.parentId ? byId.get(t.parentId) : null;
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); total.set(cur.id, total.get(cur.id) + n); cur = cur.parentId ? byId.get(cur.parentId) : null; }
  }
  return { own, total, none };
}

// Cartões da versão 1 (assunto/subtópico em texto, sem topicId) -> caminhos da nova árvore.
export function planLegacyMigration(cards) {
  const assignments = [];
  for (const c of cards) {
    if (c.topicId) continue;
    const path = [c.topic, c.subtopic].flatMap((x) => parsePathString(x));
    if (path.length) assignments.push({ cardId: c.id, path });
  }
  const unique = new Map(assignments.map((a) => [pathKey(a.path), a.path]));
  return { assignments, paths: [...unique.values()] };
}

// ---------- CSV de cartões ----------
// Colunas: frente;verso;assunto;subtopico (cabeçalho opcional). "assunto" aceita um CAMINHO: "Tributos > Impostos".
// O subtópico é acrescentado como nível extra. Sem assunto na linha, usa defaults.path (lista de nomes).
export function csvToCardInputs(text, defaults = {}) {
  const rows = parseCSV(text);
  if (!rows.length) return { inputs: [], errors: ["Nenhum conteúdo para importar."] };
  const head = rows[0].map(normalizeText);
  const hasHeader = head[0] === "frente" && head[1] === "verso";
  const body = hasHeader ? rows.slice(1) : rows;
  const inputs = [], errors = [];
  body.forEach((r, i) => {
    const line = i + (hasHeader ? 2 : 1);
    let base = parsePathString(r[2]);
    if (!base.length) base = defaults.path ?? [];
    const path = [...base, ...parsePathString(r[3])];
    const v = validateCardInput({ front: r[0], back: r[1] });
    const errs = [...v.errors];
    if (path.length > TOPIC_LIMITS.maxDepth) errs.push(`Assunto com mais de ${TOPIC_LIMITS.maxDepth} níveis.`);
    for (const n of path) errs.push(...checkTopicNameFormat(n).errors);
    if (errs.length) errors.push(`Linha ${line}: ${errs.join(" ")}`);
    else inputs.push({ front: v.value.front, back: v.value.back, path });
  });
  return { inputs, errors };
}

// ---------- Backup / importação ----------
// Formato: { app:"anki-pessoal", schemaVersion, kind:"cards"|"full", exportedAt, subject, topics:[...], cards:[...], events:[...] }
// Versão 1 (sem "topics") continua sendo aceita na importação.
export function buildBackup({ subject, cards, events, topics = [], kind, now = new Date() }) {
  const out = { app: "anki-pessoal", schemaVersion: SCHEMA_VERSION, kind, exportedAt: toISO(now), subject, topics, cards };
  if (kind === "full") out.events = events;
  return out;
}

function isISO(s) { return typeof s === "string" && !Number.isNaN(Date.parse(s)); }

export function validateBackupTopic(t, subject) {
  const e = [];
  if (!t || typeof t !== "object") return ["assunto não é um objeto"];
  if (typeof t.id !== "string" || !t.id || t.id.includes("/")) e.push("id inválido");
  if (t.subject !== subject) e.push("disciplina diferente");
  e.push(...checkTopicNameFormat(t.name).errors);
  if (t.parentId != null && (typeof t.parentId !== "string" || !t.parentId)) e.push("parentId inválido");
  if (t.order != null && !Number.isFinite(t.order)) e.push("order inválido");
  return e;
}

export function validateBackupCard(c, subject) {
  const e = [];
  if (!c || typeof c !== "object") return ["cartão não é um objeto"];
  if (typeof c.id !== "string" || !c.id || c.id.includes("/")) e.push("id inválido");
  if (c.subject !== subject) e.push(`disciplina "${c.subject}" difere de "${subject}"`);
  const v = validateCardInput(c);
  if (!v.ok) e.push(...v.errors);
  const f = c.fsrs;
  if (!f || typeof f !== "object") e.push("dados FSRS ausentes");
  else {
    if (![0, 1, 2, 3].includes(f.state)) e.push("fsrs.state inválido");
    if (!isISO(f.due)) e.push("fsrs.due inválido");
    for (const k of ["stability", "difficulty", "elapsed_days", "scheduled_days", "reps", "lapses"]) {
      if (typeof f[k] !== "number" || !Number.isFinite(f[k]) || f[k] < 0) e.push(`fsrs.${k} inválido`);
    }
    if (f.last_review != null && !isISO(f.last_review)) e.push("fsrs.last_review inválido");
  }
  if (!isISO(c.createdAt)) e.push("createdAt inválido");
  if (!Number.isInteger(c.reviewCount) || c.reviewCount < 0) e.push("reviewCount inválido");
  return e;
}

export function validateBackupEvent(ev, subject) {
  const e = [];
  if (!ev || typeof ev !== "object") return ["evento não é um objeto"];
  if (typeof ev.id !== "string" || !ev.id || ev.id.includes("/")) e.push("id inválido");
  if (typeof ev.cardId !== "string" || !ev.cardId) e.push("cardId inválido");
  if (ev.subject !== subject) e.push("disciplina diferente");
  if (!isISO(ev.reviewedAt)) e.push("reviewedAt inválido");
  if (![1, 2, 3, 4].includes(ev.rating)) e.push("rating inválido");
  if (![0, 1, 2, 3].includes(ev.stateBefore) || ![0, 1, 2, 3].includes(ev.stateAfter)) e.push("estado inválido");
  if (!isISO(ev.dueAfter)) e.push("dueAfter inválido");
  return e;
}

// Planeja a importação SEM gravar nada. Regras: nunca sobrescreve silenciosamente.
//  - cartão com id já existente => "conflito" (ignorado, a menos que overwrite=true seja pedido explicitamente)
//  - evento com id já existente => ignorado (histórico é imutável)
//  - assunto do backup com mesmo id, ou com mesmo nome sob o mesmo pai, JUNTA-SE ao existente (sem duplicar);
//    os cartões importados passam a apontar para o assunto existente.
export function planBackupImport(parsed, subject, existingCards, existingEventIds, { overwrite = false, existingTopics = [] } = {}) {
  const report = { ok: false, fatal: [], invalidCards: [], invalidEvents: [], invalidTopics: [], newCards: [], conflicts: [], overwrites: [], newEvents: [], skippedEvents: 0, orphanEvents: [], newTopics: [], mergedTopics: 0 };
  if (!parsed || typeof parsed !== "object" || parsed.app !== "anki-pessoal") { report.fatal.push("Arquivo não é um backup do anki-pessoal."); return report; }
  if (!SUPPORTED_SCHEMAS.includes(parsed.schemaVersion)) { report.fatal.push(`Versão de esquema ${parsed.schemaVersion} não suportada (aceitas: ${SUPPORTED_SCHEMAS.join(", ")}).`); return report; }
  if (parsed.subject !== subject) { report.fatal.push(`O backup é da disciplina "${parsed.subject}", mas você está em "${subject}".`); return report; }
  if (!Array.isArray(parsed.cards)) { report.fatal.push("Lista de cartões ausente."); return report; }
  if (parsed.topics != null && !Array.isArray(parsed.topics)) { report.fatal.push("Lista de assuntos inválida."); return report; }

  // ---- assuntos ----
  const btopics = parsed.topics ?? [];
  const existingIds = new Set(existingTopics.map((t) => t.id));
  const bById = new Map(); const pending = [];
  btopics.forEach((t, i) => {
    const errs = validateBackupTopic(t, subject);
    if (!errs.length && bById.has(t.id)) errs.push("id repetido no arquivo");
    if (errs.length) report.invalidTopics.push({ index: i, id: t?.id, errors: errs });
    else { bById.set(t.id, t); pending.push({ t, i }); }
  });
  const idMap = new Map();
  const all = existingTopics.map((t) => ({ ...t }));
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let k = pending.length - 1; k >= 0; k--) {
      const { t } = pending[k];
      if (t.parentId && !idMap.has(t.parentId) && !existingIds.has(t.parentId)) continue;   // espera o pai
      const parentR = t.parentId ? (idMap.get(t.parentId) ?? t.parentId) : null;
      if (existingIds.has(t.id)) idMap.set(t.id, t.id);
      else {
        const key = normalizeText(t.name);
        const twin = all.find((x) => (x.parentId ?? null) === parentR && normalizeText(x.name) === key);
        if (twin) { idMap.set(t.id, twin.id); report.mergedTopics++; }
        else {
          const node = { id: t.id, subject, name: checkTopicNameFormat(t.name).value, parentId: parentR, order: t.order ?? 0, createdAt: t.createdAt ?? toISO(), updatedAt: t.updatedAt ?? toISO(), schemaVersion: SCHEMA_VERSION };
          all.push(node); report.newTopics.push(node); idMap.set(t.id, t.id);
        }
      }
      pending.splice(k, 1); progress = true;
    }
  }
  for (const { t, i } of pending) report.invalidTopics.push({ index: i, id: t.id, errors: ["pai inexistente ou ciclo na hierarquia"] });

  // ---- cartões ----
  const existingById = new Map(existingCards.map((c) => [c.id, c]));
  const seen = new Set();
  const validIds = new Set();
  parsed.cards.forEach((c, i) => {
    const errs = validateBackupCard(c, subject);
    if (!errs.length && c.topicId) {
      if (!idMap.has(c.topicId) && !existingIds.has(c.topicId)) errs.push("assunto (topicId) inexistente no arquivo e no banco");
    }
    if (errs.length) { report.invalidCards.push({ index: i, id: c?.id, errors: errs }); return; }
    if (seen.has(c.id)) { report.invalidCards.push({ index: i, id: c.id, errors: ["id repetido no arquivo"] }); return; }
    seen.add(c.id); validIds.add(c.id);
    const card = c.topicId ? { ...c, topicId: idMap.get(c.topicId) ?? c.topicId } : c;
    if (existingById.has(c.id)) { (overwrite ? report.overwrites : report.conflicts).push(card); }
    else report.newCards.push(card);
  });

  if (parsed.kind === "full" && Array.isArray(parsed.events)) {
    const evSeen = new Set();
    parsed.events.forEach((ev, i) => {
      const errs = validateBackupEvent(ev, subject);
      if (errs.length) { report.invalidEvents.push({ index: i, id: ev?.id, errors: errs }); return; }
      if (evSeen.has(ev.id) || existingEventIds.has(ev.id)) { report.skippedEvents++; return; }
      evSeen.add(ev.id);
      if (!validIds.has(ev.cardId) && !existingById.has(ev.cardId)) report.orphanEvents.push(ev.id);
      report.newEvents.push(ev);
    });
  }
  // Qualquer item inválido bloqueia a importação inteira (nada é gravado pela metade).
  report.ok = report.invalidCards.length === 0 && report.invalidEvents.length === 0 && report.invalidTopics.length === 0;
  return report;
}
