-- Migration: add_balance_invariant
-- 在每個 shard DB 執行
-- small_bank_s0 / small_bank_s1 / small_bank_s2 / small_bank_s3
--
-- 目的：
--   在 DB 層強制 balance = available_balance + reserved_balance 不變量
--   防止程式碼 bug 讓三個欄位靜默不一致
--
-- 執行前：
--   先確認目前資料是否已經一致，不一致的話 ALTER TABLE 會直接報錯
--   檢查指令：
--   SELECT id, balance, available_balance, reserved_balance
--   FROM accounts
--   WHERE balance != available_balance + reserved_balance;
--
-- 若有不一致的資料，先修正再執行此 migration。

ALTER TABLE public.accounts
  ADD CONSTRAINT chk_balance_invariant
  CHECK (balance = available_balance + reserved_balance);