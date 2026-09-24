# Auditoria — Discovery Engine e Registro Central de Oportunidades

Resposta às 7 perguntas do pedido de correção de arquitetura, antes de
implementar.

## 1. O que já existe

- Fundação multi-tenant (organizações, papéis, auditoria imutável).
- Inventário com ledger real de estoque.
- Necessidades por organização.
- `donation_opportunities`: oportunidades **registradas manualmente dentro
  de uma organização** (um operador digitou um contato que ele mesmo fez).
  Isso continua existindo e é um fluxo legítimo e diferente do pedido agora
  — mantido como está, ver seção 3.
- Nenhum conector externo, nenhuma fila de tarefas, nenhum registro de
  fontes, nenhum registro central de oportunidades sem dono.

## 2. O que está faltando (e será implementado nesta etapa)

- Registro de Fontes (`sources`).
- Interface comum de conectores (contrato TypeScript).
- Registro Central de Oportunidades (`opportunity_registry`), sem
  organização dona, com a máquina de estados completa pedida.
- Atribuições/lotes (`opportunity_allocations`) — permite dividir uma
  oportunidade entre várias organizações, sem a Levora ser dona física do
  item em nenhum momento.
- Papel de operador de plataforma — decisão: **reaproveitar o campo global
  `users.role = 'admin'`** que já existe na fundação de autenticação, em
  vez de criar um sistema de papéis paralelo. Quem for `admin` gerencia
  fontes e o registro central; organizações continuam vendo só o que foi
  atribuído a elas.

## 3. O que precisa ser refatorado

- Nada do que já existe precisa ser refeito. `donation_opportunities`
  (contato direto feito por um operador da própria organização) e
  `opportunity_registry` (descoberta central, ainda sem dono) são dois
  fluxos diferentes e vão coexistir — o primeiro não é substituído pelo
  segundo.
- Quando uma organização aceita uma atribuição (`opportunity_allocations`)
  e a recebe de fato, o recebimento gera uma transação real de estoque,
  reaproveitando exatamente o mesmo mecanismo já testado na fase 3
  (nenhuma duplicação de lógica de estoque).

## 4. Contratos a adicionar

- `helpers/connectors/types.tsx`: interface `SourceConnector` com os 13
  pontos pedidos (identificação, autenticação, descoberta, coleta,
  normalização, paginação, deduplicação, tratamento de erros, limites,
  auditoria, desligamento, renovação de credencial, monitoramento).
- Máquina de estados de `opportunity_registry` como mapa de transições
  permitidas, validado no servidor (não apenas sugerido na interface).

## 5. Conectores que podem ser implementados agora de verdade

Apenas **um**: o conector `manual` — um operador de plataforma (`admin`)
registra à mão uma oportunidade que descobriu (por telefone, e-mail, visita
pessoal, indicação). Isso é honesto: é descoberta real, feita por uma
pessoa autorizada, só que sem automação. Ele implementa a interface
`SourceConnector` inteira (com "coleta" e "descoberta" sendo, neste caso,
a submissão de um formulário por um humano).

## 6. Integrações que exigem configuração externa (não implementadas agora)

Sites públicos/scraping autorizado, Facebook/Meta, X, e-mail autorizado,
formulários automatizados — todas exigem credencial e/ou aprovação de
plataforma externa que não temos. Cada uma, quando configurada, aparece no
Registro de Fontes com `status = 'nao_configurada'` e a interface mostra
literalmente **"Conector não configurado"** — nunca um resultado
simulado. O contrato (`SourceConnector`) já está pronto para receber a
implementação de cada uma sem alterar o núcleo.

## 7. Dependências que ficam parametrizadas

- Credencial de cada fonte: referenciada por nome de variável de ambiente
  em `sources.credential_ref`, nunca armazenada em texto no banco.
- Frequência de execução (`run_frequency_minutes`) e organização
  autorizadora ficam no registro de fontes, prontas para quando um
  executor em segundo plano (`queueTask`/`scheduled-jobs`, disponíveis no
  Floot) for ligado a um conector real. **Nenhum agendamento foi criado
  agora** — agendar a execução de um conector que não faz nada de real
  seria, na prática, fingir automação. O gancho de código existe; o
  agendamento entra junto com o primeiro conector de verdade.
