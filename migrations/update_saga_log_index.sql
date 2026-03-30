-- 更新 partial index，加入 COMPENSATING 狀態
-- 在每個 shard DB 執行

DROP INDEX IF EXISTS idx_saga_log_pending;

CREATE INDEX idx_saga_log_pending
  ON public.saga_log (step, updated_at)
  WHERE step IN ('RESERVED', 'CREDITED', 'COMPENSATING');
  