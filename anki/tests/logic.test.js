import test from "node:test";
import assert from "node:assert/strict";
import { SUBJECTS, assertSubjectsValid } from "../config/subjects.js";
import * as M from "../js/model.js";
import * as F from "../js/fsrs.js";
import * as S from "../js/statistics.js";

const scheduler = F.makeScheduler();
const T0 = new Date("2026-10-23T15:00:00.000Z");
const mkCard = (id = "c1", now = T0, input = { front: "Q", back: "A", topic: "T", subtopic: "" }) =>
  F.buildNewCardDoc({ id, subject: "tributario", input, now });

test("subjects: lista válida e id inválido/duplicado é rejeitado", () => {
  assert.ok(assertSubjectsValid());
  assert.throws(() => assertSubjectsValid([{ id: "Direito Civil", name: "x" }]));
  assert.throws(() => assertSubjectsValid([{ id: "civil", name: "a" }, { id: "civil", name: "b" }]));
  assert.doesNotThrow(() => assertSubjectsValid([...SUBJECTS, { id: "civil", name: "Direito Civil" }])); // Teste J (nível de config)
});

test("Teste E: cartão novo recebe agendamento FSRS real nas 4 avaliações", () => {
  const c = mkCard();
  assert.equal(c.fsrs.state, 0); assert.equal(c.reviewCount, 0);
  const p = F.previewReview(scheduler, c, T0);
  assert.deepEqual(Object.keys(p).map(Number), [1, 2, 3, 4]);
  assert.ok(new Date(p[1].due) > T0);
  assert.ok(new Date(p[1].due) < new Date(p[3].due) && new Date(p[3].due) < new Date(p[4].due)); // Again < Good < Easy
  assert.equal(p[1].fsrs.state, 1); assert.equal(p[4].fsrs.state, 2);
  assert.ok(p[3].fsrs.stability > 0 && p[3].fsrs.difficulty > 0);
});

test("intervalo exibido = agendamento gravado (mesmo objeto aplicado)", () => {
  const c = mkCard();
  const p = F.previewReview(scheduler, c, T0);
  const w = F.buildReviewWrite({ cardDoc: c, chosen: p[3], durationMs: 4200 });
  assert.equal(w.cardUpdate.due, p[3].due);
  assert.equal(w.cardUpdate.fsrs.due, p[3].fsrs.due);
  assert.equal(M.formatInterval(T0, p[3].due), M.formatInterval(T0, w.cardUpdate.due));
});

test("Teste F: cada avaliação gera exatamente um evento, id determinístico", () => {
  let c = mkCard();
  const ids = new Set();
  let now = T0;
  for (const g of [3, 3, 1, 4]) {
    const p = F.previewReview(scheduler, c, now);
    const w = F.buildReviewWrite({ cardDoc: c, chosen: p[g] });
    assert.equal(w.expectedReviewCount, c.reviewCount);
    assert.equal(w.event.reviewNumber, c.reviewCount + 1);
    assert.equal(w.event.id, `c1__${c.reviewCount + 1}`);
    assert.equal(w.event.rating, g);
    assert.equal(w.event.stateBefore, c.fsrs.state); assert.equal(w.event.stateAfter, w.cardUpdate.fsrs.state);
    assert.equal(w.event.dueBefore, c.fsrs.due); assert.equal(w.event.dueAfter, w.cardUpdate.due);
    assert.ok(!ids.has(w.event.id)); ids.add(w.event.id);
    c = { ...c, ...w.cardUpdate };
    now = new Date(c.due);              // revisa exatamente quando vence
  }
  assert.equal(c.reviewCount, 4); assert.equal(ids.size, 4);
  assert.equal(c.lapses, 1);            // o "De novo" na fase de revisão (3ª avaliação) conta como lapso
});

test("serialização FSRS é reversível (retomada entre dispositivos)", () => {
  const c = mkCard(); const p = F.previewReview(scheduler, c, T0);
  const back = F.serializeFsrs(F.deserializeFsrs(p[3].fsrs));
  assert.deepEqual(back, JSON.parse(JSON.stringify(p[3].fsrs)));
  // continuar o agendamento a partir do estado salvo funciona
  const c2 = { ...c, ...F.buildReviewWrite({ cardDoc: c, chosen: p[3] }).cardUpdate };
  const p2 = F.previewReview(scheduler, c2, new Date(c2.due));
  assert.ok(new Date(p2[3].due) > new Date(c2.due));
});

