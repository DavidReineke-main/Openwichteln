import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Kein Login: Jede Person hat einen geheimen persönlichen Link (#/m/<token>).
// Die Tokens merkt sich der Browser im localStorage, damit die Startseite
// "meine Gruppen" zeigen kann.

const app = document.getElementById('app');
const TOKENS_KEY = 'openwichteln.tokens';

const configured = !SUPABASE_URL.includes('DEIN-PROJEKT') && !SUPABASE_ANON_KEY.includes('DEIN-ANON-KEY');
const sb = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  : null;

// Token, dessen Link gerade frisch erzeugt wurde (Gruppe erstellt/beigetreten)
let freshToken = null;

// ---------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function render(...nodes) {
  app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3000);
}

function errorMessage(err) {
  const msg = err?.message || String(err);
  if (msg.includes('violates check constraint')) return 'Ungültige Eingabe – bitte Länge bzw. Link prüfen.';
  if (msg.includes('Failed to fetch')) return 'Keine Verbindung zur Datenbank. Bitte später erneut versuchen.';
  return msg;
}

// Führt eine async Aktion aus, sperrt dabei den Button und zeigt Fehler.
async function run(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err), true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function rpc(name, params) {
  const { data, error } = await sb.rpc(name, params);
  if (error) throw error;
  return data;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const baseUrl = () => `${location.origin}${location.pathname}`;
const inviteUrl = (code) => `${baseUrl()}#/join/${code}`;
const personalUrl = (token) => `${baseUrl()}#/m/${token}`;

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ----- localStorage ----------------------------------------------------

function loadTokens() {
  try {
    const list = JSON.parse(localStorage.getItem(TOKENS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function saveTokens(tokens) {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify([...new Set(tokens)]));
  } catch { /* privater Modus o. ä. */ }
}

const rememberToken = (token) => saveTokens([token, ...loadTokens().filter((t) => t !== token)]);
const forgetToken = (token) => saveTokens(loadTokens().filter((t) => t !== token));

// Personal-Token aus einem eingefügten Link oder reinem Token lesen
function extractToken(text) {
  const match = String(text).match(/#\/m\/([a-f0-9]{32,})/i) || String(text).trim().match(/^([a-f0-9]{32,})$/i);
  return match ? match[1].toLowerCase() : null;
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link kopiert');
  } catch {
    input?.select();
    toast('Bitte manuell kopieren (Strg+C)');
  }
}

function copyBox(text, label) {
  const input = h('input', { value: text, readonly: true, 'aria-label': label, onclick: (e) => e.target.select() });
  return h('div', { class: 'copybox' }, input,
    h('button', { class: 'small', type: 'button', onclick: () => copyText(text, input) }, 'Kopieren'));
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

async function route() {
  if (!configured) return renderSetupHint();
  const [, page, param] = (location.hash.replace(/^#/, '') || '/').split('/');
  try {
    if (page === 'join' && param) return await renderJoin(param);
    if (page === 'm' && param) return await renderGroup(param);
    return await renderDashboard();
  } catch (err) {
    console.error(err);
    render(h('div', { class: 'card warn' },
      h('h2', null, 'Da ist etwas schiefgelaufen'),
      h('p', null, errorMessage(err)),
      h('a', { href: '#/' }, 'Zur Übersicht')));
  }
}

// ---------------------------------------------------------------------
// Ansichten
// ---------------------------------------------------------------------

function renderSetupHint() {
  render(h('div', { class: 'card warn' },
    h('h1', null, 'Fast fertig!'),
    h('p', null, 'OpenWichteln ist noch nicht mit einer Datenbank verbunden. Trage deine Supabase-URL und den Key in ',
      h('code', null, 'app/js/config.js'), ' ein.'),
    h('p', null, 'Die Schritt-für-Schritt-Anleitung steht in der README.')));
}

// ----- Übersicht -----------------------------------------------------

async function renderDashboard() {
  const tokens = loadTokens();
  const memberships = tokens.length ? await rpc('list_memberships', { p_tokens: tokens }) : [];

  // Links, die es nicht mehr gibt (Gruppe gelöscht / entfernt), vergessen
  const valid = new Set(memberships.map((m) => m.token));
  if (tokens.some((t) => !valid.has(t))) saveTokens(tokens.filter((t) => valid.has(t)));

  const createForm = h('form', { class: 'stack' },
    h('div', { class: 'grid2' },
      h('div', null,
        h('label', { for: 'g-name' }, 'Name der Gruppe'),
        h('input', { id: 'g-name', name: 'name', required: true, maxlength: 100, placeholder: 'z. B. Familie Weihnachten 2026' })),
      h('div', null,
        h('label', { for: 'g-display' }, 'Dein Name in der Gruppe'),
        h('input', { id: 'g-display', name: 'display_name', required: true, maxlength: 60 }))),
    h('div', { class: 'grid2' },
      h('div', null,
        h('label', { for: 'g-budget' }, 'Budget (optional)'),
        h('input', { id: 'g-budget', name: 'budget', maxlength: 50, placeholder: 'z. B. 25 €' })),
      h('div', null,
        h('label', { for: 'g-date' }, 'Datum der Bescherung (optional)'),
        h('input', { id: 'g-date', name: 'event_date', type: 'date' }))),
    h('div', null,
      h('label', { for: 'g-desc' }, 'Beschreibung (optional)'),
      h('textarea', { id: 'g-desc', name: 'description', maxlength: 2000, placeholder: 'Regeln, Ort, Uhrzeit …' })),
    h('button', { type: 'submit' }, 'Gruppe erstellen'));

  createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formData(createForm);
    run(createForm.querySelector('button[type=submit]'), async () => {
      const token = await rpc('create_group', {
        p_name: f.name, p_description: f.description, p_budget: f.budget,
        p_event_date: f.event_date || null, p_display_name: f.display_name,
      });
      rememberToken(token);
      freshToken = token;
      toast('Gruppe erstellt 🎉');
      navigate(`#/m/${token}`);
    });
  });

  const importForm = h('form', { class: 'row' },
    h('div', { style: 'flex:1;min-width:200px' },
      h('input', { name: 'link', required: true, placeholder: 'Persönlichen Link hier einfügen', 'aria-label': 'Persönlicher Link' })),
    h('button', { type: 'submit', class: 'secondary' }, 'Öffnen'));
  importForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const token = extractToken(formData(importForm).link);
    if (!token) return toast('Das sieht nicht nach einem persönlichen Link aus.', true);
    navigate(`#/m/${token}`);
  });

  render(
    h('div', { class: 'card' },
      h('h1', null, 'Meine Wichtelgruppen'),
      memberships.length === 0
        ? h('p', { class: 'muted' }, 'Auf diesem Gerät sind noch keine Gruppen gespeichert. Erstelle unten eine, öffne einen Einladungslink oder füge deinen persönlichen Link ein.')
        : h('ul', { class: 'list' }, memberships.map((m) => h('li', { class: 'spread' },
          h('div', null,
            h('a', { href: `#/m/${m.token}`, class: 'wish-title' }, m.group_name),
            h('div', { class: 'small muted' },
              [`als ${m.display_name}`, m.event_date && `Bescherung: ${formatDate(m.event_date)}`].filter(Boolean).join(' · '))),
          h('div', { class: 'row' },
            m.role === 'admin' && h('span', { class: 'badge admin' }, 'Admin'),
            m.drawn
              ? h('span', { class: 'badge ok' }, 'Ausgelost')
              : h('span', { class: 'badge' }, 'Noch nicht gelost')))))),
    h('div', { class: 'card' },
      h('h2', null, 'Neue Gruppe erstellen'),
      h('p', { class: 'small muted' }, 'Du wirst automatisch Admin der Gruppe und kannst danach Leute per Link einladen.'),
      createForm),
    h('div', { class: 'card' },
      h('h2', null, 'Gruppe auf diesem Gerät öffnen'),
      h('p', { class: 'small muted' }, 'Du bist schon in einer Gruppe, aber sie fehlt hier? Füge deinen persönlichen Link ein.'),
      importForm));
}

// ----- Einladung -----------------------------------------------------

async function renderJoin(code) {
  const preview = await rpc('group_preview', { p_invite: code });

  if (!preview) {
    return render(h('div', { class: 'card warn' },
      h('h1', null, 'Einladung ungültig'),
      h('p', null, 'Dieser Einladungslink existiert nicht (mehr). Bitte frag den Admin der Gruppe nach einem neuen Link.'),
      h('a', { href: '#/' }, 'Zur Übersicht')));
  }

  const form = h('form', { class: 'stack' },
    h('div', null,
      h('label', { for: 'j-name' }, 'Wie heißt du? (so sehen dich die anderen)'),
      h('input', { id: 'j-name', name: 'display_name', required: true, maxlength: 60 })),
    h('div', { class: 'row' },
      h('button', { type: 'submit', disabled: preview.drawn }, 'Gruppe beitreten'),
      h('a', { href: '#/', class: 'btn secondary' }, 'Abbrechen')));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(form.querySelector('button[type=submit]'), async () => {
      const token = await rpc('join_group', { p_invite: code, p_display_name: formData(form).display_name });
      rememberToken(token);
      freshToken = token;
      toast('Willkommen in der Gruppe! 🎄');
      navigate(`#/m/${token}`);
    });
  });

  render(h('div', { class: 'card' },
    h('p', { class: 'muted small' }, 'Einladung zur Wichtelgruppe'),
    h('h1', null, preview.name),
    preview.description && h('p', { class: 'wish-details' }, preview.description),
    h('p', { class: 'small muted' },
      [preview.budget && `Budget: ${preview.budget}`,
        preview.event_date && `Bescherung: ${formatDate(preview.event_date)}`].filter(Boolean).join(' · ')),
    preview.members.length > 0 && h('p', { class: 'small' }, 'Schon dabei: ', preview.members.join(', ')),
    preview.drawn && h('p', { class: 'card warn small' },
      'In dieser Gruppe wurde bereits ausgelost. Ein Admin muss die Auslosung erst zurücksetzen, bevor du beitreten kannst.'),
    h('p', { class: 'small muted' }, 'Bist du schon Mitglied? Dann öffne einfach deinen persönlichen Link – nicht nochmal beitreten.'),
    form));
}

