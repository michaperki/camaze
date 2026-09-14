-- Single reserved data owner, using existing user_id-scoped product tables.
-- Apply before deploying the simulator; then run scripts/provision-simulation.js.
begin;
create table public.simulation_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.simulation_environments (
  owner_id uuid primary key check (owner_id = 'ca0a2e00-0000-4000-8000-000000000001'),
  scenario_version text not null default 'mid-size-v1',
  seed integer not null default 42,
  business_now timestamptz not null default '2026-09-14T12:00:00Z',
  revision bigint not null default 0,
  status text not null default 'empty' check (status in ('empty','ready','working','error')),
  playing boolean not null default false,
  events jsonb not null default '[]',
  operation uuid,
  operation_started_at timestamptz,
  error text
);
insert into public.simulation_environments(owner_id) values ('ca0a2e00-0000-4000-8000-000000000001');
create table public.simulation_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.simulation_environments(owner_id),
  business_date timestamptz not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);
alter table public.simulation_admins enable row level security;
alter table public.simulation_environments enable row level security;
alter table public.simulation_messages enable row level security;
revoke all on public.simulation_admins, public.simulation_environments, public.simulation_messages from anon, authenticated;
grant all on public.simulation_admins, public.simulation_environments, public.simulation_messages to service_role;

-- Fence every simulation write, including writes by a stale Vercel invocation.
-- SELECT FOR UPDATE serializes this check against reset/advance.
create function public.guard_simulation_write() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  target uuid;
  env public.simulation_environments;
  h jsonb := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
begin
  if TG_OP = 'UPDATE' and OLD.user_id is distinct from NEW.user_id and
     (OLD.user_id = 'ca0a2e00-0000-4000-8000-000000000001' or NEW.user_id = 'ca0a2e00-0000-4000-8000-000000000001') then
    raise exception 'Cannot move data across simulation boundary';
  end if;
  if TG_OP = 'DELETE' then target := OLD.user_id; else target := NEW.user_id; end if;
  if target = 'ca0a2e00-0000-4000-8000-000000000001' then
    if TG_TABLE_NAME = 'user_provider_keys' then raise exception 'Simulation cannot store provider credentials'; end if;
    select * into env from public.simulation_environments where owner_id = target for update;
    if not found or (h->>'x-simulation-revision') is distinct from env.revision::text then
      raise exception 'Missing or stale simulation revision';
    end if;
    if env.status = 'working' then
      if (h->>'x-simulation-operation') is distinct from env.operation::text then raise exception 'Simulation operation in progress'; end if;
    elsif env.status <> 'ready' then raise exception 'Simulation is not ready';
    end if;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end $$;

-- Ordinary foreign keys on IDs alone do not enforce same-account ownership.
create function public.guard_org_ownership() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if NEW.department_id is not null and not exists (select 1 from public.departments where id=NEW.department_id and user_id=NEW.user_id) then
    raise exception 'Department does not belong to this account';
  end if;
  if TG_TABLE_NAME = 'entity_assignments' then
    if NEW.person_id is not null and not exists (select 1 from public.people where id=NEW.person_id and user_id=NEW.user_id) then
      raise exception 'Person does not belong to this account';
    end if;
  end if;
  return NEW;
end $$;
create trigger guard_org_ownership before insert or update on public.people for each row execute function public.guard_org_ownership();
create trigger guard_org_ownership before insert or update on public.entity_assignments for each row execute function public.guard_org_ownership();

do $$ declare t text; begin
  foreach t in array array['daily_costs','monthly_attribution','cost_sync_state','departments','people','entity_assignments','user_settings','user_fixed_costs','user_notification_settings','alert_state','reconciliation_runs','user_provider_keys','simulation_messages'] loop
    execute format('create trigger guard_simulation_write before insert or update or delete on public.%I for each row execute function public.guard_simulation_write()',t);
    execute format('create policy exclude_system_simulation on public.%I as restrictive for all to anon, authenticated using (user_id <> %L::uuid) with check (user_id <> %L::uuid)',t,'ca0a2e00-0000-4000-8000-000000000001','ca0a2e00-0000-4000-8000-000000000001');
  end loop;
end $$;

create function public.simulation_begin(expected_revision bigint, reset_scenario boolean default false)
returns public.simulation_environments language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.simulation_environments; t text;
begin
  select * into e from public.simulation_environments where owner_id='ca0a2e00-0000-4000-8000-000000000001' for update;
  if e.revision <> expected_revision then raise exception 'Simulation changed; refresh and retry'; end if;
  if e.status='working' and (not reset_scenario or e.operation_started_at > now()-interval '10 minutes') then raise exception 'Simulation operation in progress'; end if;
  if not reset_scenario and e.status <> 'ready' then raise exception 'Load/reset the scenario first'; end if;
  update public.simulation_environments set revision=revision+1,status='working',operation=gen_random_uuid(),operation_started_at=now(),error=null
    where owner_id=e.owner_id returning * into e;
  if reset_scenario then
    perform set_config('request.headers',jsonb_build_object('x-simulation-revision',e.revision::text,'x-simulation-operation',e.operation::text)::text,true);
    foreach t in array array['entity_assignments','people','departments','daily_costs','monthly_attribution','cost_sync_state','user_fixed_costs','user_settings','user_notification_settings','alert_state','reconciliation_runs','simulation_messages'] loop
      execute format('delete from public.%I where user_id=$1',t) using e.owner_id;
    end loop;
    update public.simulation_environments set business_now='2026-09-14T12:00:00Z',events='[]',playing=false where owner_id=e.owner_id returning * into e;
  end if;
  return e;
end $$;
create function public.simulation_finish(expected_revision bigint, operation_id uuid, new_now timestamptz, new_events jsonb, new_playing boolean, failure text default null)
returns public.simulation_environments language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.simulation_environments;
begin
  update public.simulation_environments set business_now=new_now,events=new_events,playing=new_playing and failure is null,
    status=case when failure is null then 'ready' else 'error' end,error=failure,operation=null
  where owner_id='ca0a2e00-0000-4000-8000-000000000001' and revision=expected_revision and operation=operation_id returning * into e;
  if not found then raise exception 'Stale simulation operation'; end if;
  return e;
end $$;
revoke all on function public.simulation_begin(bigint,boolean), public.simulation_finish(bigint,uuid,timestamptz,jsonb,boolean,text) from public, anon, authenticated;
grant execute on function public.simulation_begin(bigint,boolean), public.simulation_finish(bigint,uuid,timestamptz,jsonb,boolean,text) to service_role;
commit;
