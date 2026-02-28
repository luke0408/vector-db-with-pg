SELECT
  s.schemaname,
  s.relname AS table_name,
  s.indexrelname AS index_name,
  s.idx_scan,
  s.idx_tup_read,
  s.idx_tup_fetch,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size
FROM pg_stat_user_indexes AS s
ORDER BY s.idx_scan DESC, pg_relation_size(s.indexrelid) DESC
LIMIT 50;
