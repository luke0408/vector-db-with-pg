SELECT
  queryid,
  calls,
  round(total_exec_time::numeric, 2) AS total_exec_ms,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  round(stddev_exec_time::numeric, 2) AS stddev_exec_ms,
  rows,
  left(query, 500) AS query
FROM pg_stat_statements
WHERE
  query ILIKE '%<->%'
  OR query ILIKE '%<=>%'
  OR query ILIKE '%hnsw.ef_search%'
  OR query ILIKE '%ivfflat.probes%'
ORDER BY total_exec_time DESC
LIMIT 30;
