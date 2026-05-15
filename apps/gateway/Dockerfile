# syntax=docker/dockerfile:1.7
#
# Vibe Shield gateway. Node.js 24 + Express 5 + Pino + Anthropic SDK.
# Multi-stage to keep the runtime image lean. v1.0.1.
#
# Migrations are NOT run at boot; deploy a one-shot job using the same
# image with command `node packages/schema/dist/scripts/migrate.js`
# before starting the gateway. (BUILD_PLAN §1.4 separate-migrate pattern.)

ARG NODE_VERSION=24-bookworm-slim

# ---- Stage 1: builder — install workspace deps + compile TS ----
FROM node:${NODE_VERSION} AS builder

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /build
# Copy the workspace manifests first to maximize layer cache hits.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/gateway/package.json ./apps/gateway/
COPY packages/schema/package.json ./packages/schema/
COPY packages/client/package.json ./packages/client/
# Full install incl. devDependencies. pnpm symlinks each package's
# node_modules so per-package scripts find their tools.
RUN pnpm install --frozen-lockfile

# Bring in source and build the workspaces the gateway depends on.
COPY packages/schema/ ./packages/schema/
COPY apps/gateway/ ./apps/gateway/
# Re-run install after source copy so workspace deps wire up properly.
RUN pnpm install --frozen-lockfile
RUN cd packages/schema && pnpm exec tsc -p tsconfig.json
RUN cd apps/gateway && pnpm exec tsc -p tsconfig.json

# Prune dev deps for the runtime image.
RUN pnpm --filter @kisaesdevlab/vibe-shield-gateway --prod deploy /pruned

# ---- Stage 2: runtime ----
FROM node:${NODE_VERSION} AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

# Drop root.
RUN groupadd --system vibe \
 && useradd --system --gid vibe --home /app --shell /usr/sbin/nologin vibe

WORKDIR /app
COPY --from=builder --chown=vibe:vibe /pruned/ ./
USER vibe

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Single Node process. Memory budget on NucBox M6: gateway ≤ 512 MB
# (BUILD_PLAN §19). Scale horizontally with replicas if needed.
CMD ["node", "dist/index.js"]
