FROM node:18-slim

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application source (secrets like .env are excluded via .dockerignore)
COPY . .

EXPOSE 3000

# Run migrations then start the server
CMD ["sh", "-c", "npm run migrate && npm start"]

