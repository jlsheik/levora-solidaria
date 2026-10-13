# Verificação visual reproduzível (`npm run qa:visual`)

Mede **componentes realmente renderizados** em Edge e/ou Chrome já instalados — cores efetivas, estados de hover/ativo/foco por eventos de entrada
reais, tamanho dos campos e contenção horizontal — em **quatro viewports** e **dois temas**, e compara com os critérios WCAG. **Não adiciona
dependências** (usa o WebSocket global do Node ≥ 22, `fetch`, `child_process`, e `postgres`/`tsx`/`vite` que o projeto já tem). Nasceu das
medições manuais da Fase 94 (`docs/ROADMAP_ATUAL.md` §10).

> A mesma infraestrutura também executa a **verificação de segurança** (`npm run qa:security`, seção abaixo).
>
> **Isto não roda no CI** (precisa de navegador e Postgres locais). O que o CI cobre são os testes unitários da lógica
> (`test/qaVisual.test.ts`: contraste, limites, guarda do banco, relatório, viewports, cobertura, limpeza, recuperação de órfãos, cenários) e os
> contratos estáticos de tokens/CSS (`test/tokensContraste.test.ts`). Eles **não** provam que a interface renderizada está correta; quem prova é
> esta rotina. Edge e Chrome compartilham o motor **Blink**: os resultados saem separados por navegador/versão, mas **não** são validação em dois
> motores independentes. Os viewports são **emulados** (tamanho de viewport), não dispositivos reais.

## Como executar

Pré-requisitos: Node 22.x (versão declarada em `package.json`), Edge e/ou Chrome instalados, Postgres local (o mesmo servidor dos testes) e
`npm install` feito.

```bash
npm run qa:visual                                    # tudo: cenários × 4 viewports × 2 temas, nos navegadores encontrados (Edge e Chrome)
npm run qa:visual -- --browser edge --verbose        # só o Edge; mostra também as linhas PASS
npm run qa:visual -- --viewports 375,1280            # subconjunto de viewports (largura ou WxH)
npm run qa:visual -- --only needs-primary-new,matching-switch
npm run qa:visual -- --list                          # lista cenários, viewports e temas
npm run qa:visual -- --self-test                     # prova que o detector acusa regressões e ausências (ver abaixo)
npm run qa:visual -- --inject-css caminho.css        # injeta CSS SÓ no navegador (experimento de regressão); produção intacta
npm run qa:visual -- --screenshots pasta             # grava um PNG por cenário × viewport × tema (inspeção humana)
npm run qa:visual -- --out relatorio.json --keep-db
npm run qa:visual -- --cleanup                       # recupera órfãos de uma execução morta à força e sai
```

**Tempo.** A matriz completa (27 cenários × 4 viewports × 2 temas × 2 navegadores = 432 combinações, ~2 400 verificações) leva ~12 min; só o
Edge, ~6 min; o autoteste, ~2 min 15 s. Para iterar, use `--only`, `--viewports` e `--browser`; a suíte do projeto (`npm test`) não é afetada.

**Banco de dados.** A rotina só usa um banco **local e descartável cujo nome termina em `_qa`** — ela recria o schema `public` a partir de
`db/schema.sql` (mesmo padrão de `test/global-setup.ts`, que exige `_test`). A URL vem de `--db-url`, de `QA_DATABASE_URL` ou é derivada de
`DATABASE_URL` em `.env.test` (`..._test` → `..._qa`; credenciais nunca são impressas nem gravadas no relatório). Banco de desenvolvimento, host
remoto ou nome sem `_qa` são recusados antes de qualquer escrita (código de saída 3). Ao terminar o banco `_qa` é apagado (`--keep-db` mantém).

**Navegadores.** Procurados nos caminhos padrão (Windows, macOS, Linux); `QA_EDGE_PATH`/`QA_CHROME_PATH` definem um caminho explícito (se não
existir, é "ambiente indisponível", sem queda para o padrão). Com `--browser auto` (padrão) um navegador ausente só gera um aviso; com
`--browser edge|chrome` ele é obrigatório.

## O que ela faz

1. Recupera órfãos de uma execução anterior morta à força, ou recusa a execução se outra estiver em andamento (ver "Limpeza").
2. Valida o banco (guarda), recria o schema, semeia dados sintéticos mínimos (`scripts/qa-visual/seed.ts`: dono, voluntário, organização,
   necessidade, item de estoque **com entrada de 5 kg e saída de 1 kg pelos endpoints reais**, capacidade e uma atribuição aceita) e sobe API +
   Vite em **portas livres**.
