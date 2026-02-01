FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p /data
ENV PORT=3000 DATA_DIR=/data HOST=0.0.0.0
EXPOSE 3000
VOLUME /data
CMD ["node", "index.js"]
