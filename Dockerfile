# Placeholder Dockerfile for CI build check
# Will be replaced with actual multi-stage build in Phase 1

FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist

ENTRYPOINT ["node", "dist/bin/bscs.js"]
