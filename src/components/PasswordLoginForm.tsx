import React, { useState } from "react";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import {
  Form,
  FormControl,
  FormItem,
  FormLabel,
  FormMessage,
  useForm,
} from "./Form";
import { Input } from "./Input";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import styles from "./PasswordLoginForm.module.css";
import {
  schema,
  postLogin,
} from "../endpoints/auth/login_with_password_POST.schema";
import { useAuth } from "../helpers/useAuth";
import { MfaCodeForm } from "./MfaCodeForm";
import { MfaSetupPanel } from "./MfaSetupPanel";
import { GoogleButton, OrDivider } from "./GoogleButton";

export type LoginFormData = z.infer<typeof schema>;

interface PasswordLoginFormProps {
  className?: string;
  /** Para onde navegar após o login. Padrão "/" (mantém o comportamento existente). */
  redirectTo?: string;
}

export const PasswordLoginForm: React.FC<PasswordLoginFormProps> = ({
  className,
  redirectTo = "/",
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fase 90: senha correta ≠ login completo para quem tem 2º fator — o servidor devolve um challenge (cookie próprio, sem sessão).
  const [mfaStage, setMfaStage] = useState<null | "verify" | "enroll">(null);
  const { onLogin } = useAuth();
  const navigate = useNavigate();

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
    schema,
  });

  const handleSubmit = async (data: LoginFormData) => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await postLogin(data);
      if (result.mfaRequired) {
        setMfaStage(result.mfaKind);
        return;
      }
      onLogin(result.user);
      setTimeout(() => navigate(redirectTo), 200);
    } catch (err) {
      console.error("Login error:", err);
      setError(
        err instanceof Error ? err.message : "Não foi possível entrar. Tente novamente."
      );
    } finally {
      setIsLoading(false);
    }
  };

  const finish = (user?: Parameters<typeof onLogin>[0]) => {
    if (user) onLogin(user);
    setTimeout(() => navigate(redirectTo), 200);
  };
  const restart = () => {
    setMfaStage(null);
    form.setValues((prev) => ({ ...prev, password: "" }));
  };

  if (mfaStage === "verify") return <MfaCodeForm onVerified={finish} onRestart={restart} />;
  if (mfaStage === "enroll") {
    return (
      <MfaSetupPanel
        mode="challenge"
        intro="Contas com acesso à plataforma precisam de um segundo fator. Configure o autenticador para entrar."
        onRestart={restart}
        onDone={finish}
      />
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className={`${styles.form} ${className || ""}`}
      >
        {error && <div className={styles.errorMessage}>{error}</div>}

        <FormItem name="email">
          <FormLabel>E-mail</FormLabel>
          <FormControl>
            <Input
              placeholder="voce@email.com"
              type="email"
              autoComplete="email"
              disabled={isLoading}
              value={form.values.email}
              onChange={(e) =>
                form.setValues((prev) => ({ ...prev, email: e.target.value }))
              }
            />
          </FormControl>
          <FormMessage />
        </FormItem>

        <FormItem name="password">
          <FormLabel>Senha</FormLabel>
          <FormControl>
            <Input
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              disabled={isLoading}
              value={form.values.password}
              onChange={(e) =>
                form.setValues((prev) => ({
                  ...prev,
                  password: e.target.value,
                }))
              }
            />
          </FormControl>
          <FormMessage />
        </FormItem>

        <Button
          type="submit"
          disabled={isLoading}
          className={styles.submitButton}
        >
          {isLoading ? (
            <span className={styles.loadingText}>
              <Spinner className={styles.spinner} size="sm" />
              Entrando...
            </span>
          ) : (
            "Entrar"
          )}
        </Button>
      </form>
      <div className={styles.alt}>
        <OrDivider>ou</OrDivider>
        <GoogleButton intent="login">Entrar com Google</GoogleButton>
      </div>
    </Form>
  );
};

