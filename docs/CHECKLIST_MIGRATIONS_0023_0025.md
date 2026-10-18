# Checklist de validação das migrations 0023, 0024 e 0025

> **Status: ROTEIRO PROPOSTO, NÃO EXECUTADO.** Nenhum passo abaixo foi executado. **Nenhuma migration deve ser aplicada à produção a partir deste documento.** Use apenas um **banco descartável** ou uma **cópia sanitizada**, com autorização específica. As consultas SQL foram escritas e revisadas por leitura contra o `db/schema.sql` da `master` (`3348e27`), mas **não foram executadas**: confira a sintaxe no ambiente descartável antes de confiar nelas.
>
> **[código]** = conferido no código; **[proposta]** = procedimento a validar.

## 1. O que cada migration faz (leitura do código)

| Migration | Efeito | Ponto de atenção |
|---|---|---|
| **0023** `destination_proofs` | adiciona `stock_destinations.proof_removed BOOLEAN` (nulo), dois `CHECK` (`proof_removed_chk`, `proof_only_chk`), o índice único parcial `uq_stock_destinations_proof_file` e o gatilho `stock_destination_proof_validate` | os `CHECK` e o índice único **só passam se não houver linha antiga que os viole**; o `migrationCompat.ts` afirma que nenhum caminho de código gravou `proof_file_id` antes da 99J, mas **isso só os dados reais comprovam** |
| **0024** `file_scan_status` | adiciona `files.scan_status NOT NULL DEFAULT 'legado_nao_analisado'` (depois o padrão passa a `'pendente'`), `scan_checked_at`, `scan_engine`, `scan_signature`, o índice parcial `idx_files_org_scan_status` e o gatilho `files_scan_status_guard`; substitui a função `stock_destination_proof_validate` | **toda linha existente de `files` vira `legado_nao_analisado`**; no modo obrigatório (que `NODE_ENV=production` impõe) esses arquivos ficam **bloqueados para download e vínculo até serem reanalisados**. Não apaga nada, mas muda o comportamento funcional |
| **0025** `file_scan_retry` | adiciona `scan_attempts INTEGER NOT NULL DEFAULT 0` e quatro colunas anuláveis em `files`; cria o índice parcial `idx_files_scan_queue` | **o `CREATE INDEX` não usa `CONCURRENTLY`**: bloqueia escritas em `files` enquanto o índice é construído. O custo depende do tamanho da tabela, que não conheço |

**Nenhuma das três tem `DROP`, `DELETE` ou `UPDATE`.** Cada arquivo roda numa transação junto com o registro em `schema_migrations`, então uma falha desfaz o arquivo inteiro **[código: `db/run-migrations.ts`]**. Não existe migration de volta: reverter é restaurar o backup anterior **[doc: `DEPLOYMENT_RUNBOOK.md`, seção 6]**.

> **Atenção:** `npm run db:preflight` e a pré-verificação do `db:migrate:incremental` cobrem somente as restrições das migrations **0005, 0007, 0009, 0010 e 0013** **[código: `db/legacyPreflight.ts`]**. **Elas NÃO verificam os dados das migrations 0023, 0024 nem 0025.** As consultas da seção 4 são necessárias.

## 2. Pré-condições e autorização

1. Autorização **específica e por escrito** para o ambiente descartável (o responsável pelo projeto).
2. Banco **descartável** ou cópia **sanitizada**; nunca a produção. Confirmar que `DATABASE_URL` aponta para ele antes de cada comando.
3. O banco de ensaio deve estar no estado de produção **anterior** às migrations a validar (ou seja, sem 0021+ aplicadas, ou no ponto que se queira testar). Registrar a lista de `schema_migrations` antes de começar.
4. Tamanho e distribuição de dados representativos (a Fase 57 usou ~139 KB, o que **não** representa produção).
5. Execução a partir do repositório (`npm run ...`): os `.sql` não existem em `dist-server`.
6. Um responsável e um local para guardar as evidências (seção 9).

## 3. Backup e verificação prévia

```bash
# backup do banco de ENSAIO (formato custom), conforme docs/DATABASE_RECOVERY.md
pg_dump -U <usuario> -d <banco_de_ensaio> -Fc -Z 6 -f ensaio_pre_migrations.dump
sha256sum ensaio_pre_migrations.dump

# pré-verificação oficial (somente leitura; cobre 0005/0007/0009/0010/0013)
npm run db:preflight
```

Códigos de saída do `db:preflight`: **0** autorizada · **2** bloqueada (dados legados impeditivos, estrutura ausente ou estado inconsistente) · **3** não verificada. **Interromper** se o código for diferente de 0.

## 4. Inventário (somente leitura)

Execute com `psql` conectado ao banco de ensaio. Todas são `SELECT`; nenhuma altera dados.

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

