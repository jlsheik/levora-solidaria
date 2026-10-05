import React, { useState } from "react";
import * as z from "zod";
import {
  Form,
  FormControl,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
  useForm,
} from "./Form";
import { Input } from "./Input";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import { GoogleButton, OrDivider } from "./GoogleButton";
import styles from "./PasswordRegisterForm.module.css";
import {
  schema,
  postRegister,
} from "../endpoints/auth/register_with_password_POST.schema";
import { postAccessCodeCheck } from "../endpoints/auth/access-code-check_POST.schema";
import { ApiRequestError } from "../helpers/apiRequestError";

export type RegisterFormData = z.infer<typeof schema>;

interface PasswordRegisterFormProps {
  className?: string;
  defaultValues?: Partial<RegisterFormData>;
  /** Chamado depois de um envio bem-sucedido (sem distinguir conta nova de
   * já existente — ver nota da Fase 51 acima). Usado por páginas como
   * convites.$token.tsx para trocar para a aba "Entrar" em vez de deixar
   * a pessoa parada numa tela sem próximo passo óbvio. */
  onSubmitted?: () => void;
}

/**
 * Cadastro em DOIS passos (Fase 92): (1) código de acesso, validado sem consumir; (2) só então aparecem as formas de criar a conta —
 * "Continuar com Google" ou e-mail e senha. O código nunca vai para a URL nem para o storage: vive só neste estado de componente
 * e segue no CORPO das requisições; o servidor revalida em qualquer caminho (a validação aqui é só experiência de uso).
 */
export const PasswordRegisterForm: React.FC<PasswordRegisterFormProps> = ({
  className,
  defaultValues,
  onSubmitted,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fase 51 (SEC-03): o cadastro não loga mais automaticamente nem
  // distingue "e-mail novo" de "e-mail já cadastrado" — a resposta do
  // servidor é sempre a mesma mensagem (ver register_with_password_POST.ts
  // e docs/SECURITY.md). Esta tela só confirma o envio e direciona para a
  // aba "Entrar"; logar de verdade acontece ali, como qualquer login.
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [codeStatus, setCodeStatus] = useState<"editing" | "checking" | "valid">("editing");
  const [codeError, setCodeError] = useState<string | null>(null);

  const form = useForm({
    schema,
    defaultValues: defaultValues || {
      email: "",
      password: "",
      displayName: "",
      accessCode: "",
    },
  });

  const accessCode = (form.values.accessCode || "").trim();

  const checkCode = async () => {
    if (!accessCode || codeStatus === "checking") return;
    setCodeError(null);
    setCodeStatus("checking");
    try {
      await postAccessCodeCheck({ accessCode });
      setCodeStatus("valid");
    } catch (err) {
      setCodeStatus("editing");
      setCodeError(
        err instanceof ApiRequestError && err.status === 429
          ? "Muitas tentativas. Aguarde um pouco antes de tentar de novo."
          : err instanceof ApiRequestError && err.code === "codigo_indisponivel"
            ? err.message
            : "Não foi possível validar o código agora. Tente novamente."
      );
    }
  };

  const changeCode = () => {
    setCodeStatus("editing");
    setCodeError(null);
  };

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    setError(null);
    setSuccessMessage(null);
    setIsLoading(true);

    try {
      const result = await postRegister(data);
      setSuccessMessage(result.message);
      form.setValues({ email: "", password: "", displayName: "", accessCode: "" });
      setCodeStatus("editing");
      onSubmitted?.();
    } catch (err) {
      console.error("Registration error:", err);

      if (err instanceof ApiRequestError && err.code === "codigo_indisponivel") {
        // o código deixou de servir (usado/expirado/revogado) entre a validação e o envio: volta ao passo 1
        setCodeStatus("editing");
        setError(err.message);
      } else if (err instanceof Error) {
        const errorMessage = err.message;
        if (errorMessage.toLowerCase().includes("nome")) {
          setError("Informe um nome válido.");
        } else {
          setError(errorMessage || "Não foi possível processar o cadastro. Tente novamente.");
        }
      } else {
        setError("Não foi possível processar o cadastro. Tente novamente.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const codeValid = codeStatus === "valid";

  return (
    <Form {...form}>
      {successMessage && <div className={styles.successMessage}>{successMessage}</div>}
      {error && <div className={styles.errorMessage}>{error}</div>}
      <form
        onSubmit={form.handleSubmit((data) =>
          handleSubmit(data as z.infer<typeof schema>)
        )}
        className={`${styles.form} ${className || ""}`}
      >
        <FormItem name="accessCode">
          <FormLabel>Código de acesso</FormLabel>
          <FormControl>
            <Input
              id="register-access-code"
              placeholder="LEV-XXXX-XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              readOnly={codeValid}
              disabled={codeStatus === "checking"}
              value={form.values.accessCode || ""}
              onChange={(e) => {
                setCodeError(null);
                form.setValues((prev: any) => ({
                  ...prev,
                  accessCode: e.target.value.toUpperCase(),
                }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !codeValid) {
                  e.preventDefault();
                  void checkCode();
                }
              }}
            />
          </FormControl>
          <FormDescription>
            {codeValid
              ? "Código válido. Escolha como criar sua conta."
              : "O código é fornecido pela Levora e vale para uma única conta. Não é a sua senha."}
          </FormDescription>
          {codeError && <div className={styles.errorMessage} role="alert">{codeError}</div>}
          <FormMessage />
        </FormItem>

        {!codeValid ? (
          <Button
            type="button"
            className={styles.submitButton}
            disabled={!accessCode || codeStatus === "checking"}
            onClick={checkCode}
          >
            {codeStatus === "checking" ? (
              <>
                <Spinner size="sm" /> Validando...
              </>
            ) : (
              "Validar código"
            )}
          </Button>
        ) : (
          <>
            <button type="button" className={styles.linkButton} onClick={changeCode}>
              Usar outro código
            </button>

            <GoogleButton intent="signup" accessCode={accessCode}>
              Continuar com Google
            </GoogleButton>
            <OrDivider>ou crie com e-mail e senha</OrDivider>

            <FormItem name="email">
              <FormLabel>E-mail</FormLabel>
              <FormControl>
                <Input
                  placeholder="voce@email.com"
                  value={form.values.email || ""}
                  onChange={(e) =>
                    form.setValues((prev: any) => ({
                      ...prev,
                      email: e.target.value,
                    }))
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>

            <FormItem name="displayName">
              <FormLabel>Nome</FormLabel>
              <FormControl>
                <Input
                  id="register-display-name"
                  placeholder="Seu nome"
                  value={form.values.displayName || ""}
                  onChange={(e) =>
                    form.setValues((prev: any) => ({
                      ...prev,
                      displayName: e.target.value,
                    }))
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
                  value={form.values.password || ""}
                  onChange={(e) =>
                    form.setValues((prev: any) => ({
                      ...prev,
                      password: e.target.value,
                    }))
                  }
                />
              </FormControl>
              <FormDescription>
                No mínimo 8 caracteres
              </FormDescription>
              <FormMessage />
            </FormItem>

            <Button
              type="submit"
              disabled={isLoading}
              className={styles.submitButton}
            >
              {isLoading ? (
                <>
                  <Spinner size="sm" /> Criando conta...
                </>
              ) : (
                "Criar conta"
              )}
            </Button>
          </>
        )}
      </form>
    </Form>
  );
};
