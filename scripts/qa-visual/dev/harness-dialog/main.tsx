// M06 — harness do DIÁLOGO REAL: renderiza os componentes de produção (src/components/Dialog + Button + base.css) com títulos controlados, sem API nem banco.
// Parâmetros: ?title=...&theme=dark|light&desc=1&br=1  (title com "|" vira quebra de linha explícita <br/>)
import React from "react";
import { createRoot } from "react-dom/client";
import "../../../../src/base.css";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../src/components/Dialog";
import { Button } from "../../../../src/components/Button";

const q = new URLSearchParams(location.search);
const title = q.get("title") ?? "Editar necessidade";
if (q.get("theme") === "dark") { document.body.classList.add("dark"); document.documentElement.classList.add("dark"); }
const parts = title.split("|");
function App() {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <main style={{ padding: 16 }}><h1>Página de fundo</h1><p>Conteúdo atrás do diálogo.</p></main>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{parts.map((p, i) => <React.Fragment key={i}>{i > 0 && <br />}{p}</React.Fragment>)}</DialogTitle>
            <DialogDescription>Altera título, descrição e prioridade. Quantidade, unidade e histórico não mudam.</DialogDescription>
          </DialogHeader>
          <label>Título<input defaultValue="Cestas básicas" /></label>
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button><Button>Salvar alterações</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
