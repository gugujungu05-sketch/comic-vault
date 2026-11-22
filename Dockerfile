FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# 平台会注入 PORT；CV_DATA_DIR 指向挂载卷，保证重启后数据不丢
ENV NODE_ENV=production
ENV CV_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787

CMD ["npm", "start"]
