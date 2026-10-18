# Checklist de validação das migrations 0023, 0024 e 0025

> **Status: ROTEIRO PROPOSTO, NÃO EXECUTADO.** Nenhum passo abaixo foi executado. **Nenhuma migration deve ser executada em produção durante estes ensaios, nem a partir deste documento.** Use apenas um **banco descartável** ou uma **cópia sanitizada**, com autorização específica. As consultas SQL foram escritas e revisadas por leitura contra o `db/schema.sql` da `master` (`3348e27`), mas **não foram executadas**: confira a sintaxe no ambiente descartável antes de confiar nelas. **Nenhuma duração ou bloqueio descrito aqui foi observado em execução.**
>
> **[código]** = conferido no código; **[comportamento padrão do PostgreSQL]** = descrito pela documentação do PostgreSQL e **não observado neste projeto**; **[proposta]** = procedimento a validar.

## 1. O que cada migration faz (leitura do código)

| Migration | Comandos relevantes (na ordem do arquivo) | Ponto de atenção |
|---|---|---|
| **0023** `destination_proofs` | `ALTER TABLE stock_destinations ADD COLUMN proof_removed`; dois `ADD CONSTRAINT … CHECK` (`proof_removed_chk`, `proof_only_chk`); `CREATE UNIQUE INDEX uq_stock_destinations_proof_file` (parcial, não `CONCURRENTLY`); função e gatilho `stock_destination_proof_validate` | os `CHECK` e o índice único **só passam se não houver linha antiga que os viole**; o `migrationCompat.ts` afirma que nenhum caminho de código gravou `proof_file_id` antes da 99J, mas **isso só os dados reais comprovam**. Tabela afetada: **`stock_destinations`** |
| **0024** `file_scan_status` | `ALTER TABLE files ADD COLUMN scan_status … NOT NULL DEFAULT 'legado_nao_analisado'` (com `CHECK`); `ALTER COLUMN scan_status SET DEFAULT 'pendente'`; três `ADD COLUMN` anuláveis; `CREATE INDEX idx_files_org_scan_status` (parcial, não `CONCURRENTLY`); gatilho `files_scan_status_guard`; substitui a função `stock_destination_proof_validate` | **toda linha existente de `files` vira `legado_nao_analisado`**; no modo obrigatório (que `NODE_ENV=production` impõe) esses arquivos ficam **bloqueados para download e vínculo até serem reanalisados**. Não apaga nada, mas muda o comportamento funcional. Tabela afetada: **`files`** |
| **0025** `file_scan_retry` | cinco `ALTER TABLE files ADD COLUMN` (`scan_attempts … NOT NULL DEFAULT 0` e quatro anuláveis), **depois** `CREATE INDEX idx_files_scan_queue` (parcial, **não `CONCURRENTLY`**) | tabela afetada: **`files`** (ver seção 1.1) |

**Nenhuma das três tem `DROP`, `DELETE` ou `UPDATE`.** Não existe migration de volta: reverter é restaurar o backup anterior **[doc: `DEPLOYMENT_RUNBOOK.md`, seção 6]**.

### 1.1 Transação e bloqueios

O runner executa **cada arquivo `.sql` inteiro em uma única transação**, junto com o `INSERT` em `schema_migrations` (`sql.begin(...)`, `trx.unsafe(migrationSql)` **[código: `db/run-migrations.ts`]**). Uma falha desfaz o arquivo inteiro; os arquivos anteriores, já confirmados em suas próprias transações, permanecem aplicados.

**[comportamento padrão do PostgreSQL, não observado aqui]** `ALTER TABLE … ADD COLUMN` e `ADD CONSTRAINT` tomam um bloqueio de **acesso exclusivo** na tabela, e esse bloqueio só é liberado quando a transação termina. Como todos os comandos do arquivo estão na mesma transação, o bloqueio é mantido **durante o arquivo inteiro**, inclusive enquanto `CREATE INDEX` constrói o índice. Em consequência, **provavelmente tanto leituras quanto escritas** na tabela afetada ficam esperando até o fim da migration, e não apenas as escritas:
- 0023: `stock_destinations`; os dois `ADD CONSTRAINT … CHECK` também precisam percorrer a tabela para validar as linhas existentes;
- 0024 e 0025: `files`, que é lida por downloads, uploads e pela fila de reanálise.

Outras sessões que tentarem acessar a tabela esperam, e podem formar fila atrás do pedido de bloqueio da migration. **O tempo real de espera depende do tamanho da tabela e do hardware, e nenhuma duração foi medida.** A medição precisa ser feita em ambiente descartável representativo (seções 5.1 e 5.3), e a aceitação da janela é decisão humana.

> **Atenção:** `npm run db:preflight` e a pré-verificação do `db:migrate:incremental` cobrem somente as restrições das migrations **0005, 0007, 0009, 0010 e 0013** (e, a partir da integração de identidade, **0026**, que ainda não está na `master` quando este checklist foi escrito) **[código: `db/legacyPreflight.ts`]**. **Elas NÃO verificam os dados das migrations 0023, 0024 nem 0025.** As consultas da seção 4 são necessárias.

