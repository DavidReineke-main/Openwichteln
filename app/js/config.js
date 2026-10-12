// Supabase-Zugangsdaten (Project Settings → API).
// Der "anon"-Key ist öffentlich gedacht – die Sicherheit kommt aus den
// Row-Level-Security-Regeln in supabase/schema.sql.
// Beim Deployment über GitHub Actions wird diese Datei automatisch aus den
// Repository-Variablen SUPABASE_URL und SUPABASE_ANON_KEY erzeugt.
export const SUPABASE_URL = 'https://DEIN-PROJEKT.supabase.co';
export const SUPABASE_ANON_KEY = 'DEIN-ANON-KEY';
