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
    h('button', { type: 'button', onclick: () => copyText(text, input) }, 'Kopieren'));
}


function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : String(name).slice(0, 2);
  return letters.toUpperCase();
}

function avatar(name, cls = '') {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  return h('span', { class: `avatar ${cls}`, style: `background:hsl(${hue} 42% 42%)`, 'aria-hidden': 'true' }, initials(name));
}

function cardHead(icon, title, subtitle) {
  return h('div', { class: 'card-head' },
    h('span', { class: 'icon', 'aria-hidden': 'true' }, icon),
    h('div', null, h('h2', null, title), subtitle && h('p', null, subtitle)));
}

function field(id, labelText, input, hint) {
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, labelText), input, hint && h('p', { class: 'hint' }, hint));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function groupChips(group, memberCount) {
  return h('div', { class: 'chips' },
    memberCount != null && h('span', { class: 'chip' }, '👥 ', plural(memberCount, 'Mitglied', 'Mitglieder')),
    group.budget && h('span', { class: 'chip' }, '💶 ', group.budget),
    group.event_date && h('span', { class: 'chip' }, '📅 ', formatDate(group.event_date)));
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

async function route() {
  if (!configured) return renderSetupHint();
  const [, page, param, sub] = (location.hash.replace(/^#/, '') || '/').split('/');
  window.scrollTo(0, 0);
  try {
    if (page === 'join' && param) return await renderJoin(param);
    if (page === 'm' && param) return await renderGroup(param, sub || 'uebersicht');
    return await renderDashboard();
  } catch (err) {
    console.error(err);
    const invalidLink = errorMessage(err).includes('persönliche Link ist ungültig');
    render(h('div', { class: 'narrow' }, h('div', { class: 'card' },
      cardHead('😕', invalidLink ? 'Dieser Link funktioniert nicht (mehr)' : 'Da ist etwas schiefgelaufen', errorMessage(err)),
      invalidLink && h('p', { class: 'small', style: 'margin-bottom:1rem' },
        'Prüf, ob du den Link vollständig kopiert hast. Admins deiner Gruppe können dir deinen Link jederzeit nochmal schicken.'),
      h('a', { href: '#/', class: 'btn secondary' }, 'Zur Startseite'))));
  }
}

// ---------------------------------------------------------------------
// Ansichten
// ---------------------------------------------------------------------

function renderSetupHint() {
  render(h('div', { class: 'narrow' }, h('div', { class: 'card' },
    cardHead('🔧', 'Fast fertig!', 'OpenWichteln ist noch nicht mit einer Datenbank verbunden.'),
    h('p', null, 'Trage deine Supabase-URL und den Key in ', h('code', null, 'app/js/config.js'),
      ' ein. Die Anleitung steht in der README.'))));
}

// ----- Startseite ----------------------------------------------------

async function renderDashboard() {
  const tokens = loadTokens();
  const memberships = tokens.length ? await rpc('list_memberships', { p_tokens: tokens }) : [];

  // Links, die es nicht mehr gibt (Gruppe gelöscht / entfernt), vergessen
  const valid = new Set(memberships.map((m) => m.token));
  if (tokens.some((t) => !valid.has(t))) saveTokens(tokens.filter((t) => valid.has(t)));

  const createForm = h('form', null,
    h('div', { class: 'fields-2' },
      field('g-name', 'Name der Gruppe', h('input', { name: 'name', required: true, maxlength: 100, placeholder: 'z. B. Familie 2026' })),
      field('g-display', 'Dein Name', h('input', { name: 'display_name', required: true, maxlength: 60, placeholder: 'So sehen dich die anderen' }))),
    h('div', { class: 'fields-2' },
      field('g-budget', 'Budget (optional)', h('input', { name: 'budget', maxlength: 50, placeholder: 'z. B. 25 €' })),
      field('g-date', 'Bescherung (optional)', h('input', { name: 'event_date', type: 'date' }))),
    h('div', { class: 'field', style: 'margin-top:.8rem' },
      h('label', { for: 'g-desc' }, 'Infos für alle (optional)'),
      h('textarea', { id: 'g-desc', name: 'description', maxlength: 2000, placeholder: 'Ort, Uhrzeit, Regeln …' })),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'lg' }, '🎄 Gruppe erstellen')));

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

  const importForm = h('form', null,
    h('div', { class: 'copybox' },
      h('input', { name: 'link', required: true, placeholder: 'https://…#/m/…', 'aria-label': 'Persönlicher Link' }),
      h('button', { type: 'submit', class: 'secondary' }, 'Öffnen')));
  importForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const token = extractToken(formData(importForm).link);
    if (!token) return toast('Das sieht nicht nach einem persönlichen Link aus.', true);
    navigate(`#/m/${token}`);
  });

  const hero = h('section', { class: 'hero' },
    h('p', { class: 'eyebrow' }, 'Wichteln ohne Zettelchaos'),
    h('h1', null, 'Geheim wichteln mit Familie & Freunden'),
    h('p', { class: 'lead' }, 'Kein Konto, keine App: Gruppe anlegen, Link verschicken, Wünsche sammeln und mit einem Klick fair auslosen.'),
    h('div', { class: 'how' },
      h('div', null, h('b', null, '1 · Gruppe erstellen'), h('small', null, 'Du wirst Admin der Gruppe.')),
      h('div', null, h('b', null, '2 · Link teilen'), h('small', null, 'Alle treten bei und tragen Wünsche ein.')),
      h('div', null, h('b', null, '3 · Auslosen'), h('small', null, 'Jede:r sieht nur das eigene Wichtelkind.'))));

  const groupsSection = memberships.length > 0 && h('section', { class: 'stack-sm' },
    h('h2', null, 'Meine Gruppen'),
    h('div', { class: 'tiles' }, memberships.map((m) => h('a', { href: `#/m/${m.token}`, class: 'tile' },
      h('div', { class: 'title' }, m.group_name),
      h('div', { class: 'person small muted' }, avatar(m.display_name), h('span', null, 'Du bist ', h('b', null, m.display_name))),
      h('div', { class: 'row' },
        m.drawn ? h('span', { class: 'badge ok' }, '✓ Ausgelost') : h('span', { class: 'badge' }, 'Wünsche sammeln'),
        m.role === 'admin' && h('span', { class: 'badge admin' }, 'Admin'),
        m.event_date && h('span', { class: 'badge' }, '📅 ', formatDate(m.event_date)))))));

  render(
    hero,
    h('div', { class: 'stack' },
      groupsSection,
      h('div', { class: 'layout' },
        h('section', { class: 'card', id: 'create' },
          cardHead('✨', 'Neue Gruppe erstellen', 'Dauert 30 Sekunden. Danach bekommst du den Einladungslink.'),
          createForm),
        h('aside', { class: 'card soft' },
          cardHead('🔑', 'Schon in einer Gruppe?', 'Auf einem neuen Gerät? Füge deinen persönlichen Link ein.'),
          importForm,
          h('p', { class: 'hint' }, 'Auf diesem Gerät merken wir uns deine Gruppen automatisch.')))));
}

