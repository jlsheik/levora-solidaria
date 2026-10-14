> **DOCUMENTO HISTÓRICO** — retrata a Fase 5 em 24/09. Hoje o matching está
> na versão 1.4 (aqui: 1.0), há 407 testes automatizados (aqui: nenhum) e o
> agendador foi observado rodando de verdade (Fases 12, 62 e 69). Estado
> atual em `docs/ROADMAP_ATUAL.md`. Texto original preservado abaixo.

## Status de implementação — fase 5 (Motor de tarefas e Motor de correspondência)

Testado ponta a ponta via API real (não simulado):

- **Alta confiança (≥90%)**: doação de cobertores em Belo Horizonte, 12
  unidades, urgência alta, contra uma organização em Belo Horizonte com
  necessidade crítica de 10 cobertores → pontuação 100%, atribuição criada
  automaticamente com status "aceita" — **sem nenhuma decisão humana** — e
  a descoberta central foi direto para "atribuida". Um segundo candidato
  (organização em Contagem com necessidade de 200 unidades, prioridade
  baixa) ficou em 57,2% e foi descartado, registrado no `match_evaluations`
  com decisão "descartado".
- **Confiança média (70–89,99%)**: doação de roupas de frio em Belo
  Horizonte contra uma organização em Campinas/SP (estado diferente, por
  isso proximidade mais baixa) com necessidade de prioridade alta → 73%,
  criou uma atribuição "proposta" com reserva de 30 minutos
  (`reserved_until`), aguardando a organização decidir.
- **Reabertura após reserva expirada**: simulei a reserva vencida e a
  reabertura da oportunidade (exatamente o que a tarefa `expireReservations`
  faz) e rodei o matching de novo — gerou uma nova proposta para o mesmo
  candidato, confirmando que a oportunidade não fica travada esperando uma
  organização que não respondeu.
- **Transparência**: cada avaliação (`/plataforma`, "Ver avaliações de
  matching") mostra os critérios usados, o peso de cada um, o resultado,
  a versão do algoritmo (1.0), se IA foi usada, e a decisão — os critérios
  sem dado real (capacidade, raio de atendimento, horários) aparecem como
  `"nao_aplicavel: dado nao coletado ainda"`, nunca como número inventado.

### Lacuna real encontrada e corrigida durante o teste

Organizações nasciam com status `em_analise` e **não existia nenhum jeito
de aprová-las** — isso faria o motor de correspondência nunca encontrar
candidato nenhum em uso real, silenciosamente. Corrigido agora: endpoint
`platform-organizations-status` (admin) e seção "Organizações" no painel
de plataforma, com aprovar/suspender.

### O que ainda não pôde ser testado de verdade

- O disparo automático das tarefas agendadas (`expireOpportunities`,
  `expireReservations`, `runMatchingSweep`) pelo relógio do Floot — isso só
  roda em produção, com o projeto publicado e em plano pago. A **lógica**
  de cada uma foi testada manualmente (reproduzindo exatamente os passos
  que a tarefa executaria), mas o agendamento em si não pôde ser observado
  rodando sozinho neste ambiente de desenvolvimento.
- Testes automatizados formais (suite de testes) não foram criados — os
  testes feitos foram de integração real via chamadas HTTP diretas ao
  ambiente do projeto, documentados aqui em vez de como arquivos de teste
  no repositório. Se preferir uma suite formal (Jasmine, que o Floot
  suporta), posso criar a partir destes mesmos cenários.
