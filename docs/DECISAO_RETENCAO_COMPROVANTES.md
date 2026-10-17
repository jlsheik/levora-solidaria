# Decisão pendente — retenção, exclusão e anonimização de comprovantes

**Status: PENDENTE de decisão jurídica e operacional. Este documento NÃO é parecer jurídico e NÃO define prazos.** Nenhum prazo foi escolhido, nenhuma rotina de exclusão existe e nenhuma foi implementada. A LGPD não fixa um prazo geral único de tratamento; a conservação depende da finalidade e de hipóteses específicas (ver as perguntas frequentes da ANPD: gov.br/anpd/pt-br/acesso-a-informacao/perguntas-frequentes). A decisão cabe ao controlador, com orientação jurídica.

## 1. O que o sistema guarda hoje

| Categoria | Onde | Conteúdo | Observações |
|---|---|---|---|
| Objeto do comprovante | armazenamento privado (disco ou S3) | foto/PDF enviado pelo usuário (JPEG, PNG, WebP, PDF, até 8 MB) | pode conter dado pessoal de terceiros enviado por engano; **não há detecção automática** |
| Metadados | `files` | organização, quem enviou, nome original, tipo, tamanho, finalidade, estado da análise, motor/assinatura, datas | nome do arquivo é livre (pode identificar alguém) |
| Vínculo | `stock_destinations` (eventos imutáveis) | arquivo ↔ destinação, motivo, autor, data; remoção de referência é outro evento | append-only; o objeto nunca é apagado |
| Auditoria | `audit_log` (encadeada por hash) | ator, ação, nome/tipo/tamanho do arquivo, motivo | **a cadeia de hash impede apagar/alterar linhas sem quebrar a verificação** |
| Destinação | `stock_destinations` | quantidades, finalidade, **números agregados** de pessoas/famílias, observações | sem cadastro nominal de beneficiários |

Finalidade do tratamento: demonstrar o destino dos recursos (prestação de contas), não identificar pessoas. Acesso: membros com `inventario.lance` (comprovante vigente); autor e proprietário/administrador para pendente/removido; nunca fora da organização.

## 2. Perguntas que precisam de resposta (com opções — nenhuma está aprovada)

1. **Base legal e finalidade** do tratamento dos comprovantes (e de eventual dado pessoal neles) — e quem é o controlador: cada organização, a plataforma ou ambos?
2. **Prazo mínimo de guarda** para prestação de contas (convênios, doadores, órgãos de controle, obrigações fiscais/contábeis da organização): quais obrigações se aplicam a cada organização? *Opções:* prazo único da plataforma; prazo configurável por organização dentro de limites; sem prazo máximo (guardar enquanto a organização existir).
3. **Prazo máximo/ eliminação** após cessar a finalidade: *Opções:* eliminação do objeto mantendo metadados e hash na auditoria; eliminação total do objeto e dos metadados do arquivo mantendo o evento de vínculo; anonimização do nome do arquivo.
4. **Encerramento de organização e exclusão de conta de usuário:** não existe hoje rotina de nenhum dos dois. O que acontece com comprovantes que a organização precisa guardar? Transferência, exportação para a organização, retenção pela plataforma por prazo legal?
5. **Direitos do titular** (acesso, correção, eliminação) quando o comprovante contém dado de terceiros: canal, prazo, quem decide, e como conciliar com o caráter imutável da auditoria.
6. **Dado pessoal enviado por engano:** procedimento de retirada (quem pode, como registrar), considerando que remover a *referência* não apaga o objeto.
7. **Arquivos infectados/suspeitos:** por quanto tempo ficam isolados, quem decide a eliminação e como isso fica registrado.
8. **Arquivos pendentes nunca vinculados e de referência removida:** prazo e critério para considerá-los elegíveis à eliminação.
9. **Auditoria × eliminação:** a cadeia de hash do `audit_log` preserva nomes e motivos; a eliminação de um objeto exige tratamento da trilha (manter o evento, registrar a eliminação como novo evento, nunca editar linhas anteriores).
10. **Transferência/armazenamento fora do país** se o provedor S3 estiver no exterior.

## 3. Consequências técnicas por decisão

- Nenhuma rotina automática de exclusão deve ser criada antes da decisão. Quando existir, precisa de: critérios inequívocos de elegibilidade (estado, idade, vínculo, organização), **modo de simulação** (relatório do que seria apagado), trilha de auditoria **como novos eventos** (nunca apagando linhas), idempotência, tratamento de falha parcial (objeto apagado e registro não, e o inverso), testes de recuperação e aprovação dupla.
- A conciliação atual (`GET /destination-proofs-reconciliation`) é a base para o relatório de elegíveis; é **somente leitura**.
- Remover a referência a um comprovante **não** é eliminação: o objeto permanece acessível a autor e proprietário/administrador. Isso precisa constar no aviso ao usuário (já consta) e na política.
- A exclusão de conta/organização hoje **não** existe; criá-la sem esta decisão arriscaria destruir evidência de prestação de contas ou, no extremo oposto, reter dado indevidamente.

## 4. Aprovações necessárias antes de automatizar qualquer exclusão

Parecer jurídico escrito; decisão registrada do controlador; revisão do encarregado (DPO), se houver; definição operacional de quem executa e audita; teste da rotina em modo de simulação com dados controlados.

## 5. Ao final

Não declarar conformidade com a LGPD com base apenas em permissões, logs ou exclusão de conta. Este item permanece **bloqueador para declarar prontidão de produção quanto à privacidade** até haver decisão.