// ----- Gruppe --------------------------------------------------------

async function renderGroup(token) {
  let state;
  try {
    state = await rpc('get_state', { p_token: token });
  } catch (err) {
    forgetToken(token);
    throw err;
  }
  rememberToken(token);

  const { me, group, members } = state;
  const isAdmin = me.role === 'admin';
  const others = members.filter((m) => m.id !== me.id);
  const nameOf = (id) => members.find((m) => m.id === id)?.display_name ?? '(ehemaliges Mitglied)';
  const reload = () => renderGroup(token);
  const ctx = { token, state, me, group, members, others, isAdmin, nameOf, reload };

  const header = h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('h1', null, group.name),
      h('div', { class: 'row' },
        isAdmin && h('span', { class: 'badge admin' }, 'Du bist Admin'),
        group.drawn_at ? h('span', { class: 'badge ok' }, 'Ausgelost') : h('span', { class: 'badge' }, 'Noch nicht gelost'))),
    h('p', { class: 'small muted' }, 'Du bist hier als ', h('strong', null, me.display_name)),
    group.description && h('p', { class: 'wish-details' }, group.description),
    h('p', { class: 'small muted' },
      [`${members.length} Mitglied${members.length === 1 ? '' : 'er'}`,
        group.budget && `Budget: ${group.budget}`,
        group.event_date && `Bescherung: ${formatDate(group.event_date)}`].filter(Boolean).join(' · ')));

  const assignment = state.assignment;
  const assignmentCard = group.drawn_at
    ? (assignment
      ? h('div', { class: 'card highlight' },
        h('p', { class: 'small muted' }, 'Psst … du beschenkst:'),
        h('div', { class: 'big-name' }, `🎁 ${assignment.receiver_name}`),
        h('h3', null, 'Wunschliste'),
        wishList(assignment.wishes, { empty: 'Noch keine Wünsche eingetragen. Schau später nochmal vorbei!' }))
      : h('div', { class: 'card warn' },
        h('p', null, 'Die Auslosung ist gelaufen, aber du warst zu dem Zeitpunkt noch kein Mitglied.')))
    : h('div', { class: 'card' },
      h('h2', null, 'Auslosung'),
      h('p', { class: 'muted' }, isAdmin
        ? 'Sobald alle dabei sind und ihre Ausschlüsse eingetragen haben, kannst du unten im Admin-Bereich die Auslosung starten.'
        : 'Die Auslosung wurde noch nicht gestartet. Trag schon mal deine Wünsche ein!'));

  const isFresh = freshToken === token;
  freshToken = null;

  render(
    h('p', null, h('a', { href: '#/' }, '← Alle Gruppen')),
    personalLinkCard(token, isFresh),
    header,
    assignmentCard,
    myWishesCard(ctx),
    exclusionsCard(ctx),
    membersCard(ctx),
    isAdmin && adminCard(ctx),
    leaveCard(ctx));
}