// ----- Einladung -----------------------------------------------------

async function renderJoin(code) {
  // Schon Mitglied (Link auf diesem Gerät gespeichert)? Dann direkt zur eigenen Seite.
  const tokens = loadTokens();
  if (tokens.length) {
    const own = await rpc('find_membership', { p_invite: code, p_tokens: tokens });
    if (own) {
      location.replace(`#/m/${own}`);
      return;
    }
  }

  const preview = await rpc('group_preview', { p_invite: code });

  if (!preview) {
    return render(h('div', { class: 'narrow' }, h('div', { class: 'card' },
      cardHead('🔗', 'Einladung ungültig', 'Dieser Einladungslink existiert nicht (mehr).'),
      h('p', { class: 'small' }, 'Frag die Person, die dich eingeladen hat, nach einem neuen Link.'),
      h('div', { class: 'form-actions' }, h('a', { href: '#/', class: 'btn secondary' }, 'Zur Startseite')))));
  }

  const form = h('form', null,
    field('j-name', 'Wie heißt du?', h('input', { name: 'display_name', required: true, maxlength: 60, placeholder: 'Dein Name' }),
      'So sehen dich die anderen in der Gruppe.'),
    h('div', { class: 'form-actions' },
      h('button', { type: 'submit', class: 'lg block', disabled: preview.drawn }, 'Mitmachen 🎁')));

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

  render(h('div', { class: 'narrow' },
    h('section', { class: 'hero' },
      h('p', { class: 'eyebrow' }, 'Du bist eingeladen'),
      h('h1', null, preview.name),
      preview.description && h('p', { class: 'lead', style: 'white-space:pre-wrap' }, preview.description),
      groupChips(preview, preview.members.length),
      preview.members.length > 0 && h('div', { class: 'row', style: 'margin-top:1rem' },
        h('div', { class: 'avatars' }, preview.members.slice(0, 8).map((n) => avatar(n))),
        h('p', { class: 'small', style: 'margin-left:.6rem' }, preview.members.slice(0, 3).join(', '),
          preview.members.length > 3 ? ` und ${preview.members.length - 3} weitere` : '', ' sind dabei'))),
    h('div', { class: 'card' },
      preview.drawn
        ? h('div', null,
          cardHead('⏳', 'Hier wurde schon gelost', 'Beitreten geht erst wieder, wenn ein Admin die Auslosung zurücksetzt.'))
        : form),
    h('div', { class: 'card soft', style: 'margin-top:1rem' },
      h('h3', null, 'So geht’s weiter'),
      h('ul', { class: 'checklist', style: 'margin-top:.75rem' },
        h('li', null, h('span', { class: 'mark' }, '1'), h('div', { class: 'text' }, 'Du bekommst einen persönlichen Link', h('small', null, 'Kein Passwort nötig – speicher ihn dir gut.'))),
        h('li', null, h('span', { class: 'mark' }, '2'), h('div', { class: 'text' }, 'Wünsche eintragen', h('small', null, 'Nur dein Wichtel und die Admins sehen sie.'))),
        h('li', null, h('span', { class: 'mark' }, '3'), h('div', { class: 'text' }, 'Auslosung abwarten', h('small', null, 'Dann siehst du, wen du beschenkst.')))),
      h('p', { class: 'hint', style: 'margin-top:.75rem' }, 'Schon Mitglied? Öffne einfach deinen persönlichen Link statt nochmal beizutreten.'))));
}

