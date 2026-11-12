# Jornada do produto (M40)

Visão contínua, **por necessidade**, do cadastro à prestação de contas: `/organizacoes/:id/jornada` (lista) e `?necessidade=ID` (detalhe).

## O que é
- Leitura sobre o que os módulos já persistem. **Nenhuma contabilidade nova** e nenhum valor inventado: suprimento (recebido da rede) e atendimento final (destinado) continuam sendo contabilidades distintas.
- Etapas: necessidade, correspondência, atribuição, recebimento, destinação, atendimento, prestação. Estados: concluída, em andamento, pendente, sem dados, não se aplica, restrita.
- Oferta registrada, oportunidade, atribuição e destinação continuam sendo coisas diferentes: uma oferta registrada **não** é doação entregue.
- Saídas de alto risco aguardando a segunda aprovação aparecem como pendência (o estoque só baixa na aprovação).

## Endpoints
- `GET /journeys` (lista, cursor por id) e `GET /journey` (detalhe). Exigem `necessidades.leia`; o servidor decide as seções por papel (rede = `atribuicoes.leia`, estoque = `inventario.lance`, oportunidades, relatórios, auditoria). Necessidade de outra organização → 404/403.

## Correlação e resultado (migration 0039)
- `needs.correlation_id` é gerado **no servidor** ao criar a necessidade. Os fluxos que tocam a necessidade (necessidade, atribuição, recebimento, destinação, correções/estornos, matching) gravam auditoria com `outcome` explícito e herdam a correlação pelo `need_id` persistido. Os demais fluxos continuam com "resultado não registrado".
- A jornada liga à Central de Auditoria filtrada: `/auditoria?correlacao=<id>`.

## Limites conhecidos
- A jornada é centrada na necessidade: ofertas do registro sem necessidade vinculada não aparecem.
- Nenhuma tela comprova entrega física; "prestação" são registros, **não homologação**.
- Decisões de política seguem pendentes (obrigatoriedade/catálogo de categoria, tolerância de quantidade, alto valor, reavaliação de decisões concluídas, limites globais, retenção, âncora independente, privilégios do banco de produção, arquivamento, regra de edição de quantidade).

## M41 — jornada unificada de ofertas e necessidades
- **Ofertas sem necessidade** entram na mesma página (`/organizacoes/:id/jornada`): *oferta local* (`donation_opportunities` sem `linked_need_id`) e *atribuição da rede sem necessidade* (`opportunity_allocations` sem `need_id` e sem avaliação de matching com necessidade). Detalhe em `GET /offer-journey` (`?oferta=local-ID` / `?oferta=rede-ID`). Nada é preenchido para "completar" as sete etapas: o que não existe é dito como pendente, não se aplica ou sem dados; oferta registrada não é doação entregue.
- **Vincular depois: bloqueado por regra de negócio.** O domínio só aceita a necessidade na criação da oferta/atribuição; não existe operação de vínculo posterior. Nada foi inventado: a tela explica o motivo e aponta as ações existentes (Oportunidades, Atribuições, Necessidades). **Decisão pendente:** criar (ou não) a operação de vincular depois, com suas regras de quantidade, estado e auditoria.
- **Origem da atribuição** vem só do persistido: `matching` (há `match_evaluations` ligada à atribuição), `manual` (pessoa autorizada, sem avaliação) ou `nao_verificavel` (marcada como automática sem avaliação no histórico). A etapa "Correspondência" só fica *concluída* quando o motor avaliou; atribuição manual aparece como "não se aplica — atribuição manual autorizada". Registros antigos não foram reescritos. As novas auditorias de atribuição gravam `origem` (`manual`/`matching`).
- **Busca, filtros e paginação no servidor** (`GET /journeys`): `q` (título, descrição, doador, categoria, `#id`, correlação), `tipo`, `vinculo`, `status`, `cursor` opaco; ordenação total e estável (criado em ↓, tipo ↑, id ↓). Só entram os tipos que o papel pode ler; os filtros vivem na URL e o voltar os preserva. Sem busca insensível a acentos (não há extensão `unaccent`).
- **Auditoria:** oferta local usa a correlação própria (M39); atribuição sem necessidade não tem correlação própria — a Central é consultada por recurso (`?recurso=opportunity_allocation&recursoId=`), sem inventar correlação.
- **Limites conhecidos:** matching executado sem resultado não deixa registro por necessidade; ofertas do Registro Central ainda não atribuídas a esta organização não aparecem (não são dela); destinação não é ligada a ofertas, só a item e necessidade.

## M42 — histórico de execuções do matching (inclusive sem correspondência)
- **Migration `0040_matching_runs`:** `matching_runs` (uma linha por execução que AVALIOU: origem, estado, contagens calculadas, código seguro de falha, correlação própria, assinatura e `repeat_count`), `matching_run_needs` (quais necessidades abertas foram consideradas e a relação: `sem_relacao`, `avaliada`, `avaliada_sem_registro`) e `match_evaluations.matching_run_id` (nulo para avaliações anteriores). Nenhuma execução é fabricada para o passado.
- **Estados por necessidade** (derivados só do que foi registrado): *não executado*, *executado com correspondência*, *executado sem correspondência* (não é falha e não prova falta de oferta), *atribuição manual (matching não executado)*, *resultado histórico não verificável* e *restrita ao papel*. Execução que **falha** é registrada em transação própria (`falhou`, código SQLSTATE seguro, nunca a mensagem) com auditoria `matching.falhou` (resultado `falhou`); ela não é atribuível a uma necessidade e não conta como "avaliada" (a varredura volta a tentar). "Em andamento" só existe dentro da transação (a execução é atômica); não existe cancelamento de matching.
- **Origem da execução:** `varredura`, `manual`, `mudanca_de_estado`, `reabertura`, `expiracao` ou `indeterminada`. Repetição automática idêntica da varredura **não** cria execução nem auditoria (Fase 95): reconfirma a anterior (`repeat_count`). Execução de usuário é sempre registrada. Tentativa ignorada (oferta inexistente, inelegível ou sem quantidade livre) não avaliou nada e não deixa execução.
- **Auditoria:** `matching.executado` agora traz correlação própria da execução, `execucaoId`, `origem`, `resultado` (`com_correspondencia`/`sem_correspondencia`) e contagens; o resultado do registro continua explícito (`concluida`). Registros da plataforma (organização nula): a organização NÃO os lê pela Central; a plataforma lê as execuções em `GET /matching-runs`.
- **Privacidade corrigida:** avaliação de oferta que NÃO foi atribuída à organização deixa de expor título, categoria, quantidade e o texto dos critérios (que carrega atributos da oferta) na jornada da necessidade; só a oferta atribuída é identificada (M40/M41 expunham).
- **Busca sem acentos** no servidor, sem extensão: a mesma tabela de troca é aplicada ao termo e à coluna (`translate` + `lower`); identificadores literais (`#id`, correlação) e o escape de `%`/`_` foram preservados. A expressão não usa índice e roda só sobre as linhas da organização.
- **Limites:** execuções anteriores à M42 não deixaram registro por necessidade; a contagem de necessidades consideradas é da plataforma e só aparece para ela; o motor não registra o *motivo* específico de incompatibilidade (só a relação e as decisões que calcula).
