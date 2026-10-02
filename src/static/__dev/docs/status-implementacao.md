> **DOCUMENTO HISTÓRICO** — retrata o estado do projeto em 24/09 (import
> inicial, "fase 4 concluída"). **Não é o estado atual**: várias coisas que
> a seção "O que ainda não existe" lista como ausentes foram construídas
> depois (matching, logística, convites, agendador, dupla autorização,
> prestação de contas…). O estado atual está em `docs/ROADMAP_ATUAL.md`
> (divergências mapeadas na seção 7). O texto original abaixo foi preservado.

# Status de implementação — Levora Solidária

Última atualização: fase 4 concluída (Discovery Engine e Registro Central).

## Como testar agora (fase 4)

1. Alguém precisa ser operador de plataforma: no banco, rode
   `UPDATE users SET role = 'admin' WHERE email = 'seu-email@...'` para a
   conta que vai operar a Levora (isso não é feito pela interface de
   propósito — é uma decisão que só o dono do projeto deve tomar).
2. Logado como esse usuário, vá em "Operação de plataforma" (aparece no
   painel para quem é `admin`).
3. Cadastre a fonte "manual" (nome livre, tipo "Manual", chave do conector
   `manual`) — só ela nasce ativa.
4. Tente cadastrar uma fonte de outro tipo (ex: Facebook/Meta) — ela nasce
   "Conector não configurado", e não é possível registrar descobertas por
   ela ainda (isso é bloqueado pelo servidor, testado).
5. Registre uma descoberta pela fonte manual, avance o status até
   "Aguardando destinação", depois atribua parte da quantidade a uma
   organização (pode dividir entre várias, em atribuições separadas).
6. Do lado da organização (aba "Rede Levora"), aceite ou recuse. Se
   aceitar, registre o recebimento escolhendo um item do inventário — isso
   gera uma entrada real de estoque, do mesmo jeito que o recebimento
   manual da fase 3.

## O que está funcionando de verdade agora

Fundação (fase 1), inventário/necessidades (fase 2), oportunidades locais
por organização (fase 3) — ver histórico de checkpoints para detalhes.

### Discovery Engine e Registro Central (fase 4)
- Registro de Fontes com regra de servidor: só o conector `manual` nasce
  ativo; qualquer outro nasce "não configurado" e fica assim até uma
  integração real ser implementada.
- Contrato `SourceConnector` (`helpers/connectorsTypes.tsx`) pronto para
  receber qualquer conector futuro sem mexer no núcleo.
- Registro Central de Oportunidades, sem organização dona, com máquina de
  estados validada no servidor (transição inválida = 409).
- Atribuições divididas entre organizações, com trava contra atribuir além
  da quantidade total (testado: 50 no total, 20+30 atribuídos, uma
  tentativa de +5 foi recusada).
- Ciclo completo testado: descoberta → verificação → validação →
  atribuição dividida (2 orgs) → uma organização aceita e recebe (estoque
  real), outra recusa → oportunidade central conclui sozinha quando não há
  mais nada pendente.

## O que ainda não existe (não fingir que existe)

- Qualquer conector automatizado de verdade (site público, Facebook/Meta,
  X, e-mail autorizado, formulário). O contrato existe; a implementação,
  não — porque nenhuma credencial real foi configurada.
- Nenhum agendamento (`queueTask`) foi criado — não há nada de real para
  agendar ainda.
- Motor de matching automático (distância, urgência, capacidade, regras da
  organização) — hoje a divisão entre organizações é sempre decisão de um
  humano (`admin`) no painel de plataforma.
- `aguardando_coleta` / `em_transporte` no registro central existem no
  banco mas não são usados por nenhuma tela — pertencem à fase de
  logística, ainda não construída.
- Convite de membros, logística (coleta/transporte/prova de entrega),
  distribuição automática, prestação de contas, dupla autorização, agentes
  de IA de verdade, integrações externas, painel de aprovação de
  organizações.

## Dependências externas pendentes

Nenhuma credencial externa foi conectada. Quando o primeiro conector real
for implementado (ex: e-mail autorizado), esta seção vai listar
exatamente o que falta configurar.

## Restrição de arquitetura registrada

O Floot não suporta subdomínio por organização — isolamento por
`organization_id` + verificação de membership. Ver `plano-implementacao.md`.
