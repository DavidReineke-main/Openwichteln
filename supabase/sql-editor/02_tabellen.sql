-- OpenWichteln – Teil 2 von 7 (automatisch aus supabase/schema.sql erzeugt)
-- Im Supabase SQL-Editor: New query → alles einfügen → Run. Danach den nächsten Teil.

-- ---------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------

create or replace function public.new_token()
returns text language sql volatile as $fn$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$fn$;

create table if not exists public.groups (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 100),
  description  text check (char_length(description) <= 2000),
  budget       text check (char_length(budget) <= 50),
  event_date   date,
  invite_code  text not null unique default public.new_token(),
  drawn_at     timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists public.members (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups (id) on delete cascade,
  token         text not null unique default public.new_token(),
  display_name  text not null check (char_length(display_name) between 1 and 60),
  role          text not null default 'member' check (role in ('admin', 'member')),
  joined_at     timestamptz not null default now()
);
create unique index if not exists members_name_unique on public.members (group_id, lower(display_name));

create table if not exists public.wishes (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.members (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  details     text check (char_length(details) <= 2000),
  link        text check (link is null or (link ~* '^https?://' and char_length(link) <= 1000)),
  created_at  timestamptz not null default now()
);
create index if not exists wishes_member_idx on public.wishes (member_id);

create table if not exists public.exclusions (
  id                uuid primary key default gen_random_uuid(),
  member_id         uuid not null references public.members (id) on delete cascade,
  target_member_id  uuid not null references public.members (id) on delete cascade,
  -- no_give:    member möchte target NICHT ziehen
  -- no_receive: member möchte NICHT von target gezogen werden
  kind              text not null check (kind in ('no_give', 'no_receive')),
  created_at        timestamptz not null default now(),
  check (member_id <> target_member_id),
  unique (member_id, target_member_id, kind)
);

create table if not exists public.assignments (
  group_id     uuid not null references public.groups (id) on delete cascade,
  giver_id     uuid not null references public.members (id) on delete cascade,
  receiver_id  uuid not null references public.members (id) on delete cascade,
  primary key (group_id, giver_id),
  unique (group_id, receiver_id)
);

-- Tabellen für die öffentliche API komplett sperren: RLS an, keine Policies.
alter table public.groups      enable row level security;
alter table public.members     enable row level security;
alter table public.wishes      enable row level security;
alter table public.exclusions  enable row level security;
alter table public.assignments enable row level security;
revoke all on public.groups, public.members, public.wishes,
              public.exclusions, public.assignments from anon, authenticated;