// ----- Gruppe --------------------------------------------------------

const TABS = [
  { key: 'uebersicht', label: 'Übersicht' },
  { key: 'wuensche', label: 'Meine Wünsche' },
  { key: 'ausschluesse', label: 'Ausschlüsse' },
  { key: 'mitglieder', label: 'Mitglieder' },
  { key: 'admin', label: 'Admin', adminOnly: true },
];

async function renderGroup(token, tab) {
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
  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin);
  if (!tabs.some((t) => t.key === tab)) tab = 'uebersicht';

  const ctx = {
    token, state, me, group, members, isAdmin,
    others: members.filter((m) => m.id !== me.id),
    nameOf: (id) => members.find((m) => m.id === id)?.display_name ?? '(ehemaliges Mitglied)',
    tabUrl: (key) => `#/m/${token}/${key}`,
    reload: () => renderGroup(token, tab),
    fresh: freshToken === token,
  };
  freshToken = null;

  const drawn = !!group.drawn_at;
  const steps = [
    ['Beigetreten', 'done'],
    ['Wünsche sammeln', drawn ? 'done' : 'current'],
    ['Auslosung', drawn ? 'done' : ''],
    ['Beschenken', drawn ? 'current' : ''],
  ];

  const hero = h('section', { class: 'hero' },
    h('div', { class: 'spread' },
      h('p', { class: 'eyebrow' }, 'Wichtelgruppe'),
      isAdmin && h('span', { class: 'chip gold' }, '★ Du bist Admin')),
    h('h1', null, group.name),
    h('p', { class: 'lead' }, 'Du bist dabei als ', h('b', { style: 'color:#fff' }, me.display_name)),
    groupChips(group, members.length),
    h('div', { class: 'steps' }, steps.map(([label, cls]) => h('div', { class: `step ${cls}` }, h('span', null, label)))));

  const counts = { wuensche: state.my_wishes.length, mitglieder: members.length };
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Bereiche' }, tabs.map((t) => h('a', {
    href: ctx.tabUrl(t.key), class: t.key === tab ? 'active' : null, 'aria-current': t.key === tab ? 'page' : null,
  }, t.label, counts[t.key] != null && h('span', { class: 'count' }, `(${counts[t.key]})`))));

  const views = {
    uebersicht: overviewTab, wuensche: wishesTab, ausschluesse: exclusionsTab, mitglieder: membersTab, admin: adminTab,
  };

  render(
    h('a', { href: '#/', class: 'back' }, '← Meine Gruppen'),
    hero,
    nav,
    views[tab](ctx));
}

