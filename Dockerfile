FROM node:20-slim

# Install LibreOffice and dependencies (runs as root in Docker)
RUN apt-get update && \
    apt-get install -y \
      libreoffice \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-impress \
      fonts-liberation \
      fontconfig \
      --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
