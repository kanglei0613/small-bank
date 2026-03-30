--
-- PostgreSQL database dump
--

\restrict OClFz7mfuVhG26tHd4OGDrN2zlrrDQchATguPCSoATgW1IAaeRMzPJGadBAIzY7

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
-- Name: account_shards; Type: TABLE; Schema: public; Owner: kanglei0613
--

CREATE TABLE public.account_shards (
    account_id bigint NOT NULL,
    shard_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.account_shards OWNER TO kanglei0613;

--
-- Name: users; Type: TABLE; Schema: public; Owner: kanglei0613
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.users OWNER TO kanglei0613;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: kanglei0613
--

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO kanglei0613;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: kanglei0613
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: kanglei0613
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: account_shards account_shards_pkey; Type: CONSTRAINT; Schema: public; Owner: kanglei0613
--

ALTER TABLE ONLY public.account_shards
    ADD CONSTRAINT account_shards_pkey PRIMARY KEY (account_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: kanglei0613
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: account_shards_shard_id_idx; Type: INDEX; Schema: public; Owner: kanglei0613
--

CREATE INDEX account_shards_shard_id_idx ON public.account_shards USING btree (shard_id);


--
-- PostgreSQL database dump complete
--

\unrestrict OClFz7mfuVhG26tHd4OGDrN2zlrrDQchATguPCSoATgW1IAaeRMzPJGadBAIzY7

