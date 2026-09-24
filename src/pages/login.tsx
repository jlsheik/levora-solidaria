import React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/Tabs";
import { PasswordLoginForm } from "../components/PasswordLoginForm";
import { PasswordRegisterForm } from "../components/PasswordRegisterForm";
import { HeartHandshake } from "lucide-react";
import styles from "./login.module.css";

export default function LoginPage() {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <HeartHandshake className={styles.brandIcon} size={28} />
          <span className={styles.brandName}>Levora Solidária</span>
        </div>
        <p className={styles.tagline}>
          Infraestrutura de solidariedade: doações rastreadas do recebimento à
          prestação de contas.
        </p>

        <Tabs defaultValue="entrar" className={styles.tabs}>
          <TabsList className={styles.tabsList}>
            <TabsTrigger value="entrar">Entrar</TabsTrigger>
            <TabsTrigger value="cadastro">Criar conta</TabsTrigger>
          </TabsList>
          <TabsContent value="entrar" className={styles.tabsContent}>
            <PasswordLoginForm />
          </TabsContent>
          <TabsContent value="cadastro" className={styles.tabsContent}>
            <PasswordRegisterForm />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
