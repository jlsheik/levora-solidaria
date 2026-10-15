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
npm run qa:visual -- --browser chrome --profile ci   # perfil reduzido do CI (58 de 67 cenários; o relatório lista os omitidos)
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
| `qa:visual` | 67 cenários × 4 viewports × 2 temas | `--profile ci`: **58 cenários** × os mesmos 4 viewports × 2 temas |
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
