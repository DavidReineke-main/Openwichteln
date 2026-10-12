# 🎁 OpenWichteln

Wichtelgruppen erstellen, Leute per Link einladen, Wünsche eintragen und geheim auslosen –
als statische Seite auf GitHub Pages, mit [Supabase](https://supabase.com) (kostenloser Plan) als Datenbank.

## Funktionen

- **Kein Login** – wer eine Gruppe erstellt oder beitritt, bekommt einen **geheimen persönlichen Link**.
  Der Link ist der Zugang (wie ein Passwort). Der Browser merkt sich die Links im localStorage, sodass die
  Startseite automatisch „meine Gruppen“ zeigt. Auf einem anderen Gerät einfach den persönlichen Link öffnen
  oder auf der Startseite einfügen.
- **Gruppen erstellen** – wer eine Gruppe anlegt, ist Admin (Name, Budget, Datum, Beschreibung).
- **Einladen per Link** – Admins teilen den Einladungslink; beim Beitreten wählt jede:r einen beliebigen Namen
  (pro Gruppe eindeutig). Der Link lässt sich erneuern, der alte wird dann ungültig.
- **Wunschliste** – sichtbar **nur** für die Person selbst, die ausgeloste Schenker:in und die Admins.
- **Geheime Ausschlüsse** – „Ich möchte X nicht ziehen“ und „Ich möchte nicht von Y gezogen werden“.
  Sichtbar ausschließlich für die Person selbst – **auch Admins sehen sie nicht**.
- **Auslosung durch Admins** – läuft serverseitig und berücksichtigt alle Ausschlüsse. Jede:r sieht nur, wen
  sie/er selbst beschenkt – auch der Admin.
- **Mitglieder verwalten** – Admins können Mitglieder entfernen, zu Admins machen, die Auslosung zurücksetzen
  und die Gruppe löschen.

## Sicherheit

Repository und Supabase-Key sind öffentlich – das ist so gewollt. Die Tabellen sind für den öffentlichen Key
komplett gesperrt; alle Zugriffe laufen über Datenbankfunktionen (`supabase/schema.sql`), die den geheimen
Token aus dem persönlichen Link prüfen und nur herausgeben, was diese Person sehen darf. Die Tokens sind
zufällig und stehen im `#`-Teil der URL, der nie an GitHub Pages übertragen wird.

**Wichtig:** Wer einen persönlichen Link hat, ist diese Person. Links also nicht weitergeben. Geht ein Link
verloren, gibt es keinen Weg zurück (Admins können die Person entfernen und neu einladen, solange noch nicht
ausgelost wurde).

Hinweis zum kostenlosen Supabase-Plan: Projekte ohne Aktivität werden nach ca. einer Woche pausiert und
lassen sich im Dashboard mit einem Klick wieder aufwecken.

## Einrichtung (ca. 10 Minuten)

### 1. Supabase-Projekt anlegen

1. Auf [supabase.com](https://supabase.com) kostenlos registrieren und ein neues Projekt erstellen.
2. Schema einspielen – am einfachsten per GitHub Action:
   - In Supabase oben auf **Connect** klicken → **Session pooler** → die URI kopieren
     (`postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-…pooler.supabase.com:5432/postgres`)
     und `[YOUR-PASSWORD]` durch das Datenbank-Passwort ersetzen.
   - Im GitHub-Repo unter **Settings → Secrets and variables → Actions → Secrets** ein Secret
     `SUPABASE_DB_URL` mit dieser URI anlegen.
   - Unter **Actions → „Supabase-Schema einspielen“ → Run workflow** starten. Bei jeder Änderung an
     `supabase/schema.sql` auf `main` läuft der Workflow automatisch erneut (das Skript ist wiederholbar).

   Alternativ den Inhalt von `supabase/schema.sql` im **SQL Editor** einfügen und ausführen.
3. Unter **Project Settings → API** die *Project URL* und den *Publishable* (bzw. *anon*) Key kopieren.

### 2. GitHub Pages aktivieren

1. Im Repository **Settings → Secrets and variables → Actions → Variables** zwei Repository-Variablen anlegen:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = anon public Key
2. **Settings → Pages → Build and deployment → Source: „GitHub Actions“** auswählen.
3. Unter **Actions** den Workflow „Deploy to GitHub Pages“ starten (oder einfach etwas auf `main` pushen).

Danach ist die Seite unter `https://davidreineke-main.github.io/Openwichteln/` erreichbar.

> Alternativ können URL und Key direkt in `app/js/config.js` eingetragen werden.

### Lokal testen

```bash
cd app
python3 -m http.server 8000
# http://localhost:8000 öffnen
```

## Aufbau

```
app/                 statische Web-App (wird auf GitHub Pages veröffentlicht)
  index.html
  css/style.css
  js/app.js          Oberfläche + Routing (Hash-Routen: #/, #/m/<token>, #/join/<code>)
  js/config.js       Supabase-URL + anon-Key
supabase/schema.sql  Tabellen, Token-geschützte RPC-Funktionen, Auslosung (draw_names)
.github/workflows/pages.yml  Deployment
```