test("Teste H: datas — dia local do fuso America/Sao_Paulo perto da meia-noite", () => {
  assert.equal(process.env.TZ, "America/Sao_Paulo");
  assert.equal(M.dayKey("2026-10-23T02:59:59.000Z"), "2026-10-22"); // 23:59:59 local do dia 22
  assert.equal(M.dayKey("2026-10-23T03:00:00.000Z"), "2026-10-23"); // 00:00:00 local do dia 23
  assert.equal(M.dayKey("2026-10-23T03:00:00.000Z", "UTC"), "2026-10-23");
  assert.equal(M.dayKey("2026-10-23T02:00:00.000Z", "UTC"), "2026-10-23");
  assert.equal(M.weekKey("2026-10-23"), "2026-10-19"); // sexta -> segunda
  assert.equal(M.monthKey("2026-10-23"), "2026-10");
});

test("Teste H: vencidos / previstos hoje / devidos agora / novos / suspensos", () => {
  const now = new Date("2026-10-23T15:00:00.000Z");           // 12:00 local
  const mk = (id, state, due, extra = {}) => ({ id, subject: "x", front: "q", back: "a", suspended: false, createdAt: "2026-01-01T00:00:00.000Z", reviewCount: state ? 1 : 0, fsrs: { state }, due, ...extra });
  const cards = [
    mk("new", 0, "2026-10-23T15:00:00.000Z"),
    mk("overdue", 2, "2026-10-22T20:00:00.000Z"),                 // ontem 17:00 local
    mk("earlyToday", 2, "2026-10-23T05:00:00.000Z"),              // hoje 02:00 local (já passou)
    mk("laterToday", 2, "2026-10-23T20:00:00.000Z"),              // hoje 17:00 local (ainda não)
    mk("tomorrow", 2, "2026-10-24T03:00:00.000Z"),                // amanhã 00:00 local
    mk("learn", 1, "2026-10-23T15:05:00.000Z"),
    mk("susp", 2, "2026-10-01T00:00:00.000Z", { suspended: true }),
  ];
  const c = S.countCards(cards, now);
  assert.deepEqual([c.total, c.new, c.learning, c.review, c.suspended], [7, 1, 1, 4, 1]);
  assert.equal(c.overdue, 1);       // só "overdue" (antes de hoje 00:00 local)
  assert.equal(c.dueToday, 4);      // overdue, earlyToday, laterToday, learn
  assert.equal(c.dueNow, 2);        // overdue, earlyToday
  const q = M.buildQueue(cards, now, 20);
  assert.deepEqual(q, ["overdue", "earlyToday", "new"]);
  assert.deepEqual(M.buildQueue(cards, now, 0), ["overdue", "earlyToday"]);
});

test("Teste G: estatísticas — acerto/erro/retenção, distintos por dia, distribuição", () => {
  const ev = (id, card, iso, rating, stateBefore, dur = null) => ({ id, cardId: card, reviewedAt: iso, rating, stateBefore, stateAfter: 2, durationMs: dur });
  const events = [
    ev("1", "a", "2026-10-22T14:00:00.000Z", 3, 0, 3000),
    ev("2", "a", "2026-10-22T15:00:00.000Z", 1, 2, 2000),   // erro em Revisão
    ev("3", "b", "2026-10-23T02:30:00.000Z", 2, 2, null),   // 23:30 local do dia 22; "Difícil" = acerto
    ev("4", "b", "2026-10-23T12:00:00.000Z", 4, 2, 1000),
    ev("5", "c", "2026-10-23T13:00:00.000Z", 3, 1, 1000),
  ];
  const m = S.reviewMetrics(events);
  assert.deepEqual([m.total, m.again, m.hard, m.good, m.easy], [5, 1, 1, 2, 1]);
  assert.equal(m.successes, 4); assert.equal(m.failures, 1); assert.equal(m.accuracy, 0.8);
  assert.equal(m.reviewStateTotal, 3); assert.equal(m.reviewStateSuccesses, 2);
  assert.ok(Math.abs(m.retention - 2 / 3) < 1e-9);
  assert.equal(m.studyMs, 7000); assert.equal(m.measured, 4); assert.equal(m.distinctCards, 3);
  const days = S.seriesBy(events, "day");
  assert.deepEqual(days.map((d) => [d.key, d.reviews, d.distinctCards]), [["2026-10-22", 3, 2], ["2026-10-23", 2, 2]]);
  assert.equal(S.seriesBy(events, "week").length, 1);
  assert.equal(S.filterEventsByDays(events, "2026-10-23", "2026-10-23").length, 2);
  assert.equal(S.ratingDistribution(events).reduce((s, r) => s + r.count, 0), 5);
  assert.equal(S.reviewMetrics([]).accuracy, null);
});

