begin;
alter table public.simulation_environments drop constraint if exists simulation_environments_owner_id_check;
update public.simulation_environments set owner_id = '0fdc87e0-60fc-4e48-af96-d363d92ad7a8' where owner_id = 'ca0a2e00-0000-4000-8000-000000000001';
alter table public.simulation_environments add constraint simulation_environments_owner_id_check check (owner_id = '0fdc87e0-60fc-4e48-af96-d363d92ad7a8');
-- Existing restrictive policies contain the previous reserved UUID.
do $$ declare r record; begin
  for r in select schemaname, tablename, policyname from pg_policies where policyname = 'exclude_system_simulation' loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;
do $$ declare t text; begin
  foreach t in array array['daily_costs','monthly_attribution','cost_sync_state','departments','people','entity_assignments','user_settings','user_fixed_costs','user_notification_settings','alert_state','reconciliation_runs','user_provider_keys','simulation_messages'] loop
    execute format('create policy exclude_system_simulation on public.%I as restrictive for all to anon, authenticated using (user_id <> %L::uuid) with check (user_id <> %L::uuid)',t,'0fdc87e0-60fc-4e48-af96-d363d92ad7a8','0fdc87e0-60fc-4e48-af96-d363d92ad7a8');
  end loop;
end $$;
create or replace function public.guard_simulation_write() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  target uuid;
  env public.simulation_environments;
  h jsonb := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
begin
  if TG_OP = 'UPDATE' and OLD.user_id is distinct from NEW.user_id and
     (OLD.user_id = '0fdc87e0-60fc-4e48-af96-d363d92ad7a8' or NEW.user_id = '0fdc87e0-60fc-4e48-af96-d363d92ad7a8') then
    raise exception 'Cannot move data across simulation boundary';
  end if;
  if TG_OP = 'DELETE' then target := OLD.user_id; else target := NEW.user_id; end if;
  if target = '0fdc87e0-60fc-4e48-af96-d363d92ad7a8' then
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
create or replace function public.guard_org_ownership() returns trigger
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
    execute format('create policy exclude_system_simulation on public.%I as restrictive for all to anon, authenticated using (user_id <> %L::uuid) with check (user_id <> %L::uuid)',t,'0fdc87e0-60fc-4e48-af96-d363d92ad7a8','0fdc87e0-60fc-4e48-af96-d363d92ad7a8');
  end loop;
end $$;

create or replace function public.simulation_begin(expected_revision bigint, reset_scenario boolean default false)
returns public.simulation_environments language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.simulation_environments; t text;
begin
  select * into e from public.simulation_environments where owner_id='0fdc87e0-60fc-4e48-af96-d363d92ad7a8' for update;
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
create or replace function public.simulation_finish(expected_revision bigint, operation_id uuid, new_now timestamptz, new_events jsonb, new_playing boolean, failure text default null)
returns public.simulation_environments language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.simulation_environments;
begin
  update public.simulation_environments set business_now=new_now,events=new_events,playing=new_playing and failure is null,
    status=case when failure is null then 'ready' else 'error' end,error=failure,operation=null
  where owner_id='0fdc87e0-60fc-4e48-af96-d363d92ad7a8' and revision=expected_revision and operation=operation_id returning * into e;
  if not found then raise exception 'Stale simulation operation'; end if;
  return e;
end $$;
create or replace function public.simulation_begin(expected_revision bigint, reset_scenario boolean default false)
returns public.simulation_environments language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.simulation_environments; t text;
begin
  select * into e from public.simulation_environments where owner_id='0fdc87e0-60fc-4e48-af96-d363d92ad7a8' for update;
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
create or replace function public.simulation_finish(expected_revision bigint, operation_id uuid, new_now timestamptz, new_events jsonb, new_playing boolean, failure text default null)
returns public.simulation_environments language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.simulation_environments;
begin
  update public.simulation_environments set business_now=new_now,events=new_events,playing=new_playing and failure is null,
    status=case when failure is null then 'ready' else 'error' end,error=failure,operation=null
  where owner_id='0fdc87e0-60fc-4e48-af96-d363d92ad7a8' and revision=expected_revision and operation=operation_id returning * into e;
  if not found then raise exception 'Stale simulation operation'; end if;
  return e;
end $$;
commit;
