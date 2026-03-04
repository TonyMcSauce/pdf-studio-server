FROM node:20-slim

RUN apt-get update && \
    apt-get install -y \
      libreoffice \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-impress \
      libreoffice-pdfimport \
      fonts-liberation \
      fontconfig \
      --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/appuser && chmod 777 /home/appuser
RUN mkdir -p /tmp && chmod 777 /tmp
ENV HOME=/home/appuser

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