test("validação de cartão, texto seguro e CSV", () => {
  assert.equal(M.validateCardInput({ front: " ", back: "x" }).ok, false);
  assert.equal(M.validateCardInput({ front: "a", back: "b" }).value.topicId, null);
  assert.equal(M.validateCardInput({ front: "a", back: "b", topicId: "t_1" }).value.topicId, "t_1");
  assert.equal(M.validateCardInput({ front: "a", back: "b", topicId: "x/y" }).ok, false);
  const html = M.renderRichText('<img src=x onerror=alert(1)> **b** *i* `c`\nlinha2');
  assert.ok(!html.includes("<img")); assert.ok(html.includes("&lt;img")); assert.ok(html.includes("<strong>b</strong>") && html.includes("<em>i</em>") && html.includes("<code>c</code>") && html.includes("\n"));
  const csv = M.toCSV([["frente", "verso", "assunto", "subtopico"], ['Pergunta; com "aspas"', "linha1\nlinha2", "T", ""]]);
  const rows = M.parseCSV(csv);
  assert.deepEqual(rows[1], ['Pergunta; com "aspas"', "linha1\nlinha2", "T", ""]);
  assert.equal(M.csvToCardInputs(csv).inputs.length, 1);
  assert.ok(M.csvToCardInputs("frente;verso\n;sem frente").errors.length === 1);
  assert.throws(() => M.parseCSV('"aberta'));
});

test("Teste K: backup (cartões e completo) é recuperável e importação valida sem sobrescrever", () => {
  let c = mkCard("c1"); const events = [];
  const p = F.previewReview(scheduler, c, T0); const w = F.buildReviewWrite({ cardDoc: c, chosen: p[3], durationMs: 1000 });
  c = { ...c, ...w.cardUpdate }; events.push(w.event);
  const full = JSON.parse(JSON.stringify(M.buildBackup({ subject: "tributario", cards: [c, mkCard("c2")], events, kind: "full" })));
  const cardsOnly = JSON.parse(JSON.stringify(M.buildBackup({ subject: "tributario", cards: [c], events, kind: "cards" })));
  assert.equal(cardsOnly.events, undefined); assert.equal(full.events.length, 1);

  // banco vazio: tudo é novo
  let plan = M.planBackupImport(full, "tributario", [], new Set());
  assert.ok(plan.ok); assert.equal(plan.newCards.length, 2); assert.equal(plan.newEvents.length, 1);
  assert.equal(plan.newCards[0].fsrs.due, c.fsrs.due); assert.equal(plan.newCards[0].reviewCount, 1);
  // banco já com c1 e o evento: nada é sobrescrito
  plan = M.planBackupImport(full, "tributario", [c], new Set([events[0].id]));
  assert.equal(plan.newCards.length, 1); assert.equal(plan.conflicts.length, 1); assert.equal(plan.overwrites.length, 0); assert.equal(plan.newEvents.length, 0); assert.equal(plan.skippedEvents, 1);
  plan = M.planBackupImport(full, "tributario", [c], new Set(), { overwrite: true });
  assert.equal(plan.overwrites.length, 1);
  // disciplina errada, esquema errado, item malformado
  assert.ok(M.planBackupImport(full, "contabilidade", [], new Set()).fatal.length);
  assert.ok(M.planBackupImport({ ...full, schemaVersion: 99 }, "tributario", [], new Set()).fatal.length);
  assert.ok(M.planBackupImport({ foo: 1 }, "tributario", [], new Set()).fatal.length);
  const bad = JSON.parse(JSON.stringify(full)); bad.cards[1].fsrs.due = "lixo"; delete bad.cards[0].back;
  plan = M.planBackupImport(bad, "tributario", [], new Set());
  assert.equal(plan.ok, false); assert.equal(plan.invalidCards.length, 2);
  const dup = JSON.parse(JSON.stringify(full)); dup.cards.push(dup.cards[0]);
  assert.equal(M.planBackupImport(dup, "tributario", [], new Set()).ok, false);
});