## 2. Pré-condições, autorização e isolamento do ambiente

1. Autorização **específica e por escrito** para o ambiente descartável (o responsável pelo projeto), com o **alvo esperado registrado antes do ensaio**: nome do banco, host/endereço e porta.
2. Banco **descartável** ou cópia **sanitizada**; nunca a produção.
3. O banco de ensaio deve estar no estado anterior às migrations a validar. Registrar a lista de `schema_migrations` antes de começar.
4. Tamanho e distribuição de dados representativos (a Fase 57 usou ~139 KB, o que **não** representa produção).
5. Execução a partir do repositório (`npm run ...`): os `.sql` não existem em `dist-server`.
6. Um responsável e um local para guardar as evidências (seção 9).

### 2.1 Como garantir o banco-alvo (obrigatório antes de **cada** comando que se conecte ao banco)

**Por que isto é necessário [código]:** `db/run-migrations.ts`, `db/preflight.ts` e `db/migrate.ts` leem `DATABASE_URL` **ou**, na ausência dela, `FLOOT_DATABASE_URL`; `db/storage-audit.ts` lê `DATABASE_URL`. Todas importam `dotenv/config`, que carrega um arquivo `.env` do diretório de trabalho (`dotenv` 16.x, que por padrão **não** sobrescreve variáveis já definidas no ambiente). **Não encontrei nessas ferramentas nenhuma trava que impeça operar num banco que não seja descartável** (a trava `_test` existe só em `test/global-setup.ts`). Por isso a instrução "confirme a `DATABASE_URL`" não basta; siga todos os passos:

1. **Checkout sem credenciais de produção.** Use um clone novo ou uma worktree nova do repositório. O `.env` está no `.gitignore`, então um clone novo não o tem. Confirme que **não existe** `.env` no diretório (`ls -a | grep -x .env` em POSIX; `Test-Path .env` no PowerShell). Se existir, **não execute**: use outro checkout.
2. **Definir a conexão explicitamente, sem expor a senha, e neutralizar fontes acidentais de configuração.** Duas formas de conexão são usadas, **derivadas dos mesmos componentes** (nome do banco, usuário, host e porta do alvo registrado no item 1 da seção 2), para que o alvo verificado seja o alvo usado:
   - `ENSAIO_URL_SEM_SENHA`: URL **sem senha**, usada por `psql` e `pg_dump`. A senha vem do **arquivo de senhas do PostgreSQL** com permissões restritas (`~/.pgpass` com modo `0600` em POSIX; `%APPDATA%\postgresql\pgpass.conf` no Windows) ou da **solicitação interativa** do próprio cliente. **Nunca coloque a senha na URL passada a esses comandos**: um argumento de linha de comando pode ficar visível a outros usuários da máquina (lista de processos) e fica no histórico do shell.
   - `DATABASE_URL`: URL **com senha**, necessária porque as ferramentas Node do projeto (`db:preflight`, `db:migrate:incremental`, `storage:audit`) leem somente essa variável **[código]**. Ela é passada **por variável de ambiente, nunca por argumento**.

   **Limites a conhecer:** a variável de ambiente é herdada pelos processos filhos do terminal e pode ser visível a outros processos do mesmo usuário e a administradores; não use terminal compartilhado, não habilite `set -x` e feche o terminal ao terminar. **Não adote `PGPASSWORD` como solução geral**: a documentação do PostgreSQL desaconselha seu uso por segurança, porque em alguns sistemas operacionais o ambiente de um processo pode ser visível a outros usuários. O arquivo de senhas é lido pelos clientes libpq (`psql`, `pg_dump`); a forma como as ferramentas Node obtêm a senha é **somente** pela `DATABASE_URL`. Percent-encode caracteres especiais da senha.

   POSIX (bash):
   ```bash
   unset FLOOT_DATABASE_URL S3_BUCKET S3_REGION S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_ENDPOINT
   unset PGHOST PGPORT PGDATABASE PGUSER PGSERVICE PGSERVICEFILE PGPASSFILE PGPASSWORD PGOPTIONS   # fontes acidentais de configuração do libpq
   # componentes do alvo REGISTRADO (seção 2, item 1), digitados uma única vez:
   ENSAIO_USUARIO='<usuario_ensaio>'; ENSAIO_HOST='<host_ensaio>'; ENSAIO_PORTA='<porta>'; ENSAIO_BANCO='<banco_ensaio>'
   export ENSAIO_URL_SEM_SENHA="postgres://${ENSAIO_USUARIO}@${ENSAIO_HOST}:${ENSAIO_PORTA}/${ENSAIO_BANCO}"
   read -r -s -p "Senha do banco de ENSAIO (com percent-encoding): " ENSAIO_SENHA; echo
   export DATABASE_URL="postgres://${ENSAIO_USUARIO}:${ENSAIO_SENHA}@${ENSAIO_HOST}:${ENSAIO_PORTA}/${ENSAIO_BANCO}"
   unset ENSAIO_SENHA
   ```

   PowerShell:
   ```powershell
   Remove-Item Env:FLOOT_DATABASE_URL, Env:S3_BUCKET, Env:S3_REGION, Env:S3_ACCESS_KEY_ID, Env:S3_SECRET_ACCESS_KEY, Env:S3_ENDPOINT -ErrorAction SilentlyContinue
   Remove-Item Env:PGHOST, Env:PGPORT, Env:PGDATABASE, Env:PGUSER, Env:PGSERVICE, Env:PGSERVICEFILE, Env:PGPASSFILE, Env:PGPASSWORD, Env:PGOPTIONS -ErrorAction SilentlyContinue
   $u = '<usuario_ensaio>'; $h = '<host_ensaio>'; $po = '<porta>'; $b = '<banco_ensaio>'   # componentes do alvo REGISTRADO
   $env:ENSAIO_URL_SEM_SENHA = "postgres://${u}@${h}:${po}/${b}"
   $s = Read-Host "Senha do banco de ENSAIO (com percent-encoding)" -AsSecureString
   $p = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   $env:DATABASE_URL = "postgres://${u}:${p}@${h}:${po}/${b}"
   Remove-Variable p, s
   ```
   As variáveis valem só para o terminal atual. **Nunca** imprima `DATABASE_URL` (`echo`, `Get-ChildItem Env:`, `set -x`). **Não edite uma das duas URLs isoladamente**: gere as duas pelo bloco acima, no mesmo terminal.