function wishList(wishes, { empty, onDelete } = {}) {
  if (!wishes?.length) return h('div', { class: 'empty' }, h('span', { class: 'big' }, '🎈'), empty || 'Keine Wünsche.');
  return h('div', { class: 'wishes' }, wishes.map((w) => {
    const link = w.link && safeUrl(w.link);
    return h('div', { class: 'wish' },
      h('span', { class: 'bullet', 'aria-hidden': 'true' }, '🎁'),
      h('div', { class: 'grow' },
        h('div', { class: 'wish-title' }, w.title),
        w.details && h('div', { class: 'wish-details' }, w.details),
        link && h('a', { href: link, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'Link ansehen ↗')),
      onDelete && h('button', { class: 'ghost sm', title: 'Wunsch löschen', 'aria-label': `${w.title} löschen`, onclick: (e) => onDelete(w, e.currentTarget) }, '✕'));
  }));
}

function drawButton({ token, group, members, reload }, extraClass = '') {
  if (group.drawn_at) {
    return h('button', {
      class: `danger ${extraClass}`,
      onclick: (e) => {
        if (!confirm('Auslosung wirklich zurücksetzen? Alle Zuteilungen gehen verloren und es muss neu gelost werden.')) return;
        run(e.currentTarget, async () => {
          await rpc('reset_draw', { p_token: token });
          toast('Auslosung zurückgesetzt');
          reload();
        });
      },
    }, 'Auslosung zurücksetzen');
  }
  return h('button', {
    class: extraClass,
    disabled: members.length < 3,
    onclick: (e) => {
      if (!confirm(`Jetzt unter ${members.length} Mitgliedern auslosen? Danach kann niemand mehr beitreten oder Ausschlüsse ändern.`)) return;
      run(e.currentTarget, async () => {
        await rpc('draw_names', { p_token: token });
        toast('Ausgelost! 🎉');
        reload();
      });
    },
  }, '🎲 Jetzt auslosen');
}

// ----- Tab: Übersicht --------------------------------------------------

function overviewTab(ctx) {
  const { state, group, members, isAdmin, tabUrl } = ctx;
  const drawn = !!group.drawn_at;
  const assignment = state.assignment;

  let main;
  if (drawn && assignment) {
    main = h('section', { class: 'card gift-card' },
      h('p', { class: 'label' }, 'Psst … dein Wichtelkind ist'),
      h('div', { class: 'name' }, assignment.receiver_name),
      h('p', { class: 'label', style: 'margin-bottom:1rem' }, 'Verrat es niemandem! 🤫'),
      h('h3', { style: 'margin-bottom:.6rem' }, `Wunschliste von ${assignment.receiver_name}`),
      wishList(assignment.wishes, { empty: 'Noch keine Wünsche eingetragen – schau später nochmal rein.' }));
  } else if (drawn) {
    main = h('section', { class: 'card' },
      cardHead('⏳', 'Du warst bei der Auslosung noch nicht dabei', 'Bitte einen Admin, die Auslosung zurückzusetzen und neu zu losen.'));
  } else {
    const wishCount = state.my_wishes.length;
    const exclCount = state.my_exclusions.length;
    const enough = members.length >= 3;
    main = h('section', { class: 'card' },
      cardHead('🧭', 'Deine nächsten Schritte', 'Bis zur Auslosung kannst du alles noch ändern.'),
      h('ul', { class: 'checklist' },
        h('li', { class: 'done' }, h('span', { class: 'mark' }, '✓'),
          h('div', { class: 'text' }, 'Du bist dabei', h('small', null, `als ${ctx.me.display_name}`))),
        h('li', { class: wishCount ? 'done' : 'todo' }, h('span', { class: 'mark' }, wishCount ? '✓' : '2'),
          h('div', { class: 'text' }, 'Wünsche eintragen',
            h('small', null, wishCount ? plural(wishCount, 'Wunsch eingetragen', 'Wünsche eingetragen') : 'Damit dein Wichtel weiß, was dir Freude macht.')),
          h('a', { href: tabUrl('wuensche'), class: `btn sm ${wishCount ? 'secondary' : ''}` }, wishCount ? 'Bearbeiten' : 'Eintragen')),
        h('li', { class: exclCount ? 'done' : '' }, h('span', { class: 'mark' }, exclCount ? '✓' : '3'),
          h('div', { class: 'text' }, 'Ausschlüsse festlegen (optional)',
            h('small', null, exclCount ? `${exclCount} festgelegt – nur für dich sichtbar` : 'Z. B. damit Paare sich nicht gegenseitig ziehen.')),
          h('a', { href: tabUrl('ausschluesse'), class: 'btn sm secondary' }, exclCount ? 'Ändern' : 'Festlegen')),
        h('li', null, h('span', { class: 'mark' }, '4'),
          h('div', { class: 'text' }, 'Auslosung',
            h('small', null, isAdmin
              ? (enough ? `Bereit – ${plural(members.length, 'Mitglied', 'Mitglieder')} dabei.` : 'Mindestens 3 Mitglieder nötig – lade noch Leute ein.')
              : 'Startet ein Admin, sobald alle dabei sind.')),
          isAdmin && drawButton(ctx, 'sm'))));
  }

  // Frisch erstellt/beigetreten: persönlichen Link ganz nach oben
  const sidebar = ctx.fresh ? [] : [personalLinkCard(ctx)];
  if (isAdmin && !drawn) sidebar.unshift(inviteCard(ctx));
  sidebar.push(membersMiniCard(ctx));
  if (group.description) {
    sidebar.push(h('section', { class: 'card' }, cardHead('📝', 'Infos'), h('p', { class: 'small', style: 'white-space:pre-wrap' }, group.description)));
  }

  const layout = h('div', { class: 'layout' }, main, h('aside', { class: 'stack' }, sidebar));
  const top = [];
  if (ctx.fresh) top.push(personalLinkCard(ctx));
  return top.length ? h('div', { class: 'stack' }, top, layout) : layout;
}

function personalLinkCard({ token, fresh }) {
  return h('section', { class: `card ${fresh ? 'accent' : ''}` },
    cardHead('🔑', 'Dein persönlicher Link', fresh ? 'Jetzt speichern – das ist dein Zugang!' : 'Damit kommst du auf jedem Gerät rein.'),
    copyBox(personalUrl(token), 'Mein persönlicher Link'),
    h('p', { class: 'hint' }, 'Nicht weitergeben – wer den Link hat, sieht dein Wichtelkind.'));
}

function inviteCard({ group }) {
  const link = inviteUrl(group.invite_code);
  return h('section', { class: 'card' },
    cardHead('💌', 'Leute einladen', 'Schick diesen Link an alle, die mitmachen – oder füge Leute im Tab „Mitglieder“ direkt hinzu.'),
    copyBox(link, 'Einladungslink'),
    navigator.share && h('div', { class: 'form-actions' }, h('button', {
      class: 'secondary sm',
      onclick: () => navigator.share({
        title: `Wichteln: ${group.name}`, text: `Mach mit beim Wichteln in „${group.name}“!`, url: link,
      }).catch(() => {}),
    }, 'Teilen …')));
}

function membersMiniCard({ members, me, tabUrl }) {
  return h('section', { class: 'card' },
    h('div', { class: 'spread', style: 'margin-bottom:.8rem' },
      h('h2', null, `👥 Dabei (${members.length})`),
      h('a', { href: tabUrl('mitglieder'), class: 'small' }, 'Alle ansehen')),
    h('ul', { class: 'list' }, members.slice(0, 6).map((m) => h('li', null,
      h('div', { class: 'person' }, avatar(m.display_name),
        h('div', { class: 'who' }, h('b', null, m.display_name, m.id === me.id ? ' (du)' : '')),
        m.role === 'admin' && h('span', { class: 'badge admin' }, 'Admin'))))),
    members.length > 6 && h('p', { class: 'hint' }, `… und ${members.length - 6} weitere`));
}

// ----- Tab: Wünsche ----------------------------------------------------

function wishesTab({ token, state, reload }) {
  const form = h('form', null,
    field('w-title', 'Was wünschst du dir?', h('input', { name: 'title', required: true, maxlength: 200, placeholder: 'z. B. Ein gutes Krimi-Buch' })),
    field('w-link', 'Link (optional)', h('input', { name: 'link', type: 'url', maxlength: 1000, placeholder: 'https://…' })),
    field('w-details', 'Details (optional)', h('textarea', { name: 'details', maxlength: 2000, placeholder: 'Größe, Farbe, Alternativen …' })),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'block' }, '+ Wunsch hinzufügen')));

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

  return h('div', { class: 'layout' },
    h('section', { class: 'card' },
      cardHead('🎁', 'Meine Wunschliste', '🔒 Sehen nur dein Wichtel und die Admins.'),
      wishList(state.my_wishes, { empty: 'Noch leer – trag rechts deinen ersten Wunsch ein.', onDelete })),
    h('aside', { class: 'card' },
      cardHead('✍️', 'Neuer Wunsch'),
      form));
}

