Sua análise está correta ao apontar que não devemos fingir que existe descoberta automática quando ainda não há conectores reais. Porém, a descoberta automática de oportunidades é um requisito central da Levora Solidária e NÃO deve ser removida do escopo nem adiada indefinidamente.

Precisamos corrigir a arquitetura antes de avançar para a conclusão do produto.

## 1. Descoberta automática é requisito obrigatório

A Levora Solidária deve ser capaz de, por meio de agentes de IA e conectores autorizados, encontrar oportunidades reais de doação em fontes externas.

O fluxo desejado é:

FONTE EXTERNA
→ DESCOBERTA
→ NORMALIZAÇÃO
→ VERIFICAÇÃO
→ QUALIFICAÇÃO
→ REGISTRO DA OPORTUNIDADE
→ MATCHING
→ CONTATO
→ NEGOCIAÇÃO
→ ATRIBUIÇÃO À ORGANIZAÇÃO
→ COLETA
→ TRANSPORTE
→ ENTREGA
→ COMPROVAÇÃO
→ CONCLUSÃO.

Não devemos fingir nenhuma integração que ainda não esteja configurada, mas a arquitetura e os contratos necessários devem existir desde já.

## 2. Não criar um “estoque físico compartilhado da Levora”

A preocupação sobre um pool compartilhado é válida, portanto não devemos modelar a Levora como proprietária das doações físicas.

Criar um REGISTRO CENTRAL DE OPORTUNIDADES.

Uma oportunidade é apenas uma descoberta de algo potencialmente disponível para doação.

Exemplo:

Oportunidade #82921

* origem: empresa ABC
* itens: 50 mesas
* quantidade: 50
* localização: Belo Horizonte
* condição: usada / bom estado
* disponibilidade: imediata
* fonte: site
* origem da descoberta: agente de descoberta
* status: validada
* organização destinatária: ainda não atribuída

A Levora não é proprietária física do item.

## 3. A propriedade operacional deve aparecer somente após a atribuição

Quando uma organização aceitar determinada oportunidade:

Oportunidade
→ Lote
→ Organização destinatária

A partir desse momento o processo passa a possuir uma organização responsável.

Deve ser possível dividir uma oportunidade entre várias organizações.

Exemplo:

50 mesas
→ Igreja A recebe 20
→ Igreja B recebe 30.

Não criar um estoque central físico pertencente à plataforma.

## 4. Criar o REGISTRO DE FONTES

Implementar uma estrutura configurável chamada REGISTRO DE FONTES.

Cada fonte deve possuir:

* nome;
* tipo;
* endereço;
* método de acesso;
* conector utilizado;
* status;
* última execução;
* próxima execução;
* frequência;
* credenciais associadas;
* organização autorizadora, quando aplicável;
* permissões;
* limites;
* política da fonte;
* situação da conexão;
* erros recentes;
* data da última validação.

## 5. Criar arquitetura de conectores

Criar uma interface comum para conectores.

Cada conector deve possuir:

* identificação;
* autenticação;
* descoberta;
* coleta dos dados;
* normalização;
* paginação;
* controle de duplicidade;
* tratamento de erros;
* limites;
* auditoria;
* desligamento;
* renovação de credencial;
* monitoramento.

O sistema deve permitir adicionar novos conectores sem alterar o núcleo da Levora Solidária.

## 6. Primeiros conectores

Implementar primeiro apenas conectores que possam ser realmente utilizados com autorização e dentro das regras da respectiva plataforma.

A arquitetura deve estar preparada para:

* sites públicos;
* pesquisa externa autorizada;
* páginas empresariais;
* Facebook/Meta;
* X;
* e-mail autorizado;
* formulários;
* outras fontes futuras.

Quando uma integração real ainda não estiver configurada, mostrar claramente:

“Conector não configurado.”

NUNCA simular integração concluída.

## 7. Registro de oportunidades

Toda descoberta deve criar um registro auditável.

Campos mínimos:

* identificador;
* data de descoberta;
* fonte;
* URL ou referência da origem;
* organização/pessoa de origem, quando disponível;
* categoria;
* descrição;
* quantidade;
* unidade;
* estado;
* localização;
* disponibilidade;
* urgência;
* evidência;
* confiança;
* agente responsável;
* última verificação;
* validade;
* status;
* histórico.

## 8. Estados da oportunidade

Implementar máquina de estados:

DESCOBERTA
→ EM VERIFICAÇÃO
→ VALIDADA
→ AGUARDANDO DESTINAÇÃO
→ RESERVADA
→ ATRIBUÍDA
→ AGUARDANDO COLETA
→ EM TRANSPORTE
→ RECEBIDA
→ CONCLUÍDA

Estados alternativos:

RECUSADA
EXPIRADA
CANCELADA
BLOQUEADA
DUPLICADA

Toda mudança deve gerar evento de auditoria.

## 9. Matching

O motor de matching deve comparar:

* tipo de recurso;
* quantidade;
* necessidade;
* capacidade;
* distância;
* urgência;
* condições;
* armazenamento;
* restrições;
* prazo;
* capacidade logística;
* regras da organização.

A IA pode sugerir.

A regra determinística deve validar.

O sistema deve guardar o motivo da correspondência.

## 10. Descoberta em escala

Criar agentes e tarefas assíncronas para:

* pesquisar novas oportunidades;
* atualizar oportunidades existentes;
* detectar mudança de status;
* detectar expiração;
* detectar duplicidades;
* identificar novas fontes;
* priorizar oportunidades;
* encaminhar oportunidades para matching.

Não implementar tudo como uma única chamada de IA.

Utilizar filas e tarefas de fundo.

## 11. Autonomia

A IA pode realizar ações automáticas somente quando:

* a ferramenta estiver autorizada;
* a política permitir;
* a fonte permitir;
* houver consentimento quando necessário;
* a ação estiver dentro do nível de risco permitido.

Ações de maior risco precisam de aprovação conforme a matriz definida no contrato do sistema.

## 12. Objetivo desta etapa

Antes de prosseguir com telas secundárias ou refinamentos visuais, faça uma auditoria do projeto atual e produza:

1. o que já existe;
2. o que está faltando;
3. quais partes precisam ser refatoradas;
4. quais contratos precisam ser adicionados;
5. quais conectores podem ser realmente implementados agora;
6. quais integrações exigem configuração externa;
7. quais dependências devem ficar parametrizadas.

Depois disso, implemente a infraestrutura do Discovery Engine e do Registro Central de Oportunidades.

Não remova essa funcionalidade por ela exigir integrações externas.

Não crie integrações fictícias.

Não crie estoques físicos compartilhados da Levora.

Construa a arquitetura real que permita que a autonomia seja ativada conforme os conectores reais forem configurados.
