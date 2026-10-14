import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Info, ListChecks, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { getOrganizations } from "../endpoints/organizations_GET.schema";
import { getUnitRegularizationCases, type RegularizationCase } from "../endpoints/unit-regularization-cases_GET.schema";
import { postUnitRegularizationConfer } from "../endpoints/unit-regularization-confer_POST.schema";
import { postUnitRegularizationValidate } from "../endpoints/unit-regularization-validate_POST.schema";
import { postUnitRegularizationClose } from "../endpoints/unit-regularization-close_POST.schema";
import { postUnitRegularizationCorrect } from "../endpoints/unit-regularization-correct_POST.schema";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { Textarea } from "../components/Textarea";
import { Skeleton } from "../components/Skeleton";
import { UnitSelect } from "../components/UnitSelect";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/Dialog";
import inputStyles from "../components/Input.module.css";
import styles from "./organizacoes.$organizationId.regularizacao.module.css";

type Action = { kind: "confer" | "validate" | "close" | "correct"; item: RegularizationCase } | null;

const STATUS_FILTERS = [
  { value: "ativos", label: "Em aberto" },
  { value: "todos", label: "Todos" },
  { value: "aberto", label: "Aberto" },
  { value: "conferido", label: "Conferido, aguardando validação" },
  { value: "resolvido", label: "Resolvido" },
  { value: "corrigido", label: "Cadastro corrigido" },
  { value: "encerrado", label: "Encerrado sem resolução" },
] as const;

const EVENT_LABEL: Record<string, string> = {
  aberto: "Caso aberto",
  correcao_cadastral: "Correção cadastral",
  conferencia_registrada: "Conferência registrada",
  conferencia_devolvida: "Conferência devolvida",
  validada_resolvida: "Validada e resolvida",
  encerrado: "Encerrado sem resolução",
};

const fmtQty = (q: number | null, unit: string | null) => (q === null ? "—" : `${q}${unit ? ` ${unit}` : ""}`);
const fmtDate = (iso: string) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

