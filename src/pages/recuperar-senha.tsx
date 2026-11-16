import React, { useEffect } from "react";
import { HeartHandshake } from "lucide-react";
import { PasswordResetRequestForm } from "../components/PasswordResetRequestForm";
import styles from "./login.module.css";

/** Pedido de redefinição de senha (público). Reaproveita o cartão visual do login. */
export default function RecoverPasswordPage() {
  useEffect(() => {
    document.title = "Esqueci minha senha — Levora Solidária";
  }, []);
  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <div className={styles.brand}>
          <HeartHandshake className={styles.brandIcon} size={28} aria-hidden="true" />
          <span className={styles.brandName}>Levora Solidária</span>
        </div>
        <PasswordResetRequestForm />
      </main>
    </div>
  );
}
