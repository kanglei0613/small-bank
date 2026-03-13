--
-- PostgreSQL database dump
--

\restrict byEVsfUOzM9OcKHbEbZPjXEk0TE4FWpGYUaoADilSG1ZNmdPUtvdnb6fRBT5neD

-- Dumped from database version 16.13 (Homebrew)
-- Dumped by pg_dump version 16.13 (Homebrew)

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

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: kanglei0613
--

CREATE TABLE public.accounts (
    id bigint NOT NULL,
    balance bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id bigint DEFAULT 0 NOT NULL,
    reserved_balance bigint DEFAULT 0 NOT NULL,
    available_balance bigint DEFAULT 0 NOT NULL
);


ALTER TABLE public.accounts OWNER TO kanglei0613;

--
-- Name: transfers; Type: TABLE; Schema: public; Owner: kanglei0613
--

CREATE TABLE public.transfers (
    id bigint NOT NULL,
    from_account_id bigint NOT NULL,
    to_account_id bigint NOT NULL,
    amount bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(20) DEFAULT 'COMPLETED'::character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.transfers OWNER TO kanglei0613;

--
-- Name: transfers_id_seq; Type: SEQUENCE; Schema: public; Owner: kanglei0613
--

CREATE SEQUENCE public.transfers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.transfers_id_seq OWNER TO kanglei0613;

--
-- Name: transfers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: kanglei0613
--

ALTER SEQUENCE public.transfers_id_seq OWNED BY public.transfers.id;


--
-- Name: transfers id; Type: DEFAULT; Schema: public; Owner: kanglei0613
--

ALTER TABLE ONLY public.transfers ALTER COLUMN id SET DEFAULT nextval('public.transfers_id_seq'::regclass);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: kanglei0613
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: transfers transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: kanglei0613
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_pkey PRIMARY KEY (id);


--
-- Name: accounts_user_id_idx; Type: INDEX; Schema: public; Owner: kanglei0613
--

CREATE INDEX accounts_user_id_idx ON public.accounts USING btree (user_id);


--
-- Name: transfers_from_idx; Type: INDEX; Schema: public; Owner: kanglei0613
--

CREATE INDEX transfers_from_idx ON public.transfers USING btree (from_account_id);


--
-- Name: transfers_to_idx; Type: INDEX; Schema: public; Owner: kanglei0613
--

CREATE INDEX transfers_to_idx ON public.transfers USING btree (to_account_id);


--
-- PostgreSQL database dump complete
--

\unrestrict byEVsfUOzM9OcKHbEbZPjXEk0TE4FWpGYUaoADilSG1ZNmdPUtvdnb6fRBT5neD

