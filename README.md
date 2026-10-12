# 🎁 OpenWichteln

Wichtelgruppen erstellen, Leute per Link einladen, Wünsche eintragen und geheim auslosen –
als statische Seite auf GitHub Pages, mit [Supabase](https://supabase.com) (kostenloser Plan) als Datenbank.

## Funktionen

- **Gruppen erstellen** – wer eine Gruppe anlegt, ist automatisch Admin (Name, Budget, Datum, Beschreibung).
- **Einladen per Link** – Admins sehen einen Einladungslink, können ihn kopieren/teilen und jederzeit erneuern (der alte wird ungültig).
- **Wunschliste** – jedes Mitglied trägt Wünsche (mit optionalem Link und Details) ein.
  Sichtbar **nur** für die Person selbst, die ausgeloste Schenker:in und die Admins.
- **Geheime Ausschlüsse** – „Ich möchte X nicht ziehen“ und „Ich möchte nicht von Y gezogen werden“.
  Sichtbar ausschließlich für die Person selbst – **auch Admins sehen sie nicht**.
- **Auslosung durch Admins** – läuft serverseitig in der Datenbank und berücksichtigt alle Ausschlüsse.
  Jede:r sieht nur, wen sie/er selbst beschenkt – auch der Admin sieht nur die eigene Zuteilung.
  Ist mit den Ausschlüssen keine Auslosung möglich, gibt es eine Fehlermeldung (ohne zu verraten, wer was ausgeschlossen hat).
- **Mitglieder verwalten** – Admins können Mitglieder entfernen, zu Admins machen, die Auslosung zurücksetzen und die Gruppe löschen.

## Geht das mit GitHub Pages?

Ja. GitHub Pages hostet nur statische Dateien, deshalb liegen die Daten in Supabase (Postgres).
Die Geheimhaltung wird **in der Datenbank** über Row-Level-Security durchgesetzt (`supabase/schema.sql`) –
nicht im Browser. Selbst wer die Seite manipuliert, kommt nicht an fremde Wünsche, Ausschlüsse oder Paarungen.
Der Supabase-„anon“-Key im Frontend ist dafür gedacht, öffentlich zu sein.

Hinweis zum kostenlosen Supabase-Plan: Projekte ohne Aktivität werden nach ca. einer Woche pausiert
und lassen sich im Dashboard mit einem Klick wieder aufwecken. Der eingebaute E-Mail-Versand ist auf wenige
Mails pro Stunde begrenzt (für Freundes-/Familiengruppen reicht das meist; sonst eigenes SMTP hinterlegen).

## Einrichtung (ca. 10 Minuten)

### 1. Supabase-Projekt anlegen

1. Auf [supabase.com](https://supabase.com) kostenlos registrieren und ein neues Projekt erstellen.
2. Im Projekt **SQL Editor** öffnen, den kompletten Inhalt von [`supabase/schema.sql`](supabase/schema.sql) einfügen und ausführen.
3. **Authentication → URL Configuration**:
   - *Site URL*: `https://davidreineke-main.github.io/Openwichteln/`
   - *Redirect URLs*: dieselbe URL hinzufügen (für lokale Tests zusätzlich z. B. `http://localhost:8000/`).
4. Optional: Unter **Authentication → Providers → Email** „Confirm email“ ausschalten, wenn sich Leute ohne
   Bestätigungsmail sofort registrieren können sollen.
5. Unter **Project Settings → API** die *Project URL* und den *anon public* Key kopieren.

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
  js/app.js          Oberfläche + Routing (Hash-Routen: #/, #/g/<id>, #/join/<code>)
  js/config.js       Supabase-URL + anon-Key
supabase/schema.sql  Tabellen, Row-Level-Security, Auslosung (draw_names)
.github/workflows/pages.yml  Deployment
```
