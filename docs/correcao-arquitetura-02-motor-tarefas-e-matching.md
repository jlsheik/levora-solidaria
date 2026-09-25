Sobre os dois pontos que você deixou pendentes em `docs/plano-implementacao.md`, quero ajustar a decisão de arquitetura.

## 1. `queueTask` / agendamento

Não quero que o sistema fique sem a infraestrutura de agendamento simplesmente porque alguns conectores externos ainda não estão configurados.

A infraestrutura de tarefas assíncronas e agendamento deve ser implementada agora.

Precisamos ter um mecanismo real para:

* executar tarefas futuras;
* executar tarefas recorrentes;
* reprocessar tarefas com erro;
* controlar tentativas;
* controlar atraso;
* evitar duplicação;
* registrar execução;
* registrar falha;
* permitir cancelamento;
* permitir reprocessamento manual;
* manter histórico;
* usar idempotência;
* controlar prioridade;
* controlar bloqueios;
* controlar dependências.

Crie o motor de tarefas de forma desacoplada dos conectores.

### Tarefas internas que já podem existir agora

Mesmo sem descoberta externa configurada, já podemos criar tarefas reais para:

1. verificar oportunidades próximas da expiração;
2. verificar oportunidades sem atualização;
3. reprocessar oportunidades pendentes;
4. tentar novamente integrações que falharam;
5. executar matching de oportunidades pendentes;
6. verificar reservas expiradas;
7. verificar coletas atrasadas;
8. verificar entregas atrasadas;
9. verificar notificações pendentes;
10. reprocessar notificações com erro;
11. atualizar indicadores;
12. executar verificações de consistência;
13. detectar duplicidades;
14. gerar alertas internos;
15. executar rotinas de auditoria;
16. limpar tarefas expiradas;
17. gerar tarefas de acompanhamento;
18. reavaliar oportunidades quando necessidades forem alteradas.

### Tarefas externas

Para conectores que ainda não possuem credenciais ou integração real, crie a tarefa e o conector de forma configurável, mas deixe seu estado como:

"Não configurado"

Nunca simule uma execução.

Exemplo:

CONSUMIR_FONTE_FACEBOOK
Status: DESABILITADA
Motivo: integração não configurada

Quando a integração real for configurada, essa tarefa poderá ser ativada sem alterar o motor de tarefas.

Portanto:

NÃO remover o `queueTask`.

NÃO deixar a infraestrutura de tarefas para uma fase futura.

Construir o motor agora.

---

# 2. Motor de matching automático

Também quero alterar a decisão de que o matching continuará sendo exclusivamente humano.

Isso não corresponde ao objetivo final da Levora Solidária.

O matching automático é uma funcionalidade central do produto.

Não quero que uma pessoa da plataforma precise olhar cada oportunidade e escolher manualmente qual organização receberá.

## O que deve existir

Construir um `Motor de Correspondência` real.

Ele deve receber:

### Dados da oportunidade

* categoria;
* subcategoria;
* item;
* quantidade;
* unidade;
* estado;
* localização;
* disponibilidade;
* validade;
* urgência;
* restrições;
* condições especiais;
* necessidade de transporte;
* requisitos de armazenamento;
* documentação;
* evidências;
* confiabilidade da oportunidade.

### Dados das organizações destinatárias

* necessidades;
* quantidade necessária;
* categorias aceitas;
* categorias proibidas;
* capacidade de armazenamento;
* capacidade operacional;
* localização;
* raio de atendimento;
* capacidade logística;
* prioridade;
* urgência;
* horários;
* restrições;
* status da organização;
* disponibilidade para receber;
* histórico de recebimento.

## O motor deve calcular uma pontuação de correspondência

Exemplo:

Compatibilidade de categoria: 100
Necessidade atual: 95
Distância: 90
Quantidade: 80
Urgência: 100
Capacidade: 100
Logística: 85
Restrições: 100

Resultado final:
92,4%

O cálculo precisa ser explicável e auditável.

O sistema deve registrar:

* quais critérios foram usados;
* peso de cada critério;
* resultado de cada critério;
* pontuação final;
* versão da regra;
* data;
* modelo de IA, se utilizado;
* justificativa.

---

# 3. IA não deve substituir as regras determinísticas

A arquitetura deve ser:

REGRAS DETERMINÍSTICAS
+
MOTOR DE PONTUAÇÃO
+
IA COMO APOIO
=============

DECISÃO DE MATCHING

A IA pode:

* interpretar descrição;
* classificar categoria;
* identificar equivalências;
* explicar contexto;
* sugerir correspondências.

Mas não deve ignorar:

