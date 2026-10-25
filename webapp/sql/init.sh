#!/bin/sh

set -ex
cd `dirname $0`

ISUCON_DB_HOST=${ISUCON_DB_HOST:-127.0.0.1}
ISUCON_DB_PORT=${ISUCON_DB_PORT:-3306}
ISUCON_DB_USER=${ISUCON_DB_USER:-isucon}
ISUCON_DB_PASSWORD=${ISUCON_DB_PASSWORD:-isucon}
ISUCON_DB_NAME=${ISUCON_DB_NAME:-isuports}

mysql_exec() {
	mysql -u"$ISUCON_DB_USER" \
		-p"$ISUCON_DB_PASSWORD" \
		--host "$ISUCON_DB_HOST" \
		--port "$ISUCON_DB_PORT" \
		"$ISUCON_DB_NAME" "$@"
}

# MySQLを初期化
mysql_exec < init.sql

# visit_history のインデックスが無ければ貼る (初回のみ時間がかかる)
if [ "$(mysql_exec -N -e "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'visit_history' AND index_name = 'tenant_competition_player_idx'")" = "0" ]; then
	mysql_exec < admin/20_index.sql
fi

# インデックスを貼った初期テナントDBを template/ に用意しておく
# (初期データへのインデックス作成は時間がかかるので、初回か 20_index.sql の更新時のみ行う)
TEMPLATE_DIR=../tenant_db/template
if [ ! -f "$TEMPLATE_DIR/.ready" ] || [ tenant/20_index.sql -nt "$TEMPLATE_DIR/.ready" ]; then
	rm -rf "$TEMPLATE_DIR"
	mkdir -p "$TEMPLATE_DIR"
	for db in ../../initial_data/*.db; do
		cp "$db" "$TEMPLATE_DIR/"
		sqlite3 "$TEMPLATE_DIR/$(basename "$db")" < tenant/20_index.sql > /dev/null
	done
	touch "$TEMPLATE_DIR/.ready"
fi

# SQLiteのデータベースを初期化
rm -f ../tenant_db/*.db ../tenant_db/*.db-wal ../tenant_db/*.db-shm
cp "$TEMPLATE_DIR"/*.db ../tenant_db/
