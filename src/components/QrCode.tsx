import React, { useMemo } from "react";
import { encode } from "uqr";
import styles from "./mfa.module.css";

/**
 * QR code do `otpauth://` (Fase 90). A biblioteca (`uqr`, zero dependências) só desenha a matriz; o LEVORA continua dono do
 * segredo, da cifra e da validação. SVG gerado no CLIENTE (nenhum dado vai a terceiros; não muda `img-src 'self'`).
 * Sempre escuro sobre claro, mesmo no tema escuro (leitores de QR exigem contraste claro/escuro tradicional).
 */
export const QrCode: React.FC<{ value: string; label: string }> = ({ value, label }) => {
  const { size, path } = useMemo(() => {
    const matrix = encode(value, { ecc: "M", border: 1 }).data;
    const parts: string[] = [];
    matrix.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) parts.push(`M${x} ${y}h1v1h-1z`);
      })
    );
    return { size: matrix.length, path: parts.join("") };
  }, [value]);

  return (
    <div className={styles.qrBox}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <rect width={size} height={size} fill="#ffffff" />
        <path d={path} fill="#000000" />
      </svg>
    </div>
  );
};
