#!/bin/sh
# EC2 (AMI から起動した競技用サーバー) 上で git pull → 反映 → 再起動する
#   初回: sudo su - isucon
#         git clone https://github.com/urzk/isucon12-qualify.git ~/repo
#   以降: ~/repo/deploy/deploy.sh [branch]   (デフォルトは main)
# webapp は Node.js 版 (webapp/docker-compose-node.yml) を systemd の isuports.service で動かす
set -eu
BRANCH=${1:-main}
REPO=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR=/home/isucon

echo "==> git pull ($BRANCH)"
cd "$REPO"
git fetch origin "$BRANCH"
git checkout -q "$BRANCH"
git reset -q --hard "origin/$BRANCH"
git log --oneline -1

echo "==> sync webapp / public"
# tenant_db (SQLite の実データ) と node_modules はサーバー上のものを残す
rsync -a --delete \
  --exclude tenant_db/ --exclude node_modules/ --exclude sql/admin/90_data.sql \
  "$REPO/webapp/" "$HOME_DIR/webapp/"
rsync -a --delete "$REPO/public/" "$HOME_DIR/public/"

echo "==> nginx"
# AMI の nginx 設定はこれらのファイルから作られているので、ここを編集して反映する
sudo install -m 0644 "$REPO/provisioning/mitamae/cookbooks/nginx/nginx.conf" /etc/nginx/nginx.conf
sudo install -m 0644 "$REPO/provisioning/mitamae/cookbooks/nginx/isuports.conf" /etc/nginx/sites-available/isuports.conf
sudo nginx -t
sudo systemctl reload nginx

echo "==> webapp (Node.js)"
# AMI の初期状態は Go 版なので Node.js 版に切り替える (2回目以降は何もしない)
if grep -q 'docker-compose-go.yml' /etc/systemd/system/isuports.service; then
  sudo sed -i 's/docker-compose-go.yml/docker-compose-node.yml/g' /etc/systemd/system/isuports.service
  sudo systemctl daemon-reload
fi
# ExecStart が `docker compose up --build` なので再起動でイメージに src が入り直す
sudo systemctl restart isuports

echo "==> wait for webapp :3000"
i=0
until curl -s -o /dev/null http://127.0.0.1:3000/; do
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then
    echo "webapp did not start; check: sudo journalctl -u isuports -n 100" >&2
    exit 1
  fi
  sleep 2
done
echo "deployed: $(git -C "$REPO" rev-parse --short HEAD)"