3. Abre cada navegador **headless** com perfil temporário e porta de depuração escolhida pelo SO.
4. Para cada cenário × viewport × tema: aplica o viewport (`Emulation.setDeviceMetricsOverride`), navega, **confere o que a PÁGINA enxerga**
   (`innerWidth/innerHeight` ± 1 px; redimensionar a janela externa não basta) e registra `viewport` e `viewportInner` em cada linha. Login real
   pela interface (uma sessão por usuário, reaproveitada), tema como o app faz (classe `dark` no `<body>`), passos reais (cliques; envio de um
   **arquivo sintético inválido** ao `<input type=file>` do FileDropzone) e medição.
5. Estados: **hover** (ponteiro real; confirma `:hover`), **ativo** (mouse pressionado e solto FORA do elemento, sem clique), **foco** (tecla real +
   `.focus()`, confirma `:focus-visible`), **normal**, e nos Switches **ligado/desligado** (Espaço real) e **desabilitado**.
6. Calcula as razões de contraste **no Node** (`lib/contrast.mjs`, testado) sobre cores efetivas (pilha de fundos a partir do próprio elemento,
   alfa composto) e aplica o limite do tipo de elemento. Se o viewport não se confirma: conteúdo mais largo que o viewport = **FAIL** (o navegador
   móvel reduz a página); caso contrário `UNMEASURABLE`.
7. Toda combinação recebe também **contenção**: página sem rolagem horizontal; com diálogo aberto, diálogo dentro do viewport e sem rolagem
   horizontal interna.
8. Verifica a **cobertura**: toda combinação navegador × cenário × viewport × tema esperada precisa ter ao menos uma linha; faltando, vira
   `UNMEASURABLE` (nunca "aprovado por omissão").
9. Escreve o relatório JSON (sem credenciais) e encerra navegador, API, Vite, arquivos temporários, perfil e banco.

### Critérios (WCAG 2.x)

| Tipo | Limite | Onde se aplica |
|---|---|---|
| `text` | 4,5:1 (3:1 se ≥ 24 px, ou ≥ 18,66 px em negrito) | texto de botão, de erro (rótulo e mensagem), variação do inventário, título/subtítulo do FileDropzone |
| `icon` | 3:1 | botão só com ícone (`ghost`), ícone de saída do inventário |
| `boundary` | 3:1 | borda de campo (`--input-border`), trilho e polegar do Switch, limite do FileDropzone |
| `ring` | 3:1 contra a superfície | anel de foco (último `box-shadow` ou `outline`); **sem indicador de foco = FAIL**; no FileDropzone o foco entra no `<input>` escondido e o **contêiner** precisa mostrar o indicador |
| `layout` | campo sem excesso > 0,5 px sobre o contêiner, dentro do viewport, `box-sizing: border-box`, altura 40 px (input, gatilho do Select) / mín. 96 px (textarea); página e diálogo contidos | todos os cenários |
| `sinal` | o texto precisa trazer o sinal (`-1`, `+5`) | variação do inventário: o indicador não depende só da cor |
| `info` | sem limite (só registra) | componentes **desabilitados** (isentos de contraste, WCAG 1.4.3) |

### Cobertura (`scripts/qa-visual/scenarios.mjs`)

27 cenários × 2 temas × 4 viewports (375×812, 390×844, 768×1024, 1280×900): `ghost` (ícone, em necessidades e matching, e o botão "Clear error"
do FileDropzone), `primary`, `outline` (também desabilitado), `destructive`, `secondary` (controle), `Switch` (desligado, ligado, foco,
desabilitado como voluntário), `Input`/`Textarea`/`Select`, texto de erro `--error-text` (rótulo e mensagem de um formulário real), variação
**negativa** e positiva do inventário (e ícone de saída) e **FileDropzone** (título, subtítulo, limite, foco por teclado, erro de arquivo
inválido e botão de limpar o erro). Valores de medições anteriores são **referência histórica**: a rotina mede de novo a cada execução.

### Resultados e códigos de saída

| Status | Significado | Efeito |
|---|---|---|
| `PASS` | medido e dentro do critério | — |
| `FAIL` | medido e **fora** do critério (violação real) | saída **1** |
| `MISSING` | o elemento esperado não existe na tela (ou um passo não o achou) | saída **2** |
| `UNMEASURABLE` | existe, mas o estado exigido não pôde ser aplicado, o viewport não se confirmou, o login falhou ou faltou cobertura | saída **2** |
| `SKIP` | dispensado explicitamente | listado no relatório |
| `ENV` | ambiente indisponível (navegador, banco recusado pela guarda, API/Vite não subiram, execução simultânea) | saída **3** |

