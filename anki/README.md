# Flashcards pessoais com FSRS (HTML + Firestore + GitHub Pages)

Sistema de flashcards com revisão espaçada **FSRS**, um único núcleo para todas as matérias, dados no **Firestore**, hospedagem estática no **GitHub Pages**. Sem login nesta versão.

## Estrutura

```
anki-pessoal/
├── index.html            escolha da disciplina + resumo geral
├── anki.html             revisão, gerenciamento de cartões e backup (genérico: ?materia=<id>)
├── relatorios.html       indicadores e tabelas por matéria/período
├── carregar.html         carga em lote de cartões (colar texto/planilha ou arquivo CSV)
├── assuntos.html         gerenciar a árvore de assuntos e mover cartões entre assuntos
├── limpar.html           apagar dados (com backup obrigatório antes)
├── config/subjects.js    LISTA DE DISCIPLINAS (único arquivo a editar para criar matérias)
├── css/style.css
├── js/
│   ├── firebase-config.js  SEUS valores do Firebase (preencher)
│   ├── model.js            funções puras: datas, validação, fila, texto seguro, CSV, importação
│   ├── fsrs.js             camada fina sobre a biblioteca ts-fsrs
│   ├── statistics.js       estatísticas (puras, sem DOM/Firebase)
│   ├── anki-core.js        acesso ao Firestore (genérico por disciplina)
│   ├── app.js              utilitários de interface e preferências locais
│   └── page-*.js           controladores de cada página
├── firestore.rules       regras do Firestore (LEIA a seção de segurança)
├── tests/logic.test.js   testes automatizados (Node) dos módulos puros
└── package.json          só para os testes; o site não usa npm
```

## Bibliotecas (carregadas por CDN via `importmap`, sem build)

| Biblioteca | Versão | Origem |
|---|---|---|
| ts-fsrs (FSRS-6) | 5.4.1 | https://www.npmjs.com/package/ts-fsrs · https://github.com/open-spaced-repetition/ts-fsrs · servida por `cdn.jsdelivr.net/npm/ts-fsrs@5.4.1/dist/index.mjs` |
| Firebase JS SDK (modular) | 11.10.0 | https://firebase.google.com/docs/web/setup · servida por `www.gstatic.com/firebasejs/11.10.0/` |

Os agendamentos vêm de `scheduler.repeat()` da ts-fsrs; o projeto não reimplementa o algoritmo. Para trocar de versão, altere o `importmap` nas três páginas `.html`.

## Configurar o Firebase (passo a passo)

1. Acesse https://console.firebase.google.com → **Adicionar projeto** (pode desativar o Google Analytics).
2. No projeto: ícone **`</>`** (Web) → registre o app (apelido livre; **não** marque Firebase Hosting).
3. **Build → Firestore Database → Criar banco de dados**. Escolha uma região próxima (ex.: `southamerica-east1`) e o modo **produção** (as regras abaixo liberam o necessário).
4. Aba **Regras** do Firestore: cole o conteúdo de `firestore.rules` e **Publicar** (ou `firebase deploy --only firestore:rules` se usar a CLI).
5. `js/firebase-config.js` já está preenchido com o projeto `questoessimplepresent`. (Analytics não é usado e não é carregado.)
6. Teste localmente (precisa de servidor HTTP, `file://` não funciona com módulos): `python3 -m http.server 8000` e abra `http://localhost:8000`.
7. Verificação de gravação: crie um cartão na aba **Cartões**, depois confira em *Firestore → Dados* o documento em `subjects/<id>/cards/…`. Recarregue a página: o cartão deve continuar lá. Avalie o cartão: deve surgir um documento em `subjects/<id>/review_events/…`.

## Publicar no GitHub Pages

1. Crie um repositório e envie o conteúdo da pasta (sem `node_modules`; há `.gitignore`).
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, pasta `/ (root)`.
3. Aguarde o link `https://<usuario>.github.io/<repositorio>/`. Funciona em HTTPS.
4. Atalhos por matéria: `…/anki.html?materia=tributario`, `…/anki.html?materia=contabilidade`.

## Adicionar uma matéria

Acrescente uma linha em `config/subjects.js` (ex.: `{ id: "civil", name: "Direito Civil" }`). Id: minúsculas, números e `_`, 2–40 caracteres; **nunca mude o id depois** de ter cartões. Não é preciso alterar mais nada (nem as regras do Firestore, que aceitam qualquer id válido).

## Modelo de dados (Firestore)

```
subjects/{id}/cards/{cardId}
subjects/{id}/review_events/{cardId}__{n}
subjects/{id}/topics/{topicId}
```

