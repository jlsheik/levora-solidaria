# Convite de membros por e-mail

Antes desta funcionalidade, adicionar alguém a uma organização exigia
inserir a linha em `memberships` diretamente no banco. Este documento
descreve o fluxo real que substitui isso.

## Como funciona

1. Proprietário ou administrador da organização clica em "Convidar" na aba
   Equipe (`src/pages/organizacoes.$organizationId.tsx`), informa e-mail e
   papel (administrador, operador ou voluntário — nunca proprietário por
   convite).
2. O servidor (`src/endpoints/organization-invites_POST.ts`):
   - recusa se o e-mail já for de um membro ativo (409);
   - revoga automaticamente um convite pendente anterior para o mesmo
     e-mail nesta organização, se existir, e cria um novo;
   - gera um token aleatório de 32 bytes, guarda **apenas o hash SHA-256**
     dele em `organization_invites.token_hash` (mesmo princípio dos códigos
     de ativação de organização do master prompt, seção 9 — nunca token em
     texto puro no banco);
   - tenta enviar por e-mail via `src/helpers/emailAdapter.tsx`;
   - devolve o link de aceite (`acceptUrl`) na resposta da API — é a
     **única vez** que o token aparece em texto puro, mesmo se o e-mail for
     enviado com sucesso. Se o SMTP não estiver configurado, a interface diz
     isso explicitamente e oferece "Copiar link" para quem convidou
     compartilhar manualmente (nunca finge que o e-mail foi enviado).
3. Convite expira em 7 dias (`INVITE_EXPIRATION_DAYS`, em
   `src/helpers/organizationInvites.tsx`). Convites pendentes expirados são
   marcados como tal de forma oportunista, na leitura (mesmo padrão de
   limpeza de sessões expiradas já usado em `getServerUserSession`).
4. Quem recebe o link (`/convites/:token`, página pública
   `src/pages/convites.$token.tsx`):
   - se não tiver conta, pode criar uma (e-mail vem pré-preenchido) ou
     entrar com uma conta existente — os componentes de login/cadastro
     ganharam um `redirectTo` opcional para voltar à página do convite
     depois;
   - o servidor (`organization-invites-accept_POST.ts`) **recusa aceitar se
     o e-mail da conta logada não for exatamente o e-mail convidado** (403)
     — sem essa checagem, qualquer pessoa logada poderia usar um link
     vazado para entrar em uma organização à qual não foi convidada;
   - ao aceitar, a membership é criada (ou reativada, se já existia
     inativa) com o papel do convite, e o convite muda para `aceito`.
5. Tudo gera evento de auditoria: `organizacao.convite_criado`,
   `organizacao.convite_revogado`, `organizacao.convite_aceito`.

## Configuração de e-mail (opcional)

Sem `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` no `.env`,
convites continuam funcionando integralmente — só o envio automático de
e-mail fica desligado, e a interface avisa isso claramente (nunca finge que
enviou). Ver `.env.example`.

## O que ainda não existe (fora do escopo desta entrega)

- Reenvio de convite sem revogar/recriar (hoje "reenviar" é implementado
  como revogar o pendente + criar um novo, o que já resolve o caso de uso,
  mas gera duas linhas na tabela em vez de uma).
- Limite de quantos convites pendentes uma organização pode ter simultâneos
  (não há abuso conhecido a mitigar ainda, mas se convite virar vetor de
  spam, precisa de rate limit próprio).
- Convite direto para o papel `proprietario` (decisão deliberada: hoje só
  se torna proprietário quem cria a organização; transferir propriedade é
  um fluxo separado, ainda não implementado).
