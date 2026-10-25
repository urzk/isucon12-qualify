#!/bin/sh
# Docker を使わずローカル(macOS)で webapp(Go) / blackauth / nginx を起動・停止する
#   ./local/run.sh start | stop | status
# MySQL は Homebrew の mysql (127.0.0.1:3306) が起動済みである前提
# webapp は 3000 番が他で使われがちなので 3100 番で起動する
set -e
cd "$(dirname "$0")"
LOCAL_DIR=$(pwd)
ROOT=$(cd .. && pwd)
WEBAPP_PORT=${SERVER_APP_PORT:-3100}

mkdir -p log run

start() {
  (cd "$ROOT/blackauth" && nohup go run main.go > "$LOCAL_DIR/log/blackauth.log" 2>&1 & echo $! > "$LOCAL_DIR/run/blackauth.pid")

  (cd "$ROOT/webapp/go" && go build -o "$LOCAL_DIR/run/isuports" ./cmd/isuports)
  (cd "$ROOT/webapp/go" && \
    SERVER_APP_PORT=$WEBAPP_PORT \
    ISUCON_DB_HOST=127.0.0.1 ISUCON_DB_PORT=3306 \
    ISUCON_DB_USER=isucon ISUCON_DB_PASSWORD=isucon ISUCON_DB_NAME=isuports \
    nohup "$LOCAL_DIR/run/isuports" > "$LOCAL_DIR/log/webapp.log" 2>&1 & echo $! > "$LOCAL_DIR/run/webapp.pid")

  nginx -p "$LOCAL_DIR/" -c nginx.conf
  echo "started: https://admin.t.isucon.dev/ (webapp :$WEBAPP_PORT, blackauth :3001, nginx :443)"
}

stop() {
  [ -f run/nginx.pid ] && nginx -p "$LOCAL_DIR/" -c nginx.conf -s quit || true
  for name in webapp blackauth; do
    if [ -f "run/$name.pid" ]; then
      # go run は子プロセスでバイナリを実行するので子も止める
      pid=$(cat "run/$name.pid")
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
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
