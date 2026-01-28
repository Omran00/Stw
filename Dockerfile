# Use a slim Node.js image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application source code
COPY . .

# Ensure storage files exist and are writable
RUN touch stwdo-last.json stwdo-meta.json && chmod 666 stwdo-last.json stwdo-meta.json

# Expose the health check port
EXPOSE 8000

# Start the application
CMD ["npm", "start"]