3. **Verificar a identidade do servidor e do banco, no mesmo terminal e com a URL sem senha**, antes de **cada** comando que se conecte ao banco (`db:preflight`, `db:migrate:incremental`, `storage:audit`, `psql`, `pg_dump`):

   POSIX: `psql "$ENSAIO_URL_SEM_SENHA" -X -A -t -c "SELECT current_database(), inet_server_addr(), inet_server_port(), current_user"`
   PowerShell: `psql $env:ENSAIO_URL_SEM_SENHA -X -A -t -c "SELECT current_database(), inet_server_addr(), inet_server_port(), current_user"`

   O `psql` usa o arquivo de senhas ou pergunta a senha. Como as duas URLs saem dos mesmos componentes, o servidor e o banco verificados são os que a `DATABASE_URL` das ferramentas Node também usa.

4. **Comparar com o alvo esperado registrado no item 1 da seção 2** (nome do banco, endereço e porta). **Se houver qualquer divergência, ou dúvida, interromper e comunicar o responsável**; não repetir para "ver se muda".
   - **Limites desta verificação:** o resultado só prova que a conexão aponta para o alvo registrado; **não prova**, sozinho, que o alvo registrado seja descartável (isso depende de o responsável ter definido corretamente o alvo). `inet_server_addr()` retorna nulo em conexão por socket Unix; túneis, proxies e apelidos de DNS podem fazer o endereço divergir do esperado sem que haja erro.
5. **Não registrar credenciais.** Antes de arquivar `migrations_ensaio.log` e relatórios, revise-os e remova qualquer host, URL ou credencial que apareça.

Repita os passos 3 e 4 sempre que abrir um terminal novo ou alterar variáveis de ambiente.

## 3. Backup e verificação prévia

```bash
# (identidade do banco verificada conforme a seção 2.1)
# backup do banco de ENSAIO (formato custom), conforme docs/DATABASE_RECOVERY.md; sem senha na linha de comando
pg_dump -d "$ENSAIO_URL_SEM_SENHA" -Fc -Z 6 -f ensaio_pre_migrations.dump
sha256sum ensaio_pre_migrations.dump

# pré-verificação oficial (somente leitura; cobre 0005/0007/0009/0010/0013, e 0026 quando a identidade for integrada); usa a DATABASE_URL do ambiente
npm run db:preflight
```
No PowerShell, use `pg_dump -d $env:ENSAIO_URL_SEM_SENHA …` e `Get-FileHash -Algorithm SHA256 ensaio_pre_migrations.dump`.

Códigos de saída do `db:preflight`: **0** autorizada · **2** bloqueada (dados legados impeditivos, estrutura ausente ou estado inconsistente) · **3** não verificada. **Interromper** se o código for diferente de 0.

## 4. Inventário (somente leitura)

Execute com `psql` conectado ao banco de ensaio (identidade verificada, seção 2.1). Todas são `SELECT`; nenhuma altera dados. **Não foram executadas.**

### 4.1 Contagens de base (guardar para a comparação final)

```sql
SELECT 'files' AS tabela, count(*) FROM files
UNION ALL SELECT 'stock_destinations', count(*) FROM stock_destinations
UNION ALL SELECT 'logistics_events', count(*) FROM logistics_events
UNION ALL SELECT 'audit_log', count(*) FROM audit_log;

SELECT purpose, storage_provider, count(*) FROM files GROUP BY purpose, storage_provider ORDER BY 1, 2;
SELECT pg_size_pretty(pg_total_relation_size('files')) AS tamanho_files;
SELECT id FROM schema_migrations ORDER BY id;
```

