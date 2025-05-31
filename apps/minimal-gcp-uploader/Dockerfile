FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY uploader.js .

CMD ["npm", "start"] 