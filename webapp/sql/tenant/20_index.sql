-- ランキング・課金計算で大会ごと(参加者ごと)のスコアを引く
CREATE INDEX IF NOT EXISTS player_score_competition_player_idx ON player_score (tenant_id, competition_id, player_id, row_num);
-- 参加者詳細で参加者ごとのスコアを引く
CREATE INDEX IF NOT EXISTS player_score_player_idx ON player_score (tenant_id, player_id);
-- 読み込みと書き込みを並行させるため WAL にする (DB ファイルに永続化される)
PRAGMA journal_mode = WAL;
