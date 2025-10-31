# Use official Node.js LTS image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm install --only=production

# Copy application files
COPY server/ ./server/
COPY public/ ./public/

# Set environment to production
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server/index.js"]

# Build instructions:
# docker build -t stamp-die-kaart .
# 
# Run instructions:
# docker run -p 3000:3000 -e API_KEY=demo-key-123 stamp-die-kaart
#
# With custom API keys:
# docker run -p 3000:3000 -e API_KEYS=key1,key2,key3 stamp-die-kaart
