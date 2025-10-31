# Basic Dockerfile for Stamp-die-kaart MVP
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package files first for better layer caching
COPY package.json package-lock.json* ./

# Install production deps only
RUN npm install --only=production

# Copy rest of the app
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]
