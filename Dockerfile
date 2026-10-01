# syntax=docker/dockerfile:1.6
# Two-stage image for the Kora monitor bot (push-only Telegram notifier).
#   builder — npm ci, tsc -> dist/, prune dev deps
#   final   — dist + prod node_modules, non-root alpine user
#
# Fully env-driven — no config files, no required host paths/volumes. State
# persists at /app/data/state.json inside the container by default; it is
# lost on container recreation, which is an accepted tradeoff.

FROM node:26.3.1-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------------------

FROM node:26.3.1-alpine AS final

WORKDIR /app

ENV NODE_ENV=production
# Default persistence path inside the container (override via env if needed).
ENV STATE_FILE=/app/data/state.json

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /app/data && \
    addgroup -g 1005 -S appuser && \
    adduser -u 1005 -G appuser -h /app -S -D appuser && \
    chown -R appuser:appuser /app

USER appuser

CMD ["node", "dist/index.js"]