function personalLinkCard(token, isFresh) {
  const body = [
    h('p', { class: 'small' },
      'Das ist dein Zugang – es gibt kein Passwort. Speichere den Link (z. B. als Lesezeichen oder in einer Notiz an dich selbst), ',
      'damit du auch auf anderen Geräten reinkommst. ', h('strong', null, 'Nicht weitergeben:'),
      ' Wer den Link hat, sieht, wen du beschenkst.'),
    copyBox(personalUrl(token), 'Mein persönlicher Link'),
  ];
  if (isFresh) {
    return h('div', { class: 'card highlight' }, h('h2', null, '🔑 Dein persönlicher Link'), body);
  }
  return h('details', { class: 'card' }, h('summary', null, '🔑 Mein persönlicher Link'), body);
}

function wishList(wishes, { empty, onDelete } = {}) {
  if (!wishes?.length) return h('p', { class: 'muted small' }, empty || 'Keine Wünsche.');
  return h('ul', { class: 'list' }, wishes.map((w) => {
    const link = w.link && safeUrl(w.link);
    return h('li', { class: 'spread' },
      h('div', { style: 'min-width:0;flex:1' },
        h('div', { class: 'wish-title' }, w.title),
        w.details && h('div', { class: 'wish-details small' }, w.details),
        link && h('a', { href: link, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'small' }, 'Link öffnen ↗')),
      onDelete && h('button', { class: 'danger small', onclick: (e) => onDelete(w, e.target) }, 'Löschen'));
  }));
}

