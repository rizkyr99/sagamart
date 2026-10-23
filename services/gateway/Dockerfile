# Build context is the repository root (the service depends on workspace packages):
#   docker build -f services/gateway/Dockerfile .
FROM node:24.11.1-bookworm-slim AS build
RUN npm install -g pnpm@10.34.7
WORKDIR /src

# Manifests first, so dependency installs are cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/node-common/package.json packages/node-common/
# Test support is a dev dependency, but pnpm resolves every workspace link when installing and deploying.
COPY packages/contract-testing/package.json packages/contract-testing/
COPY contracts/gen/ts/package.json contracts/gen/ts/
COPY services/gateway/package.json services/gateway/
RUN pnpm install --frozen-lockfile --filter "@sagamart/gateway..."

COPY packages/node-common packages/node-common
COPY packages/contract-testing packages/contract-testing
COPY contracts/gen/ts contracts/gen/ts
COPY services/gateway services/gateway
RUN pnpm --filter "@sagamart/gateway..." build \
 && pnpm --filter @sagamart/gateway deploy --legacy --prod /out

FROM node:24.11.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8100
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.GATEWAY_HTTP_PORT || 8100) + '/readyz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "./dist/instrument.js", "dist/main.js"]
