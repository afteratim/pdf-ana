FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV TEMP_DIR=/tmp/pdf-analyzer
ENV MAX_UPLOAD_MB=200
ENV MAX_PAGES=100
ENV MAX_OCR_PAGES=10
ENV OCR_DPI=110

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

RUN mkdir -p /tmp/pdf-analyzer && \
    chown -R node:node /app /tmp/pdf-analyzer

USER node

EXPOSE 10000

CMD ["npm", "start"]