FROM node:22-alpine

WORKDIR /app
COPY index.html style.css app.js server.js package.json ./

ENV DATA_DIR=/data
EXPOSE 8787

CMD ["node", "server.js"]
