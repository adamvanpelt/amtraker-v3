# Dockerfile
FROM oven/bun:1.1
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
# Default is API; override CMD in the cron service
CMD ["bun","run","index.ts"]
