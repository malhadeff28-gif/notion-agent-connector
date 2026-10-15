FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
COPY public ./public
RUN mkdir /app/data && chown -R node:node /app
USER node
ENV BIND_HOST=0.0.0.0 PORT=3100 DATABASE_PATH=/app/data/connector.sqlite
EXPOSE 3100
CMD ["node", "src/index.js"]
