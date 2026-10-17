-- Mail-Einstellungen in die Datenbank schreiben.
-- Wird vom Workflow "Supabase-Schema einspielen" mit psql-Variablen aufgerufen;
-- leere Werte überschreiben nichts.
insert into private.settings (key, value)
select k, v from (values
  ('brevo_api_key',  :'brevo_api_key'),
  ('mail_from',      :'mail_from'),
  ('mail_from_name', :'mail_from_name'),
  ('site_url',       :'site_url')
) as t (k, v)
where v <> ''
on conflict (key) do update set value = excluded.value;
