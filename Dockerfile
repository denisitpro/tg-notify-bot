# syntax=docker/dockerfile:1.6
# Two-stage image for the Kora monitor bot (push-only Telegram notifier).
#   deps  — bun install --frozen-lockfile --production (no dev deps)
#   final — src + prod node_modules, non-root alpine user; Bun runs the TS directly
#
# Fully env-driven — no config files, no required host paths/volumes. State
# persists at /app/data/state.json inside the container by default; it is
# lost on container recreation, which is an accepted tradeoff.
#
# BUN_VERSION must match version.txt (CI and compose pass it):
#   docker build --build-arg BUN_VERSION=$(tr -d '[:space:]' < version.txt) \
#     -t denisitpro/tg-notify-bot:local .

ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION}-alpine AS deps

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------

FROM oven/bun:${BUN_VERSION}-alpine AS final

WORKDIR /app

ENV NODE_ENV=production
# Default persistence path inside the container (override via env if needed).
ENV STATE_FILE=/app/data/state.json

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY src ./src

# The oven/bun base image ships its own `bun` user; we keep appuser (uid/gid 1005)
# for compatibility with existing deployments.
RUN mkdir -p /app/data && \
    addgroup -g 1005 -S appuser && \
    adduser -u 1005 -G appuser -h /app -S -D appuser && \
    chown -R appuser:appuser /app

USER appuser

CMD ["bun", "src/index.ts"]