test("carga em lote: separadores, caminho de assunto, padrão e erros por linha", () => {
  const tsv = "P1\tR1\tTributos > Impostos\tImpostos em espécie\nP2\tR2\t\t";
  const r = M.csvToCardInputs(tsv, { path: ["Padrao", "Sub"] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.inputs[0].path, ["Tributos", "Impostos", "Impostos em espécie"]);   // subtópico vira nível extra
  assert.deepEqual(r.inputs[1].path, ["Padrao", "Sub"]);                                  // padrão nas linhas sem assunto
  const old = M.csvToCardInputs("frente;verso;assunto;subtopico\nQ;A;Competência tributária;Impostos federais");   // formato da v1
  assert.deepEqual(old.inputs[0].path, ["Competência tributária", "Impostos federais"]);
  const semi = M.csvToCardInputs('frente;verso;assunto;subtopico\n"a;b";"l1\nl2";T;S');
  assert.equal(semi.inputs.length, 1); assert.equal(semi.inputs[0].front, "a;b"); assert.equal(semi.inputs[0].back, "l1\nl2");
  const bad = M.csvToCardInputs("ok;ok\n;sem frente\nso frente");
  assert.equal(bad.errors.length, 2); assert.ok(bad.errors[0].startsWith("Linha 2"));
  assert.ok(M.csvToCardInputs("a;b;1>2>3>4>5>6>7>8>9").errors.length === 1);   // profundidade máxima
});

const T = (id, name, parentId = null, order = 0) => ({ id, subject: "tributario", name, parentId, order, createdAt: "2026-10-31T10:00:00.000Z", updatedAt: "2026-10-31T10:00:00.000Z", schemaVersion: 2 });
const sample = [T("a", "Tributos"), T("b", "Impostos", "a", 0), T("c", "Impostos em espécie", "b"), T("d", "Taxas", "a", 1), T("e", "Princípios", null, 1)];

test("árvore: caminhos, achatamento em ordem, descendentes e ciclos", () => {
  const { byId } = M.buildTree(sample);
  assert.deepEqual(M.topicPath("c", byId), ["Tributos", "Impostos", "Impostos em espécie"]);
  const flat = M.flattenTree(sample);
  assert.deepEqual(flat.map((x) => [x.name, x.depth]), [["Tributos", 0], ["Impostos", 1], ["Impostos em espécie", 2], ["Taxas", 1], ["Princípios", 0]]);
  assert.equal(flat[2].pathText, "Tributos › Impostos › Impostos em espécie");
  assert.deepEqual([...M.descendantIds("a", sample)].sort(), ["a", "b", "c", "d"]);
  assert.equal(M.wouldCycle("a", "c", sample), true);
  assert.equal(M.wouldCycle("c", "a", sample), false);
  assert.deepEqual(M.topicPath("zzz", byId), []);
  assert.equal(M.flattenTree([T("x", "Órfão", "naoexiste")]).length, 1);   // pai inexistente => raiz
});

test("árvore: nomes (unicidade por nível, separadores) e validação de mover", () => {
  assert.equal(M.validateTopicName("  taxas ", "a", sample).ok, false);          // já existe (sem acento/maiúscula)
  assert.equal(M.validateTopicName("Taxas", "e", sample).ok, true);              // outro nível
  assert.equal(M.validateTopicName("A > B", null, sample).ok, false);
  assert.equal(M.validateTopicName("Taxas", "a", sample, "d").ok, true);         // ignorar o próprio nó (renomear)
  assert.equal(M.validateMove("a", "c", sample).ok, false);                      // para dentro de si mesmo
  assert.equal(M.validateMove("c", "e", sample).ok, true);
  assert.equal(M.validateMove("d", "b", sample).ok, true);
  const clash = [...sample, T("f", "Taxas", "e")];
  assert.equal(M.validateMove("f", "a", clash).ok, false);                       // colide com "Taxas" sob "Tributos"
  const deep = []; for (let i = 0; i < 8; i++) deep.push(T(`n${i}`, `N${i}`, i ? `n${i - 1}` : null));
  assert.equal(M.validateMove("a", "n7", [...deep, ...sample]).ok, false);       // passaria de 8 níveis
});

test("árvore: reordenar entre irmãos", () => {
  assert.deepEqual(M.planReorder("d", "up", sample), [{ id: "d", order: 0 }, { id: "b", order: 1 }]);
  assert.deepEqual(M.planReorder("b", "up", sample), []);
  assert.deepEqual(M.planReorder("d", "down", sample), []);
  const ties = [T("x", "A", null, 0), T("y", "B", null, 0), T("z", "C", null, 0)];   // ordens iguais são normalizadas
  const up = M.planReorder("z", "up", ties);
  assert.deepEqual(up.sort((p, q) => p.id.localeCompare(q.id)), [{ id: "y", order: 2 }, { id: "z", order: 1 }]);
});

test("outline: recuo vira caminhos; erros de recuo e nomes são reportados", () => {
  const r = M.parseOutline("Tributos\n  Impostos\n    Impostos em espécie\n  Taxas\nPrincípios\n\n- Legalidade");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.paths.map((p) => p.join(" > ")), ["Tributos", "Tributos > Impostos", "Tributos > Impostos > Impostos em espécie", "Tributos > Taxas", "Princípios", "Legalidade"]);
  assert.equal(M.parseOutline("A\n    B\n  C").errors.length, 1);        // recuo inconsistente (4 e 2)
  assert.equal(M.parseOutline("A\n      C").errors.length, 0);              // unidade = 6 => nível 1
  assert.equal(M.parseOutline("A\n    B\n        D\n      E").errors.length, 1);
  assert.equal(M.parseOutline("A\n  B\n      D").errors.length, 1);        // pula nível
  assert.equal(M.parseOutline("A > B").errors.length, 1);
  assert.equal(M.parseOutline("\tA\n\t\tB").errors.length, 0);
});