function myWishesCard({ token, state, reload }) {
  const form = h('form', { class: 'stack' },
    h('div', { class: 'grid2' },
      h('div', null,
        h('label', { for: 'w-title' }, 'Wunsch'),
        h('input', { id: 'w-title', name: 'title', required: true, maxlength: 200, placeholder: 'z. B. Ein gutes Buch' })),
      h('div', null,
        h('label', { for: 'w-link' }, 'Link (optional)'),
        h('input', { id: 'w-link', name: 'link', type: 'url', maxlength: 1000, placeholder: 'https://…' }))),
    h('div', null,
      h('label', { for: 'w-details' }, 'Details (optional)'),
      h('textarea', { id: 'w-details', name: 'details', maxlength: 2000, placeholder: 'Größe, Farbe, Alternativen …' })),
    h('button', { type: 'submit' }, 'Wunsch hinzufügen'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formData(form);
    if (f.link.trim() && !safeUrl(f.link.trim())) return toast('Der Link muss mit http:// oder https:// beginnen.', true);
    run(form.querySelector('button[type=submit]'), async () => {
      await rpc('add_wish', { p_token: token, p_title: f.title, p_details: f.details, p_link: f.link });
      toast('Wunsch gespeichert');
      reload();
    });
  });

  const onDelete = (wish, button) => run(button, async () => {
    await rpc('delete_wish', { p_token: token, p_wish_id: wish.id });
    reload();
  });

  return h('div', { class: 'card' },
    h('h2', null, 'Meine Wünsche'),
    h('p', { class: 'small muted' }, '🔒 Sichtbar nur für deine:n ausgeloste:n Wichtel und die Admins der Gruppe.'),
    wishList(state.my_wishes, { empty: 'Du hast noch keine Wünsche eingetragen.', onDelete }),
    h('hr', { style: 'border:none;border-top:1px solid var(--border);margin:1rem 0' }),
    form);
}

