// Camada fina sobre a biblioteca ts-fsrs (v5.4.1, implementa FSRS-6).
// Fonte: https://github.com/open-spaced-repetition/ts-fsrs  |  https://www.npmjs.com/package/ts-fsrs
// NENHUM cálculo de agendamento é feito aqui: tudo vem de scheduler.repeat() da biblioteca.
import { fsrs, createEmptyCard, Rating, Grades } from "ts-fsrs";
import { SCHEMA_VERSION, toISO } from "./model.js";

// Parâmetros padrão (valores padrão da biblioteca, explicitados para documentação).
// Futuramente podem vir de um documento de configuração no Firestore (ver README).
export const DEFAULT_FSRS_PARAMS = {
  request_retention: 0.9,   // retenção desejada (90%)
  maximum_interval: 36500,  // intervalo máximo em dias
  enable_fuzz: true,        // pequena variação para evitar cartões "empilhados"
  enable_short_term: true,  // passos de aprendizagem 1m/10m (padrão da lib)
};

export function makeScheduler(overrides = {}) {
  return fsrs({ ...DEFAULT_FSRS_PARAMS, ...overrides });
}

// Estado FSRS guardado no Firestore: mesmas chaves do objeto Card da biblioteca,
// com datas como ISO-8601 UTC (Firestore não guarda Date do JS de forma portável em JSON).
export function serializeFsrs(card) {
  return {
    due: toISO(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    learning_steps: card.learning_steps,
    state: card.state,
    last_review: card.last_review ? toISO(card.last_review) : null,
  };
}

export function deserializeFsrs(o) {
  const c = {
    due: new Date(o.due),
    stability: o.stability,
    difficulty: o.difficulty,
    elapsed_days: o.elapsed_days,
    scheduled_days: o.scheduled_days,
    reps: o.reps,
    lapses: o.lapses,
    learning_steps: o.learning_steps ?? 0,
    state: o.state,
  };
  if (o.last_review) c.last_review = new Date(o.last_review);
  return c;
}

export function emptyFsrsState(now = new Date()) {
  return serializeFsrs(createEmptyCard(now));
}

// Campos de topo derivados do estado FSRS (usados em consultas e listagens).
export function derivedFields(fsrsState, reviewCount) {
  return {
    state: fsrsState.state,
    due: fsrsState.due,
    lastReview: fsrsState.last_review,
    reps: fsrsState.reps,
    lapses: fsrsState.lapses,
    reviewCount,
  };
}

export function buildNewCardDoc({ id, subject, input, now = new Date() }) {
  const iso = toISO(now);
  const f = emptyFsrsState(now);
  return {
    id, subject,
    front: input.front, back: input.back, topicId: input.topicId ?? null,
    createdAt: iso, updatedAt: iso,
    suspended: false,
    fsrs: f,
    ...derivedFields(f, 0),
    schemaVersion: SCHEMA_VERSION,
  };
}

// Pré-visualiza as 4 avaliações para um cartão EM UM instante `now`.
// Retorna { 1..4: { rating, fsrs (serializado), log, due, intervalLabelFrom } }.
// O resultado escolhido é aplicado EXATAMENTE como foi mostrado (mesmo objeto),
// garantindo que o intervalo exibido no botão = agendamento gravado.
export function previewReview(scheduler, cardDoc, now = new Date()) {
  const rec = scheduler.repeat(deserializeFsrs(cardDoc.fsrs), now);
  const out = {};
  for (const g of Grades) {
    const { card, log } = rec[g];
    out[g] = { rating: g, fsrs: serializeFsrs(card), log, due: toISO(card.due), reviewedAt: toISO(now) };
  }
  return out;
}

// Constrói a escrita atômica de uma revisão: novo estado do cartão + evento histórico.
export function buildReviewWrite({ cardDoc, chosen, durationMs = null }) {
  const before = cardDoc.fsrs;
  const after = chosen.fsrs;
  const newCount = cardDoc.reviewCount + 1;
  const event = {
    id: `${cardDoc.id}__${newCount}`,       // determinístico: reenvio do mesmo clique não duplica
    cardId: cardDoc.id,
    subject: cardDoc.subject,
    reviewedAt: chosen.reviewedAt,
    rating: chosen.rating,
    reviewNumber: newCount,
    stateBefore: before.state,
    stateAfter: after.state,
    dueBefore: before.due,
    dueAfter: after.due,
    scheduledDaysBefore: before.scheduled_days,  // intervalo anterior
    scheduledDaysAfter: after.scheduled_days,
    elapsedDays: chosen.log.elapsed_days ?? null,
    stabilityBefore: before.stability,
    stabilityAfter: after.stability,
    difficultyBefore: before.difficulty,
    difficultyAfter: after.difficulty,
    durationMs,
    schemaVersion: SCHEMA_VERSION,
  };
  const cardUpdate = { fsrs: after, ...derivedFields(after, newCount) };
  return { event, cardUpdate, expectedReviewCount: cardDoc.reviewCount };
}

export { Rating, Grades };