export default function OrganizationRegularizationPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = Number(params.organizationId);
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]["value"]>("ativos");
  const [source, setSource] = useState<"" | "allocation" | "local_donation">("");
  const [category, setCategory] = useState<"" | RegularizationCase["category"]>("");
  const [order, setOrder] = useState<"antigos" | "recentes">("antigos");
  const [action, setAction] = useState<Action>(null);

  const orgsQuery = useQuery({ queryKey: ["organizations"], queryFn: () => getOrganizations() });
  const org = orgsQuery.data?.organizations.find((o) => o.id === organizationId);
  // Mesma permissão do servidor (logistica.gerencie: proprietário, administrador e operador). A UI nunca é a autoridade: o endpoint recusa quem não a tem.
  const canView = org && ["proprietario", "administrador", "operador"].includes(org.myRole);
  const canManage = org && (org.myRole === "proprietario" || org.myRole === "administrador");

  const query = useQuery({
    queryKey: ["unit-regularization-cases", organizationId, status, source, category, order],
    queryFn: () => getUnitRegularizationCases({ organizationId, status, source: source || undefined, category: category || undefined, order }),
    enabled: Number.isFinite(organizationId) && !!canView,
    retry: false,
  });
  const data = query.data;
  const hasFilters = status !== "ativos" || source !== "" || category !== "" || order !== "antigos";

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["unit-regularization-cases", organizationId] });
    queryClient.invalidateQueries({ queryKey: ["organization-allocations", organizationId] });
    queryClient.invalidateQueries({ queryKey: ["inventory-items", organizationId] });
    queryClient.invalidateQueries({ queryKey: ["opportunities", organizationId] });
  };

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}>
        <ArrowLeft size={16} /> Voltar ao painel
      </Link>

      <nav className={styles.tabNav}>
        <Link to={`/organizacoes/${organizationId}`} className={styles.tabNavItem}>Visão geral</Link>
        <Link to={`/organizacoes/${organizationId}/inventario`} className={styles.tabNavItem}>Inventário</Link>
        <Link to={`/organizacoes/${organizationId}/necessidades`} className={styles.tabNavItem}>Necessidades</Link>
        <Link to={`/organizacoes/${organizationId}/oportunidades`} className={styles.tabNavItem}>Oportunidades</Link>
        <Link to={`/organizacoes/${organizationId}/atribuicoes`} className={styles.tabNavItem}>Rede Levora</Link>
        <Link to={`/organizacoes/${organizationId}/prestacao-contas`} className={styles.tabNavItem}>Prestação de contas</Link>
        <Link to={`/organizacoes/${organizationId}/matching`} className={styles.tabNavItem}>Configurações de Matching</Link>
        {canManage && <Link to={`/organizacoes/${organizationId}/unidades`} className={styles.tabNavItem}>Unidades</Link>}
        <span className={styles.tabNavItemActive} aria-current="page">Pendências de unidade</span>
      </nav>

      <h1 className={styles.title}>Pendências de unidade</h1>
      <p className={styles.subtitle}>
        Recebimentos em que a unidade da oferta não tem equivalência comprovada com a unidade do item. Enquanto o caso estiver em aberto, <strong>nada é lançado no estoque</strong> nem
        contado como atendimento — mas o recebimento não se perde: tudo o que foi apresentado fica registrado aqui.
      </p>

      <div className={styles.infoBanner} role="note">
        <Info size={16} aria-hidden="true" />
        <p>
          <strong>A conferência não é uma conversão.</strong> Quem recebeu conta ou mede a quantidade <em>na unidade do item</em>. Se a quantidade real não puder ser estabelecida, o caso
          permanece pendente. Corrigir um erro de cadastro não lança estoque: depois dele, registre o recebimento normalmente.
        </p>
      </div>

      {org && !canView ? (
        <div className={styles.emptyState} role="status">
          <ListChecks size={20} aria-hidden="true" />
          <p>Seu papel nesta organização ({org.myRole}) não permite ver estas pendências. Falta permissão para lançar logística.</p>
        </div>
      ) : (
        <>
          <section className={styles.section} aria-labelledby="reg-filtros">
            <h2 id="reg-filtros" className={styles.sectionTitle}>Filtros</h2>
            <div className={styles.filters}>
              <div className={styles.filterField}>
                <label htmlFor="reg-status" className={styles.filterLabel}>Situação</label>
                <select id="reg-status" className={`${inputStyles.input} ${styles.select}`} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                  {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="reg-source" className={styles.filterLabel}>Origem</label>
                <select id="reg-source" className={`${inputStyles.input} ${styles.select}`} value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
                  <option value="">Todas as origens</option>
                  <option value="allocation">Atribuição da rede Levora</option>
                  <option value="local_donation">Doação local</option>
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="reg-category" className={styles.filterLabel}>Tipo de divergência</label>
                <select id="reg-category" className={`${inputStyles.input} ${styles.select}`} value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
                  <option value="">Todos os tipos</option>
                  <option value="a_classificar">A classificar</option>
                  <option value="conferencia_fisica">Conferência física</option>
                  <option value="erro_cadastral">Erro cadastral</option>
                  <option value="conversao_nao_suportada">Depende de conversão não suportada</option>
                  <option value="informacao_insuficiente">Informação insuficiente</option>
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="reg-order" className={styles.filterLabel}>Ordem</label>
                <select id="reg-order" className={`${inputStyles.input} ${styles.select}`} value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
                  <option value="antigos">Mais antigos primeiro</option>
                  <option value="recentes">Mais recentes primeiro</option>
                </select>
              </div>
              <div className={styles.filterActions}>
                <Button variant="outline" size="sm" disabled={!hasFilters} onClick={() => { setStatus("ativos"); setSource(""); setCategory(""); setOrder("antigos"); }}>
                  <RotateCcw size={14} /> Limpar filtros
                </Button>
              </div>
            </div>
          </section>

          <section className={styles.section} aria-labelledby="reg-lista" aria-live="polite" aria-busy={query.isFetching}>
            <h2 id="reg-lista" className={styles.sectionTitle}>Casos{data ? ` (${data.cases.length})` : ""}</h2>
            {query.isError ? (
              <div className={styles.errorState} role="alert">
                <p>Não foi possível carregar as pendências de unidade. Nenhum dado foi alterado.</p>
                <Button variant="outline" size="sm" onClick={() => query.refetch()}>Tentar novamente</Button>
              </div>
            ) : query.isLoading || !data ? (
              <Skeleton className={styles.listSkeleton} />
            ) : data.cases.length === 0 ? (
              <p className={styles.emptyText} role="status">
                {hasFilters ? "Nenhum caso corresponde aos filtros aplicados." : "Nenhuma pendência de unidade em aberto. Os recebimentos desta organização estão sem divergência."}
              </p>
            ) : (
              <ul className={styles.caseList}>
                {data.cases.map((c) => (
                  <li key={c.id} className={styles.case}>
                    <div className={styles.caseHead}>
                      <span className={styles.status} data-status={c.status}>{c.statusLabel}</span>
                      <span className={styles.caseMeta}>{c.sourceLabel} · aberto em {fmtDate(c.openedAt)}{c.openedByName ? ` por ${c.openedByName}` : ""}</span>
                    </div>
                    <h3 className={styles.caseTitle}>{c.resourceTitle}</h3>
                    <dl className={styles.facts}>
                      <div><dt>Divergência</dt><dd>{c.divergenceLabel}</dd></div>
                      <div><dt>Etapa bloqueada</dt><dd>{c.blockedStage}</dd></div>
                      <div><dt>Ofertado</dt><dd>{fmtQty(c.offeredQuantity, c.offeredUnit ?? "unidade não informada")}</dd></div>
                      <div><dt>Quantidade informada ao receber</dt><dd>{c.informedQuantity} (sem unidade confirmada)</dd></div>
                      <div><dt>Item de estoque</dt><dd>{c.itemName} — unidade do item: {c.itemUnit}</dd></div>
                      {c.checkedQuantity !== null && <div><dt>Conferido</dt><dd>{c.checkedQuantity} {c.checkedUnit}{c.conferredByName ? ` por ${c.conferredByName}` : ""}</dd></div>}
                      {c.divergenceReason && <div><dt>Motivo da divergência</dt><dd>{c.divergenceReason}</dd></div>}
                      {c.validatedByName && <div><dt>Validado por</dt><dd>{c.validatedByName}{c.withoutSecondValidation ? " (sem segunda validação: único administrador ativo)" : ""}</dd></div>}
                      {c.closedReason && <div><dt>Motivo do fechamento</dt><dd>{c.closedReason}</dd></div>}
                    </dl>
                    <p className={styles.next}><strong>Próxima ação:</strong> {c.nextAction}</p>
                    <div className={styles.actions}>
                      {c.canConfer && <Button size="sm" onClick={() => setAction({ kind: "confer", item: c })}>Conferir quantidade</Button>}
                      {c.canValidate && <Button size="sm" onClick={() => setAction({ kind: "validate", item: c })}>Validar conferência</Button>}
                      {c.canCorrect && <Button size="sm" variant="outline" onClick={() => setAction({ kind: "correct", item: c })}>Corrigir unidade da doação</Button>}
                      {c.canClose && <Button size="sm" variant="outline" onClick={() => setAction({ kind: "close", item: c })}>Encerrar sem resolução</Button>}
                      {c.sourceType === "allocation" && (c.status === "aberto" || c.status === "conferido") && <span className={styles.hint}>Se o cadastro da oferta da rede estiver errado, a correção é feita pela equipe da Levora.</span>}
                    </div>
                    <details className={styles.history}>
                      <summary>Histórico do caso ({c.events.length})</summary>
                      <ol>
                        {c.events.map((e) => (
                          <li key={e.id}>
                            <strong>{EVENT_LABEL[e.eventType] ?? e.eventType}</strong> · {fmtDate(e.createdAt)}{e.actorName ? ` · ${e.actorName}` : ""}
                            {(e.previousValue !== null || e.newValue !== null) && <span> · {e.previousValue ?? "—"} → {e.newValue ?? "—"}</span>}
                            {(e.quantityBefore !== null || e.quantityAfter !== null) && <span> · quantidade {e.quantityBefore ?? "—"} → {e.quantityAfter ?? "—"}</span>}
                            {e.reason && <span> — {e.reason}</span>}
                          </li>
                        ))}
                      </ol>
                    </details>
                  </li>
                ))}
              </ul>
            )}
            {data?.truncated && <p className={styles.truncNotice} role="status">Há mais casos do que o limite exibido; refine os filtros.</p>}
          </section>
        </>
      )}

      <ActionDialog action={action} organizationId={organizationId} canManage={!!canManage} onClose={() => setAction(null)} onDone={() => { setAction(null); refresh(); }} />
    </div>
  );
}

