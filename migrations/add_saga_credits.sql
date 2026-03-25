-- 在每個 shard DB 執行
-- 記錄跨 shard 轉帳 Step 2 (credit toAccount) 是否完成
-- 與 toAccount 的入帳在同一個 transaction 寫入，確保原子性
-- recovery worker 查此表判斷 RESERVED 狀態下 toAccount 是否已入帳

CREATE TABLE IF NOT EXISTS public.saga_credits (
  id          bigserial PRIMARY KEY,
  transfer_id bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saga_credits_transfer_id
  ON public.saga_credits (transfer_id);
