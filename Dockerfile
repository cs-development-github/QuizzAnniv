FROM node:20-alpine AS base

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000

FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS runner

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY data ./data

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const http=require('http');const port=process.env.PORT||4000;const req=http.get(`http://127.0.0.1:${port}/health`,res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));"

USER node

CMD ["node", "src/server.js"]
