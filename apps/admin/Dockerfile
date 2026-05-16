# syntax=docker/dockerfile:1.7
#
# Vibe Shield admin UI. React 18 + Vite static build, served by nginx.
# Multi-stage to keep the runtime image tiny (~50 MB).
# v1.1.4 — appliance integration.

ARG NODE_VERSION=24-bookworm-slim
ARG NGINX_VERSION=1.27-alpine

# ---- Stage 1: builder — install workspace deps + build the SPA ----
FROM node:${NODE_VERSION} AS builder

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/admin/package.json ./apps/admin/
RUN pnpm install --frozen-lockfile

COPY apps/admin/ ./apps/admin/
# Re-run install so per-package .bin symlinks resolve. Same pattern
# the gateway Dockerfile uses; pnpm hoisting in Docker doesn't always
# create the bin links when --filter is used.
RUN pnpm install --frozen-lockfile
RUN cd apps/admin && pnpm exec tsc -b && pnpm exec vite build

# ---- Stage 2: runtime — nginx serving the built assets -----------
FROM nginx:${NGINX_VERSION} AS runtime

# Drop nginx's default config; we serve a single SPA + a fall-through
# to /index.html for client-side routing.
RUN rm /etc/nginx/conf.d/default.conf
COPY <<'EOF' /etc/nginx/conf.d/admin.conf
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  # Long cache on hashed assets (Vite emits /assets/*.[hash].*).
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  # SPA fall-through — every other path serves index.html.
  location / {
    try_files $uri $uri/ /index.html;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
  }

  # Caddy in front handles TLS; nginx logs to stdout for docker logs.
  access_log /dev/stdout;
  error_log /dev/stderr warn;
}
EOF

COPY --from=builder /build/apps/admin/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --spider --quiet http://127.0.0.1/ || exit 1
