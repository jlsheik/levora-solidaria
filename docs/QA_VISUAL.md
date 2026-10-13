# Verificação visual reproduzível (`npm run qa:visual`)

Mede **componentes realmente renderizados** em Edge e/ou Chrome já instalados — cores efetivas, estados de hover/ativo/foco por eventos de entrada
reais, tamanho dos campos — e compara com os critérios WCAG. **Não adiciona dependências** (usa o WebSocket global do Node ≥ 22, `fetch`,
`child_process`, e `postgres`/`tsx`/`vite` que o projeto já tem). Nasceu das medições manuais da Fase 94 (`docs/ROADMAP_ATUAL.md` §10).

> **Isto não roda no CI** (precisa de navegador e Postgres locais). O que o CI cobre são os testes unitários da lógica
> (`test/qaVisual.test.ts`: aritmética de contraste, limites, guarda do banco, relatório, cenários) e os contratos estáticos de tokens/CSS
> (`test/tokensContraste.test.ts`). Eles **não** provam que a interface renderizada está correta; quem prova é esta rotina.

## Como executar

Pré-requisitos: Node 22.x (versão declarada em `package.json`), Edge e/ou Chrome instalados, Postgres local (o mesmo servidor dos testes) e
`npm install` feito.

```bash
npm run qa:visual                                    # todos os cenários, em todos os navegadores encontrados (Edge e Chrome)
npm run qa:visual -- --browser edge --verbose        # só o Edge; mostra também as linhas PASS
npm run qa:visual -- --only needs-primary-new,matching-switch
npm run qa:visual -- --list                          # lista os cenários
npm run qa:visual -- --self-test                     # prova que o detector acusa regressões e ausências (ver abaixo)
npm run qa:visual -- --inject-css caminho.css        # injeta CSS SÓ no navegador (experimento de regressão); produção intacta
npm run qa:visual -- --out relatorio.json --keep-db
```

**Banco de dados.** A rotina só usa um banco **local e descartável cujo nome termina em `_qa`** — ela recria o schema `public` a partir de
`db/schema.sql` (mesmo padrão de `test/global-setup.ts`, que exige `_test`). A URL vem de `--db-url`, de `QA_DATABASE_URL` ou é derivada de
`DATABASE_URL` em `.env.test` (`..._test` → `..._qa`; as credenciais nunca são impressas). Banco de desenvolvimento, host remoto ou nome sem
`_qa` são recusados antes de qualquer escrita (código de saída 3). Ao terminar o banco `_qa` é apagado (use `--keep-db` para mantê-lo).

**Navegadores.** Procurados nos caminhos padrão (Windows, macOS, Linux); `QA_EDGE_PATH`/`QA_CHROME_PATH` definem um caminho explícito (se não
existir, é "ambiente indisponível", não há queda para o padrão). Com `--browser auto` (padrão) um navegador ausente só gera um aviso; com
`--browser edge|chrome` ele é obrigatório. Edge e Chrome compartilham o motor **Blink**: os resultados saem separados por navegador/versão,
mas **não** são validação em dois motores independentes.

## O que ela faz

1. Valida o banco (guarda), recria o schema, semeia dados sintéticos mínimos (`scripts/qa-visual/seed.ts`: dono, voluntário, organização,
   necessidade, item, capacidade) e sobe API + Vite em **portas livres**.
2. Abre cada navegador **headless** com perfil temporário e porta de depuração escolhida pelo SO.
3. Para cada cenário e cada tema (`claro`/`escuro`, aplicado como o próprio app faz: classe `dark` no `<body>`): login real pela interface
   (um usuário por vez; cookies limpos entre usuários), navega, executa os passos (cliques reais), aplica o estado real e mede.
4. Estados: **hover** (ponteiro real; confirma `:hover`), **ativo** (botão do mouse pressionado e solto FORA do elemento, sem clique),
   **foco** (tecla real e `.focus()`, confirma `:focus-visible`), **normal** e, nos Switches, **ligado/desligado** (Espaço real) e **desabilitado**.
5. Compõe cores com alfa sobre o fundo efetivo (pilha de fundos a partir do próprio elemento), calcula a razão de contraste **no Node**
   (`lib/contrast.mjs`, testado) e aplica o limite do tipo de elemento.
6. Escreve um relatório JSON (navegador e versão, cenário, alvo, variante, tema, estado, critério, valor medido, limite, resultado, detalhe) e
   encerra navegador, API, Vite, banco e perfil temporário (inclusive em Ctrl+C).