Autoteste falho = saída **4**. O resumo mostra as verificações **por navegador e viewport**: são verificações, **não componentes independentes**
(o mesmo componente aparece em vários temas, estados e viewports, e nos dois navegadores).

## Autoteste do detector (`--self-test`)

Injeta, **apenas no navegador** (CSS ou JS; nunca o CSS de produção), 14 regressões conhecidas — ícone `ghost` preto no escuro, hover do
`primary`/`destructive`/`outline` na direção errada, trilho do Switch em `--muted`, borda de campo em `--border`, campo `content-box`, texto de
erro no `--error` escuro, campo mais largo que o contêiner e página com rolagem horizontal em 375, variação negativa ilegível e **sem sinal**,
FileDropzone sem indicador de foco e com erro ilegível no escuro — e exige que o cenário correspondente **falhe**. Exige também `MISSING` para um
seletor inexistente e `UNMEASURABLE` para hover em botão desabilitado. Regressão que passe sem ser detectada = detector cego (saída 4).

## Limpeza e interrupções

Tudo é registrado em um `Cleanups` (ordem inversa, continua após falha, idempotente) — também em erro inesperado e Ctrl+C: navegador, perfil
temporário, arquivos sintéticos, API/Vite (árvore de processos) e, por último, o banco `_qa`. Se o orquestrador for **morto à força**, o registro
`%TEMP%/levora-qa-visual/active.json` (PIDs, perfis e nome do banco; **nunca credenciais**) permite que a próxima execução — ou
`npm run qa:visual -- --cleanup` — encerre só PIDs cuja linha de comando ainda é nossa (evita matar um processo que reaproveitou o PID), apague só
diretórios `levora-qa-profile-*` e derrube o banco `_qa`. Uma execução simultânea é recusada (`ENV`), pois ambas recriariam o mesmo banco.

## Verificação de segurança em navegador real (`npm run qa:security`)

Mesma infraestrutura (Edge/Chrome headless por CDP, banco `_qa` descartável, pilha API + Vite em portas livres, limpeza e recuperação de órfãos
compartilhadas — as duas ferramentas recriam o mesmo banco, então uma execução simultânea é recusada), com **dados sintéticos** e servidores
**só em 127.0.0.1**. Nada sai desta máquina e as cargas só pedem uma imagem de 1 pixel ao coletor local.

```bash
npm run qa:security                               # calibração + CSRF + XSS, nos navegadores encontrados (~5 min)
npm run qa:security -- --browser edge --only xss  # só um navegador / só uma parte (calibration, csrf, xss)
npm run qa:security -- --cleanup                  # recupera órfãos de uma execução morta à força
```

Saídas: 0 conforme · 1 falha de segurança · 2 não consegui medir · 3 ambiente indisponível · 4 **calibração do detector falhou** (resultados não confiáveis).

**Calibração primeiro (o detector precisa provar que enxerga).** Antes de olhar o app, a ferramenta ataca *fixtures* próprias, isoladas, que **não
são código de produção**: uma página que usa `innerHTML` (deve ser acusada) e outra `textContent` (não); um `href` `javascript:` ingênuo (deve
executar ao clicar) e um filtrado; e uma "vítima" com cookie `SameSite=Lax` com um endpoint **vulnerável** (deve ser acusado quando atacado do mesmo
site) e outro **guardado por `Sec-Fetch-Site`** (não). Se qualquer uma divergir, CSRF/XSS do app nem rodam (saída 4). Também registra, sem critério, se
`javascript:` em âncora `target=_blank rel=noopener` executa no navegador (nos dois testados: **não**).

**CSRF** (alvo real: `POST /_api/v1/needs`, cria uma necessidade com título-marcador; o efeito é confirmado **no banco**, não só pelo status). Sessão do
dono aberta por login real; páginas de atacante servidas por outra origem, que faz a requisição forjada. Origens: **`cross-site`**
(`http://localhost:porta` → app em `127.0.0.1`; `Sec-Fetch-Site: cross-site`) e **`same-site`** (`http://127.0.0.1:outra-porta`; mesmo site, origem
diferente; `Sec-Fetch-Site: same-site`). Seis tipos: `fetch` `text/plain` no-cors, XHR `text/plain`, `sendBeacon`, formulário `enctype=text/plain` com
corpo JSON válido (navegação de topo), `fetch` `application/json` (exige preflight) e formulário urlencoded. Controles: **mesma origem legítima TEM de
criar** (senão a sonda não prova nada → UNMEASURABLE) e **sem sessão** não pode criar. Evidência por tentativa: `Sec-Fetch-Site`, `Origin`, se o cookie
foi enviado (e o motivo do bloqueio pelo navegador, ex. `SchemefulSameSiteLax`; **nunca o valor do cookie**), status e se o registro existe.

