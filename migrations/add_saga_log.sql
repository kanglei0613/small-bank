-- 在每個 shard DB 執行此 migration
-- small_bank_s0 / small_bank_s1 / small_bank_s2 / small_bank_s3

CREATE TABLE IF NOT EXISTS public.saga_log (
  id               bigserial PRIMARY KEY,
  transfer_id      bigint       NOT NULL,
  step             varchar(20)  NOT NULL,
  from_account_id  bigint       NOT NULL,
  to_account_id    bigint       NOT NULL,
  from_shard_id    int          NOT NULL,
  to_shard_id      int          NOT NULL,
  amount           bigint       NOT NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saga_log_pending
  ON public.saga_log (step, updated_at)
  WHERE step IN ('RESERVED', 'CREDITED');

CREATE UNIQUE INDEX IF NOT EXISTS idx_saga_log_transfer_id
  ON public.saga_log (transfer_id);
