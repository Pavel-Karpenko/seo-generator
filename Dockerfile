# ---- Builder stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package*.json ./
COPY tsconfig*.json ./
COPY nest-cli.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci --ignore-scripts

# Copy application source
COPY src/ ./src/

# Build the NestJS application
RUN npm run build

# Prune devDependencies for a leaner production install
RUN npm prune --omit=dev

# ---- Production stage ----
FROM node:20-alpine AS production

# Install wget for health checks
RUN apk add --no-cache wget dumb-init

# Create a non-root application user
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup --no-create-home appuser

WORKDIR /app

# Copy only what is needed for production
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

# Drop privileges
USER appuser

EXPOSE 3000

# dumb-init ensures proper signal propagation and zombie reaping
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
