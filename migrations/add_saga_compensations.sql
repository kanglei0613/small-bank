-- 在每個 shard DB 執行
-- 記錄跨 shard 轉帳的補償記錄，用於 recovery worker 的冪等判斷

CREATE TABLE IF NOT EXISTS public.saga_compensations (
  id          bigserial PRIMARY KEY,
  transfer_id bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saga_compensations_transfer_id
  ON public.saga_compensations (transfer_id);