function exclusionsCard({ token, state, group, others, nameOf, reload }) {
  const locked = !!group.drawn_at;
  const exclusions = state.my_exclusions;

  const section = (kind, title, hint) => {
    const items = exclusions.filter((x) => x.kind === kind);
    const taken = new Set(items.map((x) => x.target_member_id));
    const options = others.filter((m) => !taken.has(m.id));
    const select = h('select', { 'aria-label': title },
      h('option', { value: '' }, '— Person auswählen —'),
      options.map((m) => h('option', { value: m.id }, m.display_name)));
    const add = h('button', {
      class: 'secondary small',
      onclick: () => {
        if (!select.value) return;
        run(add, async () => {
          await rpc('add_exclusion', { p_token: token, p_target_id: select.value, p_kind: kind });
          reload();
        });
      },
    }, 'Hinzufügen');

    return h('div', null,
      h('h3', null, title),
      h('p', { class: 'small muted' }, hint),
      items.length
        ? h('ul', { class: 'list' }, items.map((x) => h('li', { class: 'spread' },
          h('span', null, nameOf(x.target_member_id)),
          !locked && h('button', {
            class: 'secondary small',
            onclick: (e) => run(e.target, async () => {
              await rpc('delete_exclusion', { p_token: token, p_exclusion_id: x.id });
              reload();
            }),
          }, 'Entfernen'))))
        : h('p', { class: 'small muted' }, 'Niemand.'),
      !locked && options.length > 0 && h('div', { class: 'row', style: 'margin-top:.5rem' },
        h('div', { style: 'flex:1;min-width:180px' }, select), add));
  };

  return h('details', { class: 'card', open: exclusions.length > 0 || null },
    h('summary', null, '🤫 Geheime Ausschlüsse'),
    h('p', { class: 'small muted' },
      'Diese Angaben sieht niemand außer dir – auch die Admins nicht. Sie werden nur bei der Auslosung berücksichtigt.',
      locked ? ' Nach der Auslosung können sie nicht mehr geändert werden.' : ''),
    others.length === 0
      ? h('p', { class: 'small muted' }, 'Sobald weitere Mitglieder beigetreten sind, kannst du hier Ausschlüsse festlegen.')
      : h('div', { class: 'stack' },
        section('no_give', 'Ich möchte nicht ziehen …', 'Diese Personen möchtest du nicht beschenken.'),
        section('no_receive', 'Ich möchte nicht gezogen werden von …', 'Diese Personen sollen dich nicht beschenken.')));
}

