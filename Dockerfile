# Stage 1: Builder - Install dependencies
FROM node:25-alpine AS builder

# Install git (required for npm to install dependencies from GitHub)
RUN apk add --no-cache git

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if available) to leverage Docker cache
# Use wildcards to ensure both package.json and package-lock.json (or yarn.lock/pnpm-lock.yaml) are copied
COPY package.json ./

# Install production dependencies
# This command automatically handles package-lock.json if it exists, otherwise it creates one.
# For Bun, you might use 'bun install --production'.
RUN npm install

# Stage 2: Runner - Copy application code and run
FROM node:25-alpine

# Set working directory
WORKDIR /app

# Copy production dependencies from the builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy the rest of the application source code
# This includes the 'src' directory, default config, and package files for runtime information.
COPY src/ ./src/
COPY config.default.ts ./config.default.ts
COPY package.json ./package.json

# Expose the port the application listens on (default is 3000 from config.default.js)
EXPOSE 3000

# Set environment variables for configuration
# These can be overridden via docker-compose.yml or 'docker run -e'
# Example: NODELINK_SERVER_PASSWORD=your_secure_password
ENV NODELINK_SERVER_PORT=3000 \
    NODELINK_SERVER_HOST=0.0.0.0 \
    NODELINK_CLUSTER_ENABLED=true

# Command to run the application
# It uses the 'start' script defined in package.json
CMD ["npm", "start"]
