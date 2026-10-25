# bullseye はサポートが終了し security リポジトリのパッケージが取得できなくなったので bookworm を使う
FROM node:18.20.8-bookworm

WORKDIR /tmp
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
  apt-get install -y wget gcc g++ make sqlite3 libsqlite3-dev default-mysql-client

RUN useradd --uid=1001 --create-home isucon
USER isucon

RUN mkdir -p /home/isucon/webapp/node
WORKDIR /home/isucon/webapp/node
COPY --chown=isucon:isucon ./ /home/isucon/webapp/node/

CMD [ "bash", "-c", "npm install && npm run serve" ]