### 4.2 Antes da 0023 (a coluna `proof_removed` ainda **não existe**; não a referencie)

```sql
-- quantas linhas já têm comprovante (esperado: 0, segundo o migrationCompat.ts)
SELECT count(*) AS com_proof_file_id FROM stock_destinations WHERE proof_file_id IS NOT NULL;

-- violaria proof_only_chk (correção com comprovante E outros campos)
SELECT id FROM stock_destinations
 WHERE proof_file_id IS NOT NULL AND entry_type = 'correction'
   AND num_nonnulls(delivered_on, people_served, notes) > 0;

-- violaria o índice único (mesmo arquivo vinculado mais de uma vez)
SELECT proof_file_id, count(*) FROM stock_destinations
 WHERE proof_file_id IS NOT NULL GROUP BY proof_file_id HAVING count(*) > 1;

-- informativo: o gatilho da 0023 só vale para linhas futuras, mas veja se há comprovante de propósito errado
SELECT s.id, f.purpose FROM stock_destinations s JOIN files f ON f.id = s.proof_file_id
 WHERE f.purpose <> 'comprovante_destinacao';
```

**Interromper** se qualquer uma das duas consultas de violação (segunda e terceira) devolver linhas: a migration 0023 falharia.

### 4.3 `proof_url` dos eventos de logística (não tem chave estrangeira)

**O que o código aceita [código]:** `proofUrl` pode ser um caminho relativo do app **ou qualquer URL `http(s)`** (`src/helpers/proofUrl.ts`); o recebimento com arquivo grava exatamente `/_api/v1/files-download?fileId=<id>`. O endpoint de download lê o parâmetro com `url.searchParams.get("fileId")` (`files-download_GET.ts`), que **diferencia maiúsculas de minúsculas**: um link com `FILEID=` ou `fileid=` **não** é tratado pelo app como link válido de arquivo. Por isso as consultas abaixo diferenciam maiúsculas e minúsculas no caminho e no parâmetro (só o esquema `http`/`https` aceita variações de capitalização) e tratam variações como casos a **inspecionar**, não como links do app. Um `http(s)` pode ser um endereço absoluto **da própria aplicação** (também afetado pela 0024) ou um site externo: **não classifique todos os `http(s)` como externos**.

**Classificação em uma única consulta (as classes são mutuamente exclusivas, pois vêm de um `CASE`; cada linha cai em exatamente uma):**

```sql
SELECT classe, count(*) FROM (
  SELECT CASE
    -- a) caminho relativo do app (formato gravado pelo recebimento; aceita sufixo de parâmetros/âncora)
    WHEN proof_url ~ '^/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$' THEN 'a_relativo_do_app'
    -- b) URL absoluta cujo caminho é o do app (possível link da própria aplicação; confirme o host abaixo)
    WHEN proof_url ~ '^[Hh][Tt][Tt][Pp][Ss]?://[^/]+/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$' THEN 'b_absoluto_com_caminho_do_app'
    -- c) contém o caminho do app em outra forma (prefixo de caminho antes de /_api, parâmetro diferente etc.): INSPECIONAR
    WHEN proof_url ~ '/_api/v1/files-download' THEN 'c_caminho_do_app_em_outra_forma_inspecionar'
    -- d) outros http(s) (externos ou de formato desconhecido)
    WHEN proof_url ~* '^https?://' THEN 'd_outro_http'
    -- e) qualquer outro formato não vazio
    ELSE 'e_outro_formato'
  END AS classe
  FROM logistics_events
  WHERE proof_url IS NOT NULL AND proof_url <> ''
) t GROUP BY classe ORDER BY classe;

-- conferência: a soma das classes deve ser igual a este total
SELECT count(*) AS total_nao_vazio FROM logistics_events WHERE proof_url IS NOT NULL AND proof_url <> '';

-- hosts dos links da classe b, para decidir quais são da própria aplicação
SELECT substring(proof_url from '^[Hh][Tt][Tt][Pp][Ss]?://([^/]+)') AS host, count(*) FROM logistics_events
 WHERE proof_url ~ '^[Hh][Tt][Tt][Pp][Ss]?://[^/]+/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$'
 GROUP BY 1 ORDER BY 2 DESC;
```

**Integridade dos links das classes a e b** (a extração e o filtro usam os **mesmos** padrões, ambos com diferenciação de maiúsculas):

```sql
-- links cujo arquivo NÃO existe, ou existe em OUTRA organização
-- (para a classe b, o resultado só é conclusivo se o host for o da própria aplicação)
SELECT e.id, e.organization_id
  FROM logistics_events e
  LEFT JOIN files f ON f.id = substring(e.proof_url from '/_api/v1/files-download\?fileId=([0-9]{1,18})')::bigint
 WHERE (e.proof_url ~ '^/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$'
     OR e.proof_url ~ '^[Hh][Tt][Tt][Pp][Ss]?://[^/]+/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$')
   AND (f.id IS NULL OR f.organization_id <> e.organization_id);
```

