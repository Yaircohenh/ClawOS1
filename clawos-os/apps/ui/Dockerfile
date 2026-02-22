FROM node:20-alpine
WORKDIR /app

# Install server deps
COPY package.json package-lock.json* ./
RUN npm ci || npm i

# Install client deps and build the React SPA
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm ci || npm i
COPY client ./client
RUN cd client && npm run build

# Copy server source
COPY src ./src

EXPOSE 18887
CMD ["node", "src/index.js"]
