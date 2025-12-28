-- Enable cryptographic functions for UUID generation
create extension if not exists pgcrypto;

-- Table definition for job listings
create table if not exists public.job_listings (
    id uuid primary key default gen_random_uuid(),
    source text not null,
    source_job_id text not null,
    url text,
    title text,
    company_name text,
    company_logo_url text,
    category text,
    job_type text,
    publication_date timestamptz,
    candidate_required_location text,
    salary text,
    description_html text,
    content_hash text not null,
    raw_json jsonb not null,
    first_seen_at timestamptz not null,
    verified_at timestamptz not null,
    removed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists job_listings_source_job_idx
    on public.job_listings (source, source_job_id);

create index if not exists job_listings_source_verified_idx
    on public.job_listings (source, verified_at desc);

create index if not exists job_listings_source_removed_idx
    on public.job_listings (source, removed_at);

create index if not exists job_listings_company_idx
    on public.job_listings (company_name);

-- Trigger to keep updated_at fresh
create or replace function public.set_job_listings_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger job_listings_set_updated_at
    before update on public.job_listings
    for each row execute procedure public.set_job_listings_updated_at();

-- RPC to batch upsert job listings
create or replace function public.upsert_job_listings_batch(
    p_source text,
    p_run_ts timestamptz,
    p_jobs jsonb
)
returns bigint
language plpgsql
as $$
declare
    v_count bigint;
begin
    with payload as (
        select jsonb_array_elements(p_jobs) as job
    ), upserted as (
        insert into public.job_listings as jl (
            source,
            source_job_id,
            url,
            title,
            company_name,
            company_logo_url,
            category,
            job_type,
            publication_date,
            candidate_required_location,
            salary,
            description_html,
            content_hash,
            raw_json,
            first_seen_at,
            verified_at,
            removed_at
        )
        select
            p_source,
            job->>'source_job_id',
            job->>'url',
            job->>'title',
            job->>'company_name',
            job->>'company_logo_url',
            job->>'category',
            job->>'job_type',
            (job->>'publication_date')::timestamptz,
            job->>'candidate_required_location',
            job->>'salary',
            job->>'description_html',
            job->>'content_hash',
            job->'raw_json',
            p_run_ts,
            p_run_ts,
            null
        from payload
        on conflict (source, source_job_id) do update
        set
            url = excluded.url,
            title = excluded.title,
            company_name = excluded.company_name,
            company_logo_url = excluded.company_logo_url,
            category = excluded.category,
            job_type = excluded.job_type,
            publication_date = excluded.publication_date,
            candidate_required_location = excluded.candidate_required_location,
            salary = excluded.salary,
            description_html = excluded.description_html,
            content_hash = excluded.content_hash,
            raw_json = excluded.raw_json,
            verified_at = excluded.verified_at,
            removed_at = excluded.removed_at,
            first_seen_at = jl.first_seen_at
        returning 1
    )
    select count(*) into v_count from upserted;

    return coalesce(v_count, 0);
end;
$$;

-- RPC to mark listings missing from the latest run
create or replace function public.mark_missing_job_listings(
    p_source text,
    p_run_ts timestamptz
)
returns bigint
language plpgsql
as $$
declare
    v_count bigint;
begin
    update public.job_listings
    set removed_at = p_run_ts
    where source = p_source
      and removed_at is null
      and verified_at < p_run_ts;

    get diagnostics v_count = row_count;
    return coalesce(v_count, 0);
end;
$$;
