-- OpenWichteln – Teil 4 von 7 (automatisch aus supabase/schema.sql erzeugt)
-- Im Supabase SQL-Editor: New query → alles einfügen → Run. Danach den nächsten Teil.

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
    'me', jsonb_build_object('id', me.id, 'display_name', me.display_name, 'role', me.role),
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