**Cartão**: `id, subject, front, back, topicId, createdAt, updatedAt, suspended, fsrs{due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, learning_steps, state, last_review}` (mesmas chaves do `Card` da ts-fsrs). `topicId` aponta para um nó da árvore de assuntos (ou `null` = sem assunto). Cartões da versão 1 podem ainda ter `topic`/`subtopic` em texto; a página **Assuntos** (ou o aviso em **Cartões**) converte para a árvore com um clique e campos derivados para consulta/lista: `state, due, lastReview, reps, lapses, reviewCount, schemaVersion`. `reviewCount` é o total de avaliações da história do cartão (não zera ao reiniciar o agendamento).

**Evento**: `id, cardId, subject, reviewedAt, rating (1 De novo, 2 Difícil, 3 Bom, 4 Fácil), reviewNumber, stateBefore/After, dueBefore/After, scheduledDaysBefore/After, elapsedDays, stability/difficulty antes e depois, durationMs, schemaVersion`.

**Datas**: todo instante é string ISO-8601 em **UTC** (`2026-10-23T15:00:00.000Z`); ordena corretamente como texto e permite consultas por intervalo. A conversão para o **dia local** (fuso do navegador) acontece só na apresentação/agrupamento (`model.js → dayKey`). Revisões às 23:59 e 00:01 locais caem em dias diferentes.

**Consistência**: toda escrita usa **transação** do Firestore. Uma revisão atualiza o cartão e cria o evento na mesma transação, e só é aceita se `reviewCount` no servidor for igual ao que a tela viu (impede revisão duplicada por clique duplo ou por dois aparelhos). O id do evento é determinístico (`cardId__n`). Se a gravação falhar, o cartão continua na tela e **nada** é considerado salvo.

**Assunto (nó da árvore)**: `id, subject, name, parentId (null = principal), order, createdAt, updatedAt, schemaVersion`. Profundidade máxima: 8 níveis. Nomes são únicos entre irmãos (sem diferenciar acento/maiúscula). O caminho de um cartão é calculado da árvore (ex.: Tributos › Impostos › Impostos em espécie); renomear ou mover um assunto não exige reescrever os cartões.

## Assuntos em árvore (`assuntos.html`)

- **Criar vários de uma vez**: digite um assunto por linha, com recuo para subassuntos; o que já existe é reaproveitado.
- **Estrutura**: clique num assunto para ver as ações: + Subassunto, Renomear, Mover, ↑/↓ (ordem entre irmãos) e Excluir. Os números mostram os cartões diretos e, entre parênteses, com subassuntos.
- **Excluir um assunto** apaga também os subassuntos, mas **não apaga cartões**: eles passam para o assunto pai (ou ficam “sem assunto”).
- **Mover cartões em lote**: selecione um assunto, marque os cartões e escolha o destino.
- **Estudar por assunto**: em Cartões → Revisar há o seletor “Assunto da sessão” (inclui os subassuntos). A lista de cartões também filtra por assunto.

## Apagar tudo para reorganizar (`limpar.html`)

Escolha uma disciplina ou todas e o que apagar (cartões, histórico, assuntos). A página (1) mostra as contagens, (2) obriga baixar o **backup completo** (confere se o arquivo tem exatamente o que o servidor tem), (3) só libera o botão depois de você marcar que conferiu o arquivo e digitar APAGAR. **Não há desfazer**, só restaurar o backup (Cartões → Backup → Importar). Para apenas reorganizar, prefira mover assuntos e cartões em **Assuntos**: preserva o histórico.

## Métricas (definições)

Acerto = Difícil, Bom ou Fácil. Erro = De novo (Difícil **não** é erro). Taxa de acerto = acertos ÷ avaliações. **Retenção** = acertos ÷ avaliações feitas em cartões que já estavam no estado Revisão. Vencido = data anterior ao início de hoje (local); Previsto hoje = até o fim de hoje; Pendente agora = data ≤ agora. Tempo: só soma avaliações com tempo confiável (aba sempre visível, ≤ 10 min). Detalhes no cabeçalho de `js/statistics.js` e na página de relatórios.

## Segurança — fase atual: TOTALMENTE ABERTO (decisão do proprietário)

**Estado atual de `firestore.rules`**: qualquer pessoa com o endereço do site pode ler, criar, alterar e apagar tudo em `subjects/**`, inclusive o histórico, sem validação. O restante do banco fica negado. Publique estas regras em Firestore → Regras para o app funcionar. Endurecer fica para a próxima fase (opções abaixo).

