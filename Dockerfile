FROM node:20-alpine

# Install bash for CLI commands
RUN apk add --no-cache bash curl

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY rolldown.config.js ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY bin/ ./bin/

# Build the application
RUN npm run build

# Create non-root user
RUN addgroup -g 1001 -S musicspree && \
    adduser -S musicspree -u 1001 -G musicspree

# Create data directory
RUN mkdir -p /app/data && chown -R musicspree:musicspree /app

USER musicspree

# Make CLI commands executable
RUN chmod +x /app/bin/spree

# Add bin to PATH
ENV PATH="/app/bin:$PATH"

EXPOSE 3000

CMD ["npm", "start"]