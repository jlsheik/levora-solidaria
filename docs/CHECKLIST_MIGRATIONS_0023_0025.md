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

> **Atenção:** `npm run db:preflight` e a pré-verificação do `db:migrate:incremental` cobrem somente as restrições das migrations **0005, 0007, 0009, 0010 e 0013** **[código: `db/legacyPreflight.ts`]**. **Elas NÃO verificam os dados das migrations 0023, 0024 nem 0025.** As consultas da seção 4 são necessárias.

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
2. **Definir a conexão explicitamente e neutralizar fallbacks.** Sem escrever a senha na linha de comando nem no histórico. Percent-encode caracteres especiais da senha.

   POSIX (bash):
   ```bash
   unset FLOOT_DATABASE_URL S3_BUCKET S3_REGION S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_ENDPOINT
   unset PGHOST PGPORT PGDATABASE PGUSER PGSERVICE PGPASSFILE   # evita que o psql herde alvo de variáveis PG*
   read -r -s -p "Senha do banco de ENSAIO: " ENSAIO_SENHA; echo
   export DATABASE_URL="postgres://<usuario_ensaio>:${ENSAIO_SENHA}@<host_ensaio>:<porta>/<banco_ensaio>"
   unset ENSAIO_SENHA
   ```

   PowerShell:
   ```powershell
   Remove-Item Env:FLOOT_DATABASE_URL, Env:S3_BUCKET, Env:S3_REGION, Env:S3_ACCESS_KEY_ID, Env:S3_SECRET_ACCESS_KEY, Env:S3_ENDPOINT -ErrorAction SilentlyContinue
   Remove-Item Env:PGHOST, Env:PGPORT, Env:PGDATABASE, Env:PGUSER, Env:PGSERVICE, Env:PGPASSFILE -ErrorAction SilentlyContinue
   $s = Read-Host "Senha do banco de ENSAIO" -AsSecureString
   $p = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   $env:DATABASE_URL = "postgres://<usuario_ensaio>:$p@<host_ensaio>:<porta>/<banco_ensaio>"
   Remove-Variable p, s
   ```
   As variáveis valem só para o terminal atual. **Nunca** imprima `DATABASE_URL` (`echo`, `Get-ChildItem Env:`, `set -x`).
3. **Verificar a identidade do servidor e do banco, no mesmo terminal e com a mesma variável**, antes de **cada** comando que se conecte ao banco (`db:preflight`, `db:migrate:incremental`, `storage:audit`, `psql`, `pg_dump`):

   POSIX: `psql "$DATABASE_URL" -X -A -t -c "SELECT current_database(), inet_server_addr(), inet_server_port(), current_user"`
   PowerShell: `psql $env:DATABASE_URL -X -A -t -c "SELECT current_database(), inet_server_addr(), inet_server_port(), current_user"`

4. **Comparar com o alvo esperado registrado no item 1 da seção 2** (nome do banco, endereço e porta). **Se houver qualquer divergência, ou dúvida, interromper e comunicar o responsável**; não repetir para "ver se muda".
   - **Limites desta verificação:** o resultado só prova que a conexão aponta para o alvo registrado; **não prova**, sozinho, que o alvo registrado seja descartável (isso depende de o responsável ter definido corretamente o alvo). `inet_server_addr()` retorna nulo em conexão por socket Unix; túneis, proxies e apelidos de DNS podem fazer o endereço divergir do esperado sem que haja erro.
5. **Não registrar credenciais.** Antes de arquivar `migrations_ensaio.log` e relatórios, revise-os e remova qualquer host, URL ou credencial que apareça.

Repita os passos 3 e 4 sempre que abrir um terminal novo ou alterar variáveis de ambiente.

## 3. Backup e verificação prévia

```bash
# (identidade do banco verificada conforme a seção 2.1)
# backup do banco de ENSAIO (formato custom), conforme docs/DATABASE_RECOVERY.md
pg_dump -d "$DATABASE_URL" -Fc -Z 6 -f ensaio_pre_migrations.dump
sha256sum ensaio_pre_migrations.dump

# pré-verificação oficial (somente leitura; cobre 0005/0007/0009/0010/0013)
npm run db:preflight
```
No PowerShell, use `pg_dump -d $env:DATABASE_URL …` e `Get-FileHash -Algorithm SHA256 ensaio_pre_migrations.dump`.

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

O código aceita como `proofUrl` um caminho relativo do app **ou qualquer URL `http(s)`** **[código: `src/helpers/proofUrl.ts`]**; o recebimento com arquivo grava exatamente `/_api/v1/files-download?fileId=<id>`. Um link `http(s)` pode portanto ser um endereço absoluto **da própria aplicação** (que também será afetado pela 0024) ou um site externo. **Não classifique automaticamente todos os links `http(s)` como externos.**

