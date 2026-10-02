# Kevbot — production image for an always-on host (Oracle Always Free VM).
#
# Two stages so the runtime image carries no TypeScript toolchain: the build
# stage compiles, the runtime stage installs production deps only.
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Re-resolve to production-only deps for the runtime stage.
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

# dumb-init reaps zombies and, critically, forwards SIGTERM to node so
# systemd's stop/restart shuts the gateway down cleanly instead of killing it.
RUN apk add --no-cache dumb-init

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# counter.json is the only tracked file in data/; the list files are
# gitignored on purpose and are mounted in at runtime.
COPY data ./data

# Run unprivileged. The node image already provides this user.
USER node

# data/ is a volume so the counter, whitelist, and blacklist survive a
# container rebuild.
VOLUME ["/app/data"]
VOLUME ["/app/logs"]

CMD ["dumb-init", "node", "dist/index.js"]
