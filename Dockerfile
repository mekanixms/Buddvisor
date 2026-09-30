FROM node:18-slim

WORKDIR /app

# python3 is required by the `terminal` agent tool (PTY bridge)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application source (secrets like .env are excluded via .dockerignore)
COPY . .

EXPOSE 3000

# Run migrations then start the server
CMD ["sh", "-c", "npm run migrate && npm start"]

