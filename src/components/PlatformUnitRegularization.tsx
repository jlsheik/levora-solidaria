import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ruler } from "lucide-react";
import { toast } from "sonner";
import { getUnitRegularizationPlatform } from "../endpoints/unit-regularization-platform_GET.schema";
import { postUnitRegularizationCorrectOffer } from "../endpoints/unit-regularization-correct-offer_POST.schema";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { Textarea } from "./Textarea";
import { UnitSelect } from "./UnitSelect";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import styles from "./PlatformUnitRegularization.module.css";

/**
 * Fase 99C — casos de regularização que dependem da oferta da rede (registro global, que só a plataforma corrige). Única ação transversal: corrigir a unidade da PRÓPRIA oferta,
 * com motivo, quando não há recebimentos já lançados com a unidade antiga. Não vê itens de estoque, notas nem usuários das organizações.
 */
export function PlatformUnitRegularizationSection() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["unit-regularization-platform"], queryFn: () => getUnitRegularizationPlatform(), retry: false });
  const [target, setTarget] = useState<{ id: number; title: string; offeredUnit: string | null; itemUnit: string } | null>(null);
  const [unit, setUnit] = useState("");
  const [reason, setReason] = useState("");

  const correct = useMutation({
    mutationFn: () => postUnitRegularizationCorrectOffer({ caseId: target!.id, newUnit: unit, reason }),
    onSuccess: () => {
      toast.success("Unidade da oferta corrigida. A organização pode registrar o recebimento normalmente.");
      setTarget(null);
      setUnit("");
      setReason("");
      queryClient.invalidateQueries({ queryKey: ["unit-regularization-platform"] });
      queryClient.invalidateQueries({ queryKey: ["opportunity-registry"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Não foi possível corrigir a unidade da oferta"),
  });

  return (
    <section className={styles.section} aria-labelledby="reg-plataforma-titulo">
      <h2 id="reg-plataforma-titulo" className={styles.title}><Ruler size={18} /> Pendências de unidade das ofertas da rede</h2>
      <p className={styles.help}>
        Recebimentos que ficaram sem ser lançados porque a unidade da oferta não tem equivalência comprovada com a do item. Corrija a unidade da oferta só se o cadastro estiver errado;
        caso contrário, a organização resolve por conferência física. Nada é convertido.
      </p>
      {query.isError ? (
        <p className={styles.help} role="alert">Não foi possível carregar as pendências. {query.error instanceof Error ? query.error.message : ""}</p>
      ) : query.isLoading || !query.data ? (
        <Skeleton className={styles.skeleton} />
      ) : query.data.cases.length === 0 ? (
        <p className={styles.help} role="status">Nenhuma pendência de unidade de oferta da rede em aberto.</p>
      ) : (
        <ul className={styles.list}>
          {query.data.cases.map((c) => (
            <li key={c.id} className={styles.row}>
              <div className={styles.rowInfo}>
                <strong>{c.resourceTitle}</strong>
                <span>{c.organizationName} · aberto em {new Date(c.openedAt).toLocaleDateString("pt-BR")}</span>
                <span>Oferta: {c.offeredQuantity ?? "—"} {c.offeredUnit ?? "(sem unidade)"} · unidade do item: {c.itemUnit}</span>
              </div>
              <Button size="sm" variant="outline" onClick={() => { setTarget({ id: c.id, title: c.resourceTitle, offeredUnit: c.offeredUnit, itemUnit: c.itemUnit }); setUnit(""); setReason(""); }}>
                Corrigir unidade da oferta
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!target} onOpenChange={(open) => { if (!open) setTarget(null); }}>
        <DialogContent>
          <form onSubmit={(e) => { e.preventDefault(); correct.mutate(); }} className={styles.form}>
            <DialogHeader>
              <DialogTitle>Corrigir a unidade da oferta</DialogTitle>
              <DialogDescription>{target?.title} · unidade atual: {target?.offeredUnit ?? "não informada"} · unidade do item: {target?.itemUnit}</DialogDescription>
            </DialogHeader>
            <label className={styles.label} htmlFor="plat-reg-unit">Unidade correta</label>
            <UnitSelect id="plat-reg-unit" value={unit} onChange={setUnit} />
            <label className={styles.label} htmlFor="plat-reg-reason">Motivo / evidência do erro de cadastro</label>
            <Textarea id="plat-reg-reason" required minLength={10} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setTarget(null)} disabled={correct.isPending}>Cancelar</Button>
              <Button type="submit" disabled={correct.isPending || unit === ""}>{correct.isPending ? "Enviando..." : "Confirmar correção"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
