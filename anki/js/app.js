// Utilitários de interface compartilhados pelas três páginas. Sem lógica de dados ou de estatística.
import { escapeHtml, flattenTree } from "./model.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export { escapeHtml };

// Preferências LOCAIS (apenas aparência/limites de sessão). Cartões e progresso nunca ficam aqui.
const PREF_KEY = "anki-pessoal:prefs";
const DEFAULT_PREFS = { theme: "auto", fontSize: 18, newPerSession: 20 };
export function getPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; } catch { return { ...DEFAULT_PREFS }; }
}
export function setPrefs(p) {
  const next = { ...getPrefs(), ...p };
  try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch { /* armazenamento bloqueado: ignora */ }
  applyPrefs(next);
  return next;
}
export function applyPrefs(p = getPrefs()) {
  const root = document.documentElement;
  if (p.theme === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", p.theme);
  root.style.setProperty("--card-font", `${p.fontSize}px`);
}

export function mountPrefsControls(container) {
  const p = getPrefs();
  container.innerHTML = `
    <label>Tema <select id="pref-theme"><option value="auto">Automático</option><option value="light">Claro</option><option value="dark">Escuro</option></select></label>
    <label>Fonte do cartão <input id="pref-font" type="range" min="14" max="28" step="1"></label>
    <label>Cartões novos por sessão <input id="pref-new" type="number" min="0" max="500" style="width:5em"></label>`;
  $("#pref-theme", container).value = p.theme;
  $("#pref-font", container).value = p.fontSize;
  $("#pref-new", container).value = p.newPerSession;
  $("#pref-theme", container).onchange = (e) => setPrefs({ theme: e.target.value });
  $("#pref-font", container).oninput = (e) => setPrefs({ fontSize: Number(e.target.value) });
  $("#pref-new", container).onchange = (e) => setPrefs({ newPerSession: Math.max(0, Math.min(500, Number(e.target.value) || 0)) });
}

let toastTimer;
export function toast(message, kind = "ok", ms = 4000) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = message;
  el.className = `toast ${kind} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

export function showBanner(container, message, kind = "error") {
  container.innerHTML = message ? `<div class="banner ${kind}" role="alert">${escapeHtml(message).replace(/\n/g, "<br>")}</div>` : "";
}

export function download(filename, text, mime = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function readFileText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error("Falha ao ler o arquivo.")); r.readAsText(file); });
}

// <option>s da árvore de assuntos (recuados). Valores: id do nó, "" (todos) e "__none__" (sem assunto).
export const NONE = "__none__";
export function topicSelectOptions(topics, { allLabel = null, noneLabel = null, exclude = null } = {}) {
  let h = "";
  if (allLabel != null) h += `<option value="">${escapeHtml(allLabel)}</option>`;
  if (noneLabel != null) h += `<option value="${NONE}">${escapeHtml(noneLabel)}</option>`;
  for (const n of flattenTree(topics)) {
    if (exclude && exclude.has(n.id)) continue;
    h += `<option value="${escapeHtml(n.id)}">${"\u00a0\u00a0\u00a0".repeat(n.depth)}${escapeHtml(n.name)}</option>`;
  }
  return h;
}

export function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

applyPrefs();