**Pendente de comprovação por leitura:** não há, no código, indicação de que a aplicação seja servida sob um prefixo de caminho (o nginx documentado serve `/_api/` na raiz); links com prefixo caem na **classe c**, onde precisam de inspeção manual. Se o ambiente real usar prefixo, a classe c precisa ser reclassificada pelo responsável. Os links das classes d e e não apontam para arquivos do app; a classe c **não** pode ser assumida como externa nem como do app sem inspeção.

Registrar os totais. Depois da 0024, os links das classes a e b que apontam para arquivos legados passam a responder 409 no modo obrigatório até a reanálise.

## 5. Aplicação incremental e medições

**Atenção:** o runner **aplica todas as migrations pendentes** de uma vez (`db/run-migrations.ts` percorre todos os arquivos de `db/migrations/` ainda não registrados); **não há opção documentada para aplicar uma migration específica**. Se 0021 e 0022 também estiverem pendentes no banco de ensaio, elas serão aplicadas na mesma execução, e o tempo total e o bloqueio observados as incluirão. Interprete os resultados com isso em mente.

```bash
# (identidade do banco verificada conforme a seção 2.1; registre a hora de início)
date -u +"%Y-%m-%dT%H:%M:%SZ"
time npm run db:migrate:incremental > migrations_ensaio.log 2>&1
codigo=$?          # capture IMEDIATAMENTE: qualquer comando entre os dois altera $?
echo "codigo de saida: $codigo"
date -u +"%Y-%m-%dT%H:%M:%SZ"
cat migrations_ensaio.log
```
Redirecionar para arquivo (sem `pipe`) mantém `$?` como o código do `npm`.

```powershell
# (identidade do banco verificada conforme a seção 2.1)
$t = [Diagnostics.Stopwatch]::StartNew()
cmd /c "npm run db:migrate:incremental > migrations_ensaio.log 2>&1"
$codigo = $LASTEXITCODE        # capture IMEDIATAMENTE; não use $? para decidir sucesso
$t.Stop()
"codigo de saida: $codigo | duracao: $([math]::Round($t.Elapsed.TotalSeconds, 1)) s"
Get-Content migrations_ensaio.log -Encoding UTF8
if ($codigo -ne 0) { "FALHA: interromper e registrar (exceto o código 1 esperado no teste da seção 8)" }
```
**Por que `cmd /c` no PowerShell:** no Windows PowerShell 5.1, o redirecionamento `>`/`*>` grava o arquivo em **UTF-16 LE**, e `2>&1` aplicado a um comando nativo converte a saída de erro em registros de erro do PowerShell, o que pode alterar o conteúdo do log e o valor de `$?` mesmo quando o código de saída é 0. Com `cmd /c "… > arquivo 2>&1"` o redirecionamento é feito pelo `cmd`, o arquivo recebe os bytes que o processo escreveu (UTF-8, como o Node emite), e `$LASTEXITCODE` recebe o código de saída que o `cmd` repassa do `npm`. Em PowerShell 7 ou superior, `>` grava UTF-8 sem BOM por padrão e `npm run … *> arquivo` também serve; ainda assim leia `$LASTEXITCODE` logo em seguida. Se preferir `Out-File`/`Tee-Object` no 5.1, defina `-Encoding utf8` (grava com BOM) e confirme o valor de `$LASTEXITCODE` imediatamente depois. **Estas formas não foram ensaiadas**: valide a sintaxe, a codificação do log e o código de saída no ambiente descartável antes de confiar nelas.

Códigos do `db:migrate:incremental`: **0** ok · **1** falha ao aplicar uma migration · **2** bloqueado pela pré-verificação · **3** pré-verificação não concluída. **Interromper** em qualquer código diferente de 0.

### 5.1 Medir o bloqueio real, com a migration inteira

**Meça a execução completa do runner (a transação inteira do arquivo), não apenas o `CREATE INDEX`.** Executar só o `CREATE INDEX` em outra transação usa um bloqueio mais fraco, não inclui os `ALTER TABLE` anteriores e **subestima** o efeito real.

Em um banco de ensaio com volume representativo (identidade verificada nas duas sessões):
1. **Sessão 1:** rode o runner (seção 5). Registre início e fim.
2. **Sessão 2** (outra conexão ao **mesmo** banco de ensaio, com a verificação 2.1 repetida), durante a execução, a cada poucos segundos:

```sql
-- observação (somente leitura)
SELECT l.pid, l.mode, l.granted, a.state, a.wait_event_type, left(a.query, 60) AS consulta
  FROM pg_locks l JOIN pg_stat_activity a USING (pid)
 WHERE l.relation = 'files'::regclass;   -- troque por 'stock_destinations'::regclass ao medir a 0023

-- teste de acesso sem esperar: BEGIN; LOCK TABLE files IN ACCESS SHARE MODE NOWAIT; ROLLBACK;  (leitura)
--                              BEGIN; LOCK TABLE files IN ROW EXCLUSIVE MODE NOWAIT; ROLLBACK;  (escrita)
-- um erro "could not obtain lock on relation" indica que a operação teria esperado
```
O `LOCK TABLE … NOWAIT` seguido de `ROLLBACK` não altera dados. Registre, para cada instante, se a leitura e a escrita conseguiram o bloqueio, e por quanto tempo isso durou.