* restrições;
* capacidade;
* segurança;
* validade;
* categorias proibidas;
* localização;
* regras da organização.

---

# 4. Matching automático sem equipe de plataforma

Não quero criar uma dependência estrutural de uma "equipe da Levora" escolhendo manualmente cada destino.

A organização destinatária já terá fornecido suas necessidades e restrições.

Portanto:

O sistema deve ser capaz de fazer:

OPORTUNIDADE
↓
GERAR CANDIDATOS
↓
CALCULAR PONTUAÇÕES
↓
APLICAR REGRAS
↓
ESCOLHER MELHOR DESTINO
↓
CRIAR PROPOSTA DE MATCH
↓
RESERVAR A OPORTUNIDADE
↓
NOTIFICAR A ORGANIZAÇÃO
↓
AGUARDAR ACEITE QUANDO O FLUXO EXIGIR
↓
CONFIRMAR ATRIBUIÇÃO

Não exigir intervenção de uma equipe central.

---

# 5. Três níveis de decisão

Implementar três faixas:

### ALTA CONFIANÇA

Exemplo:
pontuação >= 90%

E nenhuma regra crítica foi violada.

Atribuição pode ocorrer automaticamente.

### CONFIANÇA MÉDIA

Exemplo:
70% a 89,99%

O sistema pode sugerir e solicitar confirmação da organização destinatária.

### BAIXA CONFIANÇA

Abaixo de 70%.

Não atribuir.

Manter a oportunidade disponível para nova avaliação.

Os limites precisam ser configuráveis.

---

# 6. Evitar duas organizações receberem a mesma doação

Quando uma oportunidade for selecionada:

deve existir mecanismo de reserva.

Exemplo:

OPORTUNIDADE #8291
↓
reservada para Organização A
↓
reserva válida por 30 minutos
↓
Organização A confirma
↓
atribuição definitiva

Se expirar:

reserva liberada
↓
matching novamente

Isso deve ser controlado transacionalmente.

---

# 7. Divisão automática

Também deve existir divisão de lotes.

Exemplo:

Doação:
100 cobertores

Organização A:
precisa 40

Organização B:
precisa 35

Organização C:
precisa 25

O sistema pode dividir automaticamente:

A → 40
B → 35
C → 25

desde que as regras permitam divisão.

Registrar todos os vínculos.

---

# 8. Reavaliação automática

O matching não deve acontecer somente uma vez.

Executar novamente quando:

* surgir nova necessidade;
* uma organização ficar indisponível;
* surgir uma organização mais compatível;
* oportunidade mudar;
* quantidade mudar;
* validade mudar;
* localização mudar;
* reserva expirar;
* organização recusar;
* coleta não for possível.

Criar eventos que acionem nova avaliação.

---

# 9. Transparência

No painel, preciso conseguir abrir uma oportunidade e visualizar:

"MATCH AUTOMÁTICO"

Organização escolhida:
Igreja X

Pontuação:
94,2%

Motivos:

* categoria compatível
* necessidade urgente
* capacidade disponível
* distância adequada
* quantidade compatível
* logística possível

Também mostrar:

Versão do algoritmo:
1.0

Data:
XX/XX/XXXX

Isso é importante para auditoria.

---

# 10. Não criar funcionalidade fictícia

Continuo exigindo a mesma regra:

* nenhuma integração fictícia;
* nenhum dado fictício tratado como real;
* nenhum conector simulado como concluído;
* nenhum envio falso;
* nenhum agendamento falso;
* nenhum matching falso.

Mas a infraestrutura real do motor de tarefas e do motor de matching deve ser construída agora.

Quando não houver fonte externa configurada, o sistema deve simplesmente informar:

"Não existem fontes externas ativas para esta organização."

E continuar funcionando com as oportunidades reais já existentes no sistema.

---

# 11. O que quero agora

Antes de continuar a construção, atualize `docs/plano-implementacao.md` para refletir estas decisões.

Depois:

1. implementar o motor de tarefas;
2. implementar o motor de matching;
3. criar testes automatizados;
4. criar dados de teste;
5. testar reservas;
6. testar concorrência;
7. testar divisão de lotes;
8. testar reprocessamento;
9. testar expiração;
10. testar matching novamente após mudança de necessidade;
11. testar isolamento entre organizações;
12. testar auditoria das decisões;
13. só então continuar para os demais módulos.

A arquitetura final da Levora Solidária deve permitir operação progressivamente autônoma sem depender de uma equipe central da Levora escolhendo manualmente os destinos.

A intervenção humana deve existir apenas onde uma regra de segurança, exceção ou consentimento exigir.
