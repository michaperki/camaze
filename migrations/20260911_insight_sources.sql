-- Shared benchmark metadata only. Customer usage stays in daily_costs.
create table if not exists public.insight_sources (
  id text primary key,
  snapshot jsonb,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default '-infinity',
  status text not null default 'pending' check (status in ('pending', 'refreshing', 'ok', 'error')),
  error text
);
alter table public.insight_sources enable row level security;
revoke all on public.insight_sources from anon, authenticated;
grant select, insert, update on public.insight_sources to service_role;
insert into public.insight_sources (id) values ('artificial-analysis') on conflict do nothing;