3. **Registrar a duração total e os intervalos de bloqueio como valores medidos, com o tamanho da tabela** (`pg_size_pretty`, contagem de linhas). Decidir, com a operação, se a janela aceita esse bloqueio **[decisão humana]**.

### 5.2 Verificação de `schema_migrations`

```sql
SELECT id, applied_at FROM schema_migrations WHERE id IN (
  '0023_destination_proofs.sql', '0024_file_scan_status.sql', '0025_file_scan_retry.sql') ORDER BY id;
```

Esperado: as três linhas, na ordem. Rodar `npm run db:migrate:incremental` de novo deve imprimir "Nenhuma migração pendente." (idempotência).

### 5.3 Medir cada migration (métodos reproduzíveis; nenhum valor foi medido)

O runner não permite escolher uma migration, então não é possível medi-las "uma a uma" pelo próprio runner. Use **um** dos métodos, declarando suas limitações no relatório:

**Método 1: tempo total.** O `time` (bash) ou o cronômetro (`Stopwatch`) da seção 5 dá a duração do runner inteiro (inclui a pré-verificação e a partida do Node).

**Método 2: estimativa por `applied_at` (aproximação).** A coluna `schema_migrations.applied_at` tem `DEFAULT now()`, e `now()` devolve o **início da transação**; como o `INSERT` roda dentro da transação de cada migration, `applied_at` marca aproximadamente o **início** dela. A diferença entre linhas consecutivas estima a duração da migration **anterior**.
```sql
SELECT id, applied_at,
       applied_at - lag(applied_at) OVER (ORDER BY applied_at) AS intervalo_desde_a_anterior
  FROM schema_migrations WHERE id >= '0021' ORDER BY applied_at;
```
Limitações: é estimativa (inclui o intervalo entre transações e a sobrecarga do Node); a duração da **última** migration não sai da tabela (use o horário de fim do runner registrado na seção 5); o primeiro intervalo pode incluir tempo de pré-verificação.

**Método 3: medição isolada por restauração independente.** Para medir uma migration sozinha, restaure o dump do estado **imediatamente anterior** num banco descartável **novo** e rode o runner a partir de um checkout cujo conjunto de migrations termine nela. Verifiquei no repositório que a última migration em cada um destes commits da `master` é a indicada, e que `db/run-migrations.ts`, `db/legacyPreflight.ts` e `db/preflight.ts` são idênticos a `3348e27` nesses commits:

| Checkout | Última migration presente |
|---|---|
| `6d3cb53` | 0022 |
| `f2d0a58` | 0023 |
| `77d3a01` | 0024 |
| `3348e27` | 0025 |

Sequência: estado inicial S0 → (checkout `6d3cb53`) 0021 e 0022 juntas → dump S1 → restaurar S1 em banco novo → (checkout `f2d0a58`) 0023 → dump S2 → restaurar S2 em banco novo → (checkout `77d3a01`) 0024 → dump S3 → restaurar S3 em banco novo → (checkout `3348e27`) 0025. Cada restauração e cada checkout exigem repetir a seção 2.1 e usar um banco novo. **Pré-condições:** dump e restauração feitos conforme `docs/DATABASE_RECOVERY.md`; banco de ensaio novo a cada etapa; os checkouts não podem conter `.env`. Este método é **proposto e não foi executado**.

## 6. Conferência do efeito da 0024 e da 0025

```sql
-- 0024: toda linha antiga deve ter virado legado_nao_analisado (nenhuma outra, em um banco que só tinha dados antigos)
SELECT scan_status, count(*) FROM files GROUP BY scan_status;

-- 0025: contadores zerados e índice criado
SELECT count(*) FILTER (WHERE scan_attempts <> 0) AS tentativas_nao_zero FROM files;
SELECT indexname FROM pg_indexes WHERE tablename = 'files' AND indexname IN ('idx_files_org_scan_status', 'idx_files_scan_queue');
```

**Efeito funcional a registrar:** com o app em modo obrigatório contra esse banco, o download e o vínculo de comprovante de um arquivo `legado_nao_analisado` respondem 409 `arquivo_nao_liberado`. Essa verificação exige subir a aplicação contra o banco descartável (**fora do escopo deste documento; requer autorização**).

## 7. Comparação antes e depois

1. Repetir as contagens da seção 4.1: **devem ser idênticas** (as migrations são aditivas).
2. Comparar a estrutura: `pg_dump --schema-only` antes e depois e inspecionar a diferença, que deve conter apenas as colunas, constraints, índices e funções/gatilhos listados na seção 1.
3. Comparar a lista de `schema_migrations`: apenas as novas.

