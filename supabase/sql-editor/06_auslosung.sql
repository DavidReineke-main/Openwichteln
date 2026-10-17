-- OpenWichteln – Teil 6 von 7 (automatisch aus supabase/schema.sql erzeugt)
-- Im Supabase SQL-Editor: New query → alles einfügen → Run. Danach den nächsten Teil.

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
