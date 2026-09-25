-- Upload real de arquivo (ex.: foto de comprovante de entrega). Ver
-- src/helpers/storageAdapter.tsx para os adaptadores de armazenamento
-- (disco local por padrão, S3-compatível quando configurado por ambiente)
-- e docs/UPLOAD_DE_ARQUIVOS.md para o desenho completo.

CREATE TABLE files (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by_user_id INTEGER NOT NULL REFERENCES users(id),
  storage_provider TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  purpose TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_files_org ON files(organization_id);
