// Vite de desenvolvimento para a verificação visual: a mesma configuração do projeto, com proxy da API para a porta de QA.
import { defineConfig, mergeConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import base from "../../vite.config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export default mergeConfig(base, defineConfig({ root, server: { proxy: { "/_api": { target: `http://127.0.0.1:${process.env.QA_API_PORT}`, changeOrigin: true } } } }));