test("ensurePaths: reutiliza nós existentes (sem acento/caixa) e cria só o que falta", () => {
  const plan = M.planEnsurePaths([["tributos", "IMPOSTOS", "Impostos em espécie"], ["Tributos", "Contribuições"], ["Novo"]], sample, "tributario");
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.created.map((n) => n.name), ["Contribuições", "Novo"]);
  assert.equal(plan.idByPath.get(M.pathKey(["Tributos", "Impostos", "Impostos em espécie"])), "c");
  const contrib = plan.created[0]; assert.equal(contrib.parentId, "a"); assert.equal(contrib.order, 2);
  assert.ok(M.planEnsurePaths([["a", "b>c"]], [], "x").errors.length);
  assert.equal(M.planEnsurePaths([["X", "Y"], ["x", "y", "z"]], [], "x").created.length, 3);   // 2º caminho reaproveita X e Y
});

test("contagem por assunto (própria e com subassuntos) e cartões sem assunto", () => {
  const cards = [{ topicId: "c" }, { topicId: "c" }, { topicId: "b" }, { topicId: "d" }, {}, { topicId: "inexistente" }];
  const c = M.countByTopic(cards, sample);
  assert.equal(c.own.get("c"), 2); assert.equal(c.total.get("b"), 3); assert.equal(c.total.get("a"), 4); assert.equal(c.total.get("e"), 0);
  assert.equal(c.none, 2);
  const byId = M.buildTree(sample).byId;
  assert.deepEqual(M.cardPath({ topicId: "b" }, byId), ["Tributos", "Impostos"]);
  assert.deepEqual(M.cardPath({ topic: "Antigo", subtopic: "Sub" }, byId), ["Antigo", "Sub"]);   // texto da v1
});

