-- ============================================================================
-- TripFlow — Supabase schema
--
-- Run this once, in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once.
--
-- The design principle behind every choice here: the browser holds the anon key, so the
-- database must assume the client is hostile. Nothing is protected by the app being polite —
-- every table has row-level security on, and every policy names the row's owner explicitly.
-- If someone opens the console and calls the API by hand, they still only reach their own rows.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- trips
--
-- One row per trip, not one row per account. A single JSON blob per user would be simpler to
-- write and would make sharing a single trip impossible without handing over everything else,
-- so the trip is the unit from the start.
--
-- `data` is the trip exactly as the app already stores it in localStorage. That keeps one shape
-- in one place: no server-side model to drift from the client's, no migration needed to add a
-- field to a trip, and the local-only mode stays a first-class path rather than a legacy one.
-- ---------------------------------------------------------------------------
create table if not exists public.trips (
  id          text primary key,                -- the app's own trip id, so local and remote agree
  owner       uuid not null references auth.users(id) on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false   -- soft delete: a device that has been offline
                                               -- must learn a trip was removed, and a missing
                                               -- row is indistinguishable from one it has not
                                               -- synced yet
);

create index if not exists trips_owner_updated_idx on public.trips (owner, updated_at desc);

alter table public.trips enable row level security;

-- Policies are written separately for each verb rather than as one "for all", so that a mistake
-- in one cannot silently widen the others.
drop policy if exists "own trips: read"   on public.trips;
drop policy if exists "own trips: insert" on public.trips;
drop policy if exists "own trips: update" on public.trips;
drop policy if exists "own trips: delete" on public.trips;

create policy "own trips: read"   on public.trips for select using (auth.uid() = owner);
create policy "own trips: insert" on public.trips for insert with check (auth.uid() = owner);
-- `using` decides which rows may be updated; `with check` decides what they may be changed INTO.
-- Without the second, an owner could rewrite `owner` and hand a row to somebody else.
create policy "own trips: update" on public.trips for update
  using (auth.uid() = owner) with check (auth.uid() = owner);
create policy "own trips: delete" on public.trips for delete using (auth.uid() = owner);

-- ---------------------------------------------------------------------------
-- updated_at, maintained by the database
--
-- The client sends its own timestamp and the client's clock cannot be trusted — a phone with a
-- wrong date would win or lose every merge. The server stamps the row on the way in, so the
-- ordering used to resolve conflicts comes from one clock.
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trips_touch_updated_at on public.trips;
create trigger trips_touch_updated_at
  before insert or update on public.trips
  for each row execute function public.touch_updated_at();
