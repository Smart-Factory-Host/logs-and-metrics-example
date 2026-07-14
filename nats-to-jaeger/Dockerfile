FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.mjs ./

CMD ["node", "/app/index.mjs"]