// Auditoria dos relatórios JSON das rotinas de QA para o CI (módulo puro, testado). Não confia no código de saída sozinho: relê o relatório e
// recusa um "sucesso" em que algo obrigatório não rodou (navegador errado, perfil sem seleção registrada, calibração ausente, cabeçalhos do nginx
// não executados, Node diferente do esperado) ou em que o relatório contém algo que parece segredo.

/** Padrões que NÃO podem aparecer em relatório publicado como artefato. Retorna os rótulos encontrados. */
export function findSecrets(text, extraLiterals = []) {
  const found = [];
  if (/postgres(ql)?:\/\/[^\s"'/]+:[^\s"'@]+@/i.test(text)) found.push("URL de banco com credenciais");
  if (/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\./.test(text)) found.push("token JWT");
  if (/floot_built_app_session=[^;\s"]{8,}/.test(text)) found.push("valor do cookie de sessão");
  if (/authorization"?\s*[:=]\s*"?(bearer|basic)\s+\S{6,}/i.test(text)) found.push("cabeçalho Authorization");
  if (/(secret|api[_-]?key|token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{16,}["']/i.test(text)) found.push("segredo atribuído");
  for (const lit of extraLiterals) if (lit && text.includes(lit)) found.push("literal secreto conhecido");
  return found;
}

const COUNT_KEYS = ["FAIL", "MISSING", "UNMEASURABLE", "ENV"];
const ALL_PARTS = ["calibration", "csrf", "xss", "uploads", "headers"];

function commonProblems(name, r, { expectNode, expectBrowser, forbidBrowsers = ["edge"] }) {
  const problems = [];
  if (!r) return [`${name}: relatório ausente`];
  if (expectNode && !String(r.node ?? "").startsWith(`v${expectNode}.`)) problems.push(`${name}: Node efetivo ${r.node ?? "?"}, esperado ${expectNode}.x`);
  const names = (r.navegadores ?? []).map((b) => b.name);
  if (!names.length) problems.push(`${name}: nenhum navegador registrado`);
  if (expectBrowser && !names.includes(expectBrowser)) problems.push(`${name}: navegador esperado ${expectBrowser}, executados: ${names.join(", ") || "nenhum"}`);
  for (const f of forbidBrowsers) if (names.includes(f)) problems.push(`${name}: ${f} não deveria ter sido usado no CI`);
  for (const k of COUNT_KEYS) if ((r.contagem?.[k] ?? 0) > 0) problems.push(`${name}: ${r.contagem[k]} resultado(s) ${k}`);
  if ((r.env ?? []).length) problems.push(`${name}: falha(s) de ambiente: ${r.env.join(" | ").slice(0, 300)}`);
  if (!((r.contagem?.PASS ?? 0) > 0)) problems.push(`${name}: nenhuma verificação PASS (nada foi medido)`);
  return problems;
}

/** Avalia os dois relatórios. Retorna { problems, markdown }. `problems` vazio = o job pode ser verde. */
export function evaluateReports({ visual, security, visualRaw = "", securityRaw = "", expectNode, expectBrowser, requireParts = ALL_PARTS, commit = "(desconhecido)", knownSecrets = [] }) {
  const problems = [];
  const opt = { expectNode, expectBrowser };
  problems.push(...commonProblems("qa:visual", visual, opt), ...commonProblems("qa:security", security, opt));

  if (visual) {
    const s = visual.selecao;
    if (!s) problems.push("qa:visual: o relatório não registra a seleção de cenários (subconjunto x catálogo)");
    else if (!s.completo && !(s.omitidos ?? []).length) problems.push("qa:visual: seleção marcada como incompleta sem listar os omitidos");
    if ((visual.viewports ?? []).length !== 4) problems.push(`qa:visual: esperados 4 viewports, executados ${(visual.viewports ?? []).length}`);
    if ((visual.temas ?? []).length !== 2) problems.push(`qa:visual: esperados 2 temas, executados ${(visual.temas ?? []).length}`);
  }
  if (security) {
    const parts = security.partes ?? [];
    for (const p of requireParts) if (!parts.includes(p)) problems.push(`qa:security: parte obrigatória "${p}" não foi executada (não conta como aprovada)`);
    if (requireParts.includes("headers") && !security.headersExecutados) problems.push("qa:security: os cabeçalhos do nginx (Docker) NÃO foram executados");
    if (requireParts.includes("calibration") && !(security.linhas ?? []).some((l) => l.kind === "calibração" && l.status === "PASS")) problems.push("qa:security: nenhuma calibração de detector aprovada no relatório");
  }
  for (const [name, raw] of [["qa:visual", visualRaw], ["qa:security", securityRaw]]) {
    const hits = findSecrets(raw, knownSecrets); if (hits.length) problems.push(`${name}: o relatório contém ${hits.join(", ")} (não publicar)`);
  }

  const md = [];
  md.push("## QA de navegador (modo reduzido do CI)", "", "> **Subconjunto, não a matriz completa local.** O que não aparece abaixo como executado **não foi verificado** neste job.", "");
  md.push(`- Commit: \`${commit}\``, `- Node efetivo: \`${visual?.node ?? security?.node ?? "?"}\` (esperado ${expectNode ?? "-"}.x)`);
  for (const [name, r] of [["qa:visual", visual], ["qa:security", security]]) if (r) md.push(`- ${name} — navegador: ${(r.navegadores ?? []).map((b) => `${b.name} \`${b.version}\``).join(", ") || "nenhum"} · ${["PASS", "FAIL", "MISSING", "UNMEASURABLE", "SKIP", "ENV"].map((k) => `${k}=${r.contagem?.[k] ?? 0}`).join(" ")}`);
  if (visual?.selecao) {
    const s = visual.selecao; md.push(`- qa:visual — perfil \`${s.perfil}\`: ${s.executados} de ${s.total} cenários × viewports ${(visual.viewports ?? []).join(", ")} × temas ${(visual.temas ?? []).join(", ")}`);
    if (s.omitidos?.length) md.push(`- qa:visual — **não executados** (omitidos pelo perfil): ${s.omitidos.join(", ")}`);
  }
  if (security) {
    md.push(`- qa:security — partes executadas: ${(security.partes ?? []).join(", ")}${(security.partesOmitidas ?? []).length ? ` · **não selecionadas**: ${security.partesOmitidas.join(", ")}` : ""}`);
    md.push(`- qa:security — cabeçalhos do nginx real (Docker): ${security.headersExecutados ? "**executados**" : "**NÃO executados**"}`);
  }
  md.push("", problems.length ? `### ❌ Reprovado (${problems.length})\n${problems.map((p) => `- ${p}`).join("\n")}` : "### ✅ Aprovado no escopo acima");
  return { problems, markdown: md.join("\n") };
}
