// M19 — SEPARAÇÃO DE DIRETÓRIOS do QA visual (M18/A2). Quatro conceitos que não se misturam:
//   1. CANDIDATAS (escrita pelo `capture`): por padrão FORA do repositório (`~/.levora-qa/visual-candidates`); dentro do repositório só em `.qa-visual-local/` (ignorado pelo Git).
//   2. REFERÊNCIAS aprovadas versionáveis: `scripts/qa-visual/visual-references/` (reservado; NUNCA é destino de captura; nenhuma existe hoje).
//   3. EVIDÊNCIAS históricas: fora do repositório (pastas m0x-evidence); nunca destino de captura.
//   4. TEMPORÁRIO de execução: `os.tmpdir()` (relatórios, imagens de diff).
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCAL_AREA = ".qa-visual-local";
export const REFERENCES_DIR = path.join("scripts", "qa-visual", "visual-references");
export const defaultCandidateDir = (home = os.homedir()) => path.join(home, ".levora-qa", "visual-candidates");

const inside = (child, parent) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
/** realpath do ancestral existente mais profundo + o restante (resolve junctions/symlinks mesmo para um destino que ainda não existe). */
export function realOrSelf(p) { let cur = path.resolve(p); const rest = []; for (;;) { try { return path.join(realpathSync(cur), ...rest.reverse()); } catch { const up = path.dirname(cur); if (up === cur) return path.resolve(p); rest.push(path.basename(cur)); cur = up; } } }

export class DirError extends Error { constructor(code, message) { super(message); this.name = "DirError"; this.code = code; } }

/** Valida o destino de ESCRITA de candidatas. Devolve o caminho absoluto real. Lança DirError (códigos: BAD_PATH, NOT_A_DIRECTORY, INSIDE_REPO, REFERENCES_AREA). */
export function resolveCandidateDir(input, { root, cwd = process.cwd(), home = os.homedir() } = {}) {
  const raw = input ?? defaultCandidateDir(home);
  if (typeof raw !== "string" || raw.includes("\0") || raw.trim() === "") throw new DirError("BAD_PATH", "caminho de candidatas inválido");
  const dir = realOrSelf(path.resolve(cwd, raw));
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new DirError("NOT_A_DIRECTORY", `o destino de candidatas existe e não é um diretório: ${dir}`);
  if (root) {
    const R = realOrSelf(root); const refs = realOrSelf(path.join(root, REFERENCES_DIR)); const local = realOrSelf(path.join(root, LOCAL_AREA));
    if (inside(dir, refs)) throw new DirError("REFERENCES_AREA", "candidatas nunca são gravadas na área de referências aprovadas (visual-references)");
    if (inside(dir, R) && !inside(dir, local)) throw new DirError("INSIDE_REPO", `o destino de candidatas fica dentro do repositório fora de ${LOCAL_AREA}/ (risco de inclusão acidental no Git): ${dir}`);
  }
  return dir;
}
