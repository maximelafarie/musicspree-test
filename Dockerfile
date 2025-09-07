# Multi-stage build for production
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY rolldown.config.js ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

# Install runtime dependencies
RUN apk add --no-cache \
    bash \
    curl \
    findutils \
    coreutils \
    beets \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production --ignore-scripts \
    && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist/ ./dist/

# Copy CLI script
COPY bin/spree ./bin/spree

# Create non-root user with proper permissions
RUN addgroup -g 1001 -S musicspree && \
    adduser -S musicspree -u 1001 -G musicspree && \
    mkdir -p /app/data /downloads /music && \
    chown -R musicspree:musicspree /app /downloads /music && \
    chmod +x /app/bin/spree

# Create symlink for global access
RUN ln -sf /app/bin/spree /usr/local/bin/spree

# Switch to non-root user
USER musicspree

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node /app/dist/cli.js test || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV PATH="/app/bin:$PATH"

# Expose port (if web interface is added later)
EXPOSE 3000

# Create volume mount points
VOLUME ["/app/data", "/downloads", "/music"]

# Default command
CMD ["node", "/app/dist/index.js"]

# Labels for better container management
LABEL org.opencontainers.image.title="MusicSpree" \
    org.opencontainers.image.description="Automated music recommendation fetcher and playlist manager" \
    org.opencontainers.image.version="1.0.0" \
    org.opencontainers.image.source="https://github.com/votre-username/musicspree" \
    maintainer="musicspree@example.com"