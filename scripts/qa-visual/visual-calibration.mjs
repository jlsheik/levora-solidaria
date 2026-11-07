// M12 — CALIBRAÇÃO das regiões de ruído, por GRUPO página × viewport (dado GERADO por m12-evidence/tools/gen-calibration.mjs a partir de bateria/validacao-regioes-v3.json; não editar à mão).
// Critério pré-registrado (m12-evidence/dropzone-3casos/PRE-REGISTRO-bateria.md): um grupo é CALIBRATED quando NENHUM par (rodada de validação × rodada de derivação) fica DIFFERENT sob o comparador com regiões e
// nenhuma divergência passa de Δ4; qualquer outro resultado é NEEDS_INVESTIGATION (sem região "para passar"). A bateria: oficiais 4 rodadas, dropzone 7 (derivação d1–d4 / o1–o3; validação d5–d7 / o4).
// O gate visual de PRODUÇÃO continua DESABILITADO (nenhuma baseline aprovada; calibração da dropzone não concluída). Esta tabela só (1) documenta a decisão e (2) faz `visual.mjs approve` RECUSAR a aprovação
// de célula de um grupo em NEEDS_INVESTIGATION (aprovar uma imagem instável criaria falsas regressões depois).
export const CALIBRATION = Object.freeze({
  version: "m12-v3",
  productionGate: "DISABLED",
  reason: "calibração incompleta: 1 grupo(s) em NEEDS_INVESTIGATION (dropzone-erro-tamanho|1280x900) e nenhuma baseline aprovada",
  groups: Object.freeze({
  "atribuicoes-dropzone|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "atribuicoes-dropzone|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "destinacoes-erro-periodo|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "destinacoes-erro-periodo|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "destinacoes|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "destinacoes|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "dropzone-arquivo-aceito|1280x900": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-arquivo-aceito|375x812": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-arrastando|1280x900": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-enviando|1280x900": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-enviando|375x812": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-erro-tamanho|1280x900": {
    "status": "NEEDS_INVESTIGATION",
    "pares": 48,
    "foraDasRegioes": 4
  },
  "dropzone-erro-tamanho|375x812": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-erro-tipo|1280x900": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-erro-tipo|375x812": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-falha-rede|1280x900": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-falha-rede|375x812": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-falha-servidor-5xx|1280x900": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-falha-servidor-5xx|375x812": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-falha-servidor|1280x900": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-falha-servidor|375x812": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-fim-ocioso|1280x900": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "dropzone-fim-ocioso|375x812": {
    "status": "CALIBRATED",
    "pares": 48,
    "foraDasRegioes": 0
  },
  "inventario|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "inventario|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "login-erro|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "login-erro|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "login|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "login|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "matching|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "matching|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "necessidades-dialogo-editar|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "necessidades-dialogo-editar|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "necessidades|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "necessidades|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "org-inicio|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "org-inicio|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "prestacao-contas|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "prestacao-contas|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "regularizacao|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "regularizacao|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "unidades-vazio|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "unidades-vazio|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "unidades|1280x900": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  },
  "unidades|375x812": {
    "status": "CALIBRATED",
    "pares": 12,
    "foraDasRegioes": 0
  }
}),
});

/** Grupo (página|viewport) de um id de célula `pagina__navegador__WxH__tema`. */
export const groupOf = (cellId) => { const p = String(cellId).split("__"); return p.length >= 4 ? `${p[0]}|${p[2]}` : null; };

/** { status: "CALIBRATED" | "NEEDS_INVESTIGATION" | "NOT_VALIDATED", group } — NOT_VALIDATED: a célula não entrou na bateria de validação. */
export function calibrationOf(cellId) { const g = groupOf(cellId); const e = g ? CALIBRATION.groups[g] : null; return { group: g, status: e ? e.status : "NOT_VALIDATED", detail: e ?? null }; }

/** Lança se a célula pertence a um grupo em NEEDS_INVESTIGATION (usada por `visual.mjs approve`). */
export function assertApprovable(cellId) {
  const c = calibrationOf(cellId);
  if (c.status === "NEEDS_INVESTIGATION") throw Object.assign(new Error(`a célula ${cellId} pertence ao grupo ${c.group}, em NEEDS_INVESTIGATION na calibração ${CALIBRATION.version} (${c.detail.foraDasRegioes} par(es) fora das regiões em ${c.detail.pares}); aprovar uma imagem instável criaria falsas regressões. Investigue e recalibre antes.`), { code: "UNCALIBRATED_CELL" });
  return c;
}