// ----- Tab: Ausschlüsse ------------------------------------------------

function exclusionsTab({ token, state, group, others, reload }) {
  const locked = !!group.drawn_at;
  const exclusions = state.my_exclusions;

  const picker = (kind, icon, title, subtitle) => {
    const byTarget = new Map(exclusions.filter((x) => x.kind === kind).map((x) => [x.target_member_id, x]));
    return h('section', { class: 'card' },
      cardHead(icon, title, subtitle),
      others.length === 0
        ? h('div', { class: 'empty' }, h('span', { class: 'big' }, '👋'), 'Sobald andere beigetreten sind, kannst du sie hier auswählen.')
        : h('div', { class: 'pick' }, others.map((m) => {
          const existing = byTarget.get(m.id);
          return h('button', {
            type: 'button', class: existing ? 'on' : null, disabled: locked, 'aria-pressed': existing ? 'true' : 'false',
            onclick: (e) => run(e.currentTarget, async () => {
              if (existing) await rpc('delete_exclusion', { p_token: token, p_exclusion_id: existing.id });
              else await rpc('add_exclusion', { p_token: token, p_target_id: m.id, p_kind: kind });
              reload();
            }),
          }, avatar(m.display_name), m.display_name);
        })),
      h('p', { class: 'hint', style: 'margin-top:.8rem' },
        byTarget.size ? `${byTarget.size} ausgewählt. Antippen zum Entfernen.` : 'Antippen zum Auswählen.'));
  };

  return h('div', { class: 'stack' },
    h('div', { class: 'card soft' },
      cardHead('🤫', 'Streng geheim', locked
        ? 'Die Auslosung ist gelaufen – Ausschlüsse sind jetzt eingefroren.'
        : 'Niemand sieht deine Auswahl – auch die Admins nicht. Sie wird nur bei der Auslosung berücksichtigt.')),
    h('div', { class: 'cols-2' },
      picker('no_give', '🙅', 'Ich möchte nicht ziehen …', 'Diese Personen willst du nicht beschenken.'),
      picker('no_receive', '🚫', 'Nicht gezogen werden von …', 'Diese Personen sollen dich nicht beschenken.')));
}

