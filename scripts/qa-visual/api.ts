// API de desenvolvimento para a verificação visual (porta escolhida pelo orquestrador em PORT; banco em DATABASE_URL, já validado como `_qa`).
import { buildApp } from "../../server/index";

const app = await buildApp();
app.listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`API de QA na porta ${process.env.PORT}`));
