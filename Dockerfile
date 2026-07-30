FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist
# Migrations and skills are runtime assets, not build output — they must be copied explicitly
# or the container starts against an unmigrated database with no skill surface.
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY --from=build /app/.claude ./.claude
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

CMD ["node", "dist/index.js"]
