import React, { useEffect } from "react";
import { HeartHandshake } from "lucide-react";
import { PasswordResetForm } from "../components/PasswordResetForm";
import styles from "./login.module.css";

/** Redefinição de senha a partir do link do e-mail (público). O token vem no fragmento da URL e é removido da barra de endereço ao abrir. */
export default function ResetPasswordPage() {
  useEffect(() => {
    document.title = "Redefinir senha — Levora Solidária";
  }, []);
  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <div className={styles.brand}>
          <HeartHandshake className={styles.brandIcon} size={28} aria-hidden="true" />
          <span className={styles.brandName}>Levora Solidária</span>
        </div>
        <PasswordResetForm />
      </main>
    </div>
  );
}
