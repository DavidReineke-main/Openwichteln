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

-- E-Mail (optional) und Link-Erneuerung durch Admins
alter table public.members add column if not exists email text
  check (email is null or (char_length(email) <= 254 and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
alter table public.members add column if not exists notify boolean not null default true;
alter table public.members add column if not exists link_reset_at timestamptz;
alter table public.members add column if not exists link_reset_by text;
create index if not exists members_email_idx on public.members (lower(email));

-- Privates Schema: wird nicht über die API veröffentlicht
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.settings (
  key    text primary key,
  value  text
);
create table if not exists private.mail_log (
  id          bigserial primary key,
  key         text not null,
  created_at  timestamptz not null default now()
);
create index if not exists mail_log_key_idx on private.mail_log (key, created_at);

-- pg_net verschickt HTTP-Anfragen (an den Mail-Dienst) aus der Datenbank
do $ext$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net nicht verfügbar – E-Mail-Versand bleibt deaktiviert';
end
$ext$;

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
-- E-Mail-Versand (optional) über Brevo + pg_net
-- Einstellungen in private.settings: brevo_api_key, mail_from,
-- mail_from_name, site_url (setzt der Workflow aus GitHub-Secrets).
-- ---------------------------------------------------------------------

create or replace function private.setting(p_key text)
returns text language sql stable security definer set search_path = public as $fn$
  select value from private.settings where key = p_key;
$fn$;

create or replace function private.mail_enabled()
returns boolean language sql stable security definer set search_path = public as $fn$
  select coalesce(private.setting('brevo_api_key'), '') <> ''
     and coalesce(private.setting('mail_from'), '') <> ''
     and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'net' and p.proname = 'http_post');
$fn$;

create or replace function private.esc(p text)
returns text language sql immutable as $fn$
  -- NULL bleibt NULL, damit coalesce(... || private.esc(x), '') optionale Teile weglässt
  select replace(replace(replace(replace(replace(p,
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$fn$;

create or replace function private.norm_email(p text)
returns text language plpgsql immutable as $fn$
declare v text := nullif(lower(trim(coalesce(p, ''))), '');
begin
  if v is not null and (char_length(v) > 254 or v !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'Bitte eine gültige E-Mail-Adresse angeben.';
  end if;
  return v;
end;
$fn$;

create or replace function private.member_url(p_token text)
returns text language sql stable security definer set search_path = public as $fn$
  select coalesce(nullif(private.setting('site_url'), ''), 'https://davidreineke-main.github.io/Openwichteln/')
         || '#/m/' || p_token;
$fn$;

-- true = darf senden (und merkt sich den Versand), false = zu früh
create or replace function private.rate_ok(p_key text, p_interval interval)
returns boolean language plpgsql volatile security definer set search_path = public as $fn$
begin
  if exists (select 1 from private.mail_log where key = p_key and created_at > now() - p_interval) then
    return false;
  end if;
  insert into private.mail_log (key) values (p_key);
  return true;
end;
$fn$;

-- p_body ist bereits fertiges (escaptes) HTML, p_title/p_subject sind Klartext
create or replace function private.send_mail(
  p_to text, p_subject text, p_title text, p_body text,
  p_button_label text default null, p_button_url text default null
) returns void language plpgsql volatile security definer set search_path = public as $fn$
declare v_html text;
begin
  if p_to is null or not private.mail_enabled() then return; end if;
  v_html :=
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1c2420;line-height:1.5">'
    || '<div style="background:#143f30;color:#ffffff;padding:16px 24px;border-radius:12px 12px 0 0;font-size:18px;font-weight:bold">🎁 OpenWichteln</div>'
    || '<div style="background:#ffffff;border:1px solid #e7dfd3;border-top:none;padding:24px;border-radius:0 0 12px 12px">'
    || '<h1 style="font-size:22px;margin:0 0 12px">' || private.esc(p_title) || '</h1>'
    || p_body
    || case when p_button_url is not null then
         '<p style="margin:24px 0 8px"><a href="' || private.esc(p_button_url) || '" style="background:#b8322a;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">'
         || private.esc(coalesce(p_button_label, 'Öffnen')) || '</a></p>'
         || '<p style="font-size:12px;color:#66706b;word-break:break-all">' || private.esc(p_button_url) || '</p>'
       else '' end
    || '<p style="font-size:12px;color:#66706b;margin-top:24px;border-top:1px solid #e7dfd3;padding-top:12px">'
    || 'Du bekommst diese Mail, weil bei OpenWichteln deine E-Mail-Adresse hinterlegt ist. '
    || 'Updates kannst du in deiner Gruppe unter „E-Mail &amp; Updates“ abbestellen. Der Link in dieser Mail ist dein persönlicher Zugang – bitte nicht weiterleiten.</p>'
    || '</div></div>';
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using 'https://api.brevo.com/v3/smtp/email',
          jsonb_build_object(
            'sender', jsonb_build_object('email', private.setting('mail_from'),
                                         'name', coalesce(nullif(private.setting('mail_from_name'), ''), 'OpenWichteln')),
            'to', jsonb_build_array(jsonb_build_object('email', p_to)),
            'subject', p_subject,
            'htmlContent', v_html),
          jsonb_build_object('api-key', private.setting('brevo_api_key'),
                             'Content-Type', 'application/json', 'Accept', 'application/json');
exception when others then
  raise warning 'Mailversand fehlgeschlagen: %', sqlerrm;
end;
$fn$;

-- Update an ein Mitglied, nur wenn E-Mail hinterlegt und Updates erwünscht
create or replace function private.notify(
  p_member public.members, p_subject text, p_title text, p_body text
) returns void language plpgsql volatile security definer set search_path = public as $fn$
begin
  if p_member.email is null or not p_member.notify then return; end if;
  perform private.send_mail(p_member.email, p_subject, p_title, p_body, 'Zur Gruppe', private.member_url(p_member.token));
end;
$fn$;

create or replace function private.send_link_mail(p_member public.members)
returns void language plpgsql volatile security definer set search_path = public as $fn$
declare v_group text;
begin
  select name into v_group from groups where id = p_member.group_id;
  perform private.send_mail(p_member.email,
    'Dein Link für „' || v_group || '“',
    'Dein persönlicher Wichtel-Link',
    '<p>Hallo ' || private.esc(p_member.display_name) || ',</p>'
    || '<p>hier ist dein persönlicher Link für die Wichtelgruppe <b>' || private.esc(v_group) || '</b>. '
    || 'Er ist dein Zugang – damit kommst du auf jedem Gerät rein.</p>',
    'Zur Gruppe', private.member_url(p_member.token));
end;
$fn$;

create or replace function private.wishes_html(p_member_id uuid)
returns text language sql stable security definer set search_path = public as $fn$
  select coalesce(
    '<ul style="padding-left:20px">' || string_agg(
      '<li style="margin-bottom:6px"><b>' || private.esc(title) || '</b>'
      || coalesce(' – ' || private.esc(details), '')
      || coalesce(' (<a href="' || private.esc(link) || '">Link</a>)', '') || '</li>', '' order by created_at)
    || '</ul>',
    '<p><i>Noch keine Wünsche eingetragen.</i></p>')
  from wishes where member_id = p_member_id;
$fn$;

-- ---------------------------------------------------------------------
-- Öffentliche RPCs
-- ---------------------------------------------------------------------

-- Gruppe anlegen; gibt den persönlichen Token der Erstellerin (Admin) zurück
drop function if exists public.create_group(text, text, text, date, text);
create or replace function public.create_group(
  p_name text, p_description text, p_budget text, p_event_date date, p_display_name text,
  p_email text default null
) returns text language plpgsql security definer set search_path = public as $fn$
declare v_group uuid; m members%rowtype;
begin
  insert into groups (name, description, budget, event_date)
  values (trim(p_name), nullif(trim(p_description), ''), nullif(trim(p_budget), ''), p_event_date)
  returning id into v_group;
  insert into members (group_id, display_name, role, email)
  values (v_group, trim(p_display_name), 'admin', private.norm_email(p_email))
  returning * into m;
  if m.email is not null then perform private.send_link_mail(m); end if;
  return m.token;
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

drop function if exists public.join_group(text, text);
create or replace function public.join_group(p_invite text, p_display_name text, p_email text default null)
returns text language plpgsql security definer set search_path = public as $fn$
declare g groups%rowtype; m members%rowtype; a members%rowtype; v_count int;
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
  insert into members (group_id, display_name, email)
  values (g.id, trim(p_display_name), private.norm_email(p_email))
  returning * into m;
  if m.email is not null then perform private.send_link_mail(m); end if;

  select count(*) into v_count from members where group_id = g.id;
  for a in select * from members where group_id = g.id and role = 'admin' and id <> m.id loop
    perform private.notify(a,
      'Neues Mitglied in „' || g.name || '“',
      m.display_name || ' ist dabei!',
      '<p><b>' || private.esc(m.display_name) || '</b> ist der Gruppe <b>' || private.esc(g.name)
      || '</b> beigetreten. Ihr seid jetzt ' || v_count || '.</p>');
  end loop;
  return m.token;
end;
$fn$;

-- Alles, was die Person mit diesem Token sehen darf
create or replace function public.get_state(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare me members%rowtype; g groups%rowtype; v_admin boolean;
begin
  me := member_by_token(p_token);
  select * into g from groups where id = me.group_id;
  v_admin := me.role = 'admin';
  return jsonb_build_object(
    'mail_enabled', private.mail_enabled(),
    'me', jsonb_build_object('id', me.id, 'display_name', me.display_name, 'role', me.role,
                             'email', me.email, 'notify', me.notify,
                             'link_reset_at', me.link_reset_at, 'link_reset_by', me.link_reset_by),
    'group', jsonb_build_object(
      'id', g.id, 'name', g.name, 'description', g.description, 'budget', g.budget,
      'event_date', g.event_date, 'drawn_at', g.drawn_at,
      'invite_code', case when v_admin then g.invite_code end),
    'members', (select jsonb_agg(jsonb_build_object(
                         'id', id, 'display_name', display_name, 'role', role,
                         'has_email', case when v_admin then email is not null end)
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
    'all_wishes', case when v_admin then
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
declare me members%rowtype; giver members%rowtype;
begin
  me := member_by_token(p_token);
  if (select count(*) from wishes where member_id = me.id) >= 50 then
    raise exception 'Maximal 50 Wünsche pro Person.';
  end if;
  insert into wishes (member_id, title, details, link)
  values (me.id, trim(p_title), nullif(trim(p_details), ''), nullif(trim(p_link), ''));

  -- Nach der Auslosung: Schenker:in über neue Wünsche informieren (max. alle 30 Min.)
  select m.* into giver from assignments a join members m on m.id = a.giver_id where a.receiver_id = me.id;
  if found and giver.email is not null and giver.notify then
    if private.rate_ok('wish:' || giver.id || ':' || me.id, interval '30 minutes') then
      perform private.notify(giver,
        'Neuer Wunsch von deinem Wichtelkind',
        me.display_name || ' hat die Wunschliste ergänzt',
        '<p><b>' || private.esc(me.display_name) || '</b> hat einen neuen Wunsch eingetragen. Aktuell steht auf der Liste:</p>'
        || private.wishes_html(me.id));
    end if;
  end if;
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
declare me members%rowtype; old groups%rowtype; g groups%rowtype; m members%rowtype;
begin
  me := admin_by_token(p_token);
  select * into old from groups where id = me.group_id;
  update groups set name = trim(p_name), description = nullif(trim(p_description), ''),
                    budget = nullif(trim(p_budget), ''), event_date = p_event_date
  where id = me.group_id returning * into g;

  if (old.name, old.description, old.budget, old.event_date)
     is distinct from (g.name, g.description, g.budget, g.event_date) then
    for m in select * from members where group_id = g.id and id <> me.id loop
      if m.email is not null and m.notify then
        if private.rate_ok('group:' || m.id, interval '1 hour') then
          perform private.notify(m,
            'Neuigkeiten in „' || g.name || '“',
            'Die Gruppeninfos wurden aktualisiert',
            '<p>' || private.esc(me.display_name) || ' hat die Infos zur Gruppe <b>' || private.esc(g.name) || '</b> geändert:</p><ul>'
            || coalesce('<li>Budget: <b>' || private.esc(g.budget) || '</b></li>', '')
            || coalesce('<li>Bescherung: <b>' || to_char(g.event_date, 'DD.MM.YYYY') || '</b></li>', '')
            || coalesce('<li>' || replace(private.esc(g.description), chr(10), '<br>') || '</li>', '')
            || '</ul>');
        end if;
      end if;
    end loop;
  end if;
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
  grp      groups%rowtype;
  giver    members%rowtype;
  receiver members%rowtype;
  pair     record;
begin
  me := admin_by_token(p_token);
  select * into grp from groups where id = me.group_id;
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

  -- Alle mit E-Mail erfahren, wen sie beschenken
  for pair in select giver_id, receiver_id from assignments where group_id = me.group_id loop
    select * into giver from members where id = pair.giver_id;
    select * into receiver from members where id = pair.receiver_id;
    perform private.notify(giver,
      'Die Auslosung für „' || grp.name || '“ ist da! 🎁',
      'Die Auslosung ist da!',
      '<p>In der Gruppe <b>' || private.esc(grp.name) || '</b> wurde gerade gelost. Du beschenkst:</p>'
      || '<p style="font-size:26px;font-weight:bold;margin:8px 0 16px">' || private.esc(receiver.display_name) || '</p>'
      || coalesce('<p>Budget: <b>' || private.esc(grp.budget) || '</b></p>', '')
      || coalesce('<p>Bescherung: <b>' || to_char(grp.event_date, 'DD.MM.YYYY') || '</b></p>', '')
      || '<p>Das steht bisher auf der Wunschliste:</p>' || private.wishes_html(receiver.id)
      || '<p>Psst – verrat es niemandem! 🤫</p>');
  end loop;
end;
$fn$;

create or replace function public.reset_draw(p_token text)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype; g groups%rowtype; m members%rowtype;
begin
  me := admin_by_token(p_token);
  select * into g from groups where id = me.group_id;
  if g.drawn_at is null then return; end if;
  delete from assignments where group_id = me.group_id;
  update groups set drawn_at = null where id = me.group_id;
  for m in select * from members where group_id = g.id and id <> me.id loop
    perform private.notify(m,
      'Neue Auslosung in „' || g.name || '“',
      'Die Auslosung wurde zurückgesetzt',
      '<p>' || private.esc(me.display_name) || ' hat die Auslosung in <b>' || private.esc(g.name)
      || '</b> zurückgesetzt. Deine bisherige Zuteilung gilt nicht mehr – sobald neu gelost wurde, bekommst du wieder Bescheid.</p>');
  end loop;
end;
$fn$;

-- ---------------------------------------------------------------------
-- E-Mail & Links
-- ---------------------------------------------------------------------

create or replace function public.app_info()
returns jsonb language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object('mail_enabled', private.mail_enabled());
$fn$;

create or replace function public.set_email(p_token text, p_email text, p_notify boolean default true)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype; v_email text; v_old text;
begin
  me := member_by_token(p_token);
  v_old := me.email;
  v_email := private.norm_email(p_email);
  update members set email = v_email, notify = coalesce(p_notify, true) where id = me.id
  returning * into me;
  -- Neue Adresse: Link direkt zuschicken
  if v_email is not null and v_email is distinct from v_old then
    if private.rate_ok('link:' || me.id, interval '2 minutes') then
      perform private.send_link_mail(me);
    end if;
  end if;
end;
$fn$;

create or replace function public.send_my_link(p_token text)
returns void language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype;
begin
  me := member_by_token(p_token);
  if not private.mail_enabled() then raise exception 'Der E-Mail-Versand ist noch nicht eingerichtet.'; end if;
  if me.email is null then raise exception 'Hinterlege zuerst eine E-Mail-Adresse.'; end if;
  if not private.rate_ok('link:' || me.id, interval '5 minutes') then
    raise exception 'Gerade erst verschickt – bitte ein paar Minuten warten.';
  end if;
  perform private.send_link_mail(me);
end;
$fn$;

-- Link vergessen: schickt alle Links zu einer Adresse (ohne zu verraten, ob es welche gibt)
create or replace function public.request_links(p_email text)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_email text; v_list text;
begin
  v_email := private.norm_email(p_email);
  if v_email is null then raise exception 'Bitte eine E-Mail-Adresse angeben.'; end if;
  if not private.mail_enabled() then raise exception 'Der E-Mail-Versand ist noch nicht eingerichtet.'; end if;
  if (select count(*) from private.mail_log where key like 'recover:%' and created_at > now() - interval '1 hour') >= 30 then
    return;
  end if;
  if not private.rate_ok('recover:' || v_email, interval '10 minutes') then return; end if;

  select string_agg('<li style="margin-bottom:8px"><a href="' || private.esc(private.member_url(m.token)) || '">'
                    || private.esc(g.name) || '</a> – als ' || private.esc(m.display_name) || '</li>', '' order by g.created_at desc)
  into v_list
  from members m join groups g on g.id = m.group_id
  where m.email = v_email;
  if v_list is null then return; end if;

  perform private.send_mail(v_email, 'Deine Wichtel-Links', 'Deine persönlichen Links',
    '<p>Hier sind alle Wichtelgruppen, in denen diese E-Mail-Adresse hinterlegt ist:</p><ul style="padding-left:20px">'
    || v_list || '</ul>');
end;
$fn$;

-- Admin erstellt einen neuen persönlichen Link für ein Mitglied (alter wird ungültig).
-- p_via_mail = true: Link geht nur per Mail an die Person, der Admin sieht ihn nicht.
create or replace function public.admin_reset_link(p_token text, p_member_id uuid, p_via_mail boolean default false)
returns text language plpgsql security definer set search_path = public as $fn$
declare me members%rowtype; target members%rowtype; v_group text;
begin
  me := admin_by_token(p_token);
  select * into target from members where id = p_member_id and group_id = me.group_id;
  if not found then raise exception 'Mitglied nicht gefunden.'; end if;
  if target.id = me.id then raise exception 'Deinen eigenen Link findest du in der Übersicht.'; end if;
  if p_via_mail and (target.email is null or not private.mail_enabled()) then
    raise exception 'Für diese Person ist keine E-Mail-Adresse hinterlegt.';
  end if;

  update members set token = new_token(), link_reset_at = now(), link_reset_by = me.display_name
  where id = target.id returning * into target;

  select name into v_group from groups where id = target.group_id;
  perform private.send_mail(target.email,
    'Dein neuer Link für „' || v_group || '“',
    'Dein neuer Wichtel-Link',
    '<p>' || private.esc(me.display_name) || ' hat für dich einen neuen persönlichen Link für <b>'
    || private.esc(v_group) || '</b> erstellt. Dein alter Link funktioniert nicht mehr – nutze ab jetzt diesen:</p>',
    'Zur Gruppe', private.member_url(target.token));

  return case when p_via_mail then null else target.token end;
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

grant execute on function public.create_group(text, text, text, date, text, text) to anon, authenticated;
grant execute on function public.group_preview(text)                            to anon, authenticated;
grant execute on function public.join_group(text, text, text)                   to anon, authenticated;
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
grant execute on function public.app_info()                                     to anon, authenticated;
grant execute on function public.set_email(text, text, boolean)                 to anon, authenticated;
grant execute on function public.send_my_link(text)                             to anon, authenticated;
grant execute on function public.request_links(text)                            to anon, authenticated;
grant execute on function public.admin_reset_link(text, uuid, boolean)          to anon, authenticated;
