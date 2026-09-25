# Privacidade e LGPD

Master prompt, seção 142 (documentação obrigatória) e seção 54
(privacidade: privacy by design, minimização, RBAC, retenção, exclusão
compatível com auditoria). A LGPD se aplica ao tratamento de dados
pessoais no Brasil; dados de saúde e religião estão entre os dados pessoais
sensíveis previstos na lei — um cadastro "de igreja" não torna a informação
livre para uso ou pública por si só.

## Dados pessoais que o sistema coleta hoje

Só o que existe de verdade — não a lista completa que a visão do master
prompt eventualmente cobre (beneficiários, doadores como entidade própria,
dados de saúde, ainda não implementados, ver `docs/ARCHITECTURE.md`):

| Tabela | Dado pessoal | Quem vê |
|---|---|---|
| `users` | e-mail, nome de exibição | A própria pessoa; outros membros da mesma organização veem nome+e-mail via `organization-members`/`organization-invites` (`membros.leia`/`membros.gerencie`) |
| `sessions` | vínculo com `user_id`, timestamps | Ninguém via interface; só consulta direta ao banco |
| `login_attempts` | e-mail tentado, sucesso/falha, timestamp | Ninguém via interface — usado só internamente para bloqueio por força bruta |
| `organizations` | nome legal, cidade/estado, quem criou | Membros da própria organização; dados agregados podem aparecer em relatórios |
| `files` | quem enviou (`uploaded_by_user_id`), nome original do arquivo | Membros da organização dona do arquivo |
| `audit_log` | ator de cada ação | Proprietário/administrador da organização (`auditoria.leia`) |

**O que ainda não existe** (e portanto não é coletado): dados de
beneficiários (nome, CPF, composição familiar, dados de saúde/religião —
seção 13 do master prompt), dados de doador pessoa física além de texto
livre na oportunidade legada. Quando esses domínios forem construídos,
este documento precisa ser atualizado ANTES de qualquer coleta começar —
não depois.

## Minimização já aplicada

- Necessidades (`needs`) e inventário não têm nenhum campo de dado pessoal
  de beneficiário — são só quantidade, categoria, prioridade.
- Convite de membro (`docs/CONVITE_DE_MEMBROS.md`) só grava o e-mail
  convidado e o papel — nenhum outro dado da pessoa antes de ela aceitar.

## RBAC como controle de privacidade

Ver `docs/RBAC_PERMISSOES.md`. `membros.leia` (ver e-mail de outros
membros) e `auditoria.leia` (ver quem fez o quê) são permissões separadas,
não concedidas a voluntário — controle de acesso a dado pessoal é parte do
mesmo mecanismo de RBAC, não uma camada à parte.

## Retenção e exclusão

- **Não há política de retenção configurável nem exclusão automática por
  prazo** — nenhum job apaga dados antigos.
- **Exclusão sob pedido do titular (RESOLVIDO)**: `POST /_api/v1/auth/account-delete`
  (`src/endpoints/auth/account-delete_POST.ts`), acessível pelo menu de
  usuário no painel. Exige confirmação de senha (reautenticação antes de
  ação destrutiva). Reconcilia com a auditoria imutável exatamente como
  planejado aqui: nunca apaga a linha de `users` (quebraria toda referência
  de `actor_user_id` em `audit_log`/`stock_transactions`/etc., que são
  append-only) — em vez disso anonimiza `email`→`usuario-excluido-<id>@removido.invalid`
  e `display_name`→"Usuário removido", apaga a senha e todas as sessões
  (logout imediato em todo dispositivo), e inativa todas as memberships da
  pessoa. A própria exclusão vira um evento de auditoria
  (`usuario.conta_excluida`), gravado antes de anonimizar.
- **Regra de proteção contra organização órfã**: recusa (409) excluir a
  conta se a pessoa for a única proprietária ativa de alguma organização —
  não existe ainda um fluxo de transferência de titularidade
  (`docs/CONVITE_DE_MEMBROS.md`), então excluir nesse caso deixaria a
  organização sem ninguém para administrá-la. A pessoa precisa contatar a
  equipe da Levora Solidária para resolver isso antes.
- Testado (`test/accountDelete.test.ts`): anonimização completa, recusa com
  senha errada (nada é alterado), bloqueio por organização órfã, liberação
  quando há outro proprietário ativo, e que um proprietário inativo não
  conta como "outro proprietário". Testado também com o app rodando de
  verdade (registro → exclusão → tentativa de login com a conta antiga
  falha).

## Dados sensíveis (LGPD art. 5º, II)

Nenhum dado sensível (saúde, religião, etc.) é coletado hoje porque o
domínio que coletaria isso (beneficiários) não existe. **Antes de
implementar Beneficiary Management** (seção 13 do master prompt), este
documento precisa ganhar uma seção específica sobre base legal, minimização
adicional (evitar endereço completo quando um ponto seguro bastar — já
instruído na seção 13) e controles de acesso extras para esse dado.

## Portal público de transparência

Ainda não implementado (ver README, "Estado conhecido/lacunas" e
`docs/ARCHITECTURE.md`). Quando existir, a regra do master prompt (seção
38) já é clara e deve ser seguida à risca: nunca beneficiário
identificável, nunca endereço de família, nunca telefone/CPF, nunca
conversa — só agregados.
