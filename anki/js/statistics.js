// Estatísticas derivadas dos cartões e dos eventos históricos. Funções puras, sem DOM e sem Firebase.
//
// DEFINIÇÕES (usadas também na página de relatórios):
//  - Novo ............ cartão não suspenso com estado FSRS "Novo" (nunca avaliado).
//  - Aprendizagem .... não suspenso, estado Aprendizagem ou Reaprendizagem.
//  - Revisão ......... não suspenso, estado Revisão.
//  - Suspenso ........ cartão suspenso (não entra nas outras categorias nem nas filas).
//  - Vencido ......... não suspenso, não novo, com data de revisão ANTERIOR ao início do dia local de hoje.
//  - Previsto p/ hoje  não suspenso, não novo, com data de revisão até o fim do dia local de hoje
//                      (inclui os vencidos e os que vencem ainda hoje).
//  - Devido agora .... não suspenso, não novo, com data de revisão <= agora (é o que a fila serve).
//  - Acerto .......... avaliação Difícil, Bom ou Fácil (recordação bem-sucedida).
//  - Erro ............ avaliação "De novo".  "Difícil" NÃO é erro.
//  - Taxa de acerto .. acertos / total de avaliações do período (todos os estados).
//  - Retenção ........ acertos / avaliações feitas em cartões que ESTAVAM no estado Revisão
//                      (cartões já aprendidos). Não inclui cartões novos nem em aprendizagem.
//  - Revisões dia .... eventos classificados pelo dia LOCAL do instante da revisão.
import { dayKey, weekKey, monthKey, localDayBounds, toISO, classifyCard } from "./model.js";

export function countCards(cards, now = new Date()) {
  const { start, end } = localDayBounds(now);
  const startISO = toISO(start), endISO = toISO(end), nowISO = toISO(now);
  const r = { total: cards.length, new: 0, learning: 0, review: 0, suspended: 0, overdue: 0, dueToday: 0, dueNow: 0, withHistory: 0 };
  for (const c of cards) {
    if (c.reviewCount > 0) r.withHistory++;
    const k = classifyCard(c);
    r[k]++;
    if (k === "suspended" || k === "new") continue;
    if (c.due < startISO) r.overdue++;
    if (c.due < endISO) r.dueToday++;
    if (c.due <= nowISO) r.dueNow++;
  }
  return r;
}

export function filterEventsByDays(events, fromKey, toKey) {
  return events.filter((e) => {
    const k = dayKey(e.reviewedAt);
    return (!fromKey || k >= fromKey) && (!toKey || k <= toKey);
  });
}

export function reviewMetrics(events) {
  const m = { total: 0, again: 0, hard: 0, good: 0, easy: 0, successes: 0, failures: 0, accuracy: null,
              reviewStateTotal: 0, reviewStateSuccesses: 0, retention: null, studyMs: 0, measured: 0, distinctCards: 0 };
  const ids = new Set();
  for (const e of events) {
    m.total++;
    ids.add(e.cardId);
    ({ 1: () => m.again++, 2: () => m.hard++, 3: () => m.good++, 4: () => m.easy++ })[e.rating]?.();
    const ok = e.rating >= 2;
    if (ok) m.successes++; else m.failures++;
    if (e.stateBefore === 2) { m.reviewStateTotal++; if (ok) m.reviewStateSuccesses++; }
    if (typeof e.durationMs === "number") { m.studyMs += e.durationMs; m.measured++; }
  }
  m.distinctCards = ids.size;
  m.accuracy = m.total ? m.successes / m.total : null;
  m.retention = m.reviewStateTotal ? m.reviewStateSuccesses / m.reviewStateTotal : null;
  return m;
}

// Série agrupada por dia/semana/mês: [{ key, reviews, distinctCards, again, hard, good, easy, studyMs }]
export function seriesBy(events, granularity = "day") {
  const keyOf = { day: (k) => k, week: weekKey, month: monthKey }[granularity];
  if (!keyOf) throw new Error(`Granularidade inválida: ${granularity}`);
  const buckets = new Map();
  for (const e of events) {
    const k = keyOf(dayKey(e.reviewedAt));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }
  return [...buckets.keys()].sort().map((key) => {
    const m = reviewMetrics(buckets.get(key));
    return { key, reviews: m.total, distinctCards: m.distinctCards, again: m.again, hard: m.hard, good: m.good, easy: m.easy,
             accuracy: m.accuracy, retention: m.retention, studyMs: m.studyMs };
  });
}

export function ratingDistribution(events) {
  const m = reviewMetrics(events);
  const t = m.total || 1;
  return [
    { rating: 1, count: m.again, pct: m.again / t },
    { rating: 2, count: m.hard, pct: m.hard / t },
    { rating: 3, count: m.good, pct: m.good / t },
    { rating: 4, count: m.easy, pct: m.easy / t },
  ];
}

// Comparação entre matérias: recebe { subjectId: { cards, events } } e devolve uma linha por matéria.
export function compareSubjects(dataBySubject, now = new Date()) {
  return Object.entries(dataBySubject).map(([id, d]) => ({
    id, cards: countCards(d.cards, now), metrics: reviewMetrics(d.events),
  }));
}

export function formatPct(x) { return x == null ? "—" : `${(x * 100).toFixed(1).replace(".", ",")}%`; }
export function formatDuration(ms) {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`;
}
