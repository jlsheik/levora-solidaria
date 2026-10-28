// O zod 4 sonda `new Function("")` para decidir se usa o parser compilado (JIT). Sob a CSP de produção (sem unsafe-eval) o navegador REGISTRA essa sonda como
// violação (`securitypolicyviolation`) mesmo com o erro capturado — o qa:security acusa. `jitless` desliga a sonda e o JIT (validação continua idêntica, só um pouco mais lenta).
// Precisa rodar ANTES de qualquer schema ser criado: por isso é o primeiro import de main.tsx.
import { z } from "zod";

z.config({ jitless: true });