### O que a configuração sem login NÃO garante

- Os valores de `firebase-config.js` **não são segredo**; estão no código que o site publica.
- Sem autenticação, o Firestore não sabe quem acessa. **Qualquer pessoa que descobrir o endereço do site ou ler o código pode ler, criar, alterar e excluir cartões** do seu projeto. O id da matéria na URL não é autenticação. **Não há como garantir uso exclusivo seu sem login.**
- Repositório público no GitHub Pages também expõe o código e a configuração.
- As regras atuais só restringem ao caminho `subjects/**`. Não validam formato nem protegem o histórico. (A versão com validação e histórico imutável pode ser restaurada na fase de segurança.)
- Uso recomendado nesta fase: apenas conteúdo de estudo sem dados pessoais, **backup completo periódico** (aba Backup) e acompanhamento do uso no console (alertas de orçamento).
- **Como endurecer** quando os dados forem importantes (não implementado): (1) Firebase Authentication anônimo + regras que aceitem só o seu `uid`; (2) App Check; (3) login com e-mail/Google restrito ao seu endereço. Qualquer uma dessas muda o requisito “sem login”, por isso ficou fora da v1.

## Comportamento sem internet

A fonte dos dados é o Firestore. **Sem conexão**: não é possível carregar cartões novos nem salvar; as operações de escrita falham com mensagem clara e nada é gravado ou contado como feito. **Não há sincronização offline implementada nem testada.** Preferências de aparência ficam no `localStorage` do aparelho.

## Carregar cartões em lote (`carregar.html`)

Escolha a disciplina, cole o texto (uma linha por cartão: `frente ; verso ; assunto ; subtópico`, separador `;`, vírgula ou tabulação — dá para colar direto de uma planilha) ou escolha um arquivo `.csv/.txt`. O **assunto pode ser um caminho** (`Tributos > Impostos > Impostos em espécie`); o que não existir é criado. O subtópico, se houver, vira um nível a mais. O campo “assunto padrão” vale para as linhas sem assunto. **Validar** mostra a prévia e quantos já existem; só então **Importar** grava. Linha inválida bloqueia tudo; frentes repetidas são ignoradas. Os cartões entram como novos (sem histórico).

## Importação e exportação

Aba **Backup**. *Só cartões* (JSON/CSV) = conteúdo e, no JSON, agendamento. *Backup completo* (JSON) = cartões + todos os eventos de histórico. Ambos incluem a árvore de assuntos. Backups antigos (versão 1, sem árvore) continuam sendo aceitos; ao importar, assuntos iguais aos existentes são juntados (sem duplicar). A importação valida tudo antes e **bloqueia o lote inteiro** se houver item inválido; cartões com id já existente são ignorados, a menos que você marque “sobrescrever” (com confirmação); eventos já existentes são ignorados. CSV: `frente;verso;assunto;subtopico` (o assunto pode ser caminho), cria apenas cartões novos e ignora frentes repetidas; a exportação CSV grava o caminho completo na coluna assunto.

## Parâmetros FSRS

Padrões da biblioteca em `js/fsrs.js` (`DEFAULT_FSRS_PARAMS`): retenção desejada 0,90; intervalo máximo 36500 dias; fuzz ligado. Sem otimização automática de pesos. Futuramente, `makeScheduler(overrides)` já aceita parâmetros vindos de uma tela de configuração.

## Observações de uso

- Cartões em (re)aprendizagem com novo prazo ≤ 20 min voltam ao fim da fila da sessão; podem aparecer antes do horário exato (o FSRS aceita revisão antecipada).
- Atalhos na revisão: Espaço/Enter mostra a resposta; 1–4 avalia.
- Custo: a página lê todos os cartões da matéria a cada carga (plano gratuito: 50 mil leituras/dia). O resumo da página inicial lê todas as matérias.

## Testes

- **Automatizados em Node** (`npm install && npm test`; usa `TZ=America/Sao_Paulo`): módulos puros com a ts-fsrs real (FSRS, datas, estatísticas, árvore de assuntos, outline, migração, CSV, backup v1/v2, importação).
- **De navegador (Chromium) contra um Firestore FALSO em memória**, usado só durante o desenvolvimento (não faz parte do projeto): carga em lote, árvore de assuntos, mover cartões, revisão com clique duplo, falha de rede, backup, limpeza e restauração. O falso imita as regras do real que mais causam erro (leituras antes de escritas em transações, recusa de `undefined`). **Nada disso substitui testar com o seu Firestore real**, que é o que importa; faça o checklist de uso depois de publicar.
