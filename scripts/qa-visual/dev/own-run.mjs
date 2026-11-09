// M13: registro de PROPRIEDADE para os verificadores de desenvolvimento (dev/*-check.mjs). Antes, esses scripts abriam navegador e servidor sem registrar a identidade (PID + instante de criação + perfil
// exclusivo) em lib/orphans.mjs; se fossem interrompidos à força, os filhos ficavam órfãos e a única saída era encerrar "pelo que parece ser deles" (correspondência por linha de comando) — exatamente o
// que o contrato da M06 proíbe. Com este registro, `npm run qa:visual -- --cleanup` recupera os órfãos por identidade comprovada, e SIGINT/SIGTERM executam a limpeza dos filhos próprios.
// Uso: const own = ownRun(); launchBrowser(exe, { onSpawn: own.onSpawn, onProfile: own.onProfile, onProfileGone: own.onProfileGone }); startStack({ ..., onSpawn: own.onSpawn }); … finally { await own.end(); }
import { Cleanups } from "../lib/cleanup.mjs";
import { RunState, installSignalHandlers } from "../lib/orphans.mjs";

export function ownRun({ exitCode = 3, proc = process } = {}) {
  const cleanups = new Cleanups(); const state = new RunState(); state.begin();
  installSignalHandlers({ cleanups, state, proc, exitCode });
  return {
    cleanups, state,
    onSpawn: (pid, kind, extra) => state.addChild(pid, kind, extra),
    onProfile: (dir) => state.addProfile(dir),
    onProfileGone: (dir) => state.dropProfile(dir),
    /** Fim normal: roda as limpezas registradas e apaga o registro desta execução. */
    end: async () => { try { await cleanups.runAll(); } finally { state.end(); } },
  };
}