```sql
-- eventos com link de download do próprio app (id limitado a 18 dígitos para a conversão numérica abaixo não estourar)
SELECT count(*) FROM logistics_events WHERE proof_url ~ '^/_api/v1/files-download\?fileId=[0-9]{1,18}$';

-- links externos (http/https): o sistema não analisa nem retém esse conteúdo
SELECT count(*) FROM logistics_events WHERE proof_url ~* '^https?://';

-- outros formatos (para entender o que existe)
SELECT count(*) FROM logistics_events
 WHERE proof_url IS NOT NULL
   AND proof_url !~ '^/_api/v1/files-download\?fileId=[0-9]{1,18}$' AND proof_url !~* '^https?://';

-- links do app cujo arquivo NÃO existe, ou existe em OUTRA organização
SELECT e.id, e.organization_id
  FROM logistics_events e
  LEFT JOIN files f ON f.id = substring(e.proof_url from 'fileId=([0-9]{1,18})$')::bigint
 WHERE e.proof_url ~ '^/_api/v1/files-download\?fileId=[0-9]{1,18}$'
   AND (f.id IS NULL OR f.organization_id <> e.organization_id);
```

Registrar os totais: depois da 0024, os links do app que apontam para arquivos legados passam a responder 409 no modo obrigatório até a reanálise.

## 5. Aplicação incremental e medições

```bash
# registre a hora; `time` mede o tempo total. Redirecione para um arquivo (sem pipe) para que $? seja o código do npm
time npm run db:migrate:incremental > migrations_ensaio.log 2>&1
echo "codigo de saida: $?"
cat migrations_ensaio.log
```

Códigos do `db:migrate:incremental`: **0** ok · **1** falha ao aplicar uma migration · **2** bloqueado pela pré-verificação · **3** pré-verificação não concluída. **Interromper** em qualquer código diferente de 0.

Medições a registrar para cada migration: tempo de aplicação (o log mostra "Aplicando/Aplicada com sucesso", sem cronometragem; meça com `time` ou rodando as migrations uma a uma em janelas separadas).

### 5.1 Bloqueio causado pela 0025 (índice sem `CONCURRENTLY`)

Para medir o efeito, em um banco com volume realista:
1. Em uma sessão, aplique a 0025 (ou execute apenas o `CREATE INDEX` do arquivo em uma transação de teste).
2. Em outra sessão, durante a construção, tente uma escrita em `files` e meça o tempo de espera; observe também:

```sql
SELECT pid, mode, granted, relation::regclass FROM pg_locks WHERE relation = 'files'::regclass;
SELECT pid, wait_event_type, wait_event, state, query FROM pg_stat_activity WHERE datname = current_database();
```

Leituras continuam possíveis; escritas (`INSERT`/`UPDATE`/`DELETE`) em `files` esperam. Com `ALTER TABLE ... ADD COLUMN` há também um bloqueio exclusivo breve. Registrar a duração e decidir, com a operação, se a janela aceita esse bloqueio **[decisão humana]**.

### 5.2 Verificação de `schema_migrations`

```sql
SELECT id, applied_at FROM schema_migrations WHERE id IN (
  '0023_destination_proofs.sql', '0024_file_scan_status.sql', '0025_file_scan_retry.sql') ORDER BY id;
```

Esperado: as três linhas, na ordem. Rodar `npm run db:migrate:incremental` de novo deve imprimir "Nenhuma migração pendente." (idempotência).

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

## 8. Teste de rollback em falha controlada

Somente em banco descartável. Objetivo: confirmar que a falha de uma migration desfaz o arquivo inteiro.
1. A partir do estado anterior à 0025, crie um objeto que cause conflito, por exemplo um índice com o nome `idx_files_scan_queue` em outra coluna de `files`.
2. Rode `npm run db:migrate:incremental` e confirme código de saída **1**.
3. Verifique que **nada** da 0025 ficou: a coluna `scan_attempts` não existe e `schema_migrations` não contém a 0025.
4. Remova o objeto de conflito e reaplique; a 0025 deve concluir.

## 9. Critérios e evidências

**Aprovar o ensaio quando:** a pré-verificação sai com 0; as consultas da seção 4.2 não devolvem violações; as migrations aplicam com código 0 e na ordem; as contagens antes/depois são idênticas; o efeito da 0024 é o esperado; o tempo e o bloqueio da 0025 foram medidos e aceitos pela operação; o teste de rollback comprovou o desfazimento.

**Interromper quando:** qualquer código de saída diferente de 0; violação nas consultas 4.2; contagem divergente; qualquer indício de que o ensaio está apontando para banco que não é descartável.

**Evidências a guardar:** data e hora; commit da aplicação; dump pré-migration e seu checksum; saídas de todas as consultas; `migrations_ensaio.log`; códigos de saída; tempos medidos; resultado do teste de rollback; observações sobre bloqueios. Nunca guardar dados pessoais, conteúdos de arquivos nem credenciais.

## 10. O que este documento NÃO afirma

- Que as migrations 0023 a 0025 estejam validadas com dados históricos reais.
- Que o bloqueio de escrita da 0025 seja aceitável (depende do tamanho da tabela).
- Que a produção possa receber as migrations: isso exige as validações acima, o backup, a janela de implantação aprovada e autorização explícita.
- Qualquer valor de tempo, tamanho ou capacidade.

## 11. Decisões humanas pendentes

| Decisão | Responsável |
|---|---|
| Autorização do ambiente descartável e do volume de dados do ensaio | responsável pelo projeto |
| Aceitação do bloqueio de escrita da 0025 e da janela de implantação | operação / responsável pelo projeto |
| Política dos arquivos legados bloqueados pela 0024 (reanálise em lote, sob demanda ou priorizada) | responsável pelo projeto |
