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
npm run qa:visual -- --browser chrome --profile ci   # perfil reduzido do CI (71 de 80 cenários; o relatório lista os omitidos)
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

27 cenários × 2 temas × 4 viewports (375×812, 390×844, 768×1024, 1280×900): `ghost` (ícone, em necessidades e matching, e o botão "Fechar aviso de erro"
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

`qa:security` registra também o **contêiner Docker do nginx** (nome `levora-qa-nginx-*`, só estes nomes são removidos), o armazenamento de arquivos descartável e a build temporária do cliente; provado com morte forçada do orquestrador no meio da parte `headers`: `npm run qa:security -- --cleanup` removeu o contêiner, os diretórios temporários e o banco `_qa` (0 sobras).

## Execução reduzida no CI (GitHub Actions)

> **Não é a matriz completa.** O CI roda um **subconjunto** explícito; a matriz completa (2 navegadores, 27 cenários, `qa:security` com Edge e Chrome) continua sendo **local**.
> O que o CI não executa **não é dado como aprovado**: aparece como "não executado" no relatório e no resumo do job.

**Onde:** job `qa-browser` em `.github/workflows/ci.yml`, **independente** do job `test` (sem `needs`, sem `continue-on-error`: os dois precisam passar). Mesmos gatilhos
(`push`/`pull_request` em `master`) e permissão `contents: read`; sem secrets. Node **22** (`actions/setup-node`), com um passo que **falha se `process.versions.node`
não for 22** e registra `node -v`, `google-chrome --version` e `docker --version` no log. Postgres: o serviço efêmero do próprio job; `QA_DATABASE_URL` aponta para
`levora_solidaria_qa` (a guarda de `lib/guard.mjs` continua exigindo nome `_qa` e host local — o job **não** define `DATABASE_URL`, e o banco `_test` é recusado pela guarda).

| | Local (completo) | CI (reduzido) |
|---|---|---|
| Navegador | Edge e Chrome | **só o Chrome do runner** (`--browser chrome`; nunca Edge); `QA_BROWSER_NO_SANDBOX=1` por opt-in explícito (AppArmor do runner) |
| `qa:visual` | 80 cenários × 4 viewports × 2 temas | `--profile ci`: **71 cenários** × os mesmos 4 viewports × 2 temas |
| `qa:security` | 5 partes, 2 navegadores | **as 5 partes** (calibração, CSRF, XSS, uploads, cabeçalhos nginx/Docker), 1 navegador |
| Duração | ~12 min + ~7 min | alvo ~10 min (limite do job: 40 min) |

**Critério do perfil `ci`** (`CI_PROFILE_IDS` em `scenarios.mjs`): uma ou mais variantes de cada família em que já houve regressão real — botões (primary, outline, ghost, destructive,
secondary, desabilitado), Switch (ligado/desligado/foco/desabilitado), Input/Textarea/Select, texto e borda de erro, FileDropzone (borda, foco, erro) e variação negativa do
inventário. **Omitidos (9):** `login-password-field`, `needs-edit-dialog-title`, `org-outline-rename`, `matching-ghost-delete-icon`, `inventory-delta-positive`, `inventory-delta-icon-out`,
`dropzone-title`, `dropzone-subtitle`, `dropzone-error-clear` (variantes redundantes da mesma família). `test/qaCi.test.ts` trava que o perfil só cita cenários existentes e cobre essas famílias.

**Docker (cabeçalhos de produção):** o runner `ubuntu-latest` tem Docker. O job faz `docker pull` explícito de `nginx:1.27-alpine` e `alpine/openssl:3.5.9` (versão fixa + digest, `NGINX_IMAGE`/`OPENSSL_IMAGE` em `scripts/qa-visual/security/nginx.mjs`) (a ferramenta não baixa imagens
sozinha) e a parte `headers` roda o `deploy/nginx.conf` real. No Linux, o contêiner alcança a API do host por `--add-host host.docker.internal:host-gateway` e a API de QA escuta em
`0.0.0.0` (`QA_API_HOST`, só nessa parte e só no runner efêmero; localmente continua 127.0.0.1). **Sem Docker a parte `headers` vira `ENV` (saída 3) e o job reprova** — não é omitida em silêncio.

**Códigos de saída:** os mesmos de cada ferramenta (0 conforme · 1 violação · 2 não medido · 3 ambiente · 4 autoteste/calibração). Além disso, o passo **"Audit reports"**
(`scripts/qa-visual/ci-summary.mjs`, lógica pura em `lib/ci-report.mjs`) relê os dois relatórios JSON e reprova (1) se: o Node não for o esperado; o navegador não for o Chrome (ou
Edge aparecer); houver FAIL/MISSING/UNMEASURABLE/ENV; nenhuma verificação PASS; `qa:visual` não registrar a seleção (`selecao`), tiver ≠ 4 viewports ou ≠ 2 temas; `qa:security` não tiver
executado qualquer das 5 partes, a calibração, ou os cabeçalhos do nginx (`headersExecutados`). Sai com **2** se o relatório parecer conter segredo (URL de banco com credenciais, JWT, valor do cookie
de sessão, Authorization, o literal da senha de QA) — e então o artefato **não é publicado**. O resumo Markdown (commit, Node, navegador e versão, seleção, omitidos, contagens, cabeçalhos executados
ou não) vai para `$GITHUB_STEP_SUMMARY`; os JSON e o resumo viram o artefato `qa-browser-reports` (14 dias). Os relatórios já nasciam sem credenciais (a URL do banco nunca é gravada).

**Limpeza:** a própria ferramenta limpa em sucesso, falha e Ctrl+C (processos, perfis, contêiner nginx `levora-qa-nginx-*`, banco `_qa`); o passo `Cleanup leftovers` (`if: always()`) só complementa:
`npm run qa:security -- --cleanup`, remoção dos contêineres `levora-qa-nginx-*` e dos `levora-qa-profile-*`. Nada mata processos genéricos.

**Estado da validação:** configuração conferida localmente (`test/qaCi.test.ts`: estrutura do YAML, auditoria, CLI) e comandos do CI rodados localmente (Chrome, Node 24). **Executado no GitHub Actions:** a primeira execução do workflow endurecido passou no run `38516837928` (commit `d863660`, PR #1): jobs `test` (77 arquivos de teste) e `qa-browser` aprovados, com Node `v22.23.3`, Chrome `154.0.8037.97` e Docker `28.0.4` no runner Linux; `qa:visual` no perfil reduzido (18 de 27 cenários × 4 viewports × 2 temas) com 776 PASS; `qa:security` com 98 PASS (calibração, CSRF, XSS, uploads e cabeçalhos do nginx real em Docker); `docker pull` das duas imagens por digest; artefato `qa-browser-reports` auditado e publicado; limpeza concluída; sem timeout. *Continua sem comprovação:* a matriz completa de 27 cenários e outros navegadores (só rodam localmente; o CI usa só o Chrome), e a estabilidade em execuções repetidas (houve um único run verde para este workflow).

## Verificação de segurança em navegador real (`npm run qa:security`)

Mesma infraestrutura (Edge/Chrome headless por CDP, banco `_qa` descartável, pilha API + Vite em portas livres, limpeza e recuperação de órfãos
compartilhadas — as duas ferramentas recriam o mesmo banco, então uma execução simultânea é recusada), com **dados sintéticos** e servidores
**só em 127.0.0.1**. Nada sai desta máquina e as cargas só pedem uma imagem de 1 pixel ao coletor local.

```bash
npm run qa:security                               # calibração + CSRF + XSS + uploads + cabeçalhos de produção (nginx real), nos navegadores encontrados (~7 min)
npm run qa:security -- --browser edge --only xss  # só um navegador / só partes (calibration, csrf, xss, uploads, headers)
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

**Uploads** (parte `uploads`; arquivos sintéticos e inofensivos pelo `files-upload`/`files-download` reais, sessão real; armazenamento em diretório temporário
descartável, nunca `storage/uploads`). Cada cenário é julgado por **três fontes**: a resposta HTTP, o que ficou persistido (linhas em `files` + arquivos no disco) e
o que o navegador faz ao abrir o conteúdo (o coletor não pode receber nenhum aviso). As linhas dizem qual das categorias ocorreu: **aceito e servido com segurança**
(200, Content-Type exato, nosniff, no-store, disposição só ASCII, bytes idênticos, navegador exibe como imagem) · **rejeitado corretamente** (400/413 em JSON e
**nenhuma** linha nem arquivo novo) · **violação** (FAIL) · não medido (UNMEASURABLE) · ausente (MISSING) · falha de ambiente (ENV). Cenários: PNG/JPEG/WebP/PDF válidos;
SVG e HTML ATIVOS declarados como PNG/PDF/JPEG; PNG declarado JPEG; tipos proibidos (`image/svg+xml`, `text/html`); base64 inválido; nomes `../../etc/passwd.png`,
Unicode e `<img onerror>.png`; 8 MB+1 e corpo > 16 MB; linhas ANTIGAS `text/html` e `image/svg+xml` (semeadas direto no banco) abertas no navegador; sem sessão,
id inexistente/inválido, e usuário de OUTRA organização (download e envio). Calibração: o mesmo conteúdo ativo servido inline como HTML/SVG **executa** (detector acusa) e
servido como `image/png`+nosniff ou `attachment` **não** executa.

**Cabeçalhos de produção** (parte `headers`; **exige Docker** com as imagens `nginx:1.27-alpine` e `alpine/openssl:3.5.9` (versão fixa + digest, `NGINX_IMAGE`/`OPENSSL_IMAGE` em `scripts/qa-visual/security/nginx.mjs`) já presentes — a rotina não baixa nada; sem elas a parte
vira ENV, saída 3, e as demais continuam). Faz uma build temporária do cliente (`vite build --outDir` temporário, sem tocar em `dist/`), gera um certificado autoassinado,
sobe o **`deploy/nginx.conf` real** (só domínio, certificado e porta da API trocados; cada troca é conferida e, se a configuração mudar, a rotina falha em vez de testar outra
coisa) e mede: (1) por location (`/`, `/login`, `/index.html`, rota da SPA, JS, CSS, asset inexistente, API pelo proxy, 404 e recusa 415 da API) a CSP (impõe bloqueio, sem
`unsafe-eval`, sem `unsafe-inline` em script, sem curingas, `frame-ancestors`), `X-Frame-Options`, nosniff, Referrer-Policy, Permissions-Policy, HSTS, cache e **uma única
ocorrência de cada cabeçalho**; igualdade da CSP do nginx e do `<meta>` da build com `src/helpers/securityHeaders.ts`; (2) envio de 3 MB, 8 MB (limite), 9 MB e > 16 MB **pelo
proxy**; (3) no navegador, sobre HTTPS (`--ignore-certificate-errors` só neste navegador descartável): login, cinco páginas e envio de comprovante pela interface **sem nenhuma
violação de CSP**, e a prova de bloqueio — seis ações de injeção que **funcionam numa página de controle sem CSP** e são **todas bloqueadas** no app (violações citadas por
diretiva), conexão externa recusada e o app **não incorporável** em iframe de outra origem (controle sem proteção incorporável). A avaliação do `eval` desliga a isenção de CSP
que o CDP concede por padrão (`allowUnsafeEvalBlockedByCSP: false`).

**Resultado desta execução** (Edge 155 + Chrome 155, ambos Blink; nginx 1.27 em Docker; ~7 min): **180 PASS, 0 outros** — por navegador 82 (13 de calibração, 14 CSRF, 25 XSS, 20 de upload e
10 de CSP no nginx real), mais 16 do próprio nginx (12 de cabeçalhos e 4 de envio pelo proxy); são verificações, não componentes independentes. Antes das correções a mesma ferramenta deu FAIL em: **4 tipos de CSRF same-site**
(Fase 94 anterior), conteúdo ativo declarado como imagem **aceito** (4), download com nome Unicode → **500**, nome com barras no cabeçalho, linha antiga HTML/SVG servida inline
(2), 413 em **HTML**, HSTS ausente no HTML e nos assets, nosniff ausente nos assets, 404 de asset "imutável" e **413 do nginx para qualquer envio acima de ~750 KB**. O
detector de upload foi provado contra o código anterior (9 FAIL com os três arquivos restaurados a `HEAD`) e o de cabeçalhos contra a configuração anterior (teste estático
falha com o `nginx.conf` de `HEAD`).

**Não mede:** WebKit/Firefox (só Blink); o **staging** (`nginx.staging.conf`: só sintaxe e regras estáticas), TLS/domínio/certificado reais, redirecionamento da porta 80, CDN/WAF
na frente; o adaptador **S3** pelo `qa:security` (ele roda no navegador sobre disco local; o S3 tem teste próprio em `test/storageS3.test.ts`, contra um servidor local); varredura de malware; PDF dentro do visualizador do navegador (o PDF é conferido por bytes e cabeçalhos, não aberto); armazenamento
de HTML/SVG por outro caminho que não o upload; postMessage/iframes de terceiros; clickjacking além do iframe testado; GETs com efeito colateral. O cookie `Secure` sobre
`http://127.0.0.1` funciona nos navegadores testados; em outro ambiente de teste isso pode exigir HTTPS.

## Regressão visual (M02): capturas reais, baselines e comparação de pixels

O `qa:visual` funcional mede contraste, bordas, larguras e presença de elementos. **Ele não compara imagens.** Esta seção descreve a camada que compara de verdade: captura real da página renderizada no Chrome/Edge, baseline revisável e comparação pixel a pixel. Os resultados visuais têm vocabulário **próprio** e nunca se misturam com o PASS funcional.

### Peças (`scripts/qa-visual/`)
| Arquivo | Função |
|---|---|
| `lib/capture.mjs` | captura uma célula (página × navegador × viewport × tema) via CDP, só em condições válidas |
| `lib/png.mjs` | codec PNG sem dependências (valida assinatura, CRC, tamanho; recusa arquivo corrompido) |
| `lib/imagediff.mjs` | comparação pixel a pixel (distância perceptual YIQ), tolerância a anti-aliasing, máscaras justificadas, aglomerados, imagem de diferença e painel |
| `lib/fingerprint.mjs` | impressão de layout (retângulos e estilos dos elementos): explica *o que* mudou (deslocado, redimensionado, oculto, cortado, sobreposto, cor, tipografia) |
| `lib/baseline.mjs` | baselines em disco: `CANDIDATE`, `APPROVED`, `SUPERSEDED`; `STALE`, `MISSING_BASELINE`, `CORRUPT` na resolução |
| `lib/visualrun.mjs` | orquestra a execução, classifica cada célula, grava evidências com SHA-256 |
| `lib/loadhealth.mjs` | D6: classifica falha de carregamento × defeito do produto × elemento ausente |
| `visual-matrix.mjs` | a matriz visual (14 páginas × 375x812 e 1280x900 × claro/escuro × Chrome/Edge = 112 imagens) |
| `visual.mjs` | CLI: `capture`, `compare`, `approve`, `status`, `verify` |
| `visual-selftest.mjs` | autoteste com navegador real contra um app-fixture descartável |
| `dev/visual-mutants.mjs` | mutantes: sabota o código e exige que os testes reprovem |

### Como usar
```bash
# 1) gerar CANDIDATAS (app real, banco descartável, pilha própria): nunca aprova nada
npm run qa:visual -- --visual capture --visual-only --visual-out C:/caminho/saida
# 2) revisar as imagens (screens/*.png) e, só então, aprovar UMA a UMA, com o seu nome
node scripts/qa-visual/visual.mjs status
node scripts/qa-visual/visual.mjs approve --id <célula> --sha256 <hash da candidata> --reviewer "Seu Nome" --note "revisado" --yes
# 3) comparar com as baselines APROVADAS
npm run qa:visual -- --visual compare --visual-only --visual-out C:/caminho/saida
# conferir o manifesto de evidências de uma execução
node scripts/qa-visual/visual.mjs verify --out C:/caminho/saida
```
`--visual-only` não roda os cenários funcionais (sem ele, os dois resultados saem juntos e **separados**). `visual.mjs capture|compare --base-url URL` serve para um app já em execução (fixture, depuração).

### Revisão humana e determinismo
```bash
# duas capturas do mesmo conjunto: os pixels precisam ser iguais (senão, investigar a causa antes de qualquer máscara)
node scripts/qa-visual/visual.mjs determinism --a <execução A> --b <execução B> --out <dir>
# galeria HTML estática para a revisão (a origem produto|fixture é obrigatória e aparece em destaque)
node scripts/qa-visual/visual.mjs gallery --baseline-dir <dir> --out <dir> --source produto
```
A galeria agrupa por página → viewport → tema → Chrome | Edge | diferença Chrome×Edge, mostra hash e metadados de cada imagem, o aviso **"AGUARDANDO APROVAÇÃO"** e os possíveis problemas apontados automaticamente (rolagem horizontal, controle fora da tela, página quase vazia, conteúdo cortado, sobreposição, texto menor que 12px, tema que não bate com a imagem, imagem de uma cor só). Esses apontamentos ajudam a revisão, **não** substituem o olhar de quem aprova. O passo a passo completo para o app real (infraestrutura, duas capturas, determinismo, galeria, aprovação) está em `scripts/qa-visual/dev/real-matrix-runbook.md`.

### Estados e resultados
**Baseline** (`visual-baselines/manifest.json` + `images/` + `fingerprints/`; arquivos com o SHA-256 no nome, nada é sobrescrito):
`CANDIDATE` (gerada para revisão) → `APPROVED` (só por `approve`, com revisor, data e hash conferido) → `SUPERSEDED` (substituída com `--replace`; fica no histórico). Na hora de comparar, a baseline resolve para: `APPROVED` (usável), `CANDIDATE_ONLY`, `MISSING_BASELINE`, `STALE` (outra configuração de captura ou outra versão **principal** do navegador: reaprovar) ou `CORRUPT` (arquivo ausente/alterado: nunca PASS silencioso). A identidade inclui página, navegador, viewport e tema.

**Célula:** `VISUAL_PASS` · `VISUAL_REGRESSION` · `FUNCTIONAL_FAIL` (a página não cumpriu o contrato de carregamento) · `INCONCLUSIVE` · `BASELINE_CORRUPT` · `MISSING_BASELINE` · `CANDIDATE_ONLY` · `STALE_BASELINE` · `CANDIDATE_CREATED`.

**Código de saída** (visual): `0` homologado (toda célula `VISUAL_PASS`) · `1` regressão visual ou falha funcional · `2` inconclusivo/baseline corrompida · `3` ambiente indisponível · **`6` NÃO HOMOLOGADO** (falta baseline aprovada/válida; não é aprovação nem falha). Com `--visual` no `run.mjs`, o código funcional prevalece se indicar problema; com o funcional em 0, vale o visual. Sem `--visual`, nada muda.

### Captura: só em condições válidas
Pré-condições observáveis (nenhuma é "esperar N segundos"): navegação concluída; app montado (`#root` com filhos) **na rota esperada**; elemento-âncora presente; `document.fonts` carregadas; rede ociosa (duas leituras); sem esqueleto/`aria-busy`; animações e transições desligadas (CSS injetado só no navegador + `prefers-reduced-motion`) e nenhuma animação em curso; viewport e tema conferidos pelo que a página enxerga; foco e mouse neutros; e **estabilidade de pixels** (duas capturas consecutivas idênticas). Se algo falha, a célula fica `INCONCLUSIVE`/`FUNCTIONAL_FAIL` com o motivo; não existe imagem de página quebrada. A captura é de página inteira até 3.200 px.

### Comparação e tolerância
Cada pixel é comparado (distância perceptual YIQ, limiar 0,1). Jitter de 1px de anti-aliasing é tolerado e contado à parte; deslocamento real, cor trocada, elemento sumido/aparecido, mudança de dimensão **não** passam por essa tolerância. **Tolerância padrão: 0 pixels diferentes e 0 de aglomerado.** Um limite percentual alto esconderia regressões localizadas (a borda de 1px de um campo largo é ~0,6% da imagem). Qualquer folga ou máscara por página exige justificativa escrita na matriz (`why` / `reason`); máscaras sem motivo são recusadas. O resultado traz imagem atual, baseline, imagem de diferença, painel lado a lado, métricas (pixels, razão, delta médio/máximo, caixa, aglomerados, forma `color-only`/`shape`) e os achados de layout.

### D6: falha de carregamento × produto × elemento ausente
Antes, qualquer elemento não achado virava `MISSING`, inclusive quando o app nem montava. Agora (`lib/loadhealth.mjs`, usado pelo executor funcional e pela captura):
| Evidência | Resultado |
|---|---|
| página **montada**, na rota esperada, sem o elemento | `MISSING` (severidade mantida) |
| rota termina em outra página (inclui `/login` por falha de autenticação do produto) | `FAIL` (redirecionamento indevido) |
| página de erro do produto no lugar do conteúdo ("Acesso negado"…) | `FAIL` |
| app não montou + recurso crítico próprio com HTTP 4xx/5xx (exceto 502/503/504), ou bloqueio do produto (CSP) | `FAIL` |
| app não montou por exceção, sem falha de rede que a explique | `FAIL` |
| app não montou + falha de **rede/cache do navegador** em recurso crítico (`ERR_CACHE_READ_FAILURE`, `ERR_CONNECTION_*`, `ERR_EMPTY_RESPONSE`…) | `UNMEASURABLE` com a causa |
| app não montou + gateway indisponível (502/503/504) | `UNMEASURABLE` |
| app não montou e nada explica | `UNMEASURABLE` (não afirma defeito do produto; nunca é aprovação) |
Evidência de produto **vence** a de ambiente quando coexistem. A resposta HTTP recebida vale mais que o `loadingFailed` que o Chromium emite junto.

### Integração com o CI Local V2 (preparada, não aplicada)
O CI Local V2 (o diretório do CI Local V2, fora do repositório) não foi alterado e **não** passa `--visual`: nada muda nos 10 gates, nos códigos de saída nem no status `local-ci-full`. Para integrar: acrescentar um gate **separado** `qa-visual-regression` que rode `npm run qa:visual -- --visual compare --visual-only --visual-out <runs/..>`, com `--browser both`; classificar `0` SUCCESS, `1` CODE_FAILURE, `2/3` INCONCLUSIVE/INFRA e **`6` como "não homologado" (não publicar sucesso visual)**. Um status visual só pode ser publicado com baselines aprovadas e comparação efetiva; enquanto houver baseline em revisão, o resultado funcional segue valendo sozinho e o visual aparece como não homologado.

### Limitações
Baselines são por navegador e versão principal (Chrome e Edge compartilham o motor, mas não compartilham imagens); mudar a versão principal exige reaprovação. A captura cobre o que o CSS renderiza; vídeo, canvas animado e conteúdo que dependa do relógio precisam de máscara com motivo. Dados dinâmicos do app real só entram na matriz depois de medida a estabilidade entre execuções. A revisão humana das candidatas é obrigatória e **não** foi feita: o repositório não traz baselines aprovadas.

### Captura no produto real: banco isolado, texto dinâmico, modo por página
- **Banco isolado sem Docker.** Quando não há PostgreSQL 16 descartável, usa-se um PostgreSQL portátil (zip oficial EDB, SHA-256 conferido, binários sem assinatura) numa pasta temporária: `initdb` com usuário exclusivo, `listen_addresses=127.0.0.1` numa porta livre, sem serviço do Windows, Registro nem firewall. O banco da execução termina em `_qa` e é criado e removido por `run.mjs`. Ao fim: `pg_ctl stop`, conferir que a porta está livre e apagar a pasta de dados e o arquivo de senha. Nunca tocar nos serviços Docker `levora-dev-*`.
- **Texto dinâmico (`dynamicText` v1).** A seed usa o relógio real, então datas e horas mudam entre execuções. Antes das capturas, os nós de texto com data/hora têm os dígitos trocados por `0` (formato preservado) e os retângulos exatos são gravados no manifesto (`dynamicText`). Não é máscara de pixels e não esconde diferenças de layout; a limitação é que os VALORES de data/hora não são verificados visualmente.
- **Estabilidade.** Duas capturas consecutivas são estáveis se idênticas ou se a diferença for imperceptível (abaixo do limiar perceptual); ruído de ±1 nível em poucos pixels não torna a célula INCONCLUSIVE.
- **Modo por página.** `capture: { fullPage: false }` na matriz (ex.: diálogo modal) captura só o viewport; a versão da configuração (`cc-<hash>`) inclui esse modo, então baselines de modos diferentes nunca se confundem.
- **Revisão.** `visual.mjs gallery --baseline-dir … --out … --source produto|fixture` gera a galeria estática (candidatas, nunca aprovadas). `visual.mjs determinism --a … --b …` compara duas execuções. Heurísticas (`review.mjs`) são apoio: elementos só para leitor de tela (menores que 8×8 px) não contam como conteúdo cortado.
- **D6 no app real.** `node scripts/qa-visual/dev/d6-real-app-check.mjs --browser chrome|edge` provoca falhas por interceptação CDP (rede, HTTP 500/503, exceção, redirecionamento, elemento ausente) e confere FAIL × MISSING × UNMEASURABLE.

### Relógio de teste congelado, captura de páginas longas e diálogos (M04)
- **Relógio congelado (`lib/clock.mjs`, `lib/clock-preload.mjs`).** Em `--visual` (padrão; `--clock off` desliga; `--clock <ISO>` troca o instante) a pilha de QA roda num instante FIXO (`2026-03-16T15:00:00.000Z`, fuso `America/Sao_Paulo`), em três camadas coerentes: (1) servidor e semente carregam `--import clock-preload.mjs` via `NODE_OPTIONS` (congela `Date.now()` e `new Date()` sem argumento; timers, `performance.now` e `hrtime` não mudam); (2) o banco `_qa` recebe `qa_clock.now()` (e `transaction_/statement_/clock_timestamp`) e `ALTER DATABASE … SET search_path = qa_clock, pg_catalog, public`: toda chamada `now()` sem schema, inclusive os `DEFAULT now()` do `schema.sql` criados com o mesmo `search_path`, devolve o instante fixo (o repositório não usa `CURRENT_TIMESTAMP`); (3) cada documento do navegador recebe `Date` congelado (`Page.addScriptToEvaluateOnNewDocument`), fuso e idioma fixos. Nada disso toca o relógio do Windows nem a produção: só filhos da pilha, o banco `_qa` descartável e o navegador de teste.
- **Sem normalização de texto.** Com o relógio congelado a normalização `dynamicText` fica DESLIGADA (`meta.dynamicText.disabled = "relogio-congelado"`): os valores de data/hora aparecem como são e entram na imagem, então uma data errada, um cálculo de prazo errado ou um rótulo de tempo errado agora são regressões visíveis. O instante, o fuso e o idioma fazem parte da identidade da configuração (`captureConfigVersion`). Efeito colateral documentado: com o tempo parado, todos os eventos criados na semente têm o mesmo horário (12:00:00) e a ordem de itens empatados vem do desempate do próprio servidor/banco; contadores regressivos mostram sempre o mesmo restante.
- **Páginas longas.** O limite de 3.200 px acabou. Até 6.000 px, uma captura; acima disso, faixas de 6.000 px com 8 px de sobreposição, com a continuidade VERIFICADA (as linhas sobrepostas têm de ser idênticas; faixa mais curta que o pedido = erro) e costura sem linhas repetidas. O manifesto guarda `docHeight`, `complete` e, por faixa, `{ y, h, sha256 }`. Acima de 40.000 px a imagem é marcada TRUNCADA (`complete: false`) — nunca declarada completa. Elementos `fixed` aparecem uma vez, como na captura de página inteira.
- **Diálogos.** Diálogos usam captura só do viewport (`capture: { fullPage: false }`: Editar necessidade e Registrar recebimento). O rodapé de ações do `Dialog` é `sticky` na base da área rolável (corpo mais alto que 85vh rola por dentro; o botão de confirmar nunca fica escondido). `dev/modal-real-check.mjs` confere no produto real, em 4 viewports (inclusive 360×520 e 1024×480) e 2 temas: o diálogo cabe, está centralizado, o overlay cobre tudo, o botão de confirmar está visível e alcançável, o rodapé é sticky quando há rolagem, o foco por Tab não escapa e Esc fecha.
- **Barra de abas da organização.** Uma só definição (`src/components/OrgTabs.module.css`, reaproveitada por `composes` nas 10 páginas): uma linha com rolagem horizontal e sombras laterais, alvo de 44 px, aba ativa trazida para a área visível (`ActiveTab`).

## O que NÃO mede / limitações

- Viewports **emulados** em navegador headless; não há dispositivo real, teclado virtual nem zoom do sistema.
- Só os cenários listados: outras telas, `secondary` (1 consumidor), `link` (sem consumidor), Checkbox/RadioGroup/AutoComplete/Calendar (sem
  consumidor) e os radios/checkbox nativos não fazem parte da rotina.
- Cores calculadas e foco, **não** leitor de tela; a árvore de acessibilidade do navegador não é medida aqui.
- Um motor (Blink). Firefox e Safari não são cobertos.
- Mede estados de interface; **não** valida regras de negócio, permissões ou dados. O conteúdo do FileDropzone (mensagens em inglês; "foto ou
  PDF" com PDF fora da lista aceita) é uma pendência de produto e **não** é avaliada nem alterada aqui.
- Localmente (Node 24) a compatibilidade com Node 22 não é exercitada; ela foi comprovada no CI, que rodou `qa:visual` e `qa:security` com Node `v22.23.3` (run `38516837928`, commit `d863660`). Vale só para os commits efetivamente executados.

## Como adicionar um cenário

Acrescente um objeto em `scripts/qa-visual/scenarios.mjs` (campos documentados no topo do arquivo) usando seletores que existam na tela real;
`test/qaVisual.test.ts` valida a estrutura e a cobertura mínima. Se for proteger uma correção nova, acrescente uma **mutação** em
`scripts/qa-visual/selftest.mjs` que reintroduza a regressão e rode `--self-test`. Se o cenário precisar de dados, estenda `seed.ts` (a semente
já existente), não crie outra infraestrutura.

**Endurecimento do workflow (validado no run `38516837928`, commit `d863660`; os dois jobs passaram e o runner baixou as SHAs e os digests indicados).** As três ações (`checkout` v4.4.0, `setup-node` v4.4.0, `upload-artifact` v4.6.2) estão fixadas em SHA completo de commit verificado (as mesmas que `@v4` resolvia), o checkout usa `persist-credentials: false` (nenhum passo faz Git depois dele), o job `test` tem `timeout-minutes: 30` (observado: ~7,5 a ~10 min) e `qa-browser` segue com 40. As imagens `nginx:1.27-alpine` e `alpine/openssl:3.5.9` são referenciadas por tag **e** digest (o mesmo digest do nginx que o runner baixou nos runs verdes; o do openssl é o da tag 3.5.9, confirmado no Docker Hub e por pull local), em `ci.yml` e na ferramenta; `test/qaCi.test.ts` exige a igualdade. Quem tiver outra build local dessas imagens precisa fazer `docker pull` das referências com digest (a parte `headers` recusa com código 3 se não existirem). Ficam de fora, de propósito: `postgres:16` (serviço do job, tag móvel de versão menor) e a atualização periódica das SHAs (manual: trocar SHA e comentário juntos).

## Fase 99B — cenários da tela de diagnóstico de unidades

Dez cenários novos (`units-*`, total 37; todos no perfil `ci`, que passa a ter 28): classificadas (canônica), desconhecidas, ambíguas, lista vazia (organização 2 da semente, sem nenhuma unidade), **erro de carregamento** (o navegador bloqueia só `*/_api/v1/unit-inventory*`; o padrão não pode ser mais amplo, senão bloqueia o módulo `unit-inventory_GET.schema.ts` do próprio Vite), filtro (select e busca, altura 40 px), filtros aplicados, filtros sem resultado e o marcador "(a classificar)" no inventário. O móvel é coberto pelos viewports 375×812 e 390×844 (a tabela vira cartões, sem rolagem horizontal). Novos passos do runner: `{ select }` e `{ type }` (preenchem controles existentes) e o campo `blockUrls`. O primeiro contraste real medido derrubou o uso das variantes `success` e `warning` do `Badge` (4,11:1 e 2,86:1) — a tela usa um selo próprio com texto no token de leitura normal.

## Fase 99C — cenários da fila de pendências de unidade

Oito cenários novos (`regularization-*`, total 45; todos no perfil `ci`, que passa a ter 36): caso aberto (selo de situação), lista vazia (organização 2 da semente), erro de carregamento (`blockUrls` só em `*/_api/v1/unit-regularization-cases*`), filtro (select, 40 px), filtros sem resultado, diálogo de conferência (campo de quantidade 40 px e motivo ≥ 96 px, contido no viewport) e o aviso "Recebimento pendente de regularização" na atribuição. A semente abre o caso pelo **endpoint real de recebimento** (oferta em caixa × item em kg → HTTP 202). O móvel (375/390) é coberto pelos viewports.

## Fase 99E — cenários do registro de destinação

Sete cenários novos (`destination-*`, total 52; todos no perfil `ci`, que passa a ter 43): botão primário "Registrar destinação" (4 estados), campo de quantidade e de finalidade (40 px), observações (≥ 96 px), saldo insuficiente (texto de erro), aviso de segunda aprovação (perda) e seletor de necessidade (finalidade de atendimento). Móvel pelos viewports 375/390. A semente registra a saída sintética pelo **endpoint real** (`stock-destinations`), pois a saída física exige destinação desde a 99E.

## Fase 99F — cenários do atendimento da necessidade

Seis cenários novos (`needs-close-button`, `needs-close-dialog-reason`, `needs-close-dialog-description`, `needs-attendance-text`, `needs-attendance-historical-note`, `needs-closure-note`; total 58; todos no perfil `ci`, que passa a ter 49): botão "Encerrar" (4 estados), campos do diálogo de encerramento (40 px / ≥ 96 px) e os textos de progresso, de registro histórico e de necessidade encerrada. A semente cria uma necessidade parcial (destinação real), uma encerrada (endpoint `need-closure`) e uma atendida histórica.

## Fase 99G — cenários do histórico de destinações

Seis cenários novos (`destination-history-numbers`, `destination-history-event`, `destination-history-reverse-button`, `destination-reversal-kind`, `destination-reversal-consequence`, `destination-reversal-reason`; total 64; todos no perfil `ci`, que passa a ter 55): texto do saldo reversível, evento de reversão na linha do tempo, botão "Reverter" (4 estados), seletor do tipo (40 px), aviso da consequência física (devolução física cria ENTRADA) e motivo (≥ 96 px). A semente aplica uma correção documental e um estorno documental parcial pelos **endpoints reais**.

## Fase 99H — cenários do relatório de destinação

Três cenários novos (`report-destination-hint`, `report-destination-basis`, `report-reconciliation-row`; total 67; todos no perfil `ci`, que passa a ter 58) na página de prestação de contas: texto "destinação declarada", seletor da data usada (40 px) e linha de conciliação por item. A semente já traz destinações, correção e estorno reais (99G).

## Fase 99I — cenários da aba Destinação

Sete cenários novos (`destinations-filter-basis`, `destinations-filter-type`, `destinations-filter-from`, `destinations-filter-need`, `destinations-totals`, `destinations-empty-filter`, `destinations-range-error`; total 74; todos no perfil `ci`, que passa a ter 65) na página `/organizacoes/1/destinacoes`: seletores e data (40 px), totais por unidade, filtro sem resultado e erro de intervalo (via parâmetros da URL).

## Fase 99J — cenários dos comprovantes

Cinco cenários novos (`proof-box-text`, `proof-attach-button`, `proof-remove-button`, `proof-dialog-reason`, `proof-dialog-privacy-note`; total 79; todos no perfil `ci`, que passa a ter 70) no Inventário: linha do comprovante vigente, botões de anexar/remover (4 estados), motivo (≥ 96 px) e aviso de privacidade. A semente envia e vincula um comprovante sintético pelos endpoints reais.

## Fase 99K — conciliação de comprovantes

Um cenário novo (`destinations-reconciliation`; total 80; no perfil `ci`, que passa a ter 71): texto do painel somente leitura de comprovantes pendentes/removidos na aba Destinação. A semente envia um segundo comprovante sem vincular.

## Hardening pós-99K

Nenhum cenário novo: o estado da análise aparece só nos diálogos já cobertos e no painel de conciliação (`destinations-reconciliation`). A semente continua usando análise desligada (`dispensado`).

### M05 — contraste, alvos e foco medidos no produto real; relógio da semente com instantes distintos
- **`dev/contrast-real-check.mjs` (F18).** Mede, em 14 páginas × {375, 1280} × {claro, escuro}, a razão de contraste WCAG 2.x de TODO texto visível (cor e opacidade efetivas sobre o fundo composto dos ancestrais; 4,5:1, ou 3:1 para texto grande), placeholders, fronteira de campos, chaves/caixas e ícones (3:1). Com diálogo aberto só o diálogo é medido. Fundo com gradiente/imagem é marcado "indeterminado": a razão é calculada sobre a cor de fundo composta e os seletores indeterminados são listados para conferência manual (abas com sombra lateral, dropzone, esqueleto). Elementos só para leitor de tela (≤ 1×1) são ignorados. Controles desabilitados são medidos e reportados à parte (WCAG isenta; o valor fica registrado).
- **`dev/targets-real-check.mjs` (F09).** Alvos: mobile (375, ponteiro grosso) ≥ 44 px (campos de texto/seleção ≥ 40 px, decisão de produto: largura total e 2.5.5 é AAA); desktop ≥ 24 px (WCAG 2.2 AA 2.5.8; valores como 32 px são aceitos e reportados). A área considerada é a EFETIVA de clique (elementFromPoint a partir das bordas), de modo que um pseudo-elemento que amplia a área conta. Espaçamento entre alvos pequenos. Foco por teclado: até 80 paradas de Tab por página, cada uma com anel visível (contorno ≥ 2 px ou sombra) com contraste ≥ 3:1 contra o fundo, depois de esperar a transição de 230 ms; o foco não pode sair de um diálogo.
- **Relógio da semente (fase F).** A semente parte de (instante − 3600 s). No banco, `qa_clock.now()` avança 1 s por chamada (sequência `qa_clock.tick`, VOLATILE) e, quando a semente termina, volta a ser constante (`startStack`); na semente Node o `Date` só avança quando a semente pede (`__qaClockAdvance(1000)` a cada chamada de endpoint em `seed.ts`). Um relógio que avançasse a cada leitura foi testado e REJEITADO (o número de leituras varia entre execuções e o horário dos eventos deixava de ser reproduzível). A API em execução continua com relógio constante. `dev/clock-order-check.mjs` semeia dois bancos independentes e exige a mesma sequência de eventos, horários distintos entre requisições, nada no futuro e now() constante depois da semente. O schema da aplicação agora é carregado em `public` (antes caía em `qa_clock`, o primeiro do search_path) e `qa_clock` é recriado a cada preparo, o que torna `prepareDatabase` reaproveitável.
- **Revisão automática.** `offscreen-control` não acusa mais controles dentro de contêiner com rolagem horizontal (`hscroll` no fingerprint): as abas fora da tela são o comportamento previsto; o mesmo botão fora da tela SEM contêiner continua sendo defeito (teste e mutante m50).
- **Escopo e limites.** As medições de contraste/alvos/foco são feitas no produto real (Chrome e Edge); texto em gradiente é conferido à parte; desktop aceita botões de 32 px (WCAG 2.2 AA 2.5.8 = 24 px); campos de texto de 40 px no mobile são decisão de produto. Nenhuma baseline é aprovada por estas verificações: o estado oficial das 112 candidatas continua CANDIDATE até aprovação humana explícita (`visual.mjs approve`).

### M06 — segurança de processos do QA
- **O QA nunca encerra processo por nome ou por linha de comando.** `lib/procowner.mjs` é o único ponto de encerramento. Um processo só é encerrado se (a) a execução tem o `ChildProcess` que ela mesma criou (`killTree(child)`; um número de PID solto é recusado) ou (b) existe um registro desta execução com a identidade do processo (PID + instante de criação + executável [+ perfil exclusivo do navegador]) e a identidade atual do PID ainda confere exatamente (`killOwned`). PID reaproveitado = instante de criação diferente = PRESERVADO. Tabela de processos indisponível, registro sem identidade, executável ou perfil diferentes = PRESERVADO e registrado em `<tmp>/levora-qa-visual/runs/incertos.log`. Descendentes só entram se o PPID aponta para um processo já verificado e foram criados depois dele. Depois de encerrar, a tabela é conferida: se o processo continua, é erro (nunca sucesso falso). Não há `taskkill`, `wmic`, `Stop-Process`, `pkill` nem `process.kill` de grupo: a varredura estática de `test/qaProcessSafety.test.ts` reprova qualquer um deles.
- **Registro por execução** (`<tmp>/levora-qa-visual/runs/<runId>.json`, em vez de um `active.json` único): uma recuperação só toca em execuções cujo orquestrador está morto (identidade não confere) e nunca em uma execução viva (nesse caso devolve `busy`). Diretórios temporários só são apagados se tiverem o marcador `.levora-qa-owner` com o runId da execução que os criou, estiverem direto no tmp, tiverem nome de QA e nenhum processo os estiver usando.
- **Testes** (`vitest.qaprocess.config.ts`, sem banco): processos sintéticos reais (inclusive cópias do `node.exe` com nome `chrome.exe`/`msedge.exe` e linha de comando idêntica à de um navegador do QA) provam que externos sobrevivem; mutantes `p00`–`p14` em `dev/visual-mutants.mjs` (camada `proc`) reintroduzem filtros globais, aceitam PID reutilizado, ignoram marcador/uso de diretório, etc.

### M08 — passos novos do executor (dropzone R5)
- **Passos novos do executor** (`lib/runner.mjs`): `setFile` aceita `contentBase64` (bytes reais) ou `padBytes` (arquivo de N bytes); `waitFor` (espera o elemento); `scrollEnd` (leva ao fim toda área rolável do contêiner); `network` (latência emulada) e `block` (URLs bloqueadas). A rede é reposta (latência 0, sem bloqueio) a cada célula, no runner e na captura. Uploads de teste vão para `STORAGE_LOCAL_DIR` (use um diretório temporário FORA do repositório).


### M09 — "arrastando" e "enviando" capturados, asserções funcionais

- **"Arrastando" (R5):** gesto REAL de arrastar um arquivo do sistema (passo `dragFile`: `Input.dispatchDragEvent` → dragenter/dragover/drop de verdade; `phase`: `enter`, `leave` — passa por um ponto fora da área e cancela —, `drop`). O mouse não é movido na captura (`capture.keepPointer`). Só desktop: arrastar-e-soltar não existe em toque; no mobile o fluxo é o seletor de arquivos (coberto). O produto NÃO diferencia arquivo aceito de inválido durante o arrasto (só valida ao soltar): o destaque é o mesmo e isso está registrado, não inventado.
- **"Enviando" (R5) sem enfraquecer o portão de estabilidade:** passo `holdRequest` liga a interceptação do navegador (`Fetch.enable`, estágio Request) só para o padrão do envio; a requisição fica pendente de verdade, NÃO chega ao servidor e é abortada no fim da célula (`releaseHeld`). A página declara `capture.expectPending: { urlIncludes, method }`: o portão tolera SOMENTE a requisição identificada E comprovadamente segurada (`Fetch.requestPaused`); qualquer outra pendente reprova, o mesmo padrão sem estar segurado reprova, e a ausência da requisição segurada reprova (o estado "enviando" precisa estar provado). Demais páginas seguem no portão estrito. Passos `fulfillHeld` (responde a requisição segurada com um HTTP de teste, ex.: 500) e `releaseHold` (volta ao backend real).
- **Asserções funcionais da página** (`page.assert`: `includes`/`excludes` de texto, `present`/`absent` de seletores) avaliadas com a interface estável e antes da captura: falhou = `FUNCTIONAL_FAIL` (`assertion-failed`), sem imagem. Todas as páginas da dropzone proíbem o inglês residual.

### M10 — sondas, asserções avaliadas e correção do D6

- **Mecanismos de QA novos:** `lib/probes.mjs` (sonda de geometria/estilo com 3 amostras por célula, gravada em `preconditions.probe`; sonda de interação com clique real e ouvinte que cancela o evento); `assert.evalTrue` (condições arbitrárias da página; exceção = falsa).
- **Regressão achada pelo autoteste visual (introduzida na M09, corrigida na M10):** a captura chamava `Fetch.disable` no início e no fim de TODA célula e desligava a interceptação que o D6 do autoteste usa para injetar a falha de rede → o D6 "passava" a capturar (128/130). Agora só a célula que ligou a interceptação (`holdRequest` marca `holdUsed`) a desliga; testes e mutantes cobrem isso. Autoteste visual: 130/130.
- **Limite de uploads do QA:** o endpoint real limita 30 envios/hora por usuário (por processo da API). Uma matriz com mais de 30 uploads reais numa só execução termina com células INCONCLUSIVE (o chip do arquivo não aparece) — a classificação correta, não um PASS. Rode a matriz funcional em invocações separadas (antigas; R10 por navegador).


### M11 — comparador estrito, tolerância por região e sondas de diagnóstico

- **O padrão do comparador agora é EXATO** (`lib/imagediff.mjs`: `pixelThreshold: 0`, sem anti-aliasing, 0 pixels, 0 aglomerado). Medido com regressões sintéticas controladas (`m11-evidence/r14/comparador-atual-medicao.json`), o padrão anterior (limiar perceptual 0,1 ≈ 26 níveis de cinza + anti-aliasing 3×3) deixava PASSAR: deslocamento real de 1 px, 1 px de espaçamento a mais, título com contraste reduzido (40→60) e botão com a cor alterada em até 20 níveis por canal. Não havia baseline aprovada, então nenhuma aprovação foi afetada.
- **Tolerância só por REGIÃO declarada** (`page.tolerance.regions`, cada uma com `x/y/w/h` inteiros, `maxChannelDelta` de 1 a 4, `maxPixels`, `reason` ≥ 12 caracteres e, opcionalmente, `cells`: os ids das células em que vale). Um pixel que difere dentro da região com Δ ≤ `maxChannelDelta` é tolerado e contado; fora da região, ou acima do Δ, reprova; estourar o `maxPixels` faz TODOS os pixels da região passarem a contar como diferença. O relatório lista, por região, o observado e o tolerado. **Limite técnico:** dentro da região, uma mudança de até Δ2 por canal é indistinguível do ruído e passa (por isso as regiões são pequenas e por célula). Testes adversariais: `test/qaVisualComparatorAdversarial.test.ts` (deslocamento de 1 px, borda removida, texto alterado, elemento oculto, cor alterada, contraste reduzido, espaçamento incorreto: todos reprovam com o padrão e também DENTRO de uma região, até com uma região do tamanho da página).
- **`LEGACY_PERCEPTUAL_TOLERANCE`** (a política antiga) é usada SOMENTE no portão de estabilidade da captura (`stableBetween`: a página terminou de renderizar?), nunca para comparar com baseline.
- **Renderização determinística (R14).** O Chrome/Edge do QA agora é lançado com `--disable-lcd-text --font-render-hinting=none --force-color-profile=srgb` (`RENDER_FLAGS` em `lib/browser.mjs`, parte da configuração de captura: mudar invalida as baselines). Medido: sem eles, em 2 de 6 execuções independentes o Chrome rasterizou o texto de outro modo (Δ até 131 em glifos de TODAS as 24 imagens Chrome das 6 páginas afetadas); com eles, 4 execuções independentes só variaram em Δ ≤ 2.
- **Assentamento da captura (`settleCapture`).** Em 18 das 48 células das páginas afetadas, o 1º e o 2º screenshot da mesma página diferem sempre pelos mesmos pixels (ex.: 17 px em org-inicio/375, 2 e 10 px em inventario/375); a captura antiga guardava a 2ª. Agora a captura continua até duas capturas consecutivas IDÊNTICAS em bytes (até 6) e registra a sequência de ruído em `preconditions.captureNoiseSequence`. Em 8 células por navegador (a 375 px) a alternância entre dois estados nunca se repete (ex.: 17,17,17,17,17): a captura guarda a última que passou no portão perceptual (`stableMode: imperceptible`) e o relatório diz isso; é variação de rasterização em geometria fracionária (bordas em y=…,5), documentada, não tratada como determinismo.
- **Regiões de ruído medidas (`visual-noise-regions.mjs`, gerado).** Por GRUPO página × viewport (os mesmos ids de célula dos 2 navegadores × 2 temas), minúsculas (≤ 12×12 px), Δ ≤ 4, com orçamento de pixels; derivadas de rodadas independentes e **validadas numa rodada independente** não usada na derivação: oficiais, 448 pares sem nenhum fora das regiões; dropzone, 204 pares com 3 fora (1 célula, `dropzone-falha-rede` Chrome 1280 claro, 6 px nas mesmas coordenadas dos irmãos). A calibração da dropzone é, portanto, **insuficiente**: não ativar o gate visual sem mais rodadas. A versão anterior (por célula) foi reprovada pela mesma validação e substituída. Nenhuma região vale sem baseline aprovada (hoje há 0).
- **Sonda `r14:x,y,w,h`** (`lib/probes.mjs`): lista os elementos pintados cujas bordas caem numa região e a geometria fracionária deles e dos ancestrais; serve para diferenciar layout real, arredondamento CSS e rasterização. Também: a sonda de cobertura do conteúdo do diálogo por avisos (`contentCoverage`) e a asserção `evalTrue` de sobreposição.
- **Determinismo:** o comparador padrão passou a tratar variação de 1 nível entre rodadas como DIFERENTE; antes `compareRuns` a escondia (era assim que o ruído R14 não aparecia). O relatório não declara determinismo absoluto: ver `m11-final-technical-readiness-report.md`.

- **Tempo limite do login (`LOGIN_TIMEOUT_MS` = 45 s).** O primeiro login de um navegador com perfil novo contra o servidor de desenvolvimento (módulos não empacotados) levou de 2,7 s a 15,4 s (os demais, ≈ 0,7–1,2 s). Com o limite antigo de 15 s, 2 de 12 execuções do autoteste funcional (os dois navegadores) reprovavam por tempo ("login como owner não concluiu" → a mutação delta-negativo não era avaliada e o autoteste dizia "detector cego"). Um login que nunca conclui continua UNMEASURABLE.
- **Autoteste visual:** o caso "1 nível por canal" agora espera VISUAL_REGRESSION/DIFFERENT (padrão estrito); 130/130 com a política nova.

### M12 — calibração fechada com decisão explícita, proteção contra aprovação falsa e análise do Chrome

- **Decisão do gate visual: OBRIGATORIAMENTE DESABILITADO** (`visual-calibration.mjs`: `productionGate: "DISABLED"`). Motivos: nenhuma baseline aprovada (0 de 180 candidatas) e calibração da dropzone **não** concluída. As ferramentas podem ser integradas (seguras, não homologadas); nenhum PASS visual é publicável com candidatas (`visualExitCode` = 6; `homologado` falso; o CI Local V2 e o GitHub Actions não usam o modo visual — testado em `test/qaVisualCalibration.test.ts`).
- **Os "3 casos" da dropzone eram UMA célula** (`dropzone-falha-rede` Chrome 1280 claro) contra três rodadas idênticas entre si; a rodada D diferia em 6 pixels (Δ4 num, Δ1 em cinco) ao longo de **curvas de `border-radius`** em coordenada fracionária (geometria, texto e cor idênticos; mapas e recortes ampliados na evidência M12). Não é conteúdo, cor, geometria, fonte, animação nem defeito do comparador: é variação de rasterização entre execuções. A causa raiz do variante **não foi identificada**.
- **Bateria independente pré-registrada** (critérios escritos antes de rodar, uma única passada): dropzone 7 rodadas (derivação d1–d4, validação d5–d7), oficiais 4 (derivação o1–o3, validação o4); árvore idêntica antes e depois (SHA-256 do patch igual), Chrome 157.0.8103.39 e Edge 157.0.4341.42, processo/perfil/banco novos por rodada. Resultado: **oficiais 0 de 336 pares fora das regiões** (3 dentro, Δ ≤ 2); **dropzone 4 de 816 pares fora** — todos na célula `dropzone-erro-tamanho` Edge 1280 escuro, rodada d5 contra d1–d4: 4 pixels Δ1 no canto arredondado do campo de link (384–385, 692–694), enquanto d1–d4, d6 e d7 são idênticas entre si. Pelo critério pré-registrado o **grupo `dropzone-erro-tamanho|1280x900` fica em NEEDS_INVESTIGATION** (44 dos 45 grupos calibrados); não se acrescentou região "para passar" e não se repetiu a bateria.
- **Regiões v3** (`visual-noise-regions.mjs`, regeneradas com o mesmo algoritmo da v2 a partir das rodadas de derivação): 27 regiões em 11 páginas, todas ≤ 12×12 px, Δ ≤ 4, por grupo. O comparador continua EXATO por padrão; nenhuma região vale sem baseline aprovada.
- **Proteção contra aprovação falsa.** `visual.mjs approve` agora **recusa** (`UNCALIBRATED_CELL`) aprovar célula de grupo em NEEDS_INVESTIGATION (`assertApprovable`, antes de `approveBaseline`); continua exigindo `--yes` e `--reviewer`. `visual-calibration.mjs` é gerado da validação; células fora da bateria ficam `NOT_VALIDATED` (aprovação permitida, com o aviso de que a calibração não as cobre).
- **Testes adversariais ampliados** (10 → 14 regressões controladas, `qaVisualComparatorAdversarial`): aviso (toast) deslocado indevidamente (1 px vertical e lateral), campo de link parcialmente cortado, carregamento incompleto (esqueleto no lugar do conteúdo) reprovam no padrão estrito, com a região declarada e com uma região do tamanho da página. Estado funcional incorreto é coberto pelos autotestes funcionais e pelos mutantes.
- **Chrome — modo alternativo de texto (R15), reavaliação.** Sinalizadores efetivos: `--disable-lcd-text --font-render-hinting=none --force-color-profile=srgb` (+ `--disable-gpu --headless=new`, perfil exclusivo, DPR 1, 1920×1080; Windows com ClearType ligado, `FontSmoothingType=2`; GPU NVIDIA não usada pelo navegador por `--disable-gpu`). **Representatividade (dados da M11 reanalisados):** com e sem os sinalizadores a geometria dos elementos é idêntica em 120/120 comparações; 98,8% dos pixels que mudam estão dentro das caixas de texto (±2 px) e o restante em controles nativos (`<select>`), listas e tabelas — os sinalizadores só alteram a rasterização dos glifos, não escondem layout, cor de bloco nem elemento ausente. **Alcance da mitigação:** nas 11 rodadas desta bateria (11 lançamentos de cada navegador) houve **0 pares Chrome com Δ > 4**, somando-se às 9 execuções da M11; isso NÃO prova que o modo alternativo não volte nem identifica a causa (o ambiente de captura, a versão do Chrome e o perfil são parte da configuração; mudar invalida as candidatas). Ressalva R15 mantida nas candidatas Chrome.
- **Condições para HABILITAR o gate visual no futuro (todas necessárias; nenhuma foi cumprida).** (1) Revisão humana da galeria e aprovação explícita, célula a célula, por quem revisou (`visual.mjs approve --id … --sha256 … --reviewer … --yes`; esta etapa não aprovou nada). (2) Nenhum grupo da calibração em NEEDS_INVESTIGATION: investigar a causa da variação dos cantos arredondados (hipóteses não testadas: re-rasterização parcial por animações do overlay, `--disable-partial-raster`, `--num-raster-threads=1`) e repetir uma bateria NOVA pré-registrada, ou aceitar por decisão humana registrada. (3) Mesma versão de navegador, sinalizadores e perfil das candidatas (a M12 já viu o Edge mudar de 156 para 157). (4) Um gate SEPARADO no CI Local V2 (`qa:visual -- --visual compare --visual-only`, `--browser both`) que classifique exit 0 SUCCESS, 1 CODE_FAILURE, 2/3 INCONCLUSIVE/INFRA e **6 como "não homologado" (nunca publicar sucesso visual)**. Sem isso, o PASS funcional segue valendo sozinho.

### M13 — conclusão da dropzone, testes negativos do gate e propriedade de processos dos verificadores
- **Dropzone: RASTERIZAÇÃO CARACTERIZADA, causa não comprovada.** Bateria pré-registrada (hipótese: re-rasterização parcial; braço A × braço com `--disable-partial-raster`; 8+8 rodadas; 64 célula-rodadas por braço): controle 3 divergências Δ ≤ 2 nos mesmos cantos arredondados; braço experimental 4 divergências, todas num único lançamento do Edge, **Δ até 39 dentro de caixas de texto** (modo alternativo de texto também no Edge). Hipótese **rejeitada** pela regra pré-registrada; a flag não foi adotada; nenhuma tolerância/região nova; as 4 candidatas continuam NEEDS_INVESTIGATION. Instrumentação: os elementos nos pixels divergentes têm **geometria vertical fracionária** (`input` em y = 687,094; `label` em 275,594; raios 8/14 px) — observação necessária, não causa demonstrada; a hipótese seguinte (posição vertical inteira do diálogo, análoga ao `round()` horizontal do R12) é mudança de produto e só deve ser tentada com novo pré-registro.
- **Testes negativos do gate** (`test/qaVisualGateNegative.test.ts`, 17): sem baseline, só CANDIDATE, grupo NEEDS_INVESTIGATION, manifesto ausente/corrompido/de esquema desconhecido, hash divergente, configuração/versão diferente (STALE), regressão de borda, texto, elemento ausente, contraste e posição, falha funcional, falha ambiental, captura ilegível, região inválida e imagem histórica substituída como candidata — **nenhum produz exit 0**; só a imagem idêntica à aprovada chega a VISUAL_PASS.
- **Verificadores de desenvolvimento e processos.** `dev/own-run.mjs` registra (PID + instante de criação + perfil exclusivo) o navegador e o servidor dos verificadores de desenvolvimento (hoje o de avisos, `dev/toast-real-check.mjs`, que acompanha o PR B) em `lib/orphans.mjs`; SIGINT/SIGTERM executam a limpeza dos filhos próprios e `npm run qa:visual -- --cleanup` recupera execuções mortas **por identidade comprovada**. **Regra:** uma execução do QA interrompida nunca se encerra "pelo que parece ser dela" (nome de imagem, linha de comando, trecho do perfil); deixe terminar, use Ctrl+C ou `--cleanup`. No Windows, `Stop-Process` não entrega SIGTERM: o registro é o que permite recuperar. Limite residual: os outros verificadores `dev/*-check.mjs` ainda não usam `own-run`.

### M19 — âncora de aprovação, diretórios de candidatas e propriedade do banco (correções da revisão M18)

- **Âncora de aprovação (limite declarado).** `APPROVED` no `manifest.json` não basta: a aprovação só vale se houver um registro correspondente (id + SHA-256 da imagem + versão da configuração de captura) num arquivo **fora** da pasta de baselines e **fora** do repositório, apontado por `QA_APPROVAL_LEDGER` (encadeado por hash; edição, remoção e reordenação são detectadas). Sem registro: `APPROVAL_UNVERIFIED` (exit 6), nunca PASS. **É uma âncora local, não criptográfica e não prova a identidade do revisor** (`AUTHENTICITY = LOCAL_LEDGER_NOT_CRYPTOGRAPHIC`). Uma âncora realmente independente exige infraestrutura externa (revisão obrigatória com CODEOWNERS/branch protection e atestado assinado) que **não** está configurada aqui.
- **Diretórios separados.** Candidatas: por padrão `~/.levora-qa/visual-candidates` (fora do repositório); dentro do repositório só em `.qa-visual-local/` (ignorado). Referências aprovadas versionáveis: `scripts/qa-visual/visual-references/` (reservado, nunca destino de captura; nenhuma existe). Evidências históricas ficam fora do repositório. Temporários: `os.tmpdir()`. O `capture` recusa destino dentro do repositório fora de `.qa-visual-local/`, a área de referências, caminho que não é diretório e junctions/symlinks que escapem.
- **Manifesto.** Caminhos de `file`/`fingerprintFile` precisam ficar dentro da pasta de baselines (`safeJoin`); fora disso o baseline é `CORRUPT`. Versão do navegador desconhecida ou sem major legível ⇒ `STALE`.
- **Banco de QA.** Além do sufixo `_qa`, o banco criado pelo QA recebe a marca `levora-qa-owned` (`COMMENT ON DATABASE`). Banco existente sem marca e com tabelas é **recusado** (nada é apagado); sem marca e vazio é adotado; `dropDatabase` só apaga banco marcado.

### M23 — isolamento por execução do banco de QA (correção local, ainda não publicada)
A marca `levora-qa-owned` prova que o banco **é do QA**, não que **é desta execução**. Agora: (1) `prepareDatabase` recusa (falha segura) um banco com **sessões de outra execução ativa**, mesmo marcado; (2) a marca passa a carregar o `runId` (`levora-qa-owned run=<id>`); (3) `dropDatabase` recusa apagar banco marcado com **outro** `runId` (nunca derruba, com `FORCE`, o banco de outra execução). Banco com marca antiga (sem `runId`) continua aceito. A suíte de testes do produto (`vitest`, banco `*_test`) **não** usa este mecanismo: seu `globalSetup` recria o schema do banco informado sem checar uso concorrente; duas suítes sobre o mesmo banco se corrompem — risco do ambiente de testes (um banco de teste por execução), não do PR A.