function membersCard({ token, group, members, me, isAdmin, reload }) {
  const nameForm = h('form', { class: 'row', style: 'margin-top:.75rem' },
    h('div', { style: 'flex:1;min-width:180px' },
      h('input', { name: 'display_name', required: true, maxlength: 60, value: me.display_name, 'aria-label': 'Mein Name' })),
    h('button', { type: 'submit', class: 'secondary small' }, 'Namen ändern'));
  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(nameForm.querySelector('button'), async () => {
      await rpc('rename_member', { p_token: token, p_display_name: formData(nameForm).display_name });
      toast('Name geändert');
      reload();
    });
  });

  return h('div', { class: 'card' },
    h('h2', null, `Mitglieder (${members.length})`),
    h('ul', { class: 'list' }, members.map((m) => h('li', { class: 'spread' },
      h('div', { class: 'row' },
        h('span', null, m.display_name, m.id === me.id ? ' (du)' : ''),
        m.role === 'admin' && h('span', { class: 'badge admin' }, 'Admin')),
      isAdmin && m.id !== me.id && h('div', { class: 'row' },
        h('button', {
          class: 'secondary small',
          onclick: (e) => run(e.target, async () => {
            await rpc('set_member_role', {
              p_token: token, p_member_id: m.id, p_role: m.role === 'admin' ? 'member' : 'admin',
            });
            reload();
          }),
        }, m.role === 'admin' ? 'Admin entziehen' : 'Zum Admin machen'),
        !group.drawn_at && h('button', {
          class: 'danger small',
          onclick: (e) => {
            if (!confirm(`${m.display_name} wirklich aus der Gruppe entfernen?`)) return;
            run(e.target, async () => {
              await rpc('remove_member', { p_token: token, p_member_id: m.id });
              reload();
            });
          },
        }, 'Entfernen'))))),
    nameForm);
}

function adminCard({ token, state, group, members, reload }) {
  const link = inviteUrl(group.invite_code);
  const share = navigator.share && (() => navigator.share({
    title: `Wichteln: ${group.name}`,
    text: `Du bist zum Wichteln in „${group.name}“ eingeladen!`,
    url: link,
  }).catch(() => {}));

  const drawButton = group.drawn_at
    ? h('button', {
      class: 'danger',
      onclick: (e) => {
        if (!confirm('Auslosung wirklich zurücksetzen? Alle Zuteilungen gehen verloren und es muss neu gelost werden.')) return;
        run(e.target, async () => {
          await rpc('reset_draw', { p_token: token });
          toast('Auslosung zurückgesetzt');
          reload();
        });
      },
    }, 'Auslosung zurücksetzen')
    : h('button', {
      disabled: members.length < 3,
      onclick: (e) => {
        if (!confirm(`Jetzt unter ${members.length} Mitgliedern auslosen? Danach kann niemand mehr beitreten oder Ausschlüsse ändern.`)) return;
        run(e.target, async () => {
          await rpc('draw_names', { p_token: token });
          toast('Ausgelost! 🎉 Jede:r sieht jetzt über den eigenen Link, wen sie/er beschenkt.');
          reload();
        });
      },
    }, '🎲 Auslosung starten');

  const editForm = h('form', { class: 'stack' },
    h('div', { class: 'grid2' },
      h('div', null, h('label', { for: 'e-name' }, 'Name'),
        h('input', { id: 'e-name', name: 'name', required: true, maxlength: 100, value: group.name })),
      h('div', null, h('label', { for: 'e-budget' }, 'Budget'),
        h('input', { id: 'e-budget', name: 'budget', maxlength: 50, value: group.budget || '' }))),
    h('div', null, h('label', { for: 'e-date' }, 'Datum der Bescherung'),
      h('input', { id: 'e-date', name: 'event_date', type: 'date', value: group.event_date || '' })),
    h('div', null, h('label', { for: 'e-desc' }, 'Beschreibung'),
      h('textarea', { id: 'e-desc', name: 'description', maxlength: 2000, value: group.description || '' })),
    h('div', { class: 'row' },
      h('button', { type: 'submit', class: 'secondary' }, 'Speichern'),
      h('button', {
        type: 'button', class: 'danger',
        onclick: (e) => {
          if (!confirm(`Gruppe „${group.name}“ mit allen Wünschen endgültig löschen?`)) return;
          run(e.target, async () => {
            await rpc('delete_group', { p_token: token });
            forgetToken(token);
            toast('Gruppe gelöscht');
            navigate('#/');
          });
        },
      }, 'Gruppe löschen')));
  editForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formData(editForm);
    run(editForm.querySelector('button[type=submit]'), async () => {
      await rpc('update_group', {
        p_token: token, p_name: f.name, p_description: f.description,
        p_budget: f.budget, p_event_date: f.event_date || null,
      });
      toast('Gespeichert');
      reload();
    });
  });

  const allWishes = state.all_wishes || {};

  return h('div', { class: 'card' },
    h('h2', null, '🛠️ Admin-Bereich'),

    h('h3', null, 'Leute einladen'),
    h('p', { class: 'small muted' },
      'Schick diesen Link an alle, die mitmachen sollen. Jede:r wählt beim Beitreten einen Namen und bekommt einen eigenen persönlichen Link.'),
    copyBox(link, 'Einladungslink'),
    h('div', { class: 'row', style: 'margin-top:.5rem' },
      share && h('button', { class: 'secondary small', onclick: share }, 'Teilen …'),
      h('button', {
        class: 'secondary small',
        onclick: (e) => {
          if (!confirm('Neuen Einladungslink erzeugen? Der alte Link funktioniert dann nicht mehr (persönliche Links bleiben gültig).')) return;
          run(e.target, async () => {
            await rpc('regenerate_invite', { p_token: token });
            toast('Neuer Einladungslink erstellt');
            reload();
          });
        },
      }, 'Neuen Link erzeugen')),

    h('h3', { style: 'margin-top:1.25rem' }, 'Auslosung'),
    h('p', { class: 'small muted' }, group.drawn_at
      ? `Ausgelost am ${new Date(group.drawn_at).toLocaleString('de-DE')}. Die Paarungen sind geheim – auch du siehst nur deine eigene.`
      : members.length < 3
        ? 'Für die Auslosung braucht ihr mindestens 3 Mitglieder.'
        : 'Die geheimen Ausschlüsse aller Mitglieder werden automatisch berücksichtigt. Du siehst sie nicht und auch nicht, wer wen zieht.'),
    drawButton,

    h('h3', { style: 'margin-top:1.25rem' }, 'Wünsche aller Mitglieder'),
    h('div', null, members.map((m) => {
      const list = allWishes[m.id] || [];
      return h('details', null,
        h('summary', null, `${m.display_name} (${list.length})`),
        wishList(list, { empty: 'Noch keine Wünsche.' }));
    })),

    h('details', { style: 'margin-top:1.25rem' },
      h('summary', null, 'Gruppe bearbeiten'),
      editForm));
}

