# PDF Presenter - Docker Container
# Multi-stage build for smaller image size

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies (only production)
RUN npm ci --only=production

# Production stage
FROM node:20-alpine AS production

# Create app directory
WORKDIR /app

# Create uploads directory with proper permissions
RUN mkdir -p /app/uploads && chown -R node:node /app

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy app source
COPY --chown=node:node . .

# Switch to non-root user for security
USER node

# Expose the application port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Start the application
CMD ["node", "server.js"]
