-- =====================================================================
-- OpenWichteln – Datenbankschema für Supabase
-- Einmal komplett im Supabase SQL-Editor ausführen.
--
-- Geheimhaltung wird über Row-Level-Security (RLS) durchgesetzt:
--   * Wünsche sieht nur: das Mitglied selbst, die Admins der Gruppe und
--     der/die ausgeloste Schenker:in.
--   * Ausschlüsse ("will ich nicht ziehen" / "will nicht gezogen werden
--     von") sieht ausschließlich die Person, die sie angelegt hat –
--     auch Admins nicht.
--   * Zuteilungen sieht nur der/die jeweilige Schenker:in.
--   * Die Auslosung läuft serverseitig in draw_names(), damit niemand
--     (auch nicht der Admin) Ausschlüsse oder Paarungen mitlesen kann.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------

create table if not exists public.groups (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 100),
  description  text check (char_length(description) <= 2000),
  budget       text check (char_length(budget) <= 50),
  event_date   date,
  invite_code  text not null unique default replace(gen_random_uuid()::text, '-', ''),
  drawn_at     timestamptz,
  created_by   uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now()
);

create table if not exists public.members (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 60),
  role          text not null default 'member' check (role in ('admin', 'member')),
  joined_at     timestamptz not null default now(),
  unique (group_id, user_id)
);
create index if not exists members_user_idx on public.members (user_id);

