# Fase 99F — progresso de atendimento da necessidade e regra definitiva de `atendida`

Contrato desta fase: o atendimento de uma necessidade é **derivado das destinações válidas** (`stock_destinations`), nunca de um clique, do ledger de suprimento (`need_fulfillments`) ou de um status manual. A Fase 99 **não** está concluída; esta é só a subfase 99F.

## Medidas (nenhuma é somada a outra)

| Medida | Fonte | Significado |
| --- | --- | --- |
| Suprimento recebido | `need_fulfillments` (ledger) | O que a rede enviou/recebeu para a necessidade. **Sem mudança de significado.** |
| Em estoque | saldo derivado de `stock_transactions` | Saldo físico do item. |
| Destinado (físico) | `stock_destinations.quantity` líquido de reversões | Quantidade que saiu do estoque para a necessidade, em qualquer unidade. |
| **Atendido** | `stock_destinations.applied_quantity` (ou `quantity` em registros anteriores) líquido de reversões, só `is_countable` (finalidade de atendimento + unidade equivalente) | O que conta para cumprir a necessidade. |
| Excedente | `surplus_quantity` | Parte física que passou do que faltava; **não** conta como atendimento. |
| Unidade incompatível | destinações de unidade diferente da necessidade | Saída física registrada, **não** conta e nada é convertido. |

Fórmula: `atendido = min(solicitado, Σ aplicado líquido)`; `faltam = solicitado − atendido`; `percentual = atendido / solicitado`. Calculada em `src/helpers/needAttendance.tsx` (em lote, sem N+1) e **recalculada no servidor** sob trava; números vindos do navegador nunca são usados.

## Atendimento parcial (projeção, sem novo status)

Não há status persistido novo. `sem_atendimento` / `parcial` / `atendida` / `atendida_historica` / `cancelada` são uma **projeção** devolvida por `GET /needs` (`attendance.state`), mais o encerramento ativo (`closure`). Necessidade parcial continua `aberta`.

## Regra definitiva de `atendida`

- **Automática:** a destinação que leva o atendido a ≥ solicitado muda a necessidade para `atendida` **na mesma transação** da destinação (necessidade travada `FOR NO KEY UPDATE`), com auditoria `necessidade.atendida_automaticamente`. Nunca cria saída de estoque.
- **Manual (`POST /needs-status`):** `atendida` só é aceita se o atendimento recalculado alcança a quantidade (senão `409 atendimento_insuficiente` com o progresso real); `cancelada` é recusada (`409 encerramento_exige_motivo`); reabrir necessidade atendida por destinação é recusado (`atendida_por_destinacao` — a correção é a reversão, da 99G); registros históricos (atendida/cancelada sem evento) continuam reabríveis. Nenhuma resolução administrativa nova (`need_resolutions` não é mais escrita).
- Necessidade `atendida`/`cancelada` não recebe novas destinações (`necessidade_nao_aberta`).

## Excedente

Se a quantidade supera o que falta: `409 excedente_nao_autorizado` (com `maxAplicavel`). Com `authorizeSurplus: true` + `surplusReason` (≥ 10 caracteres) e papel de proprietário/administrador, a destinação grava `applied_quantity` (o que faltava) e `surplus_quantity` (o resto), `authorized_by_user_id`; a quantidade **física** nunca é cortada. Operador: `403 excedente_exige_permissao`; motivo curto: `422`. A aprovação de alto risco da 99E é preservada (quem aprova precisa poder autorizar).

## Encerramento e reabertura (`POST /need-closure`)

- `encerrar`: motivo estruturado (`recursos_insuficientes`, `necessidade_superada`, `duplicidade`, `desistencia_da_organizacao`, `outro`); com atendimento parcial a descrição é obrigatória (≥ 5), `outro` exige ≥ 10. Atômico: evento `encerramento` em `need_closures` (instantâneo solicitado/atendido/não atendido) → `needs.status = cancelada` → auditoria `necessidade.encerrada`. **Sem movimento de estoque; destinações e suprimentos preservados.** Necessidade `atendida` não é encerrada.
- `reabrir`: evento `reabertura` que corrige o encerramento (o original fica no histórico) e volta a `aberta`; o progresso é **recalculado**, nunca reiniciado. Auditoria `necessidade.reaberta`.
- Qualquer falha (inclusive de auditoria) desfaz status e evento.

## Compatibilidade histórica

Nenhuma destinação é inventada e nenhuma necessidade é reaberta automaticamente. `atendida` sem destinação aparece como **"Atendimento histórico sem destinação estruturada"** (`atendida_historica`). Destinações da 99E sem `applied_quantity` usam `quantity` como aplicado.

## Matching

`opportunityMatching` e `opportunity-allocations_POST` usam `min(faltante pelo suprimento, faltante pelo atendimento)`: necessidade parcial continua pedindo só o que falta; atendida/encerrada não recebe; o mesmo recurso nunca é contado duas vezes. A necessidade é relida sob `FOR SHARE` antes de alocar. Pesos e limiares do matching não mudaram.

## Banco (migration `0021_destination_applied_quantity`)

Colunas nullable `applied_quantity`/`surplus_quantity` em `stock_destinations` (CHECKs de forma: `0 ≤ aplicada ≤ quantidade`, `aplicada + excedente ≤ quantidade`), função `need_applied_total()` e gatilho `stock_destination_need_cap` (trava a necessidade e rejeita total aplicado acima da solicitada — defesa contra concorrência fora do endpoint). Espelhada em `db/schema.sql`, classificada em `db/migrationCompat.ts`. Tabelas: 31 (sem tabela nova).

## Interface

Página de necessidades: barra de progresso (`role=progressbar`), atendido/faltam/percentual, selo de estado, nota de histórico, excedente, unidade incompatível e dados do encerramento; ações "Encerrar" (diálogo com motivo) e "Reabrir"; o seletor livre de status saiu. Diálogo de destinação: "faltam X de Y", aviso e autorização de excedente (proprietário/administrador, com motivo).

## Testes

`test/needAttendance.test.ts` (14: parcial, atendida automática, finalidades, unidade incompatível, histórico, excedente + permissões, restrições do banco, encerramento/reabertura/rollback/permissão/isolamento, concorrência de destinações e destinação × encerramento) e adaptações de `needsStatus`, `stockDestinationsFlow`, `needDetails`, `needFulfillmentCorrections`, `ledgerLockOrder`, `seedStaging`, `qaCi`. Sensibilidade comprovada: sem a atualização automática de `atendida` 4 testes falham; sem a checagem de excedente 1 falha.

## Fora do escopo (próximas subfases)

Correções, reversões e devolução física (99G, que terá de reavaliar `atendida` quando um atendimento for revertido); relatórios (99H); histórico/prestação de contas na interface (99I); comprovantes e privacidade (99J); validação de ponta a ponta (99K).
