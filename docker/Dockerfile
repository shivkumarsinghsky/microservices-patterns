# Builds the TypeScript reference implementations and runs the pattern demos.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY examples ./examples
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# No runtime dependencies: only the compiled output is needed.
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
CMD ["node", "dist/examples/checkout-saga.js"]
