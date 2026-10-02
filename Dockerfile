# Imagem de staging/produção da Levora Solidária — backend compilado.
#
# Reproduz exatamente o caminho já validado nas Fases 58/59: build fora
# do runtime final, `npm ci --omit=dev` real (sem devDependencies), e
# `node dist-server/server/index.js` direto como entrypoint (nunca
# `npm start`, que não repassa SIGTERM de forma confiável — achado real
# da Fase 59).
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:server

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist-server ./dist-server
COPY db ./db
RUN groupadd -r levora && useradd -r -g levora -d /app -s /usr/sbin/nologin levora \
  && mkdir -p /app/storage/uploads \
  && chown -R levora:levora /app
USER levora
EXPOSE 3001
CMD ["node", "dist-server/server/index.js"]
