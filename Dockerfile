FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=4010 \
    HOST=0.0.0.0 \
    DATA_FILE=/data/db.json
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 4010
USER node
CMD ["node", "src/index.js"]