function ActionDialog({ action, organizationId, canManage, onClose, onDone }: { action: Action; organizationId: number; canManage: boolean; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [category, setCategory] = useState<"conversao_nao_suportada" | "informacao_insuficiente">("informacao_insuficiente");
  const [decision, setDecision] = useState<"aprovar" | "devolver">("aprovar");
  const [validateNow, setValidateNow] = useState(false);

  React.useEffect(() => {
    setText(""); setQty(""); setUnit(""); setDecision("aprovar"); setValidateNow(false); setCategory("informacao_insuficiente");
  }, [action?.kind, action?.item.id]);

  const done = (message: string) => { toast.success(message); onDone(); };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Não foi possível concluir a ação");

  const confer = useMutation({
    mutationFn: () => postUnitRegularizationConfer({ organizationId, caseId: action!.item.id, checkedQuantity: qty as unknown as number, reason: text, validateNow }),
    onSuccess: (r) => done(r.status === "resolvido" ? "Conferência registrada e recebimento lançado no estoque." : "Conferência registrada. Aguarda validação."),
    onError: fail,
  });
  const validate = useMutation({
    mutationFn: () => postUnitRegularizationValidate({ organizationId, caseId: action!.item.id, decision, note: text }),
    onSuccess: (r) => done(r.status === "resolvido" ? "Conferência validada e recebimento lançado no estoque." : "Conferência devolvida para nova conferência."),
    onError: fail,
  });
  const close = useMutation({
    mutationFn: () => postUnitRegularizationClose({ organizationId, caseId: action!.item.id, category, reason: text }),
    onSuccess: () => done("Caso encerrado sem resolução. Nada foi lançado no estoque."),
    onError: fail,
  });
  const correct = useMutation({
    mutationFn: () => postUnitRegularizationCorrect({ organizationId, caseId: action!.item.id, newUnit: unit, reason: text }),
    onSuccess: () => done("Unidade corrigida. Registre o recebimento normalmente."),
    onError: fail,
  });

  if (!action) return null;
  const c = action.item;
  const busy = confer.isPending || validate.isPending || close.isPending || correct.isPending;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (action.kind === "confer") confer.mutate();
    else if (action.kind === "validate") validate.mutate();
    else if (action.kind === "close") close.mutate();
    else correct.mutate();
  };
  const titles = { confer: "Conferir a quantidade", validate: "Validar a conferência", close: "Encerrar sem resolução", correct: "Corrigir a unidade da doação" };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className={styles.dialogForm}>
          <DialogHeader>
            <DialogTitle>{titles[action.kind]}</DialogTitle>
            <DialogDescription>{c.resourceTitle} · item "{c.itemName}" (unidade do item: {c.itemUnit})</DialogDescription>
          </DialogHeader>

          {action.kind === "confer" && (
            <>
              <p className={styles.dialogHelp}>Conte ou meça o que chegou <strong>na unidade do item ({c.itemUnit})</strong>. Isto é uma observação física, não uma conversão.</p>
              <label className={styles.fieldLabel} htmlFor="reg-qty">Quantidade conferida ({c.itemUnit})</label>
              <Input id="reg-qty" inputMode="decimal" required value={qty} onChange={(e) => setQty(e.target.value)} placeholder="ex.: 12,5" />
              <label className={styles.fieldLabel} htmlFor="reg-reason">Motivo da divergência</label>
              <Textarea id="reg-reason" required minLength={10} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="Explique por que a unidade ofertada difere e como a quantidade foi conferida." />
              {canManage && (
                <label className={styles.check}>
                  <input type="checkbox" checked={validateNow} onChange={(e) => setValidateNow(e.target.checked)} />
                  Validar agora (só vale se você for o único proprietário/administrador ativo)
                </label>
              )}
            </>
          )}
          {action.kind === "validate" && (
            <>
              <p className={styles.dialogHelp}>Conferido: <strong>{c.checkedQuantity} {c.checkedUnit}</strong>{c.conferredByName ? ` por ${c.conferredByName}` : ""}. Aprovar lança o recebimento no estoque uma única vez.</p>
              <fieldset className={styles.radios}>
                <legend className={styles.fieldLabel}>Decisão</legend>
                <label><input type="radio" name="reg-decision" checked={decision === "aprovar"} onChange={() => setDecision("aprovar")} /> Aprovar e lançar no estoque</label>
                <label><input type="radio" name="reg-decision" checked={decision === "devolver"} onChange={() => setDecision("devolver")} /> Devolver para nova conferência</label>
              </fieldset>
              <label className={styles.fieldLabel} htmlFor="reg-note">Observação{decision === "devolver" ? " (obrigatória)" : ""}</label>
              <Textarea id="reg-note" required={decision === "devolver"} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
            </>
          )}
          {action.kind === "close" && (
            <>
              <p className={styles.dialogHelp}>O caso será encerrado <strong>sem lançar nada no estoque</strong>. O recurso continua sem ser recebido e o motivo fica registrado.</p>
              <label className={styles.fieldLabel} htmlFor="reg-cat">Por que não foi possível resolver</label>
              <select id="reg-cat" className={`${inputStyles.input} ${styles.select}`} value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
                <option value="informacao_insuficiente">Faltam informações para decidir</option>
                <option value="conversao_nao_suportada">Depende de uma conversão que o sistema não faz</option>
              </select>
              <label className={styles.fieldLabel} htmlFor="reg-close-reason">Motivo</label>
              <Textarea id="reg-close-reason" required minLength={10} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
            </>
          )}
          {action.kind === "correct" && (
            <>
              <p className={styles.dialogHelp}>Use apenas se a unidade da doação foi cadastrada errada (hoje: <strong>{c.offeredUnit ?? "não informada"}</strong>). A nova unidade precisa ser compatível com a do item. Nada é lançado no estoque.</p>
              <label className={styles.fieldLabel} htmlFor="reg-unit">Unidade correta</label>
              <UnitSelect id="reg-unit" value={unit} onChange={setUnit} />
              <label className={styles.fieldLabel} htmlFor="reg-correct-reason">Motivo / evidência do erro</label>
              <Textarea id="reg-correct-reason" required minLength={10} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
            </>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancelar</Button>
            <Button type="submit" disabled={busy || (action.kind === "correct" && unit === "")}>{busy ? "Enviando..." : "Confirmar"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