create table if not exists public.wishes (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.members (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  details     text check (char_length(details) <= 2000),
  link        text check (link is null or link ~* '^https?://'),
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

-- ---------------------------------------------------------------------
-- Hilfsfunktionen (security definer, um RLS-Rekursion zu vermeiden)
-- ---------------------------------------------------------------------

create or replace function public.is_member(p_group_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members where group_id = p_group_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_admin(p_group_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members
    where group_id = p_group_id and user_id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.owns_member(p_member_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where id = p_member_id and user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------
-- Row-Level-Security
-- ---------------------------------------------------------------------

alter table public.groups      enable row level security;
alter table public.members     enable row level security;
alter table public.wishes      enable row level security;
alter table public.exclusions  enable row level security;
alter table public.assignments enable row level security;

-- Spaltenrechte: invite_code nur über get_invite_code() (Admins),
-- Statusfelder nur über RPCs änderbar.
revoke all on public.groups, public.members, public.wishes,
              public.exclusions, public.assignments from anon;
revoke select, insert, update on public.groups  from authenticated;
revoke insert, update         on public.members from authenticated;
grant select (id, name, description, budget, event_date, drawn_at, created_by, created_at)
  on public.groups to authenticated;
grant update (name, description, budget, event_date) on public.groups to authenticated;
grant update (display_name) on public.members to authenticated;
revoke insert, update, delete on public.assignments from authenticated;

-- groups
drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups for select to authenticated
  using (is_member(id));
drop policy if exists groups_update on public.groups;
create policy groups_update on public.groups for update to authenticated
  using (is_admin(id)) with check (is_admin(id));
drop policy if exists groups_delete on public.groups;
create policy groups_delete on public.groups for delete to authenticated
  using (is_admin(id));

-- members
drop policy if exists members_select on public.members;
create policy members_select on public.members for select to authenticated
  using (is_member(group_id));
drop policy if exists members_update_self on public.members;
create policy members_update_self on public.members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- wishes
drop policy if exists wishes_select on public.wishes;
create policy wishes_select on public.wishes for select to authenticated
  using (
    exists (
      select 1 from members m
      where m.id = wishes.member_id
        and (m.user_id = auth.uid() or is_admin(m.group_id))
    )
    or exists (
      select 1 from assignments a
      join members g on g.id = a.giver_id
      where a.receiver_id = wishes.member_id and g.user_id = auth.uid()
    )
  );
drop policy if exists wishes_insert on public.wishes;
create policy wishes_insert on public.wishes for insert to authenticated
  with check (owns_member(member_id));
drop policy if exists wishes_update on public.wishes;
create policy wishes_update on public.wishes for update to authenticated
  using (owns_member(member_id)) with check (owns_member(member_id));
drop policy if exists wishes_delete on public.wishes;
create policy wishes_delete on public.wishes for delete to authenticated
  using (owns_member(member_id));

-- exclusions: ausschließlich für die anlegende Person sichtbar
drop policy if exists exclusions_select on public.exclusions;
create policy exclusions_select on public.exclusions for select to authenticated
  using (owns_member(member_id));
drop policy if exists exclusions_insert on public.exclusions;
create policy exclusions_insert on public.exclusions for insert to authenticated
  with check (
    owns_member(member_id)
    and exists (
      select 1 from members me
      join members t on t.group_id = me.group_id
      join groups g on g.id = me.group_id
      where me.id = exclusions.member_id
        and t.id = exclusions.target_member_id
        and g.drawn_at is null
    )
  );
drop policy if exists exclusions_delete on public.exclusions;
create policy exclusions_delete on public.exclusions for delete to authenticated
  using (owns_member(member_id));

-- assignments: nur der/die Schenker:in sieht die eigene Zuteilung
drop policy if exists assignments_select on public.assignments;
create policy assignments_select on public.assignments for select to authenticated
  using (owns_member(giver_id));

-- ---------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------

create or replace function public.create_group(
  p_name text, p_description text, p_budget text, p_event_date date, p_display_name text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Bitte zuerst anmelden'; end if;
  insert into groups (name, description, budget, event_date, created_by)
  values (trim(p_name), nullif(trim(p_description), ''), nullif(trim(p_budget), ''),
          p_event_date, auth.uid())
  returning id into v_id;
  insert into members (group_id, user_id, display_name, role)
  values (v_id, auth.uid(), trim(p_display_name), 'admin');
  return v_id;
end;
$$;

-- Vorschau für Einladungslinks (ohne Mitgliedschaft lesbar)
create or replace function public.group_preview(p_code text)
returns table (id uuid, name text, description text, budget text, event_date date,
               member_count int, drawn boolean, already_member boolean)
language sql stable security definer set search_path = public as $$
  select g.id, g.name, g.description, g.budget, g.event_date,
         (select count(*)::int from members m where m.group_id = g.id),
         g.drawn_at is not null,
         exists (select 1 from members m where m.group_id = g.id and m.user_id = auth.uid())
  from groups g where g.invite_code = p_code;
$$;

create or replace function public.join_group(p_code text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare g groups%rowtype;
begin
  if auth.uid() is null then raise exception 'Bitte zuerst anmelden'; end if;
  select * into g from groups where invite_code = p_code;
  if not found then raise exception 'Dieser Einladungslink ist ungültig oder abgelaufen'; end if;
  if exists (select 1 from members where group_id = g.id and user_id = auth.uid()) then
    return g.id;
  end if;
  if g.drawn_at is not null then
    raise exception 'In dieser Gruppe wurde bereits gelost. Ein Admin muss die Auslosung erst zurücksetzen.';
  end if;
  insert into members (group_id, user_id, display_name)
  values (g.id, auth.uid(), trim(p_display_name));
  return g.id;
end;
$$;

create or replace function public.get_invite_code(p_group_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin(p_group_id) then raise exception 'Nur Admins können Einladungslinks sehen'; end if;
  return (select invite_code from groups where id = p_group_id);
end;
$$;

create or replace function public.regenerate_invite(p_group_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not is_admin(p_group_id) then raise exception 'Nur Admins können Einladungslinks erneuern'; end if;
  update groups set invite_code = replace(gen_random_uuid()::text, '-', '')
  where id = p_group_id returning invite_code into v_code;
  return v_code;
end;
$$;

create or replace function public.set_member_role(p_member_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare m members%rowtype;
begin
  select * into m from members where id = p_member_id;
  if not found or not is_admin(m.group_id) then raise exception 'Keine Berechtigung'; end if;
  if p_role not in ('admin', 'member') then raise exception 'Ungültige Rolle'; end if;
  if p_role = 'member' and m.role = 'admin'
     and (select count(*) from members where group_id = m.group_id and role = 'admin') <= 1 then
    raise exception 'Die Gruppe braucht mindestens einen Admin';
  end if;
  update members set role = p_role where id = p_member_id;
end;
$$;

create or replace function public.remove_member(p_member_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m members%rowtype;
begin
  select * into m from members where id = p_member_id;
  if not found then raise exception 'Mitglied nicht gefunden'; end if;
  if not (is_admin(m.group_id) or m.user_id = auth.uid()) then
    raise exception 'Keine Berechtigung';
  end if;
  if (select drawn_at from groups where id = m.group_id) is not null then
    raise exception 'Nach der Auslosung kann niemand entfernt werden. Bitte zuerst die Auslosung zurücksetzen.';
  end if;
  if m.role = 'admin'
     and (select count(*) from members where group_id = m.group_id and role = 'admin') <= 1
     and (select count(*) from members where group_id = m.group_id) > 1 then
    raise exception 'Bitte zuerst eine andere Person zum Admin machen';
  end if;
  delete from members where id = p_member_id;
  -- letzte Person weg -> Gruppe löschen
  delete from groups g where g.id = m.group_id
    and not exists (select 1 from members where group_id = g.id);
end;
$$;

-- Die eigentliche Auslosung: randomisiertes Backtracking unter
-- Berücksichtigung aller (geheimen) Ausschlüsse.
create or replace function public.draw_names(p_group_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  ids      uuid[];
  n        int;
  allowed  boolean[];
  cand     int[] := '{}';
  ptr      int[];
  asg      int[];
  used     boolean[];
  i int; j int; k int;
  steps    int := 0;
  found    boolean;
begin
  if not is_admin(p_group_id) then raise exception 'Nur Admins können die Auslosung starten'; end if;
  perform 1 from groups where id = p_group_id for update;
  if (select drawn_at from groups where id = p_group_id) is not null then
    raise exception 'Die Auslosung wurde bereits durchgeführt';
  end if;

  select array_agg(id order by random()) into ids from members where group_id = p_group_id;
  n := coalesce(array_length(ids, 1), 0);
  if n < 3 then raise exception 'Für die Auslosung braucht ihr mindestens 3 Mitglieder'; end if;

  -- allowed[(geber-1)*n + empfänger]
  allowed := array_fill(true, array[n * n]);
  for i in 1..n loop
    for j in 1..n loop
      if i = j or exists (
        select 1 from exclusions e
        where (e.member_id = ids[i] and e.target_member_id = ids[j] and e.kind = 'no_give')
           or (e.member_id = ids[j] and e.target_member_id = ids[i] and e.kind = 'no_receive')
      ) then
        allowed[(i - 1) * n + j] := false;
      end if;
    end loop;
  end loop;

  -- Pro Ebene eine zufällige Kandidatenreihenfolge
  for k in 1..n loop
    cand := cand || (select array_agg(x order by random()) from generate_series(1, n) x);
  end loop;

  ptr  := array_fill(0, array[n]);
  asg  := array_fill(0, array[n]);
  used := array_fill(false, array[n]);
  k := 1;

  while k >= 1 and k <= n loop
    steps := steps + 1;
    if steps > 200000 then
      raise exception 'Die Auslosung ist zu komplex – bitte Ausschlüsse reduzieren';
    end if;
    if asg[k] > 0 then
      used[asg[k]] := false;
      asg[k] := 0;
    end if;
    found := false;
    while ptr[k] < n loop
      ptr[k] := ptr[k] + 1;
      j := cand[(k - 1) * n + ptr[k]];
      if not used[j] and allowed[(k - 1) * n + j] then
        found := true;
        exit;
      end if;
    end loop;
    if found then
      asg[k] := j;
      used[j] := true;
      k := k + 1;
      if k <= n then ptr[k] := 0; end if;
    else
      ptr[k] := 0;
      k := k - 1;
    end if;
  end loop;

  if k < 1 then
    raise exception 'Mit den hinterlegten (geheimen) Ausschlüssen ist keine gültige Auslosung möglich. Bittet die Mitglieder, ihre Ausschlüsse zu lockern.';
  end if;

  insert into assignments (group_id, giver_id, receiver_id)
  select p_group_id, ids[x], ids[asg[x]] from generate_series(1, n) x;
  update groups set drawn_at = now() where id = p_group_id;
end;
$$;

create or replace function public.reset_draw(p_group_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_group_id) then raise exception 'Nur Admins können die Auslosung zurücksetzen'; end if;
  delete from assignments where group_id = p_group_id;
  update groups set drawn_at = null where id = p_group_id;
end;
$$;

-- RPCs nur für angemeldete Nutzer:innen
revoke execute on function public.create_group(text, text, text, date, text) from public, anon;
revoke execute on function public.group_preview(text)            from public, anon;
revoke execute on function public.join_group(text, text)         from public, anon;
revoke execute on function public.get_invite_code(uuid)          from public, anon;
revoke execute on function public.regenerate_invite(uuid)        from public, anon;
revoke execute on function public.set_member_role(uuid, text)    from public, anon;
revoke execute on function public.remove_member(uuid)            from public, anon;
revoke execute on function public.draw_names(uuid)               from public, anon;
revoke execute on function public.reset_draw(uuid)               from public, anon;
grant execute on function public.create_group(text, text, text, date, text) to authenticated;
grant execute on function public.group_preview(text)            to authenticated;
grant execute on function public.join_group(text, text)         to authenticated;
grant execute on function public.get_invite_code(uuid)          to authenticated;
grant execute on function public.regenerate_invite(uuid)        to authenticated;
grant execute on function public.set_member_role(uuid, text)    to authenticated;
grant execute on function public.remove_member(uuid)            to authenticated;
grant execute on function public.draw_names(uuid)               to authenticated;
grant execute on function public.reset_draw(uuid)               to authenticated;
