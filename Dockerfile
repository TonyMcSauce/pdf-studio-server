FROM node:20-bookworm

RUN apt-get update && \
    apt-get install -y \
      libreoffice \
      libreoffice-java-common \
      default-jre-headless \
      libreoffice-pdfimport \
      fonts-liberation \
      fonts-dejavu \
      fontconfig \
      --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/appuser/.config /home/appuser/.local && chmod -R 777 /home/appuser
ENV HOME=/home/appuser

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
