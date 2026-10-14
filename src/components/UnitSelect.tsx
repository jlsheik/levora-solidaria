import React from "react";
import { UNIT_WRITE_OPTIONS } from "../helpers/unitVocabulary";
import inputStyles from "./Input.module.css";

/**
 * Seleção de unidade para NOVAS gravações (Fase 99C): só as unidades do vocabulário controlado. Um valor já gravado que não é do vocabulário continua visível e selecionado
 * (como "valor histórico"), para a edição de outros campos não trocá-lo em silêncio; o servidor só aceita unidade do vocabulário para gravar de novo.
 */
export function UnitSelect({
  value,
  onChange,
  allowEmpty = false,
  disabled,
  id,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
}) {
  const known = UNIT_WRITE_OPTIONS.some((o) => o.label === value);
  return (
    <select id={id} aria-label={ariaLabel} className={inputStyles.input} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={{ height: "2.5rem" }}>
      {(allowEmpty || value === "") && <option value="">{allowEmpty ? "Não informada" : "Escolha a unidade"}</option>}
      {value !== "" && !known && <option value={value}>{value} (valor histórico)</option>}
      {UNIT_WRITE_OPTIONS.map((o) => (
        <option key={o.id} value={o.label}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
