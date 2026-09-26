-- Configuração de organização para matching automático (capacidade por
-- categoria, logística/horários, área de atendimento). Ver db/schema.sql
-- para os comentários completos de cada tabela e docs/plano-implementacao.md
-- (Fase 21/22) para o raciocínio arquitetural.

CREATE TABLE organization_capacities (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  max_capacity NUMERIC(12,3) NOT NULL CHECK (max_capacity >= 0),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, category, unit)
);
CREATE TRIGGER organization_capacities_set_updated_at BEFORE UPDATE ON organization_capacities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_organization_capacities_org ON organization_capacities(organization_id);

CREATE TABLE organization_matching_settings (
  organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  realiza_coleta BOOLEAN NOT NULL DEFAULT false,
  raio_coleta_km INTEGER CHECK (raio_coleta_km IS NULL OR raio_coleta_km > 0),
  observacoes_logisticas TEXT,
  observacoes_horarios TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER organization_matching_settings_set_updated_at BEFORE UPDATE ON organization_matching_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE organization_service_areas (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_organization_service_areas_org ON organization_service_areas(organization_id);
CREATE INDEX idx_organization_service_areas_location ON organization_service_areas(city, state);
CREATE UNIQUE INDEX idx_organization_service_areas_unique ON organization_service_areas(organization_id, lower(city), state);