// ----- Tab: Mitglieder -------------------------------------------------

// Persönlichen Link eines Mitglieds anzeigen (nur Admins bekommen ihn vom Server)
function memberLinkPanel(m, intro) {
  const url = personalUrl(m.token);
  return h('div', { class: 'card soft', style: 'margin-top:.7rem' },
    h('p', { class: 'small', style: 'margin-bottom:.6rem' }, intro || `Persönlicher Link von ${m.display_name}:`),
    copyBox(url, `Link von ${m.display_name}`),
    navigator.share && h('div', { class: 'form-actions' }, h('button', {
      class: 'secondary sm',
      onclick: () => navigator.share({ title: 'Dein Wichtel-Link', text: `Hier ist dein Wichtel-Link, ${m.display_name}:`, url }).catch(() => {}),
    }, 'Teilen …')),
    h('p', { class: 'hint' }, `Nur an ${m.display_name} schicken – wer den Link hat, sieht das Wichtelkind der Person.`));
}

// Zuletzt hinzugefügte Person (Link nach dem Neuladen noch anzeigen)
let lastAdded = null;

function addMemberCard({ token, group, reload }) {
  const added = lastAdded && lastAdded.groupId === group.id ? lastAdded : null;
  lastAdded = null;
  if (group.drawn_at) {
    return h('section', { class: 'card' },
      cardHead('➕', 'Person hinzufügen', 'Nach der Auslosung kann niemand mehr dazukommen.'));
  }
  const form = h('form', null,
    h('div', { class: 'copybox' },
      h('input', { name: 'display_name', required: true, maxlength: 60, placeholder: 'Name', 'aria-label': 'Name der neuen Person' }),
      h('button', { type: 'submit' }, 'Hinzufügen')),
    h('p', { class: 'hint' }, 'Für Leute ohne eigenes Handy oder die du lieber direkt anlegst. Du bekommst danach ihren Link.'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = formData(form).display_name.trim();
    run(form.querySelector('button'), async () => {
      const newToken = await rpc('admin_add_member', { p_token: token, p_display_name: name });
      lastAdded = { groupId: group.id, display_name: name, token: newToken };
      toast(`${name} hinzugefügt`);
      reload();
    });
  });
  return h('section', { class: `card ${added ? 'accent' : ''}` },
    cardHead('➕', 'Person hinzufügen', 'Legt ein neues Mitglied an.'),
    form,
    added && memberLinkPanel(added, `✅ ${added.display_name} ist dabei. Schick ${added.display_name} jetzt diesen Link:`));
}

