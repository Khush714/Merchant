-- Defense in depth for the Supabase Data API: every public table is RLS-protected
-- and no browser-facing role has direct privileges. The app connects as the table
-- owner through its private DATABASE_URL, so it is unaffected by these revokes.
-- This closes the gap between the drizzle/ local/CI path and supabase/migrations/.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

do $$
declare
  tbl record;
begin
  for tbl in select schemaname, tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I.%I enable row level security', tbl.schemaname, tbl.tablename);
    execute format('revoke all on table %I.%I from public, anon, authenticated, service_role', tbl.schemaname, tbl.tablename);
  end loop;
end
$$;

do $$
declare
  seq record;
begin
  for seq in select sequence_schema, sequence_name from information_schema.sequences where sequence_schema = 'public' loop
    execute format('revoke all on sequence %I.%I from public, anon, authenticated, service_role', seq.sequence_schema, seq.sequence_name);
  end loop;
end
$$;
