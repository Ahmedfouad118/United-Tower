# United Tower ERP — production image
# node:sqlite requires Node >= 22
FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# database lives on a mounted volume so data survives redeploys
# (the volume itself is attached by the host platform, e.g. `railway volume add -m /data`)
ENV UT_DB=/data/app.db
ENV PORT=4000

EXPOSE 4000

# seed runs once if the DB is empty, then start
CMD ["sh", "-c", "node db/seed.js || true; node server.js"]