function membersTab(ctx) {
  const { token, group, members, me, isAdmin, reload } = ctx;
  const drawn = !!group.drawn_at;

  const list = h('ul', { class: 'list' }, members.map((m) => {
    const panelSlot = h('div');
    const actions = isAdmin && m.id !== me.id && h('div', { class: 'row' },
      h('button', {
        class: 'secondary sm',
        onclick: () => {
          if (panelSlot.firstChild) panelSlot.replaceChildren();
          else panelSlot.replaceChildren(memberLinkPanel(m));
        },
      }, '🔗 Link'),
      h('button', {
        class: 'secondary sm',
        onclick: (e) => run(e.currentTarget, async () => {
          await rpc('set_member_role', { p_token: token, p_member_id: m.id, p_role: m.role === 'admin' ? 'member' : 'admin' });
          reload();
        }),
      }, m.role === 'admin' ? 'Admin entziehen' : 'Zum Admin'),
      !drawn && h('button', {
        class: 'danger sm',
        onclick: (e) => {
          if (!confirm(`${m.display_name} wirklich aus der Gruppe entfernen?`)) return;
          run(e.currentTarget, async () => {
            await rpc('remove_member', { p_token: token, p_member_id: m.id });
            reload();
          });
        },
      }, 'Entfernen'));
    return h('li', null,
      h('div', { class: 'spread' },
        h('div', { class: 'person' }, avatar(m.display_name),
          h('div', { class: 'who' }, h('b', null, m.display_name, m.id === me.id ? ' (du)' : '')),
          m.role === 'admin' && h('span', { class: 'badge admin' }, 'Admin')),
        actions),
      panelSlot);
  }));

  const nameForm = h('form', null,
    h('div', { class: 'copybox' },
      h('input', { name: 'display_name', required: true, maxlength: 60, value: me.display_name, 'aria-label': 'Mein Name' }),
      h('button', { type: 'submit', class: 'secondary' }, 'Speichern')));
  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(nameForm.querySelector('button'), async () => {
      await rpc('rename_member', { p_token: token, p_display_name: formData(nameForm).display_name });
      toast('Name geändert');
      reload();
    });
  });

  const onlyAdmin = isAdmin && members.filter((m) => m.role === 'admin').length === 1 && members.length > 1;
  const leave = drawn
    ? h('p', { class: 'hint' }, 'Nach der Auslosung kann niemand austreten.')
    : onlyAdmin
      ? h('p', { class: 'hint' }, 'Du bist der einzige Admin – mach zuerst jemand anderen zum Admin, um auszutreten.')
      : h('button', {
        class: 'danger sm',
        onclick: (e) => {
          const last = members.length === 1;
          if (!confirm(last ? 'Du bist das letzte Mitglied – die Gruppe wird gelöscht. Fortfahren?' : 'Gruppe wirklich verlassen? Deine Wünsche werden gelöscht.')) return;
          run(e.currentTarget, async () => {
            await rpc('remove_member', { p_token: token });
            forgetToken(token);
            toast('Gruppe verlassen');
            navigate('#/');
          });
        },
      }, 'Gruppe verlassen');

  return h('div', { class: 'layout' },
    h('section', { class: 'card' },
      cardHead('👥', `Mitglieder (${members.length})`, isAdmin ? 'Als Admin kannst du Leute hinzufügen, Links weitergeben, Rollen vergeben und Leute entfernen.' : null),
      list),
    h('aside', { class: 'stack' },
      isAdmin && addMemberCard(ctx),
      h('section', { class: 'card' }, cardHead('🏷️', 'Dein Name'), nameForm),
      h('section', { class: 'card' },
        cardHead('🚪', 'Gerät & Austritt'),
        h('div', { class: 'stack-sm' },
          h('div', null,
            h('button', {
              class: 'secondary sm',
              onclick: () => {
                if (!confirm('Gruppe auf diesem Gerät vergessen? Du bleibst Mitglied und kommst über deinen persönlichen Link wieder rein.')) return;
                forgetToken(token);
                navigate('#/');
              },
            }, 'Auf diesem Gerät vergessen'),
            h('p', { class: 'hint' }, 'Du bleibst Mitglied.')),
          h('div', null, leave)))));
}

