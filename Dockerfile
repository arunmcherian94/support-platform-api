# One image serves both services; compose overrides the command for the mocks.
# Pinned to a specific patch release (Node 26, matching .nvmrc).
FROM node:26.13.0-slim

# Development mode on purpose: the dev token issuer must be allowed. Production refuses it.
ENV NODE_ENV=development
WORKDIR /app

COPY package.json package-lock.json ./
# Install scripts stay blocked; no dependency needs one.
RUN npm ci

COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8080 8081
CMD ["node_modules/.bin/tsx", "src/server.ts"]
