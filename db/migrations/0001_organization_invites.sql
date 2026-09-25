-- Ver db/schema.sql, seção "Fase 9 — Convite de membros por e-mail", para o
-- comentário completo da decisão de design. Este arquivo existe separado do
-- schema.sql cumulativo porque bancos já provisionados (ex.: o de
-- desenvolvimento local) não podem reaplicar schema.sql inteiro sem perder
-- dados — db/schema.sql continua sendo a fonte da verdade para bancos novos
-- (ver db/migrate.ts); este arquivo é para bancos que já existem.

CREATE TYPE organization_invite_status AS ENUM ('pendente', 'aceito', 'expirado', 'revogado');

CREATE TABLE organization_invites (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role membership_role NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status organization_invite_status NOT NULL DEFAULT 'pendente',
  invited_by_user_id INTEGER NOT NULL REFERENCES users(id),
  accepted_by_user_id INTEGER REFERENCES users(id),
  revoked_by_user_id INTEGER REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_organization_invites_org ON organization_invites(organization_id, status);
CREATE UNIQUE INDEX idx_organization_invites_pending_unique ON organization_invites(organization_id, lower(email)) WHERE status = 'pendente';