## 8. Teste de rollback em falha controlada (atomicidade da migration 0025)

**Objetivo:** confirmar que a falha da migration 0025 desfaz **aquele arquivo** inteiro (as cinco colunas `ADD COLUMN` que precedem o `CREATE INDEX` na mesma transação), sem desfazer as migrations anteriores já confirmadas em suas próprias transações. Procedimento **proposto; não executado**. Só no banco descartável confirmado (seção 2.1, repetida antes de cada passo). **Nunca em produção.**

**Princípio: evidência direta.** A ausência das colunas da 0025 e a ausência de seu registro em `schema_migrations` **não bastam** como prova do rollback: o mesmo resultado aparece se o runner falhar **antes** (por exemplo, na 0023, por dados históricos inválidos) e a 0025 nunca começar. O teste só vale se houver, juntos: (1) estado inicial em que **somente a 0025 está pendente**; (2) o conflito confirmado **antes** de iniciar o runner; (3) o **log integral** mostrando a tentativa de aplicar `0025_file_scan_retry.sql` e o erro de índice já existente; (4) código de saída **1**; (5) as duas confirmações do estado final, registradas **separadamente**.

1. **Estado inicial (somente a 0025 pendente).** Banco descartável exclusivo para este teste, com as migrations até a 0024 aplicadas. Obtenha-o restaurando o dump do estado após a 0024 (Método 3 da seção 5.3) ou aplicando o runner de um checkout em que a última migration seja a 0024 (`77d3a01`). Confirme **antes** de prosseguir, e guarde as saídas:
   ```sql
   SELECT id FROM schema_migrations WHERE id >= '0021' ORDER BY id;   -- esperado: 0021, 0022, 0023, 0024; sem 0025
   SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'files'
      AND column_name IN ('scan_attempts', 'scan_next_attempt_at', 'scan_lease_until', 'scan_exhausted_at', 'scan_last_reason');   -- esperado: 0 linhas
   ```
   No checkout usado para o teste (`3348e27`, cuja última migration é a 0025), confirme que **o único arquivo ainda não registrado é a 0025**:
   ```bash
   ls db/migrations/*.sql | sed 's#.*/##' | LC_ALL=C sort > arquivos.txt
   psql "$ENSAIO_URL_SEM_SENHA" -X -A -t -c "SELECT id FROM schema_migrations" > registradas.bruto; echo "psql: $?"   # deve ser 0
   tr -d '\r' < registradas.bruto | LC_ALL=C sort > registradas.txt
   comm -23 arquivos.txt registradas.txt          # esperado: somente 0025_file_scan_retry.sql
   ```
   (No PowerShell, liste `Get-ChildItem db/migrations/*.sql` e compare com a consulta, ordenando as duas listas do mesmo modo.) Rode `npm run db:preflight` e exija código **0**. **Se qualquer confirmação falhar, interrompa.**
2. **Preparar o conflito, antes do runner.** O nome vem da migration real (`db/migrations/0025_file_scan_retry.sql`: `CREATE INDEX idx_files_scan_queue ON files(scan_next_attempt_at NULLS FIRST, id) WHERE …`). Crie um índice **com o mesmo nome e outra definição**:
   ```sql
   CREATE INDEX idx_files_scan_queue ON files (id);
   ```
3. **Confirmar o conflito presente e guardar o estado de referência**, antes de iniciar o runner:
   ```sql
   SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'files' AND indexname = 'idx_files_scan_queue';
   -- esperado: 1 linha, definição "... USING btree (id)" (NÃO a da 0025, que usa scan_next_attempt_at e WHERE)
   SELECT id FROM schema_migrations ORDER BY id;     -- salve como antes_registradas.txt
   ```
4. **Rodar o runner** com o bloco da seção 5, gravando em `rollback_ensaio.log`, e capturar o código de saída **imediatamente**. Preserve o log integral.
5. **Evidência direta no log (todas as condições; a falha de qualquer uma invalida o teste, que deve ser interrompido):**
   - o log existe, não está vazio nem truncado;
   - contém `Aplicando: 0025_file_scan_retry.sql...`;
   - contém `Falha ao aplicar migração:` e, na mesma mensagem, o nome `idx_files_scan_queue` com texto indicando que a relação já existe (a mensagem vem do servidor, no idioma configurado em `lc_messages`; em inglês, `relation "idx_files_scan_queue" already exists`);
   - **não** contém `Aplicada com sucesso: 0025_file_scan_retry.sql` e não contém nenhuma outra linha `Aplicando:` anterior à da 0025 (as anteriores devem aparecer como `Já aplicada, pulando:`);
   - o código de saída é **1**.
   ```bash
   grep -n "Aplicando: 0025_file_scan_retry.sql" rollback_ensaio.log
   grep -n "Falha ao aplicar migração" rollback_ensaio.log
   grep -n "idx_files_scan_queue" rollback_ensaio.log
   grep -c "Aplicada com sucesso" rollback_ensaio.log        # esperado: 0
   ```
   (No PowerShell, use `Select-String -Path rollback_ensaio.log -Pattern '…'`.) **Interromper e não aceitar o teste** se houve falha anterior à 0025, se a mensagem não corresponde ao conflito esperado, se não é possível confirmar que a 0025 foi iniciada, se o código não é 1, ou se o log está ausente ou truncado. Não repetir "para ver se muda": registre e comunique.
