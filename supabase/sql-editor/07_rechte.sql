-- OpenWichteln – Teil 7 von 7 (automatisch aus supabase/schema.sql erzeugt)
-- Im Supabase SQL-Editor: New query → alles einfügen → Run. Danach den nächsten Teil.

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