### Critérios (WCAG 2.x)

| Tipo | Limite | Onde se aplica |
|---|---|---|
| `text` | 4,5:1 (3:1 se ≥ 24 px, ou ≥ 18,66 px em negrito) | texto de botão e texto de erro (rótulo e mensagem) |
| `icon` | 3:1 | botão só com ícone (variante `ghost`) |
| `boundary` | 3:1 | borda de campo (`--input-border`), trilho e polegar do Switch |
| `ring` | 3:1 contra a superfície | anel de foco (último `box-shadow` ou `outline`); **sem indicador de foco = FAIL** |
| `layout` | sem excesso > 0,5 px sobre o contêiner; `box-sizing: border-box`; altura 40 px (input, gatilho do Select) / mín. 96 px (textarea) | dimensionamento de campo |
| `info` | sem limite (só registra) | componentes **desabilitados** (isentos de contraste, WCAG 1.4.3) |

### Cobertura atual (`scripts/qa-visual/scenarios.mjs`, 18 cenários × 2 temas)

`ghost` (ícone, em necessidades e matching), `primary` (normal/hover/ativo/foco), `outline` (normal/hover/ativo/foco; e desabilitado),
`destructive` (confirmação de exclusão), `secondary` (controle de que nada vazou), `Switch` (trilho desligado, ligado, foco, desabilitado como
voluntário), `Input`/`Textarea`/`Select` (borda `--input-border`, largura, altura), texto de erro `--error-text` (rótulo e mensagem de um
formulário real com validação). Os valores das medições anteriores são **referência histórica**: a rotina mede de novo a cada execução.

### Resultados e códigos de saída

| Status | Significado | Efeito |
|---|---|---|
| `PASS` | medido e dentro do critério | — |
| `FAIL` | medido e **fora** do critério (violação real) | saída **1** |
| `MISSING` | o elemento esperado não existe na tela (ou um passo não o achou) | saída **2** |
| `UNMEASURABLE` | existe, mas o estado exigido não pôde ser aplicado (ex.: `:hover` não aplicou, coberto por outro elemento, login falhou) | saída **2** |
| `SKIP` | dispensado explicitamente | listado no relatório |
| `ENV` | ambiente indisponível (navegador, banco recusado pela guarda, API/Vite não subiram) | saída **3** |

Autoteste falho = saída **4**.

## Autoteste do detector (`--self-test`)

Injeta, **apenas no navegador**, 8 regressões conhecidas (ícone `ghost` preto no escuro, hover do `primary` que clareia, hover do `destructive`
que escurece no escuro, hover do `outline` com mistura clara, trilho do Switch em `--muted`, borda de campo em `--border`, campo em
`content-box`, texto de erro no `--error` escuro) e exige que o cenário correspondente **falhe**; e exige `MISSING` para um seletor inexistente e
`UNMEASURABLE` para hover em botão desabilitado. Se alguma regressão passar sem ser detectada, o detector está cego e a saída é 4.

## O que NÃO mede / limitações

- Só **1280×900**, navegador headless, sem dispositivo real nem teclado virtual (as larguras de 375/390/768 foram medidas à mão em etapas
  anteriores e não estão automatizadas).
- Só os cenários listados: outras telas, `secondary` (apenas 1 consumidor), `link` (sem consumidor), Checkbox/RadioGroup/AutoComplete/Calendar
  (sem consumidor), radios/checkbox nativos, FileDropzone, a variação negativa do inventário não fazem parte da rotina.
- Cores calculadas e foco, **não** leitor de tela; a árvore de acessibilidade do navegador não é medida aqui.
- Um motor (Blink). Firefox e Safari não são cobertos.
- Mede estados de interface; **não** valida regras de negócio, permissões ou dados.
- Compatibilidade com Node 22 não foi executada nesta máquina (que tem Node 24): usa apenas APIs disponíveis desde o Node 22 (WebSocket
  global, `fetch`, `util.parseArgs`); os testes unitários da lógica rodam na Node 22 do CI.

## Como adicionar um cenário

Acrescente um objeto em `scripts/qa-visual/scenarios.mjs` (campos documentados no topo do arquivo) usando seletores que existam na tela real;
o teste `qaVisual.test.ts` valida a estrutura e a cobertura mínima. Se for proteger uma correção nova, acrescente uma **mutação** em
`scripts/qa-visual/selftest.mjs` que reintroduza a regressão e rode `--self-test`.