```sql
-- (a) caminho relativo do app (formato gravado pelo recebimento; aceita sufixo de parâmetros/âncora)
SELECT count(*) AS relativo_do_app FROM logistics_events
 WHERE proof_url ~ '^/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$';

-- (b) URL http(s) ABSOLUTA que contém o caminho de download do app (possível link da própria aplicação)
SELECT count(*) AS absoluto_com_caminho_do_app FROM logistics_events
 WHERE proof_url ~* '^https?://[^/]+/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$';

-- hosts dos links do tipo (b), para decidir quais são da própria aplicação
SELECT substring(proof_url from '^https?://([^/]+)') AS host, count(*) FROM logistics_events
 WHERE proof_url ~* '^https?://[^/]+/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$'
 GROUP BY 1 ORDER BY 2 DESC;

-- (c) outros http(s) (externos ou de formato desconhecido)
SELECT count(*) AS outros_http FROM logistics_events
 WHERE proof_url ~* '^https?://'
   AND proof_url !~* '^https?://[^/]+/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$';

-- (d) qualquer outro formato não vazio
SELECT count(*) AS outros_formatos FROM logistics_events
 WHERE proof_url IS NOT NULL AND proof_url <> ''
   AND proof_url !~ '^/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$'
   AND proof_url !~* '^https?://';

-- links dos tipos (a) e (b) cujo arquivo NÃO existe, ou existe em OUTRA organização
-- (para (b), o resultado só é conclusivo se o host for o da própria aplicação)
SELECT e.id, e.organization_id
  FROM logistics_events e
  LEFT JOIN files f ON f.id = substring(e.proof_url from '/_api/v1/files-download\?fileId=([0-9]{1,18})')::bigint
 WHERE e.proof_url ~* '^(https?://[^/]+)?/_api/v1/files-download\?fileId=[0-9]{1,18}([&#].*)?$'
   AND (f.id IS NULL OR f.organization_id <> e.organization_id);
```

Registrar os totais. Depois da 0024, os links dos tipos (a) e (b) que apontam para arquivos legados passam a responder 409 no modo obrigatório até a reanálise. Os de tipo (c) e (d) não passam pelo sistema.

## 5. Aplicação incremental e medições

**Atenção:** o runner **aplica todas as migrations pendentes** de uma vez (`db/run-migrations.ts` percorre todos os arquivos de `db/migrations/` ainda não registrados); **não há opção documentada para aplicar uma migration específica**. Se 0021 e 0022 também estiverem pendentes no banco de ensaio, elas serão aplicadas na mesma execução, e o tempo total e o bloqueio observados as incluirão. Interprete os resultados com isso em mente.

```bash
# (identidade do banco verificada conforme a seção 2.1; registre a hora de início)
date -u +"%Y-%m-%dT%H:%M:%SZ"
time npm run db:migrate:incremental > migrations_ensaio.log 2>&1
echo "codigo de saida: $?"
date -u +"%Y-%m-%dT%H:%M:%SZ"
cat migrations_ensaio.log
```
(Redirecionar para arquivo, sem `pipe`, mantém `$?` como o código do `npm`. No PowerShell, use `Measure-Command { npm run db:migrate:incremental *> migrations_ensaio.log }` e `$LASTEXITCODE`.)

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

**Método 1: tempo total.** O `time` / `Measure-Command` da seção 5 dá a duração do runner inteiro (inclui a pré-verificação e a partida do Node).

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

**Objetivo:** confirmar que a falha de uma migration desfaz **aquele arquivo** inteiro (as colunas `ADD COLUMN` que o precedem na mesma transação), sem desfazer as migrations anteriores já confirmadas.

**Somente no banco descartável confirmado** (seção 2.1, repetida antes de cada passo). **Nunca em produção.** O conflito deve ser preparado **antes** de iniciar o runner. O nome e a definição do índice abaixo vêm da migration real (`db/migrations/0025_file_scan_retry.sql`: `CREATE INDEX idx_files_scan_queue ON files(scan_next_attempt_at NULLS FIRST, id) WHERE …`).

1. Parta de um banco de ensaio com as migrations 0021 a 0024 ainda pendentes **ou** com 0024 já aplicada e a 0025 pendente, e sem o índice abaixo.
2. **Prepare o conflito** (um índice com o mesmo nome, em outra definição):
   ```sql
   CREATE INDEX idx_files_scan_queue ON files (id);
   ```
3. Rode o runner (seção 5). **Esperado:** as migrations anteriores à 0025 (se pendentes) são aplicadas e confirmadas; a 0025 **falha** no `CREATE INDEX` ("relation … already exists"), a mensagem "Falha ao aplicar migração" aparece e o código de saída é **1**.
4. **Verifique o rollback da transação da 0025** (todas devem confirmar o desfazimento):
   ```sql
   -- nenhuma das cinco colunas da 0025 deve existir (esperado: 0 linhas)
   SELECT column_name FROM information_schema.columns
    WHERE table_name = 'files'
      AND column_name IN ('scan_attempts', 'scan_next_attempt_at', 'scan_lease_until', 'scan_exhausted_at', 'scan_last_reason');
   -- a 0025 não pode estar registrada (esperado: 0 linhas)
   SELECT id FROM schema_migrations WHERE id = '0025_file_scan_retry.sql';
   -- as anteriores permanecem registradas (esperado: 0024 presente)
   SELECT id FROM schema_migrations WHERE id = '0024_file_scan_status.sql';
   ```
5. **Registre as evidências** (saídas das consultas, código de saída, log do runner), **antes** da limpeza.
6. **Limpeza, somente no banco descartável:** `DROP INDEX idx_files_scan_queue;` Reaplique o runner; a 0025 deve concluir com código 0.

Se, no passo 3, o runner terminar por **outro** motivo (por exemplo, a pré-verificação com código 2 ou 3), registre e interrompa: **não contorne**.

## 9. Critérios e evidências

**Aprovar o ensaio quando:** a identidade do banco foi verificada e coincide com o alvo registrado antes de cada comando; a pré-verificação sai com 0; as consultas da seção 4.2 não devolvem violações; as migrations aplicam com código 0 e na ordem; as contagens antes/depois são idênticas; o efeito da 0024 é o esperado; o bloqueio e a duração da migration **inteira** (0023, 0024 e 0025) foram medidos em volume representativo e aceitos pela operação; o teste de rollback comprovou o desfazimento. **Nenhum critério depende apenas de CI verde.**

**Interromper quando:** qualquer código de saída diferente de 0 (exceto o código 1 esperado no teste da seção 8); violação nas consultas 4.2; contagem divergente; **divergência ou dúvida na verificação de identidade do banco**.

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
