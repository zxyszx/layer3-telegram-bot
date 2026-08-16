FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser

ENV DATA_DIR=/app/data
CMD ["npm", "start"]
