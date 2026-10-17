-- OpenWichteln – Teil 3 von 7 (automatisch aus supabase/schema.sql erzeugt)
-- Im Supabase SQL-Editor: New query → alles einfügen → Run. Danach den nächsten Teil.

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
