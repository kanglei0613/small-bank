-- schema_shard.sql
-- 每個 shard DB 的完整建表 schema
-- 適用：small_bank_s0 / small_bank_s1 / small_bank_s2 / small_bank_s3
--
-- 使用方式：
--   psql -d small_bank_s0 -f schema_shard.sql
--   psql -d small_bank_s1 -f schema_shard.sql
--   psql -d small_bank_s2 -f schema_shard.sql
--   psql -d small_bank_s3 -f schema_shard.sql

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';
SET default_table_access_method = heap;


-- ============================================================
-- accounts
-- ============================================================
--
-- 三欄設計：
--   balance           = available_balance + reserved_balance（由 chk_balance_invariant 強制）
--   available_balance = 可用餘額，轉帳時扣這裡
--   reserved_balance  = 跨 shard 轉帳凍結中的金額
--

CREATE TABLE public.accounts (
    id                bigint                      NOT NULL,
    user_id           bigint      DEFAULT 0       NOT NULL,
    balance           bigint      DEFAULT 0       NOT NULL,
    available_balance bigint      DEFAULT 0       NOT NULL,
    reserved_balance  bigint      DEFAULT 0       NOT NULL,
    created_at        timestamptz DEFAULT now()   NOT NULL,
    updated_at        timestamptz DEFAULT now()   NOT NULL,
    CONSTRAINT accounts_pkey PRIMARY KEY (id),
    CONSTRAINT chk_balance_invariant
        CHECK (balance = available_balance + reserved_balance)
);

CREATE INDEX accounts_user_id_idx ON public.accounts USING btree (user_id);


-- ============================================================
-- transfers
-- ============================================================
--
-- status 生命週期：
--   same-shard:  直接 COMPLETED
--   cross-shard: RESERVED → PENDING_FINALIZE | COMPLETED | FAILED
--

CREATE SEQUENCE public.transfers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.transfers (
    id              bigint                                          NOT NULL DEFAULT nextval('public.transfers_id_seq'),
    from_account_id bigint                                         NOT NULL,
    to_account_id   bigint                                         NOT NULL,
    amount          bigint                                         NOT NULL,
    status          character varying(20) DEFAULT 'COMPLETED'      NOT NULL,
    created_at      timestamptz           DEFAULT now()            NOT NULL,
    updated_at      timestamptz           DEFAULT now()            NOT NULL,
    CONSTRAINT transfers_pkey PRIMARY KEY (id)
);

ALTER SEQUENCE public.transfers_id_seq OWNED BY public.transfers.id;

CREATE INDEX idx_transfers_from_account_id ON public.transfers USING btree (from_account_id);
CREATE INDEX idx_transfers_to_account_id   ON public.transfers USING btree (to_account_id);


-- ============================================================
-- saga_log
-- ============================================================
--
-- 跨 shard 轉帳的狀態機，存在 fromShard
--
-- step 生命週期：
--   RESERVED → CREDITED → COMPLETED
--                       ↘ COMPENSATING → FAILED
--          ↘ FAILED
--   （任何階段若資料不一致）→ NEEDS_REVIEW
--
-- transfer_id 有 UNIQUE index，確保每筆轉帳只有一列
-- idx_saga_log_pending 是 partial index，只涵蓋 recovery worker 需要掃描的狀態
--

CREATE TABLE public.saga_log (
    id              bigserial                   NOT NULL,
    transfer_id     bigint                      NOT NULL,
    step            varchar(20)                 NOT NULL,
    from_account_id bigint                      NOT NULL,
    to_account_id   bigint                      NOT NULL,
    from_shard_id   int                         NOT NULL,
    to_shard_id     int                         NOT NULL,
    amount          bigint                      NOT NULL,
    created_at      timestamptz DEFAULT now()   NOT NULL,
    updated_at      timestamptz DEFAULT now()   NOT NULL,
    CONSTRAINT saga_log_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX idx_saga_log_transfer_id
    ON public.saga_log (transfer_id);

CREATE INDEX idx_saga_log_pending
    ON public.saga_log (step, updated_at)
    WHERE step IN ('RESERVED', 'CREDITED', 'COMPENSATING');


-- ============================================================
-- saga_credits
-- ============================================================
--
-- 記錄跨 shard 轉帳 Step 2（credit toAccount）是否完成
-- 存在 toShard，與 toAccount 入帳在同一個 tx 寫入
-- recovery worker 查此表判斷 RESERVED 狀態下 toAccount 是否已入帳
--

CREATE TABLE public.saga_credits (
    id          bigserial                   NOT NULL,
    transfer_id bigint                      NOT NULL,
    created_at  timestamptz DEFAULT now()   NOT NULL,
    CONSTRAINT saga_credits_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX idx_saga_credits_transfer_id
    ON public.saga_credits (transfer_id);


-- ============================================================
-- saga_compensations
-- ============================================================
--
-- 記錄跨 shard 轉帳補償操作（扣回 toAccount）是否完成
-- 存在 toShard，與補償 UPDATE accounts 在同一個 tx 寫入
-- recovery worker 查此表做冪等判斷，防止重複補償
--

CREATE TABLE public.saga_compensations (
    id          bigserial                   NOT NULL,
    transfer_id bigint                      NOT NULL,
    created_at  timestamptz DEFAULT now()   NOT NULL,
    CONSTRAINT saga_compensations_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX idx_saga_compensations_transfer_id
    ON public.saga_compensations (transfer_id);