# syntax=docker/dockerfile:1

# --- Builder: install workspace deps and build all packages ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable

# Install dependencies first (better layer caching).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
COPY apps/server/package.json apps/server/
COPY apps/electron/package.json apps/electron/
RUN pnpm install --frozen-lockfile=false

# Build everything (core -> ui -> server via turbo's dependency graph).
COPY . .
RUN pnpm --filter @stout/core --filter @stout/ui --filter @stout/server build

# --- Runner: single app container ---
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Repo + working clone live on the mounted /data volume.
ENV STOUT_DATA_DIR=/data

RUN corepack enable

# `git` is required at runtime: first boot initializes a bare repo + working
# clone, and the git-engine reads the clone. The slim image omits it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# Copy the built workspace wholesale; pnpm's relative symlinks are preserved.
COPY --from=builder /app ./

EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "apps/server/dist/index.js"]
