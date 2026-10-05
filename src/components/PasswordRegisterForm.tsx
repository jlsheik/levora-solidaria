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
import styles from "./PasswordRegisterForm.module.css";
import {
  schema,
  postRegister,
} from "../endpoints/auth/register_with_password_POST.schema";

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

  const form = useForm({
    schema,
    defaultValues: defaultValues || {
      email: "",
      password: "",
      displayName: "",
      accessCode: "",
    },
  });

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    setError(null);
    setSuccessMessage(null);
    setIsLoading(true);

    try {
      const result = await postRegister(data);
      setSuccessMessage(result.message);
      form.setValues({ email: "", password: "", displayName: "", accessCode: "" });
      onSubmitted?.();
    } catch (err) {
      console.error("Registration error:", err);

      if (err instanceof Error) {
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
              value={form.values.accessCode || ""}
              onChange={(e) =>
                form.setValues((prev: any) => ({
                  ...prev,
                  accessCode: e.target.value.toUpperCase(),
                }))
              }
            />
          </FormControl>
          <FormDescription>
            O código é fornecido pela Levora e vale para uma única conta. Não é a sua senha.
          </FormDescription>
          <FormMessage />
        </FormItem>

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
      </form>
    </Form>
  );
};

