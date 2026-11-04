# NexusHarness dashboard for a homelab.
#   docker build -f deploy/Dockerfile -t nexusharness .
#   docker compose -f deploy/docker-compose.yml up -d
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NEXUS_HOME=/data
# git is what agents most often shell out to; add whatever else your projects need.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /workspace && chown -R node:node /data /workspace
WORKDIR /app
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY web ./web
COPY package.json ./
USER node
VOLUME ["/data", "/workspace"]
EXPOSE 7437
# The agent's own browser needs Chromium; it is intentionally not baked in (large). To enable it:
#   RUN npx playwright-core install --with-deps chromium    (as root, before USER node)
# and set browser.channel to "chromium" in the config.
ENTRYPOINT ["node", "dist/cli.js", "serve", "--host", "0.0.0.0", "--root", "/workspace"]
