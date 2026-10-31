import { $, escapeHtml, showBanner } from "./app.js";
import { SUBJECTS } from "../config/subjects.js";
import { listCards, listEvents, countEvents, friendlyError } from "./anki-core.js";
import { countCards, reviewMetrics, filterEventsByDays, seriesBy, formatPct, formatDuration } from "./statistics.js";
import { dayKey, localDayBounds, parseDayKey, toISO } from "./model.js";

const q = new URLSearchParams(location.search);
$("#r-subject").innerHTML = `<option value="">Todas</option>` + SUBJECTS.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
if (SUBJECTS.some((s) => s.id === q.get("materia"))) $("#r-subject").value = q.get("materia");

const today = new Date();
const back = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
$("#r-to").value = dayKey(today.toISOString());
$("#r-from").value = dayKey(back.toISOString());

let last = null; // { rows, allEvents } para reagrupar sem nova leitura

async function run() {
  showBanner($("#banner"), "");
  const fromKey = $("#r-from").value, toKey = $("#r-to").value;
  if (!fromKey || !toKey || fromKey > toKey) { showBanner($("#banner"), "Período inválido: a data inicial deve ser anterior ou igual à final."); return; }
  const chosen = $("#r-subject").value;
  const list = SUBJECTS.filter((s) => !chosen || s.id === chosen);
  $("#r-loading").hidden = false; $("#r-body").hidden = true; $("#r-go").disabled = true;
  try {
    const now = new Date();
    // Busca desde o menor entre início do período e início de hoje (para "revisões hoje") até o fim do maior.
    const { start: todayStart, end: todayEnd } = localDayBounds(now);
    const fromStart = parseDayKey(fromKey);
    const toEndExclusive = new Date(parseDayKey(toKey).getTime()); toEndExclusive.setDate(toEndExclusive.getDate() + 1);
    const lo = new Date(Math.min(fromStart, todayStart)), hi = new Date(Math.max(toEndExclusive, todayEnd));
    const data = await Promise.all(list.map(async (s) => {
      const [cards, events, totalEvents] = await Promise.all([
        listCards(s.id), listEvents(s.id, { fromISO: toISO(lo), toISOExclusive: toISO(hi) }), countEvents(s.id),
      ]);
      return { s, cards, events, totalEvents };
    }));
    last = { data, fromKey, toKey, now };
    render();
  } catch (e) {
    showBanner($("#banner"), friendlyError(e)); $("#r-loading").hidden = true;
  } finally { $("#r-go").disabled = false; }
}

function render() {
  const { data, fromKey, toKey, now } = last;
  const todayKey = dayKey(now.toISOString());
  const th = (arr) => `<thead><tr>${arr.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
  const row = (arr) => `<tr>${arr.map((c) => `<td>${c}</td>`).join("")}</tr>`;

  // Situação dos cartões (independente do período)
  let t = th(["Disciplina", "Cartões", "Novos", "Aprend.", "Revisão", "Susp.", "Vencidos", "Prev. hoje", "Pend. agora", "Rev. hoje", "Rev. total"]);
  const sum = { total: 0, new: 0, learning: 0, review: 0, suspended: 0, overdue: 0, dueToday: 0, dueNow: 0, today: 0, all: 0 };
  t += "<tbody>" + data.map(({ s, cards, events, totalEvents }) => {
    const c = countCards(cards, now);
    const todayN = filterEventsByDays(events, todayKey, todayKey).length;
    Object.keys(c).forEach((k) => { if (k in sum) sum[k] += c[k]; });
    sum.today += todayN; sum.all += totalEvents;
    return row([escapeHtml(s.name), c.total, c.new, c.learning, c.review, c.suspended, c.overdue, c.dueToday, c.dueNow, todayN, totalEvents]);
  }).join("");
  t += row([`<b>Total</b>`, sum.total, sum.new, sum.learning, sum.review, sum.suspended, sum.overdue, sum.dueToday, sum.dueNow, sum.today, sum.all]) + "</tbody>";
  $("#t-cards").innerHTML = t;

  // Revisões no período
  const inPeriod = data.map((d) => ({ ...d, ev: filterEventsByDays(d.events, fromKey, toKey) }));
  let p = th(["Disciplina", "Revisões", "Cartões distintos", "De novo", "Difícil", "Bom", "Fácil", "Acertos", "Erros", "Taxa acerto", "Retenção", "Tempo"]);
  const mm = (m, name) => row([name, m.total, m.distinctCards, m.again, m.hard, m.good, m.easy, m.successes, m.failures, formatPct(m.accuracy), formatPct(m.retention), formatDuration(m.studyMs)]);
  p += "<tbody>" + inPeriod.map((d) => mm(reviewMetrics(d.ev), escapeHtml(d.s.name))).join("") + mm(reviewMetrics(inPeriod.flatMap((d) => d.ev)), "<b>Total</b>") + "</tbody>";
  $("#t-period").innerHTML = p;
  $("#r-note").textContent = `Período: ${fromKey} a ${toKey} (dias no fuso local). “Cartões distintos” do total conta cada cartão uma vez no período inteiro.`;

  renderSeries();
  $("#r-loading").hidden = true; $("#r-body").hidden = false;
}

function renderSeries() {
  const { data, fromKey, toKey } = last;
  const events = data.flatMap((d) => filterEventsByDays(d.events, fromKey, toKey));
  const s = seriesBy(events, $("#r-gran").value);
  const label = { day: "Dia", week: "Semana (seg.)", month: "Mês" }[$("#r-gran").value];
  $("#t-series").innerHTML = `<thead><tr>${[label, "Revisões", "Distintos", "De novo", "Difícil", "Bom", "Fácil", "Taxa acerto", "Tempo"].map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>` +
    (s.length ? s.map((r) => `<tr><td>${r.key}</td><td>${r.reviews}</td><td>${r.distinctCards}</td><td>${r.again}</td><td>${r.hard}</td><td>${r.good}</td><td>${r.easy}</td><td>${formatPct(r.accuracy)}</td><td>${formatDuration(r.studyMs)}</td></tr>`).join("")
      : `<tr><td colspan="9" style="text-align:center">Nenhuma revisão no período.</td></tr>`) + "</tbody>";
}

$("#r-go").onclick = run;
$("#r-gran").onchange = () => last && renderSeries();
run();
