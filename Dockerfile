FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
RUN mkdir -p /app/db/uploads
EXPOSE 3000
ENV NODE_ENV=production PORT=3000
CMD ["node", "server.js"]
