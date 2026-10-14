import { classifyUnit } from "../helpers/unitVocabulary";
import styles from "./UnitText.module.css";

/**
 * Mostra a unidade EXATAMENTE como está gravada (nunca troca por uma unidade canônica presumida).
 * Só acrescenta um aviso discreto quando o valor ainda não foi classificado com segurança
 * (ambíguo ou desconhecido). Alias e canônica aparecem sem marcação: não há nada a revisar.
 */
export function UnitText({ unit, className }: { unit: string | null | undefined; className?: string }) {
  const c = classifyUnit(unit);
  if (c.kind === "ausente") return null;
  const pending = c.kind === "ambigua" || c.kind === "desconhecida";
  return (
    <>
      <span className={className}>{unit}</span>
      {pending && (
        <span className={styles.pending} title={c.explanation}>
          {" "}
          <span aria-hidden="true">(a classificar)</span>
          <span className={styles.srOnly}>, unidade ainda não classificada: {c.kind === "ambigua" ? "ambígua" : "desconhecida"}</span>
        </span>
      )}
    </>
  );
}