test("migração de assuntos em texto (v1) para a árvore", () => {
  const cards = [{ id: "1", topic: "Competência tributária", subtopic: "Impostos federais" }, { id: "2", topic: "competência tributária", subtopic: "Impostos federais" },
                 { id: "3", topic: "Princípios", subtopic: "" }, { id: "4", topic: "", subtopic: "" }, { id: "5", topicId: "x", topic: "Velho" }];
  const m = M.planLegacyMigration(cards);
  assert.equal(m.assignments.length, 3);
  assert.equal(m.paths.length, 2);                        // 1 e 2 compartilham o mesmo caminho (sem acento/caixa)
  const ens = M.planEnsurePaths(m.paths, [], "tributario");
  assert.equal(ens.created.length, 3);                    // Competência tributária, Impostos federais, Princípios
});

test("backup v1 real (sem topics) ainda importa; v2 junta assuntos iguais e remapeia cartões", () => {
  const card = (id, extra = {}) => ({ id, subject: "tributario", front: id, back: "b", createdAt: "2026-10-23T17:07:49.290Z", reviewCount: 0, suspended: false,
    fsrs: { state: 0, due: "2026-10-23T17:07:49.290Z", stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, learning_steps: 0, last_review: null }, ...extra });
  const v1 = { app: "anki-pessoal", schemaVersion: 1, kind: "full", subject: "tributario", cards: [card("c1", { topic: "Princípios", subtopic: "Anterioridade" })], events: [] };
  const p1 = M.planBackupImport(v1, "tributario", [], new Set());
  assert.ok(p1.ok); assert.equal(p1.newCards.length, 1);

  const bt = [T("a", "Tributos"), T("b", "Impostos", "a"), T("z", "Novo", "b")];
  const v2 = { app: "anki-pessoal", schemaVersion: 2, kind: "cards", subject: "tributario", topics: bt, cards: [card("k1", { topicId: "z" }), card("k2", { topicId: "b" }), card("k3")] };
  // banco já tem "tributos > impostos" com OUTROS ids (p/ q e r)
  const existing = [T("p", "tributos"), T("q", "IMPOSTOS", "p")];
  const p2 = M.planBackupImport(v2, "tributario", [], new Set(), { existingTopics: existing });
  assert.ok(p2.ok); assert.equal(p2.mergedTopics, 2);
  assert.deepEqual(p2.newTopics.map((t) => [t.id, t.parentId]), [["z", "q"]]);          // "Novo" é criado sob o existente "q"
  assert.equal(p2.newCards.find((c) => c.id === "k1").topicId, "z");
  assert.equal(p2.newCards.find((c) => c.id === "k2").topicId, "q");                   // remapeado para o existente
  assert.equal(p2.newCards.find((c) => c.id === "k3").topicId, undefined);
  // banco vazio: cria os três
  const p3 = M.planBackupImport(v2, "tributario", [], new Set());
  assert.equal(p3.newTopics.length, 3); assert.equal(p3.mergedTopics, 0);
  // topicId que não existe em lugar nenhum bloqueia
  const bad = { ...v2, cards: [card("k9", { topicId: "fantasma" })] };
  assert.equal(M.planBackupImport(bad, "tributario", [], new Set()).ok, false);
  // ciclo / pai inexistente nos assuntos do arquivo bloqueia
  const cyc = { ...v2, topics: [T("a", "A", "b"), T("b", "B", "a")], cards: [] };
  assert.equal(M.planBackupImport(cyc, "tributario", [], new Set()).ok, false);
  const orphan = { ...v2, topics: [T("a", "A", "naoexiste")], cards: [] };
  assert.equal(M.planBackupImport(orphan, "tributario", [], new Set()).ok, false);
  // backup exportado não carrega events em kind "cards"; topics sempre vão junto
  assert.deepEqual(M.buildBackup({ subject: "tributario", cards: [], topics: bt, kind: "cards" }).topics.length, 3);
});
