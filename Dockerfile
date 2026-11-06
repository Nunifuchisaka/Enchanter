FROM node:22-alpine

WORKDIR /app
COPY index.html server.js package.json ./
COPY js ./js
COPY css ./css

ENV DATA_DIR=/data
# コンテナ内部では0.0.0.0で待ち受ける(外部への公開範囲はcompose.yamlのポート指定で制御する)
ENV HOST=0.0.0.0
EXPOSE 8787

CMD ["node", "server.js"]