function leaveCard({ token, group, members, isAdmin }) {
  const forget = h('button', {
    class: 'link small',
    onclick: () => {
      if (!confirm('Gruppe auf diesem Gerät vergessen? Du bleibst Mitglied und kommst über deinen persönlichen Link wieder rein.')) return;
      forgetToken(token);
      navigate('#/');
    },
  }, 'Auf diesem Gerät vergessen');

  let leave = null;
  if (!group.drawn_at) {
    const onlyAdmin = isAdmin && members.filter((m) => m.role === 'admin').length === 1 && members.length > 1;
    leave = onlyAdmin
      ? h('span', null, 'Zum Verlassen erst jemand anderen zum Admin machen.')
      : h('button', {
        class: 'link small',
        onclick: (e) => {
          const last = members.length === 1;
          if (!confirm(last ? 'Du bist das letzte Mitglied – die Gruppe wird gelöscht. Fortfahren?' : 'Gruppe wirklich verlassen? Deine Wünsche werden gelöscht.')) return;
          run(e.target, async () => {
            await rpc('remove_member', { p_token: token });
            forgetToken(token);
            toast('Gruppe verlassen');
            navigate('#/');
          });
        },
      }, 'Gruppe verlassen');
  }

  return h('p', { class: 'small muted row', style: 'justify-content:center;gap:1.5rem' }, forget, leave);
}

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

window.addEventListener('hashchange', route);
route();
