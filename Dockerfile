FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY src/ src/
RUN mkdir -p /app/data
VOLUME ["/app/data"]
CMD ["node", "src/bot.js"]