**XSS** (cargas inofensivas em 8 contextos — elemento com `onerror`, `<script>`, fechamento de atributo, string JS, `</textarea>`, `javascript:`,
`<details ontoggle>`, expressão de template — guardadas em **11 campos** de texto livre: nome/cidade da organização, título/descrição da necessidade e
da oportunidade, item, fonte, nome de usuário, motivo da movimentação, observação do evento). Cada carga leva o próprio id; **execução = o coletor
recebe o id**; injeção = elemento `[data-xss]` no DOM. O dev server não tem CSP, então o resultado mede o **escape do app**, não uma rede de segurança.
Visita as páginas da organização (com edição e históricos abertos) e `/plataforma` (administrador) e confere **quais campos apareceram como texto
literal** (campo que não aparece em nenhuma tela vira `SKIP`, nunca aprovação); contexto de URL (comprovante legado `javascript:` na linha do tempo,
clicando na âncora, e a tentativa de gravar um `javascript:` pelo endpoint real, que deve dar 400) e contexto **refletido** (caminho, consulta e hash).

**Resultado desta execução** (Edge 155 + Chrome 155; ambos Blink): 48 verificações por navegador (9 calibração, 14 CSRF, 25 XSS), **96 PASS, 0 outros**.
Antes das correções a mesma ferramenta deu FAIL em **4 tipos de CSRF same-site** (cookie enviado, registro criado) e no **servidor aceitando
`javascript:`**; o conserto está em `docs/SECURITY.md` (CSRF e Comprovante) e os testes de regressão em `test/csrfGuard.test.ts` e `test/proofUrl.test.ts`
(removendo o conserto, ambos falham). A detecção do `href` `javascript:` foi provada removendo temporariamente o filtro do cliente: FAIL.

**Não mede:** WebKit/Firefox (só Blink); produção com CSP (o dev server não tem); armazenamento via upload de arquivo (HTML/SVG enviado); eventos
postMessage/iframes de terceiros; clickjacking (cabeçalhos cobertos por `test/securityHeaders.test.ts`); autenticação de rede/TLS; o CSRF por `GET`
(os endpoints GET não escrevem — não há teste dinâmico disso aqui). O cookie `Secure` sobre `http://127.0.0.1` funciona nos navegadores testados; em outro
ambiente de teste isso pode exigir HTTPS.

## O que NÃO mede / limitações

- Viewports **emulados** em navegador headless; não há dispositivo real, teclado virtual nem zoom do sistema.
- Só os cenários listados: outras telas, `secondary` (1 consumidor), `link` (sem consumidor), Checkbox/RadioGroup/AutoComplete/Calendar (sem
  consumidor) e os radios/checkbox nativos não fazem parte da rotina.
- Cores calculadas e foco, **não** leitor de tela; a árvore de acessibilidade do navegador não é medida aqui.
- Um motor (Blink). Firefox e Safari não são cobertos.
- Mede estados de interface; **não** valida regras de negócio, permissões ou dados. O conteúdo do FileDropzone (mensagens em inglês; "foto ou
  PDF" com PDF fora da lista aceita) é uma pendência de produto e **não** é avaliada nem alterada aqui.
- Compatibilidade com Node 22 não foi executada nesta máquina (Node 24): usa apenas APIs disponíveis desde o Node 22 (WebSocket global, `fetch`,
  `util.parseArgs`); os testes unitários da lógica rodam na Node 22 do CI.

## Como adicionar um cenário

Acrescente um objeto em `scripts/qa-visual/scenarios.mjs` (campos documentados no topo do arquivo) usando seletores que existam na tela real;
`test/qaVisual.test.ts` valida a estrutura e a cobertura mínima. Se for proteger uma correção nova, acrescente uma **mutação** em
`scripts/qa-visual/selftest.mjs` que reintroduza a regressão e rode `--self-test`. Se o cenário precisar de dados, estenda `seed.ts` (a semente
já existente), não crie outra infraestrutura.