6. **Confirmação 1: rollback da 0025.** Registre à parte, depois do passo 5 passar:
   ```sql
   SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'files'
      AND column_name IN ('scan_attempts', 'scan_next_attempt_at', 'scan_lease_until', 'scan_exhausted_at', 'scan_last_reason');   -- esperado: 0 linhas
   SELECT id FROM schema_migrations WHERE id = '0025_file_scan_retry.sql';                                                          -- esperado: 0 linhas
   SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'files' AND indexname = 'idx_files_scan_queue'; -- esperado: ainda a definição de conflito (id)
   ```
7. **Confirmação 2: migrations anteriores intactas.** Registre à parte: `SELECT id FROM schema_migrations ORDER BY id` deve ser **idêntico** ao `antes_registradas.txt` (compare com `diff`, normalizando fins de linha), com a 0024 presente; e a coluna `files.scan_status` deve existir. As anteriores permanecem aplicadas porque cada arquivo roda na sua própria transação.
8. **Evidências:** guarde o log integral, o código de saída, as saídas dos passos 1, 3, 5, 6 e 7, **antes** da limpeza.
9. **Limpeza, somente no banco descartável (identidade verificada) e depois de guardar as evidências:** `DROP INDEX idx_files_scan_queue;` Reexecute o runner; esperado: código **0**, log com `Aplicada com sucesso: 0025_file_scan_retry.sql`, e `pg_indexes` mostrando a definição real da 0025 (com `scan_next_attempt_at` e `WHERE scan_status IN ('pendente', 'indisponivel') AND scan_exhausted_at IS NULL`).

Se o runner terminar por **qualquer outro motivo** (pré-verificação com código 2 ou 3, falha numa migration anterior, erro de conexão, mensagem diferente), registre e interrompa: **não contorne** e **não use as confirmações 1 e 2 como prova**.

## 9. Critérios e evidências

**Aprovar o ensaio quando:** a identidade do banco foi verificada e coincide com o alvo registrado antes de cada comando; a pré-verificação sai com 0; as consultas da seção 4.2 não devolvem violações; as migrations aplicam com código 0 e na ordem; as contagens antes/depois são idênticas; o efeito da 0024 é o esperado; o bloqueio e a duração da migration **inteira** (0023, 0024 e 0025) foram medidos em volume representativo e aceitos pela operação; o teste de rollback atendeu a **todas** as condições de evidência direta da seção 8 (estado inicial com somente a 0025 pendente, conflito confirmado antes, log integral com a tentativa de `0025_file_scan_retry.sql` e o erro de índice já existente, código 1, e as confirmações 1 e 2 registradas separadamente); a ausência das colunas e do registro da 0025, isoladamente, **não** é prova suficiente. **Nenhum critério depende apenas de CI verde.**

**Interromper quando:** qualquer código de saída diferente de 0 (exceto o código 1 esperado no teste da seção 8, e somente se o log mostrar que a falha foi a da 0025); violação nas consultas 4.2; contagem divergente; **divergência ou dúvida na verificação de identidade do banco**; qualquer comando que exigiria colocar a senha na linha de comando.

**Evidências a guardar:** data e hora; commit da aplicação; alvo esperado e a saída da verificação de identidade (sem credenciais); dump pré-migration e seu checksum; saídas de todas as consultas; `migrations_ensaio.log` revisado; códigos de saída; tempos e intervalos de bloqueio medidos, com o tamanho da tabela; resultado do teste de rollback; observações. Nunca guardar dados pessoais, conteúdos de arquivos nem credenciais.

## 10. O que este documento NÃO afirma

- Que as migrations 0023 a 0025 estejam validadas com dados históricos reais.
- Qualquer duração ou bloqueio como já observado: **todos precisam ser medidos**.
- Que o bloqueio dessas migrations seja aceitável.
- Que a produção possa receber as migrations: isso exige as validações acima, o backup, a janela de implantação aprovada e autorização explícita.
- Que a verificação de identidade do banco, por si só, garanta que o alvo seja descartável.
- Qualquer valor de tempo, tamanho ou capacidade.

## 11. Decisões humanas pendentes

| Decisão | Responsável |
|---|---|
| Autorização do ambiente descartável, do alvo esperado e do volume de dados do ensaio | responsável pelo projeto |
| Aceitação do bloqueio (leitura e escrita) das migrations 0023 a 0025 e da janela de implantação | operação / responsável pelo projeto |
| Política dos arquivos legados bloqueados pela 0024 (reanálise em lote, sob demanda ou priorizada) | responsável pelo projeto |
