#!/bin/sh
# Docker を使わずローカル(macOS)で webapp(Node.js) / blackauth / nginx を起動・停止する
#   ./local/run.sh start | stop | status
# MySQL は Homebrew の mysql (127.0.0.1:3306) が起動済みである前提
# webapp は 3000 番が他で使われがちなので 3100 番で起動する
# Node.js は webapp/node/.nvmrc のメジャー版を ~/.nvm から探して使う (本番 Docker イメージは node 18)
set -e
cd "$(dirname "$0")"
LOCAL_DIR=$(pwd)
ROOT=$(cd .. && pwd)
WEBAPP_PORT=${SERVER_APP_PORT:-3100}

mkdir -p log run

start() {
  (cd "$ROOT/blackauth" && go build -o "$LOCAL_DIR/run/blackauth" .)
  (cd "$ROOT/blackauth"; nohup "$LOCAL_DIR/run/blackauth" > "$LOCAL_DIR/log/blackauth.log" 2>&1 & echo $! > "$LOCAL_DIR/run/blackauth.pid")

  (
    cd "$ROOT/webapp/node"
    NODE_BIN=$(ls -d "$HOME/.nvm/versions/node/v$(cat .nvmrc)."*/bin 2>/dev/null | sort -V | tail -1)
    PATH="${NODE_BIN:+$NODE_BIN:}$PATH"
    # fs-ext 等の古い node-gyp は distutils が必要なので Python 3.11 でビルドする
    [ -d node_modules ] || npm_config_python=${NODE_GYP_PYTHON:-/opt/homebrew/bin/python3.11} npm ci
    SERVER_APP_PORT=$WEBAPP_PORT \
    ISUCON_DB_HOST=127.0.0.1 ISUCON_DB_PORT=3306 \
    ISUCON_DB_USER=isucon ISUCON_DB_PASSWORD=isucon ISUCON_DB_NAME=isuports \
    nohup node_modules/.bin/ts-node --transpile-only src/main.ts > "$LOCAL_DIR/log/webapp.log" 2>&1 &
    echo $! > "$LOCAL_DIR/run/webapp.pid"
  )

  nginx -p "$LOCAL_DIR/" -c nginx.conf
  echo "started: https://admin.t.isucon.dev/ (webapp :$WEBAPP_PORT, blackauth :3001, nginx :443)"
}

stop() {
  [ -f run/nginx.pid ] && nginx -p "$LOCAL_DIR/" -c nginx.conf -s quit || true
  for name in webapp blackauth; do
    if [ -f "run/$name.pid" ]; then
      kill "$(cat "run/$name.pid")" 2>/dev/null || true
      rm -f "run/$name.pid"
    fi
  done
  echo "stopped"
}

status() {
  lsof -nP -iTCP -sTCP:LISTEN | grep -E ":($WEBAPP_PORT|3001|443) " || echo "nothing listening"
}

case "$1" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status"; exit 1 ;;
esac
