-- OpenWichteln – Teil 5 von 7 (automatisch aus supabase/schema.sql erzeugt)
-- Im Supabase SQL-Editor: New query → alles einfügen → Run. Danach den nächsten Teil.

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
