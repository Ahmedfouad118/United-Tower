# United Tower ERP — production image
# node:sqlite requires Node >= 22
FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# database lives on the mounted volume (/data) so data survives redeploys
ENV UT_DB=/data/ut-v3.db
ENV PORT=4000
ENV NODE_ENV=production

EXPOSE 4000

# seed runs once if the DB is empty, then start
CMD ["sh", "-c", "node db/seed.js || true; node server.js"]
