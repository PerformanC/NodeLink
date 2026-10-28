# Stage 1: Builder - Build TypeScript into JavaScript
FROM node:26.12.1-alpine AS builder

# Install git (required for npm to install dependencies from GitHub)
RUN apk add --no-cache git

WORKDIR /app

# Copy package manifests and TypeScript configuration
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies like typescript)
RUN npm install

# Copy source code and files needed for compilation
COPY src/ ./src/
COPY plugins/ ./plugins/
COPY scripts/ ./scripts/
COPY config.default.ts ./config.default.ts

# Compile TypeScript into JavaScript (produces dist/)
RUN npm run build

# Prune devDependencies to keep only production packages
RUN npm prune --omit=dev

# Stage 2: Runner - Copy compiled code and run
FROM node:26.12.1-alpine

# Build arguments for git and build metadata
ARG GIT_COMMIT=""
ARG GIT_BRANCH=""
ARG BUILD_TIME=""

WORKDIR /app

# Copy production dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist/config.default.js ./config.default.js

# Copy package manifests and fallback config
COPY package*.json ./
COPY config.default.ts ./config.default.ts

# Expose the port the application listens on (default is 3000 from config.default.ts)
EXPOSE 3000

# Set environment variables for production runtime and build metadata
ENV NODE_ENV=production \
    NODELINK_SERVER_PORT=3000 \
    NODELINK_SERVER_HOST=0.0.0.0 \
    NODELINK_CLUSTER_ENABLED=true \
    GIT_COMMIT=${GIT_COMMIT} \
    GIT_BRANCH=${GIT_BRANCH} \
    BUILD_TIME=${BUILD_TIME}

LABEL org.opencontainers.image.title="NodeLink" \
      org.opencontainers.image.source="https://github.com/PerformanC/NodeLink" \
      org.opencontainers.image.revision="${GIT_COMMIT}"

# Run compiled JavaScript in production
CMD ["npm", "run", "start:dist"]
