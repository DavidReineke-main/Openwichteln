-- =====================================================================
-- OpenWichteln – Datenbankschema für Supabase (ohne Login)
--
-- Einspielen: per GitHub Action "Supabase-Schema einspielen" oder im
-- Supabase SQL-Editor. Das Skript ist wiederholbar.
--
-- Zugriffsmodell: Es gibt keine Konten. Jedes Mitglied hat einen geheimen
-- persönlichen Token (steckt in seinem persönlichen Link). Die Tabellen sind
-- für den öffentlichen API-Key komplett gesperrt; alles läuft über die
-- RPC-Funktionen unten, die den Token prüfen und nur das herausgeben, was
-- die Person sehen darf:
--   * Wünsche: die Person selbst, Admins der Gruppe, der/die ausgeloste
--     Schenker:in.
--   * Ausschlüsse: ausschließlich die Person selbst (auch nicht Admins).
--   * Zuteilung: nur der/die Schenker:in selbst (auch nicht Admins).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Aufräumen einer älteren Schema-Version mit Login (falls vorhanden)
-- ---------------------------------------------------------------------
do $cleanup$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'members' and column_name = 'user_id'
  ) then
    drop table if exists public.assignments, public.exclusions, public.wishes,
                         public.members, public.groups cascade;
    drop function if exists public.create_group(text, text, text, date, text) cascade;
    drop function if exists public.group_preview(text) cascade;
    drop function if exists public.join_group(text, text) cascade;
    drop function if exists public.get_invite_code(uuid) cascade;
    drop function if exists public.regenerate_invite(uuid) cascade;
    drop function if exists public.set_member_role(uuid, text) cascade;
    drop function if exists public.remove_member(uuid) cascade;
    drop function if exists public.draw_names(uuid) cascade;
    drop function if exists public.reset_draw(uuid) cascade;
    drop function if exists public.is_member(uuid) cascade;
    drop function if exists public.is_admin(uuid) cascade;
    drop function if exists public.owns_member(uuid) cascade;
  end if;
end
$cleanup$;

-- Aufräumen: Die zwischenzeitliche E-Mail-Funktion wurde wieder entfernt
drop function if exists public.create_group(text, text, text, date, text, text);
drop function if exists public.join_group(text, text, text);
drop function if exists public.app_info();
drop function if exists public.set_email(text, text, boolean);
drop function if exists public.send_my_link(text);
drop function if exists public.request_links(text);
drop function if exists public.admin_reset_link(text, uuid, boolean);
drop schema if exists private cascade;

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

-- Link-Erneuerung durch Admins (für den Hinweis an die betroffene Person)
alter table public.members add column if not exists link_reset_at timestamptz;
alter table public.members add column if not exists link_reset_by text;
alter table public.members drop column if exists email;
alter table public.members drop column if exists notify;

-- Tabellen für die öffentliche API komplett sperren: RLS an, keine Policies.
alter table public.groups      enable row level security;
alter table public.members     enable row level security;
alter table public.wishes      enable row level security;
alter table public.exclusions  enable row level security;
alter table public.assignments enable row level security;
revoke all on public.groups, public.members, public.wishes,
              public.exclusions, public.assignments from anon, authenticated;

-- ---------------------------------------------------------------------
-- Interne Helfer (nicht öffentlich aufrufbar)
-- ---------------------------------------------------------------------

create or replace function public.member_by_token(p_token text)
returns public.members language plpgsql stable security definer set search_path = public as $fn$
declare m members%rowtype;
begin
  select * into m from members where token = p_token;
  if not found then
    raise exception 'Dieser persönliche Link ist ungültig oder du wurdest aus der Gruppe entfernt.';
  end if;
  return m;
end;
$fn$;

create or replace function public.admin_by_token(p_token text)
returns public.members language plpgsql stable security definer set search_path = public as $fn$
declare m members%rowtype;
begin
  m := member_by_token(p_token);
  if m.role <> 'admin' then raise exception 'Das dürfen nur Admins der Gruppe.'; end if;
  return m;
end;
$fn$;

create or replace function public.wishes_json(p_member_id uuid)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'title', title, 'details', details, 'link', link) order by created_at), '[]'::jsonb)
  from wishes where member_id = p_member_id;
$fn$;

