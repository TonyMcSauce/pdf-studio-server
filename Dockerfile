FROM node:20-bookworm

# Install Python and pdf2docx for PDF→DOCX conversion
RUN apt-get update && \
    apt-get install -y \
      python3 \
      python3-pip \
      python3-dev \
      build-essential \
      libmupdf-dev \
      fonts-liberation \
      fonts-dejavu \
      fontconfig \
      --no-install-recommends && \
    pip3 install --break-system-packages pdf2docx pdfplumber openpyxl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .
COPY convert.py .

EXPOSE 3000

CMD ["node", "server.js"]
