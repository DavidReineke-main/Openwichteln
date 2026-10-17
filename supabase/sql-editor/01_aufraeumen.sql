-- OpenWichteln – Teil 1 von 7 (automatisch aus supabase/schema.sql erzeugt)
-- Im Supabase SQL-Editor: New query → alles einfügen → Run. Danach den nächsten Teil.

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