create or replace function public.assert_not_drawn(p_group_id uuid)
returns void language plpgsql stable security definer set search_path = public as $fn$
begin
  if (select drawn_at from groups where id = p_group_id) is not null then
    raise exception 'Das geht nach der Auslosung nicht mehr. Ein Admin kann die Auslosung zurücksetzen.';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------
-- Öffentliche RPCs
-- ---------------------------------------------------------------------

-- Gruppe anlegen; gibt den persönlichen Token der Erstellerin (Admin) zurück
create or replace function public.create_group(
  p_name text, p_description text, p_budget text, p_event_date date, p_display_name text
) returns text language plpgsql security definer set search_path = public as $fn$
declare v_group uuid; v_token text;
begin
  insert into groups (name, description, budget, event_date)
  values (trim(p_name), nullif(trim(p_description), ''), nullif(trim(p_budget), ''), p_event_date)
  returning id into v_group;
  insert into members (group_id, display_name, role)
  values (v_group, trim(p_display_name), 'admin')
  returning token into v_token;
  return v_token;
end;
$fn$;

create or replace function public.group_preview(p_invite text)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'name', g.name, 'description', g.description, 'budget', g.budget, 'event_date', g.event_date,
    'drawn', g.drawn_at is not null,
    'members', (select coalesce(jsonb_agg(display_name order by joined_at), '[]'::jsonb)
                from members where group_id = g.id))
  from groups g where g.invite_code = p_invite;
$fn$;

create or replace function public.join_group(p_invite text, p_display_name text)
returns text language plpgsql security definer set search_path = public as $fn$
declare g groups%rowtype; v_token text;
begin
  select * into g from groups where invite_code = p_invite;
  if not found then raise exception 'Dieser Einladungslink ist ungültig oder wurde erneuert.'; end if;
  perform assert_not_drawn(g.id);
  if (select count(*) from members where group_id = g.id) >= 100 then
    raise exception 'Diese Gruppe ist voll.';
  end if;
  if exists (select 1 from members where group_id = g.id and lower(display_name) = lower(trim(p_display_name))) then
    raise exception 'Den Namen „%“ gibt es in der Gruppe schon – bitte einen anderen wählen.', trim(p_display_name);
  end if;
  insert into members (group_id, display_name) values (g.id, trim(p_display_name))
  returning token into v_token;
  return v_token;
end;
$fn$;

-- Alles, was die Person mit diesem Token sehen darf
create or replace function public.get_state(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare me members%rowtype; g groups%rowtype; is_admin boolean;
begin
  me := member_by_token(p_token);
  select * into g from groups where id = me.group_id;
  is_admin := me.role = 'admin';
  return jsonb_build_object(
    'me', jsonb_build_object('id', me.id, 'display_name', me.display_name, 'role', me.role,
                             'link_reset_at', me.link_reset_at, 'link_reset_by', me.link_reset_by),
    'group', jsonb_build_object(
      'id', g.id, 'name', g.name, 'description', g.description, 'budget', g.budget,
      'event_date', g.event_date, 'drawn_at', g.drawn_at,
      'invite_code', case when is_admin then g.invite_code end),
    'members', (select jsonb_agg(jsonb_build_object('id', id, 'display_name', display_name, 'role', role)
                                 order by joined_at)
                from members where group_id = g.id),
    'my_wishes', wishes_json(me.id),
    'my_exclusions', (select coalesce(jsonb_agg(jsonb_build_object(
                         'id', id, 'target_member_id', target_member_id, 'kind', kind)), '[]'::jsonb)
                      from exclusions where member_id = me.id),
    'assignment', (select jsonb_build_object('receiver_id', a.receiver_id,
                                             'receiver_name', r.display_name,
                                             'wishes', wishes_json(a.receiver_id))
                   from assignments a join members r on r.id = a.receiver_id
                   where a.giver_id = me.id),
    'all_wishes', case when is_admin then
                    (select coalesce(jsonb_object_agg(m.id, wishes_json(m.id)), '{}'::jsonb)
                     from members m where m.group_id = g.id)
                  end
  );
end;
$fn$;

-- Übersicht für die Startseite (Tokens aus dem localStorage)
create or replace function public.list_memberships(p_tokens text[])
returns jsonb language sql stable security definer set search_path = public as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'token', m.token, 'display_name', m.display_name, 'role', m.role,
           'group_name', g.name, 'event_date', g.event_date, 'drawn', g.drawn_at is not null)
         order by g.created_at desc), '[]'::jsonb)
  from members m join groups g on g.id = m.group_id
  where m.token = any (p_tokens[1:100]);
