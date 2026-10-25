// ==UserScript==
// @name         Coletor Persistente de Questões - Gran Cursos
// @namespace    https://local.plataforma-concursos/coletor-gran
// @version      1.1.0
// @description  Coleta questões do Gran Cursos, guarda de forma persistente (GM_setValue) e exporta TXT compatível com o importador.
// @match        https://questoes.grancursosonline.com.br/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  /* =====================================================================
   * CONFIGURAÇÃO — ajuste aqui se o HTML do site mudar
   * ===================================================================== */
  const CONFIG = {
    chaveArmazenamento: 'gran_coletor_questoes_v1',
    coletaAutomatica: true,          // coleta sozinha quando a questão carregar
    atrasoObservadorMs: 900,         // debounce do MutationObserver
    aceitarSemCodigo: false,         // true = usa hash do enunciado quando não há código Qxxxx
    separadorQuestoes: '\n\n',       // SUPOSIÇÃO: o importador separa pelo cabeçalho [Q...](url). Se precisar de "---", use '\n\n---\n\n'
    seletores: {
      cartao: ['.ds-question', '[class*="ds-question"][class*="__"]:not([class*="__body"])'],
      enunciado: ['.ds-question__body__statement'],
      alternativa: ['.ds-question__body__options__option__description'],
      // Estrutura verificada no HTML real colado pelo usuário (página de listagem, out/2026):
      ordem: ['.ds-question__header__top__order'],            // posição na listagem (ex.: 661) -> numeroQuestao
      idLink: ['.ds-question__header__top__id a'],            // texto "Q197572" + href da questão
      assuntoContainer: ['.ds-question__header__top__subject'], // 1º <a> filho direto = disciplina, 2º = assunto
      infoInferior: ['.ds-question__header__bottom__info'],   // "Ano:", "Banca:", "Prova:" + valor
      opcao: ['.ds-question__body__options__option'],         // cada alternativa (contém rótulo + descrição)
      opcaoRotulo: ['.ds-question__body__options__option__label'], // letra A, B, C...
      // Seletores individuais antigos (fallback); vazios porque o container acima já cobre.
      numeroQuestao: [],
      disciplina: [],
      assunto: [],
      ano: [],
      banca: [],
      prova: [],
      links: ['a[href*="questoes-de-concursos"]', 'a[href*="questao"]']
    },
    regexCodigo: /\bQ\d{4,9}\b/
  };

  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const LETRAS = 'ABCDEFGHIJ';
  const PREFIXO = '[Coletor Gran]';

  /* =====================================================================
   * Armazenamento persistente
   * ===================================================================== */
  const temGM = (typeof GM_getValue === 'function' && typeof GM_setValue === 'function');

  function lerBruto() {
    if (temGM) return GM_getValue(CONFIG.chaveArmazenamento, '');
    return localStorage.getItem(CONFIG.chaveArmazenamento) || '';
  }
  function gravarBruto(texto) {
    if (temGM) GM_setValue(CONFIG.chaveArmazenamento, texto);
    else localStorage.setItem(CONFIG.chaveArmazenamento, texto);
  }

  function carregar() {
    let bruto;
    try { bruto = lerBruto(); }
    catch (e) { throw new Error('Falha ao LER o armazenamento: ' + e.message); }
    if (!bruto) return { versao: 1, questoes: {}, ordem: [] };
    try {
      const obj = JSON.parse(bruto);
      if (!obj || typeof obj.questoes !== 'object') throw new Error('estrutura inválida');
      if (!Array.isArray(obj.ordem)) obj.ordem = Object.keys(obj.questoes);
      return obj;
    } catch (e) {
      // NÃO sobrescreve: preserva o bruto para recuperação manual
      console.error(PREFIXO, 'Dados armazenados ilegíveis. Conteúdo bruto preservado em __coletorQuestoesGran.brutoCorrompido()', e);
      throw new Error('Dados armazenados estão corrompidos (nada foi apagado): ' + e.message);
    }
  }

  function salvar(db) {
    const texto = JSON.stringify(db);
    try { gravarBruto(texto); }
    catch (e) { throw new Error('Falha ao GRAVAR no armazenamento: ' + e.message); }
    // verificação de leitura de volta
    let volta;
    try { volta = lerBruto(); } catch (e) { throw new Error('Gravou, mas falhou ao reler: ' + e.message); }
    if (volta !== texto) throw new Error('Verificação falhou: o valor lido difere do gravado.');
  }

  /* =====================================================================
   * Utilidades
   * ===================================================================== */
  function qs(raiz, lista) {
    for (const s of lista) {
      try { const el = raiz.querySelector(s); if (el) return el; } catch (_) { /* seletor inválido */ }
    }
    return null;
  }
  function qsa(raiz, lista) {
    for (const s of lista) {
      try { const els = raiz.querySelectorAll(s); if (els.length) return Array.from(els); } catch (_) { /* ignora */ }
    }
    return [];
  }
  function textoLimpo(el) {
    if (!el) return '';
    const t = (el.innerText != null ? el.innerText : el.textContent) || '';
    return t.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  }
  function normalizar(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  }
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36).toUpperCase();
  }
  function agora() { return new Date().toISOString(); }
  function vazio(v) { return v == null || v === '' || (Array.isArray(v) && v.length === 0); }

  /* =====================================================================
   * Extração
   * ===================================================================== */
  function encontrarCartoes() {
    const lista = qsa(document, CONFIG.seletores.cartao);
    // remove cartões aninhados (mantém o mais externo)
    return lista.filter(el => !lista.some(o => o !== el && o.contains(el)));
  }

  function extrairCodigo(cartao, totalCartoes) {
    // 0) Estrutura conhecida: <div class="...__top__id"><a href="/.../197572">Q197572</a>
    const idLink = qs(cartao, CONFIG.seletores.idLink);
    if (idLink) {
      const mId = textoLimpo(idLink).match(CONFIG.regexCodigo);
      if (mId) return { codigo: mId[0], url: idLink.href || '' };
    }
    // 1) atributos/links dentro do cartão
    const html = cartao.outerHTML || '';
    const links = qsa(cartao, CONFIG.seletores.links);
    for (const a of links) {
      const m = (a.getAttribute('href') || '').match(CONFIG.regexCodigo);
      if (m) return { codigo: m[0], url: a.href };
    }
    const mTxt = textoLimpo(cartao).match(CONFIG.regexCodigo);
    if (mTxt) return { codigo: mTxt[0], url: '' };
    const mHtml = html.match(CONFIG.regexCodigo);
    if (mHtml) return { codigo: mHtml[0], url: '' };
    // 2) URL da página, somente se houver um único cartão (senão seria ambíguo)
    if (totalCartoes === 1) {
      const mUrl = location.href.match(CONFIG.regexCodigo);
      if (mUrl) return { codigo: mUrl[0], url: location.href };
    }
    return { codigo: '', url: '' };
  }

  // Metadados na estrutura real do Gran (disciplina/assunto, ano/banca/prova, ordem)
  function extrairMetadadosGran(cartao) {
    const r = { numero: '', disciplina: '', assunto: '', ano: '', banca: '', prova: '' };
    const ordem = qs(cartao, CONFIG.seletores.ordem);
    if (ordem) r.numero = (textoLimpo(ordem).match(/\d+/) || [''])[0];

    const subj = qs(cartao, CONFIG.seletores.assuntoContainer);
    if (subj) {
      // somente <a> filhos diretos: o dropdown "+" traz assuntos adicionais e é ignorado de propósito
      const links = Array.from(subj.children).filter(c => c.tagName === 'A');
      if (links[0]) r.disciplina = textoLimpo(links[0]).replace(/\s+/g, ' ');
      if (links[1]) r.assunto = textoLimpo(links[1]).replace(/\s+/g, ' ');
    }

    qsa(cartao, CONFIG.seletores.infoInferior).forEach(info => {
      const t = textoLimpo(info).replace(/\s+/g, ' ');
      const m = t.match(/^(Ano|Banca|Prova)\s*:\s*(.+)$/i);
      if (m) r[m[1].toLowerCase()] = m[2].trim();
    });
    return r;
  }

  function metaPorSeletor(cartao, campo) {
    const el = qs(cartao, CONFIG.seletores[campo] || []);
    return el ? textoLimpo(el).replace(/^[A-Za-zÀ-ú ]+:\s*/, '') : '';
  }

  function metaPorRotulo(cartao, enunciadoEl, opcoesEls) {
    // Procura linhas "Rótulo: valor" fora do enunciado e das alternativas.
    const clone = cartao.cloneNode(true);
    const remover = [];
    if (enunciadoEl) remover.push(...qsa(clone, CONFIG.seletores.enunciado));
    remover.push(...qsa(clone, CONFIG.seletores.alternativa));
    remover.forEach(n => { try { n.remove(); } catch (_) { /* ignora */ } });
    // Usa o texto de cada elemento-folha (e também quebras de linha), pois textContent não separa blocos.
    const partes = [];
    clone.querySelectorAll('*').forEach(n => { if (!n.children.length) partes.push(n.textContent || ''); });
    partes.push(clone.textContent || '');
    const linhas = partes.join('\n').split(/\n|\r/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const res = {};
    const mapa = { disciplina: /^Disciplina\s*[:\-]\s*(.+)$/i, assunto: /^Assunto\s*[:\-]\s*(.+)$/i,
      ano: /^Ano\s*[:\-]\s*(\d{4})\b/i, banca: /^Banca\s*[:\-]\s*(.+)$/i, prova: /^Prova\s*[:\-]\s*(.+)$/i };
    for (const l of linhas) {
      for (const k in mapa) {
        if (!res[k]) { const m = l.match(mapa[k]); if (m) res[k] = m[1].trim(); }
      }
    }
    return res;
  }

  function extrairQuestao(cartao, totalCartoes) {
    const enunciadoEl = qs(cartao, CONFIG.seletores.enunciado);
    const enunciado = textoLimpo(enunciadoEl);
    const opcoesEls = qsa(cartao, CONFIG.seletores.alternativa);
    // Preferência: usar a letra real exibida no rótulo (A, B, C...) de cada opção
    const blocosOpcao = qsa(cartao, CONFIG.seletores.opcao);
    let alternativas = [];
    if (blocosOpcao.length) {
      alternativas = blocosOpcao.map((bloco, i) => {
        const desc = qs(bloco, CONFIG.seletores.alternativa);
        let t = textoLimpo(desc).replace(/^\(?[A-Ja-j]\s*[\)\.\-]\s*/, '');
        const rot = textoLimpo(qs(bloco, CONFIG.seletores.opcaoRotulo)).replace(/[^A-Za-z]/g, '').toUpperCase();
        const letra = /^[A-J]$/.test(rot) ? rot : (LETRAS[i] || String(i + 1));
        return t ? letra + ') ' + t : '';
      }).filter(Boolean);
    } else {
      alternativas = opcoesEls.map((el, i) => {
        let t = textoLimpo(el).replace(/^\(?[A-Ja-j]\s*[\)\.\-]\s*/, '');
        return t ? (LETRAS[i] || String(i + 1)) + ') ' + t : '';
      }).filter(Boolean);
    }

    const { codigo, url } = extrairCodigo(cartao, totalCartoes);
    const gran = extrairMetadadosGran(cartao);
    const porRotulo = metaPorRotulo(cartao, enunciadoEl, opcoesEls);
    const pick = (campo) => (gran[campo] || metaPorSeletor(cartao, campo) || porRotulo[campo] || '');
    let ano = pick('ano');
    const mAno = String(ano).match(/\b(19|20)\d{2}\b/);
    ano = mAno ? mAno[0] : '';

    // URL: a da própria questão (link do código). A URL da página só vale se for a página dessa questão.
    const idNum = (codigo.match(/\d+/) || [''])[0];
    const urlPagina = (idNum && location.href.indexOf(idNum) !== -1) ? location.href : '';

    return {
      codigoOriginal: codigo,
      urlOriginal: url || urlPagina,
      numeroQuestao: gran.numero || (metaPorSeletor(cartao, 'numeroQuestao').match(/\d+/) || [''])[0],
      disciplina: pick('disciplina'),
      assunto: pick('assunto'),
      ano: ano,
      banca: pick('banca'),
      prova: pick('prova'),
      enunciado: enunciado,
      alternativas: alternativas,
      coletadoEm: agora()
    };
  }

  function chaveDe(q) {
    if (q.codigoOriginal) return q.codigoOriginal;
    if (CONFIG.aceitarSemCodigo && q.enunciado) return 'H' + hash(normalizar(q.enunciado));
    return '';
  }

  function mesclar(antiga, nova) {
    const r = Object.assign({}, antiga);
    for (const k of Object.keys(nova)) {
      if (k === 'coletadoEm') continue;
      const v = nova[k];
      if (vazio(v)) continue;                       // nunca troca válido por vazio
      if (k === 'alternativas' && !vazio(antiga.alternativas) && v.length < antiga.alternativas.length) continue;
      r[k] = v;
    }
    r.coletadoEm = antiga.coletadoEm || nova.coletadoEm;
    r.atualizadoEm = agora();
    return r;
  }

  /* =====================================================================
   * Coleta
   * ===================================================================== */
  let ultimaAssinatura = '';

  function coletar(opcoes) {
    const silencioso = !!(opcoes && opcoes.silencioso);
    const resultado = { novas: 0, atualizadas: 0, inalteradas: 0, ignoradas: 0, avisos: [] };
    let cartoes;
    try { cartoes = encontrarCartoes(); } catch (e) { cartoes = []; }
    if (!cartoes.length) {
      resultado.avisos.push('Nenhum cartão de questão encontrado (seletor: ' + CONFIG.seletores.cartao.join(' | ') + '). Rode diagnostico().');
      if (!silencioso) notificar(resultado.avisos[0], 'erro');
      return resultado;
    }
    let db;
    try { db = carregar(); }
    catch (e) { resultado.avisos.push(e.message); notificar(e.message, 'erro'); return resultado; }

    let mudou = false;
    for (const cartao of cartoes) {
      let q;
      try { q = extrairQuestao(cartao, cartoes.length); }
      catch (e) { resultado.ignoradas++; resultado.avisos.push('Erro ao extrair: ' + e.message); continue; }
      if (!q.enunciado) { resultado.ignoradas++; resultado.avisos.push('Questão sem enunciado (página ainda carregando ou seletor mudou).'); continue; }
      if (!q.alternativas.length) { resultado.avisos.push('Questão ' + (q.codigoOriginal || '?') + ' sem alternativas encontradas (coletada mesmo assim).'); }
      const chave = chaveDe(q);
      if (!chave) { resultado.ignoradas++; resultado.avisos.push('Questão sem código identificador (Qxxxx) — ignorada. Ajuste regexCodigo ou ative aceitarSemCodigo.'); continue; }
      if (!q.codigoOriginal) q.codigoOriginal = chave;

      if (db.questoes[chave]) {
        const antes = JSON.stringify(db.questoes[chave]);
        const depois = mesclar(db.questoes[chave], q);
        const cmp = Object.assign({}, depois); delete cmp.atualizadoEm;
        const ant = JSON.parse(antes); delete ant.atualizadoEm;
        if (JSON.stringify(cmp) === JSON.stringify(ant)) { resultado.inalteradas++; }
        else { db.questoes[chave] = depois; resultado.atualizadas++; mudou = true; }
      } else {
        db.questoes[chave] = q; db.ordem.push(chave); resultado.novas++; mudou = true;
      }
    }

    if (mudou) {
      try { salvar(db); }
      catch (e) { resultado.avisos.push(e.message); notificar(e.message, 'erro'); return resultado; }
    }
    atualizarContador(db);
    if (!silencioso || mudou) {
      const msg = `Coleta: ${resultado.novas} nova(s), ${resultado.atualizadas} atualizada(s), ${resultado.inalteradas} sem mudança, ${resultado.ignoradas} ignorada(s). Total salvo: ${db.ordem.length}.`;
      notificar(msg, resultado.ignoradas && !resultado.novas && !resultado.atualizadas ? 'erro' : 'ok');
      console.log(PREFIXO, msg, resultado.avisos.length ? resultado.avisos : '');
    }
    return resultado;
  }

  /* =====================================================================
   * Exportação
   * ===================================================================== */
  function formatarQuestao(q) {
    const cod = q.codigoOriginal;
    const url = q.urlOriginal || '';
    const linhas = [`[${cod}](${url})`];
    if (q.numeroQuestao) linhas.push('Questão: ' + q.numeroQuestao);
    if (q.disciplina) linhas.push('Disciplina: ' + q.disciplina);
    if (q.assunto) linhas.push('Assunto: ' + q.assunto);
    if (q.ano) linhas.push('Ano: ' + q.ano);
    if (q.banca) linhas.push('Banca: ' + q.banca);
    if (q.prova) linhas.push('Prova: ' + q.prova);
    linhas.push('');
    linhas.push(q.enunciado || '');
    linhas.push('');
    (q.alternativas || []).forEach(a => linhas.push(a));
    return linhas.join('\n');
  }

  function gerarTXT() {
    const db = carregar();
    return db.ordem.filter(k => db.questoes[k]).map(k => formatarQuestao(db.questoes[k])).join(CONFIG.separadorQuestoes) + '\n';
  }

  function baixarArquivo(nome, conteudo, tipo) {
    const blob = new Blob([conteudo], { type: tipo || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }
  function carimbo() {
    const d = new Date(); const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /* =====================================================================
   * API pública
   * ===================================================================== */
  const api = {
    adicionar() { return coletar({ silencioso: false }); },
    total() {
      try { const n = carregar().ordem.length; console.log(PREFIXO, 'Total armazenado:', n); atualizarContador(); return n; }
      catch (e) { notificar(e.message, 'erro'); return -1; }
    },
    visualizar() {
      try {
        const db = carregar();
        const linhas = db.ordem.map(k => db.questoes[k]).filter(Boolean).map(q => ({
          codigo: q.codigoOriginal, disciplina: q.disciplina, assunto: q.assunto, ano: q.ano, banca: q.banca,
          alternativas: (q.alternativas || []).length, enunciado: (q.enunciado || '').slice(0, 80)
        }));
        console.table(linhas);
        abrirModal(linhas);
        return linhas;
      } catch (e) { notificar(e.message, 'erro'); return []; }
    },
    copiar() {
      try {
        const txt = gerarTXT();
        if (typeof GM_setClipboard === 'function') GM_setClipboard(txt, 'text');
        else if (navigator.clipboard) navigator.clipboard.writeText(txt);
        else throw new Error('Nenhuma API de área de transferência disponível.');
        notificar('TXT copiado para a área de transferência.', 'ok');
        return true;
      } catch (e) { notificar('Falha ao copiar: ' + e.message, 'erro'); return false; }
    },
    exportar() {
      try {
        const db = carregar();
        if (!db.ordem.length) { notificar('Nada a exportar: 0 questões armazenadas.', 'erro'); return false; }
        baixarArquivo(`questoes_gran_${carimbo()}.txt`, gerarTXT());
        notificar(`Exportadas ${db.ordem.length} questões.`, 'ok');
        return true;
      } catch (e) { notificar('Falha na exportação: ' + e.message, 'erro'); return false; }
    },
    diagnostico() {
      const info = {
        url: location.href, armazenamento: temGM ? 'GM_setValue/GM_getValue' : 'localStorage (fallback — NÃO é compartilhado com outros domínios)',
        cartoes: 0, enunciados: 0, alternativas: 0, codigosDetectados: []
      };
      const cartoes = encontrarCartoes();
      info.cartoes = cartoes.length;
      cartoes.forEach(c => {
        if (qs(c, CONFIG.seletores.enunciado)) info.enunciados++;
        info.alternativas += qsa(c, CONFIG.seletores.alternativa).length;
        info.codigosDetectados.push(extrairCodigo(c, cartoes.length).codigo || '(sem código)');
      });
      info.enunciadosNoDocumento = qsa(document, CONFIG.seletores.enunciado).length;
      info.alternativasNoDocumento = qsa(document, CONFIG.seletores.alternativa).length;
      if (cartoes[0]) {
        const clone = cartoes[0].cloneNode(true);
        [...qsa(clone, CONFIG.seletores.enunciado), ...qsa(clone, CONFIG.seletores.alternativa)].forEach(n => n.remove());
        info.textoDoCabecalhoDoPrimeiroCartao = (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      }
      if (cartoes[0]) { try { info.amostraPrimeiraQuestaoExtraida = extrairQuestao(cartoes[0], cartoes.length); } catch (e) { info.amostraPrimeiraQuestaoExtraida = 'erro: ' + e.message; } }
      try { info.totalArmazenado = carregar().ordem.length; } catch (e) { info.totalArmazenado = 'erro: ' + e.message; }
      console.log(PREFIXO, 'Diagnóstico:', info);
      return info;
    },
    backupJSON() {
      try { baixarArquivo(`backup_coletor_gran_${carimbo()}.json`, JSON.stringify(carregar(), null, 2), 'application/json'); notificar('Backup JSON baixado.', 'ok'); return true; }
      catch (e) { notificar('Falha no backup: ' + e.message, 'erro'); return false; }
    },
    restaurarBackup(textoJSON) {
      // Mescla (não substitui) um backup JSON no armazenamento atual.
      try {
        const bk = JSON.parse(textoJSON); const db = carregar(); let n = 0;
        for (const k of (bk.ordem || Object.keys(bk.questoes || {}))) {
          const q = bk.questoes[k]; if (!q) continue;
          if (db.questoes[k]) db.questoes[k] = mesclar(db.questoes[k], q); else { db.questoes[k] = q; db.ordem.push(k); n++; }
        }
        salvar(db); atualizarContador(db); notificar(`Backup mesclado: ${n} questão(ões) nova(s).`, 'ok'); return n;
      } catch (e) { notificar('Falha ao restaurar: ' + e.message, 'erro'); return -1; }
    },
    brutoCorrompido() { try { return lerBruto(); } catch (e) { return 'erro: ' + e.message; } },
    limpar() {
      // Exige confirmação explícita (diálogo + digitação). Não existe botão no painel.
      const n = (() => { try { return carregar().ordem.length; } catch (_) { return '?'; } })();
      if (!window.confirm(`Apagar TODAS as ${n} questões armazenadas? Isso é irreversível. Faça backup antes.`)) return false;
      const resp = window.prompt('Digite APAGAR TUDO para confirmar:');
      if (resp !== 'APAGAR TUDO') { notificar('Limpeza cancelada.', 'ok'); return false; }
      try {
        if (temGM && typeof GM_deleteValue === 'function') GM_deleteValue(CONFIG.chaveArmazenamento);
        else localStorage.removeItem(CONFIG.chaveArmazenamento);
        atualizarContador(); notificar('Armazenamento limpo.', 'ok'); return true;
      } catch (e) { notificar('Falha ao limpar: ' + e.message, 'erro'); return false; }
    },
    ajuda() {
      const t = [
        'Comandos de window.__coletorQuestoesGran:',
        '  adicionar()      coleta a(s) questão(ões) da página atual',
        '  total()          quantidade armazenada',
        '  visualizar()     tabela no console + janela no painel',
        '  copiar()         copia o TXT para a área de transferência',
        '  exportar()       baixa o TXT',
        '  diagnostico()    conta cartões/enunciados/alternativas e mostra o armazenamento',
        '  backupJSON()     baixa backup completo em JSON',
        '  restaurarBackup(texto)  mescla um backup JSON',
        '  limpar()         apaga tudo (pede confirmação dupla)',
        'Versão ' + VERSAO
      ].join('\n');
      console.log(t); return t;
    },
    versao: undefined
  };
  const VERSAO = '1.1.0';
  api.versao = VERSAO;

  try { W.__coletorQuestoesGran = api; }
  catch (e) { console.error(PREFIXO, 'Não foi possível expor o objeto global:', e); }

  /* =====================================================================
   * Painel (Shadow DOM, discreto, canto inferior esquerdo)
   * ===================================================================== */
  let sombra = null, elContador = null, elMsg = null, hostEl = null, timerMsg = null;

  function criarPainel() {
    if (document.getElementById('gran-coletor-host') || !document.body) return;
    hostEl = document.createElement('div');
    hostEl.id = 'gran-coletor-host';
    hostEl.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;';
    sombra = hostEl.attachShadow({ mode: 'open' });
    sombra.innerHTML = `
      <style>
        .box{font:12px/1.3 system-ui,sans-serif;background:#1f2937;color:#f3f4f6;border-radius:8px;padding:6px 8px;box-shadow:0 2px 8px rgba(0,0,0,.35);max-width:230px;opacity:.92}
        .top{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
        .corpo{margin-top:6px;display:none;flex-direction:column;gap:4px}
        .box.aberto .corpo{display:flex}
        button{font:12px system-ui,sans-serif;border:0;border-radius:5px;padding:4px 6px;background:#374151;color:#fff;cursor:pointer}
        button:hover{background:#4b5563}
        .msg{font-size:11px;min-height:14px}
        .ok{color:#86efac}.erro{color:#fca5a5}
        .modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center}
        .modal.aberto{display:flex}
        .modal .c{background:#fff;color:#111;border-radius:8px;width:min(900px,92vw);max-height:80vh;overflow:auto;padding:12px;font:12px system-ui,sans-serif}
        .modal table{border-collapse:collapse;width:100%}
        .modal td,.modal th{border-bottom:1px solid #ddd;padding:3px 5px;text-align:left;vertical-align:top}
      </style>
      <div class="box" id="box">
        <div class="top" id="topo">📚 <b>Coletor</b> <span id="cont">…</span></div>
        <div class="corpo">
          <button id="bColetar">Coletar questão atual</button>
          <button id="bExportar">Exportar TXT</button>
          <button id="bVisualizar">Visualizar questões</button>
          <div class="msg" id="msg"></div>
        </div>
      </div>
      <div class="modal" id="modal"><div class="c" id="modalC"></div></div>`;
    document.body.appendChild(hostEl);
    elContador = sombra.getElementById('cont');
    elMsg = sombra.getElementById('msg');
    sombra.getElementById('topo').addEventListener('click', () => sombra.getElementById('box').classList.toggle('aberto'));
    sombra.getElementById('bColetar').addEventListener('click', () => api.adicionar());
    sombra.getElementById('bExportar').addEventListener('click', () => api.exportar());
    sombra.getElementById('bVisualizar').addEventListener('click', () => api.visualizar());
    sombra.getElementById('modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') ev.currentTarget.classList.remove('aberto'); });
    atualizarContador();
  }

  function atualizarContador(db) {
    if (!elContador) return;
    try { elContador.textContent = String((db || carregar()).ordem.length) + ' salvas'; }
    catch (_) { elContador.textContent = 'erro'; }
  }

  function notificar(msg, tipo) {
    if (tipo === 'erro') console.warn(PREFIXO, msg); else console.log(PREFIXO, msg);
    if (!elMsg) return;
    elMsg.className = 'msg ' + (tipo === 'erro' ? 'erro' : 'ok');
    elMsg.textContent = msg;
    clearTimeout(timerMsg);
    timerMsg = setTimeout(() => { if (elMsg) elMsg.textContent = ''; }, 9000);
    if (sombra) sombra.getElementById('box').classList.add('aberto');
  }

  function abrirModal(linhas) {
    if (!sombra) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const corpo = linhas.map(l => `<tr><td>${esc(l.codigo)}</td><td>${esc(l.disciplina)}</td><td>${esc(l.ano)}</td><td>${esc(l.banca)}</td><td>${l.alternativas}</td><td>${esc(l.enunciado)}</td></tr>`).join('');
    sombra.getElementById('modalC').innerHTML = `<b>${linhas.length} questão(ões) armazenada(s)</b> (clique fora para fechar)
      <table><tr><th>Código</th><th>Disciplina</th><th>Ano</th><th>Banca</th><th>Alt.</th><th>Enunciado</th></tr>${corpo}</table>`;
    sombra.getElementById('modal').classList.add('aberto');
  }

  /* =====================================================================
   * Observador (coleta automática com debounce)
   * ===================================================================== */
  let timerObs = null, tentativas = 0;

  function agendarColeta() {
    clearTimeout(timerObs);
    timerObs = setTimeout(() => {
      try {
        // só tenta quando há cartão com enunciado; evita ruído em páginas de listagem vazia
        const cartoes = encontrarCartoes();
        if (!cartoes.length || !cartoes.some(c => qs(c, CONFIG.seletores.enunciado))) return;
        const assinatura = location.href + '|' + cartoes.map(c => (textoLimpo(qs(c, CONFIG.seletores.enunciado)) || '').slice(0, 60)).join('~');
        if (assinatura === ultimaAssinatura) return;           // nada novo na tela
        const r = coletar({ silencioso: true });
        // só marca como processado se não houve erro de armazenamento
        if (!r.avisos.some(a => /armazenamento|GRAVAR|LER|corromp/i.test(a))) ultimaAssinatura = assinatura;
      } catch (e) { console.warn(PREFIXO, 'Erro na coleta automática:', e); }
    }, CONFIG.atrasoObservadorMs);
  }

  function iniciarObservador() {
    if (!CONFIG.coletaAutomatica || !document.body) return;
    const obs = new MutationObserver((muts) => {
      // ignora mutações geradas pelo próprio painel
      if (muts.every(m => hostEl && (m.target === hostEl || hostEl.contains(m.target)))) return;
      agendarColeta();
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    agendarColeta(); // primeira tentativa
  }

  /* =====================================================================
   * Inicialização
   * ===================================================================== */
  function iniciar() {
    criarPainel();
    iniciarObservador();
    console.log(PREFIXO, 'v' + VERSAO + ' ativo. Digite window.__coletorQuestoesGran.ajuda()');
    if (!temGM) console.warn(PREFIXO, 'GM_setValue indisponível: usando localStorage (menos robusto).');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
