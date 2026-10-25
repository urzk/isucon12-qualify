-- 課金計算で (テナント, 大会) ごとに参加者の初回アクセス時刻を引く (カバリングインデックス)
ALTER TABLE `visit_history` ADD INDEX `tenant_competition_player_idx` (`tenant_id`, `competition_id`, `player_id`, `created_at`);