$fn$;

create or replace function public.rename_member(p_token text, p_display_name text)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype;
begin
  me := member_by_token(p_token);
  if exists (select 1 from members where group_id = me.group_id and id <> me.id
             and lower(display_name) = lower(trim(p_display_name))) then
    raise exception 'Den Namen „%“ gibt es in der Gruppe schon.', trim(p_display_name);
  end if;
  update members set display_name = trim(p_display_name) where id = me.id;
end;
$fn$;

create or replace function public.add_wish(p_token text, p_title text, p_details text, p_link text)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype;
begin
  me := member_by_token(p_token);
  if (select count(*) from wishes where member_id = me.id) >= 50 then
    raise exception 'Maximal 50 Wünsche pro Person.';
  end if;
  insert into wishes (member_id, title, details, link)
  values (me.id, trim(p_title), nullif(trim(p_details), ''), nullif(trim(p_link), ''));
end;
$fn$;

create or replace function public.delete_wish(p_token text, p_wish_id uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype;
begin
  me := member_by_token(p_token);
  delete from wishes where id = p_wish_id and member_id = me.id;
end;
$fn$;

create or replace function public.add_exclusion(p_token text, p_target_id uuid, p_kind text)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype;
begin
  me := member_by_token(p_token);
  perform assert_not_drawn(me.group_id);
  if not exists (select 1 from members where id = p_target_id and group_id = me.group_id) then
    raise exception 'Diese Person ist nicht in der Gruppe.';
  end if;
  insert into exclusions (member_id, target_member_id, kind)
  values (me.id, p_target_id, p_kind)
  on conflict do nothing;
end;
$fn$;

create or replace function public.delete_exclusion(p_token text, p_exclusion_id uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype;
begin
  me := member_by_token(p_token);
  perform assert_not_drawn(me.group_id);
  delete from exclusions where id = p_exclusion_id and member_id = me.id;
end;
$fn$;

-- Selbst austreten (p_member_id null) oder als Admin jemanden entfernen
create or replace function public.remove_member(p_token text, p_member_id uuid default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype; target members%rowtype;
begin
  me := member_by_token(p_token);
  if p_member_id is null or p_member_id = me.id then
    target := me;
  else
    me := admin_by_token(p_token);
    select * into target from members where id = p_member_id and group_id = me.group_id;
    if not found then raise exception 'Mitglied nicht gefunden.'; end if;
  end if;
  perform assert_not_drawn(target.group_id);
  if target.role = 'admin'
     and (select count(*) from members where group_id = target.group_id and role = 'admin') <= 1
     and (select count(*) from members where group_id = target.group_id) > 1 then
    raise exception 'Bitte zuerst eine andere Person zum Admin machen.';
  end if;
  delete from members where id = target.id;
  delete from groups g where g.id = target.group_id
    and not exists (select 1 from members where group_id = g.id);
end;
$fn$;

create or replace function public.set_member_role(p_token text, p_member_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype; target members%rowtype;
begin
  me := admin_by_token(p_token);
  if p_role not in ('admin', 'member') then raise exception 'Ungültige Rolle.'; end if;
  select * into target from members where id = p_member_id and group_id = me.group_id;
  if not found then raise exception 'Mitglied nicht gefunden.'; end if;
  if p_role = 'member' and target.role = 'admin'
     and (select count(*) from members where group_id = me.group_id and role = 'admin') <= 1 then
    raise exception 'Die Gruppe braucht mindestens einen Admin.';
  end if;
  update members set role = p_role where id = target.id;
end;
$fn$;

create or replace function public.update_group(
  p_token text, p_name text, p_description text, p_budget text, p_event_date date
) returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype;
begin
  me := admin_by_token(p_token);
  update groups set name = trim(p_name), description = nullif(trim(p_description), ''),
                    budget = nullif(trim(p_budget), ''), event_date = p_event_date
  where id = me.group_id;
end;
$fn$;

create or replace function public.delete_group(p_token text)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype;
begin
  me := admin_by_token(p_token);
  delete from groups where id = me.group_id;
end;
$fn$;

create or replace function public.regenerate_invite(p_token text)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype;
begin
  me := admin_by_token(p_token);
  update groups set invite_code = new_token() where id = me.group_id;
end;
$fn$;

-- Die eigentliche Auslosung: randomisiertes Backtracking unter
-- Berücksichtigung aller (geheimen) Ausschlüsse.
create or replace function public.draw_names(p_token text)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  me       members%rowtype;
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
  me := admin_by_token(p_token);
  perform 1 from groups where id = me.group_id for update;
  if (select drawn_at from groups where id = me.group_id) is not null then
    raise exception 'Die Auslosung wurde bereits durchgeführt.';
  end if;

  select array_agg(id order by random()) into ids from members where group_id = me.group_id;
  n := coalesce(array_length(ids, 1), 0);
  if n < 3 then raise exception 'Für die Auslosung braucht ihr mindestens 3 Mitglieder.'; end if;

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
      raise exception 'Die Auslosung ist zu komplex – bitte Ausschlüsse reduzieren.';
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
  select me.group_id, ids[x], ids[asg[x]] from generate_series(1, n) x;
  update groups set drawn_at = now() where id = me.group_id;
end;
$fn$;

create or replace function public.reset_draw(p_token text)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype;
begin
  me := admin_by_token(p_token);
  delete from assignments where group_id = me.group_id;
  update groups set drawn_at = null where id = me.group_id;
end;
$fn$;

-- Admin erstellt einen neuen persönlichen Link für ein Mitglied, z. B. wenn es
-- seinen verloren hat. Der alte Link wird ungültig, alles andere bleibt erhalten.
-- Die Person sieht in der Gruppe, wer den Link wann neu erstellt hat.
create or replace function public.admin_reset_link(p_token text, p_member_id uuid)
returns text language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype; target members%rowtype;
begin
  me := admin_by_token(p_token);
  select * into target from members where id = p_member_id and group_id = me.group_id;
  if not found then raise exception 'Mitglied nicht gefunden.'; end if;
  if target.id = me.id then raise exception 'Deinen eigenen Link findest du in der Übersicht.'; end if;
  update members set token = new_token(), link_reset_at = now(), link_reset_by = me.display_name
  where id = target.id returning * into target;
  return target.token;
end;
$fn$;

-- ---------------------------------------------------------------------
-- Rechte: interne Helfer sperren, RPCs für den öffentlichen Key freigeben
-- ---------------------------------------------------------------------

revoke execute on function public.new_token()               from public, anon, authenticated;
revoke execute on function public.member_by_token(text)     from public, anon, authenticated;
revoke execute on function public.admin_by_token(text)      from public, anon, authenticated;
revoke execute on function public.wishes_json(uuid)         from public, anon, authenticated;
revoke execute on function public.assert_not_drawn(uuid)    from public, anon, authenticated;

grant execute on function public.create_group(text, text, text, date, text)     to anon, authenticated;
grant execute on function public.group_preview(text)                            to anon, authenticated;
grant execute on function public.join_group(text, text)                         to anon, authenticated;
grant execute on function public.get_state(text)                                to anon, authenticated;
grant execute on function public.list_memberships(text[])                       to anon, authenticated;
grant execute on function public.rename_member(text, text)                      to anon, authenticated;
grant execute on function public.add_wish(text, text, text, text)               to anon, authenticated;
grant execute on function public.delete_wish(text, uuid)                        to anon, authenticated;
grant execute on function public.add_exclusion(text, uuid, text)                to anon, authenticated;
grant execute on function public.delete_exclusion(text, uuid)                   to anon, authenticated;
grant execute on function public.remove_member(text, uuid)                      to anon, authenticated;
grant execute on function public.set_member_role(text, uuid, text)              to anon, authenticated;
grant execute on function public.update_group(text, text, text, text, date)     to anon, authenticated;
grant execute on function public.delete_group(text)                             to anon, authenticated;
grant execute on function public.regenerate_invite(text)                        to anon, authenticated;
grant execute on function public.draw_names(text)                               to anon, authenticated;
grant execute on function public.reset_draw(text)                               to anon, authenticated;
grant execute on function public.admin_reset_link(text, uuid)                 to anon, authenticated;
