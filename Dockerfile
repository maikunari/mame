# Mame — Minimal Persistent Agent
# Uses bookworm-slim for glibc (better-sqlite3) and Chrome deps (agent-browser)

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ src/
RUN npm run build

# --- Production image ---
FROM node:22-bookworm-slim

# Install Chrome dependencies for agent-browser + curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser globally
RUN npm install -g agent-browser && agent-browser install

# Create non-root user
RUN groupadd -r mame && useradd -r -g mame -m -d /home/mame mame

WORKDIR /app

# Copy built app and production dependencies
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY package.json ecosystem.config.cjs ./
COPY soul-template.md heartbeat-template.md ./

# Create MAME_HOME directory structure
RUN mkdir -p /home/mame/.mame/personas \
             /home/mame/.mame/browsers \
             /home/mame/.mame/reports \
             /home/mame/.mame/logs \
             /home/mame/.mame/.vault \
    && chown -R mame:mame /home/mame/.mame /app

# Set environment
ENV MAME_HOME=/home/mame/.mame
ENV AGENT_BROWSER_ARGS="--no-sandbox"
ENV NODE_ENV=production

USER mame

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3847/health || exit 1

# Default persona can be overridden via MAME_PERSONA env var
CMD node dist/index.js --persona ${MAME_PERSONA:-default}