// ----- Tab: Admin ------------------------------------------------------

function adminTab(ctx) {
  const { token, state, group, members, reload } = ctx;
  const drawn = !!group.drawn_at;
  const allWishes = state.all_wishes || {};

  const editForm = h('form', null,
    field('e-name', 'Name', h('input', { name: 'name', required: true, maxlength: 100, value: group.name })),
    h('div', { class: 'fields-2' },
      field('e-budget', 'Budget', h('input', { name: 'budget', maxlength: 50, value: group.budget || '' })),
      field('e-date', 'Bescherung', h('input', { name: 'event_date', type: 'date', value: group.event_date || '' }))),
    h('div', { class: 'field', style: 'margin-top:.8rem' },
      h('label', { for: 'e-desc' }, 'Infos für alle'),
      h('textarea', { id: 'e-desc', name: 'description', maxlength: 2000, value: group.description || '' })),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'secondary' }, 'Speichern')));
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

  const drawCard = h('section', { class: 'card' },
    cardHead('🎲', 'Auslosung', drawn
      ? `Ausgelost am ${new Date(group.drawn_at).toLocaleString('de-DE')}.`
      : `${plural(members.length, 'Mitglied', 'Mitglieder')} dabei.`),
    h('p', { class: 'small muted', style: 'margin-bottom:1rem' }, drawn
      ? 'Die Paarungen sind geheim – auch du siehst nur deine eigene. Beim Zurücksetzen wird alles verworfen und neu gelost.'
      : members.length < 3
        ? 'Für die Auslosung braucht ihr mindestens 3 Mitglieder.'
        : 'Die geheimen Ausschlüsse werden automatisch berücksichtigt. Danach kann niemand mehr beitreten.'),
    drawButton(ctx, 'lg'));

  const wishesCard = h('section', { class: 'card' },
    cardHead('📋', 'Wünsche aller Mitglieder', 'Als Admin siehst du alle Wunschlisten.'),
    members.map((m) => {
      const list = allWishes[m.id] || [];
      return h('details', { class: 'acc' },
        h('summary', null, avatar(m.display_name), m.display_name,
          h('span', { class: `badge ${list.length ? 'ok' : ''}` }, plural(list.length, 'Wunsch', 'Wünsche'))),
        h('div', { class: 'acc-body' }, wishList(list, { empty: 'Noch keine Wünsche.' })));
    }));

  const inviteAdmin = h('section', { class: 'card' },
    cardHead('💌', 'Einladungslink', drawn ? 'Nach der Auslosung kann niemand beitreten.' : 'Wer den Link hat, kann beitreten.'),
    copyBox(inviteUrl(group.invite_code), 'Einladungslink'),
    h('div', { class: 'form-actions' }, h('button', {
      class: 'secondary sm',
      onclick: (e) => {
        if (!confirm('Neuen Einladungslink erzeugen? Der alte funktioniert dann nicht mehr (persönliche Links bleiben gültig).')) return;
        run(e.currentTarget, async () => {
          await rpc('regenerate_invite', { p_token: token });
          toast('Neuer Einladungslink erstellt');
          reload();
        });
      },
    }, '↻ Neuen Link erzeugen')));

  const danger = h('section', { class: 'card danger-zone' },
    cardHead('⚠️', 'Gruppe löschen', 'Löscht alle Mitglieder, Wünsche und die Auslosung endgültig.'),
    h('button', {
      class: 'danger',
      onclick: (e) => {
        if (!confirm(`Gruppe „${group.name}“ endgültig löschen?`)) return;
        run(e.currentTarget, async () => {
          await rpc('delete_group', { p_token: token });
          forgetToken(token);
          toast('Gruppe gelöscht');
          navigate('#/');
        });
      },
    }, 'Gruppe endgültig löschen'));

  return h('div', { class: 'layout' },
    h('div', { class: 'stack' }, drawCard, wishesCard),
    h('aside', { class: 'stack' },
      inviteAdmin,
      h('section', { class: 'card' }, cardHead('⚙️', 'Gruppe bearbeiten'), editForm),
      danger));
}

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

window.addEventListener('hashchange', route);
route();
