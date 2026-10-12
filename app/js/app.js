import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const app = document.getElementById('app');
const userbox = document.getElementById('userbox');
const PENDING_INVITE_KEY = 'openwichteln.pendingInvite';

const configured = !SUPABASE_URL.includes('DEIN-PROJEKT') && !SUPABASE_ANON_KEY.includes('DEIN-ANON-KEY');
const sb = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { flowType: 'pkce', persistSession: true } })
  : null;

let session = null;

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
  if (msg.includes('Invalid login credentials')) return 'Benutzername oder Passwort ist falsch.';
  if (msg.includes('Email not confirmed')) return 'Konto noch nicht freigeschaltet: In Supabase muss „Confirm email“ ausgeschaltet sein.';
  if (msg.includes('User already registered')) return 'Dieser Benutzername ist schon vergeben.';
  if (msg.includes('Password should be')) return 'Das Passwort muss mindestens 6 Zeichen lang sein.';
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

function must({ data, error }) {
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

function inviteUrl(code) {
  return `${location.origin}${location.pathname}#/join/${code}`;
}

function defaultName() {
  return session?.user?.user_metadata?.display_name || currentUsername();
}

function currentUsername() {
  return session?.user?.user_metadata?.username || session?.user?.email?.split('@')[0] || '';
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* privater Modus o. ä. */ }
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

async function route() {
  renderUserbox();
  if (!configured) return renderSetupHint();

  const [, page, param] = (location.hash.replace(/^#/, '') || '/').split('/');

  if (page === 'join' && param) storageSet(PENDING_INVITE_KEY, param);

  if (!session) return renderAuth();

  const pending = storageGet(PENDING_INVITE_KEY);
  if (pending && page !== 'join') {
    return navigate(`#/join/${pending}`);
  }

  try {
    if (page === 'join' && param) return await renderJoin(param);
    if (page === 'g' && param) return await renderGroup(param);
    return await renderDashboard();
  } catch (err) {
    console.error(err);
    render(h('div', { class: 'card warn' },
      h('h2', null, 'Da ist etwas schiefgelaufen'),
      h('p', null, errorMessage(err)),
      h('a', { href: '#/' }, 'Zur Übersicht')));
  }
}

function renderUserbox() {
  if (!session) {
    userbox.replaceChildren();
    return;
  }
  userbox.replaceChildren(
    h('span', null, currentUsername()),
    h('button', { class: 'secondary small', onclick: () => sb.auth.signOut() }, 'Abmelden'));
}

// ---------------------------------------------------------------------
// Ansichten
// ---------------------------------------------------------------------

function renderSetupHint() {
  render(h('div', { class: 'card warn' },
    h('h1', null, 'Fast fertig!'),
    h('p', null, 'OpenWichteln ist noch nicht mit einer Datenbank verbunden. Trage deine Supabase-URL und den anon-Key in ',
      h('code', null, 'app/js/config.js'), ' ein oder setze die Repository-Variablen ',
      h('code', null, 'SUPABASE_URL'), ' und ', h('code', null, 'SUPABASE_ANON_KEY'), '.'),
    h('p', null, 'Die Schritt-für-Schritt-Anleitung steht in der README.')));
}

// Anmeldung ohne echte E-Mail: Supabase braucht intern eine E-Mail-Adresse,
// daher wird aus dem Benutzernamen eine Platzhalter-Adresse gebildet.
// Voraussetzung: "Confirm email" ist in Supabase ausgeschaltet.
const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;
const AUTH_EMAIL_DOMAIN = 'example.com';

function usernameToEmail(username) {
  return `${username}@${AUTH_EMAIL_DOMAIN}`;
}

function normalizeUsername(value) {
  return value.trim().toLowerCase();
}

function renderAuth() {
  let mode = 'login';
  const invited = !!storageGet(PENDING_INVITE_KEY);

  const draw = () => {
    const isRegister = mode === 'register';
    const form = h('form', { class: 'stack' },
      isRegister && h('div', null,
        h('label', { for: 'name' }, 'Dein Name (so sehen dich die anderen)'),
        h('input', { id: 'name', name: 'name', required: true, maxlength: 60, autocomplete: 'name' })),
      h('div', null,
        h('label', { for: 'username' }, 'Benutzername'),
        h('input', {
          id: 'username', name: 'username', required: true, minlength: 3, maxlength: 30,
          autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false',
        }),
        isRegister && h('p', { class: 'small muted' }, '3–30 Zeichen: Buchstaben, Zahlen, . _ -')),
      h('div', null,
        h('label', { for: 'password' }, 'Passwort'),
        h('input', {
          id: 'password', name: 'password', type: 'password', required: true, minlength: 6,
          autocomplete: isRegister ? 'new-password' : 'current-password',
        }),
        isRegister && h('p', { class: 'small muted' },
          'Gut merken – ohne E-Mail lässt sich das Passwort nicht zurücksetzen.')),
      h('div', { class: 'row' },
        h('button', { type: 'submit' }, isRegister ? 'Konto erstellen' : 'Anmelden'),
        h('button', {
          type: 'button', class: 'link',
          onclick: () => { mode = isRegister ? 'login' : 'register'; draw(); },
        }, isRegister ? 'Ich habe schon ein Konto' : 'Neu hier? Konto erstellen')));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const button = form.querySelector('button[type=submit]');
      const { name, password } = formData(form);
      const username = normalizeUsername(formData(form).username);
      if (!USERNAME_PATTERN.test(username)) {
        return toast('Benutzername: 3–30 Zeichen aus Buchstaben, Zahlen, . _ -', true);
      }
      const email = usernameToEmail(username);
      run(button, async () => {
        if (isRegister) {
          const data = must(await sb.auth.signUp({
            email, password,
            options: { data: { display_name: name.trim(), username } },
          }));
          if (!data.session) {
            toast('Konto erstellt, aber Supabase verlangt noch eine E-Mail-Bestätigung. Bitte in Supabase „Confirm email“ ausschalten.', true);
          }
        } else {
          must(await sb.auth.signInWithPassword({ email, password }));
        }
      });
    });

    render(
      h('div', { class: 'card' },
        h('h1', null, invited ? 'Du wurdest zum Wichteln eingeladen! 🎄' : 'Willkommen bei OpenWichteln'),
        h('p', { class: 'muted' }, invited
          ? 'Melde dich an oder erstelle ein Konto, um der Gruppe beizutreten.'
          : 'Erstelle Wichtelgruppen, lade Freunde per Link ein, tragt Wünsche ein und lost geheim aus.'),
        form));
  };
  draw();
}

// ----- Übersicht -----------------------------------------------------

async function renderDashboard() {
  const memberships = must(await sb.from('members')
    .select('id, role, group:groups(id, name, event_date, drawn_at)')
    .eq('user_id', session.user.id)
    .order('joined_at', { ascending: false }));

  const createForm = h('form', { class: 'stack' },
    h('div', { class: 'grid2' },
      h('div', null,
        h('label', { for: 'g-name' }, 'Name der Gruppe'),
        h('input', { id: 'g-name', name: 'name', required: true, maxlength: 100, placeholder: 'z. B. Familie Weihnachten 2026' })),
      h('div', null,
        h('label', { for: 'g-display' }, 'Dein Name in der Gruppe'),
        h('input', { id: 'g-display', name: 'display_name', required: true, maxlength: 60, value: defaultName() }))),
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
      const id = must(await sb.rpc('create_group', {
        p_name: f.name, p_description: f.description, p_budget: f.budget,
        p_event_date: f.event_date || null, p_display_name: f.display_name,
      }));
      toast('Gruppe erstellt 🎉');
      navigate(`#/g/${id}`);
    });
  });

  const groups = memberships.filter((m) => m.group);
  render(
    h('div', { class: 'card' },
      h('h1', null, 'Meine Wichtelgruppen'),
      groups.length === 0
        ? h('p', { class: 'muted' }, 'Du bist noch in keiner Gruppe. Erstelle unten eine oder lass dir einen Einladungslink schicken.')
        : h('ul', { class: 'list' }, groups.map((m) => h('li', { class: 'spread' },
          h('div', null,
            h('a', { href: `#/g/${m.group.id}`, class: 'wish-title' }, m.group.name),
            h('div', { class: 'small muted' }, m.group.event_date ? `Bescherung: ${formatDate(m.group.event_date)}` : '')),
          h('div', { class: 'row' },
            m.role === 'admin' && h('span', { class: 'badge admin' }, 'Admin'),
            m.group.drawn_at
              ? h('span', { class: 'badge ok' }, 'Ausgelost')
              : h('span', { class: 'badge' }, 'Noch nicht gelost')))))),
    h('div', { class: 'card' },
      h('h2', null, 'Neue Gruppe erstellen'),
      h('p', { class: 'small muted' }, 'Du wirst automatisch Admin der Gruppe und kannst danach Leute per Link einladen.'),
      createForm));
}

// ----- Einladung -----------------------------------------------------

async function renderJoin(code) {
  const rows = must(await sb.rpc('group_preview', { p_code: code }));
  const preview = rows?.[0];

  if (!preview) {
    storageSet(PENDING_INVITE_KEY, null);
    return render(h('div', { class: 'card warn' },
      h('h1', null, 'Einladung ungültig'),
      h('p', null, 'Dieser Einladungslink existiert nicht (mehr). Bitte frag den Admin der Gruppe nach einem neuen Link.'),
      h('a', { href: '#/' }, 'Zur Übersicht')));
  }

  if (preview.already_member) {
    storageSet(PENDING_INVITE_KEY, null);
    return navigate(`#/g/${preview.id}`);
  }

  const form = h('form', { class: 'stack' },
    h('div', null,
      h('label', { for: 'j-name' }, 'Dein Name in der Gruppe'),
      h('input', { id: 'j-name', name: 'display_name', required: true, maxlength: 60, value: defaultName() })),
    h('div', { class: 'row' },
      h('button', { type: 'submit', disabled: preview.drawn }, 'Gruppe beitreten'),
      h('button', {
        type: 'button', class: 'secondary',
        onclick: () => { storageSet(PENDING_INVITE_KEY, null); navigate('#/'); },
      }, 'Abbrechen')));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(form.querySelector('button[type=submit]'), async () => {
      const id = must(await sb.rpc('join_group', { p_code: code, p_display_name: formData(form).display_name }));
      storageSet(PENDING_INVITE_KEY, null);
      toast('Willkommen in der Gruppe! 🎄');
      navigate(`#/g/${id}`);
    });
  });

  render(h('div', { class: 'card' },
    h('p', { class: 'muted small' }, 'Einladung zur Wichtelgruppe'),
    h('h1', null, preview.name),
    preview.description && h('p', { class: 'wish-details' }, preview.description),
    h('p', { class: 'small muted' },
      [`${preview.member_count} Mitglied${preview.member_count === 1 ? '' : 'er'}`,
        preview.budget && `Budget: ${preview.budget}`,
        preview.event_date && `Bescherung: ${formatDate(preview.event_date)}`].filter(Boolean).join(' · ')),
    preview.drawn && h('p', { class: 'card warn small' },
      'In dieser Gruppe wurde bereits ausgelost. Ein Admin muss die Auslosung erst zurücksetzen, bevor du beitreten kannst.'),
    form));
}

// ----- Gruppe --------------------------------------------------------

async function renderGroup(groupId) {
  const uid = session.user.id;
  const [group, members] = await Promise.all([
    sb.from('groups').select('id, name, description, budget, event_date, drawn_at').eq('id', groupId).maybeSingle().then(must),
    sb.from('members').select('id, user_id, display_name, role, joined_at').eq('group_id', groupId).order('joined_at').then(must),
  ]);

  if (!group) {
    return render(h('div', { class: 'card warn' },
      h('h1', null, 'Gruppe nicht gefunden'),
      h('p', null, 'Diese Gruppe gibt es nicht oder du bist kein Mitglied.'),
      h('a', { href: '#/' }, 'Zur Übersicht')));
  }

  const me = members.find((m) => m.user_id === uid);
  const isAdmin = me.role === 'admin';
  const others = members.filter((m) => m.id !== me.id);
  const nameOf = (id) => members.find((m) => m.id === id)?.display_name ?? '(ehemaliges Mitglied)';

  const [myWishes, exclusions, assignment, allWishes, inviteCode] = await Promise.all([
    sb.from('wishes').select('*').eq('member_id', me.id).order('created_at').then(must),
    sb.from('exclusions').select('*').eq('member_id', me.id).then(must),
    sb.from('assignments').select('receiver_id').eq('group_id', groupId).eq('giver_id', me.id).maybeSingle().then(must),
    isAdmin
      ? sb.from('wishes').select('*').in('member_id', members.map((m) => m.id)).order('created_at').then(must)
      : Promise.resolve([]),
    isAdmin ? sb.rpc('get_invite_code', { p_group_id: groupId }).then(must) : Promise.resolve(null),
  ]);

  let receiverWishes = [];
  if (assignment) {
    receiverWishes = must(await sb.from('wishes').select('*')
      .eq('member_id', assignment.receiver_id).order('created_at'));
  }

  const reload = () => renderGroup(groupId);

  // --- Kopf
  const header = h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('h1', null, group.name),
      h('div', { class: 'row' },
        isAdmin && h('span', { class: 'badge admin' }, 'Du bist Admin'),
        group.drawn_at ? h('span', { class: 'badge ok' }, 'Ausgelost') : h('span', { class: 'badge' }, 'Noch nicht gelost'))),
    group.description && h('p', { class: 'wish-details' }, group.description),
    h('p', { class: 'small muted' },
      [`${members.length} Mitglied${members.length === 1 ? '' : 'er'}`,
        group.budget && `Budget: ${group.budget}`,
        group.event_date && `Bescherung: ${formatDate(group.event_date)}`].filter(Boolean).join(' · ')));

  // --- Zuteilung
  const assignmentCard = group.drawn_at
    ? (assignment
      ? h('div', { class: 'card highlight' },
        h('p', { class: 'small muted' }, 'Psst … du beschenkst:'),
        h('div', { class: 'big-name' }, `🎁 ${nameOf(assignment.receiver_id)}`),
        h('h3', null, 'Wunschliste'),
        wishList(receiverWishes, { empty: 'Noch keine Wünsche eingetragen. Schau später nochmal vorbei!' }))
      : h('div', { class: 'card warn' },
        h('p', null, 'Die Auslosung ist gelaufen, aber du warst zu dem Zeitpunkt noch kein Mitglied.')))
    : h('div', { class: 'card' },
      h('h2', null, 'Auslosung'),
      h('p', { class: 'muted' }, isAdmin
        ? 'Sobald alle dabei sind und ihre Ausschlüsse eingetragen haben, kannst du unten im Admin-Bereich die Auslosung starten.'
        : 'Die Auslosung wurde noch nicht gestartet. Trag schon mal deine Wünsche ein!'));

  render(
    h('p', null, h('a', { href: '#/' }, '← Alle Gruppen')),
    header,
    assignmentCard,
    myWishesCard(me, myWishes, reload),
    exclusionsCard(me, others, exclusions, group, nameOf, reload),
    membersCard(group, members, me, isAdmin, reload),
    isAdmin && adminCard(group, members, allWishes, inviteCode, reload),
    leaveCard(group, me, members, isAdmin));
}

function wishList(wishes, { empty, onDelete } = {}) {
  if (!wishes.length) return h('p', { class: 'muted small' }, empty || 'Keine Wünsche.');
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

function myWishesCard(me, wishes, reload) {
  const form = h('form', { class: 'stack' },
    h('div', { class: 'grid2' },
      h('div', null,
        h('label', { for: 'w-title' }, 'Wunsch'),
        h('input', { id: 'w-title', name: 'title', required: true, maxlength: 200, placeholder: 'z. B. Ein gutes Buch' })),
      h('div', null,
        h('label', { for: 'w-link' }, 'Link (optional)'),
        h('input', { id: 'w-link', name: 'link', type: 'url', placeholder: 'https://…' }))),
    h('div', null,
      h('label', { for: 'w-details' }, 'Details (optional)'),
      h('textarea', { id: 'w-details', name: 'details', maxlength: 2000, placeholder: 'Größe, Farbe, Alternativen …' })),
    h('button', { type: 'submit' }, 'Wunsch hinzufügen'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formData(form);
    run(form.querySelector('button[type=submit]'), async () => {
      must(await sb.from('wishes').insert({
        member_id: me.id,
        title: f.title.trim(),
        details: f.details.trim() || null,
        link: f.link.trim() || null,
      }));
      toast('Wunsch gespeichert');
      reload();
    });
  });

  const onDelete = (wish, button) => run(button, async () => {
    must(await sb.from('wishes').delete().eq('id', wish.id));
    reload();
  });

  return h('div', { class: 'card' },
    h('h2', null, 'Meine Wünsche'),
    h('p', { class: 'small muted' }, '🔒 Sichtbar nur für deine:n ausgeloste:n Wichtel und die Admins der Gruppe.'),
    wishList(wishes, { empty: 'Du hast noch keine Wünsche eingetragen.', onDelete }),
    h('hr', { style: 'border:none;border-top:1px solid var(--border);margin:1rem 0' }),
    form);
}

function exclusionsCard(me, others, exclusions, group, nameOf, reload) {
  const locked = !!group.drawn_at;
  const noGive = exclusions.filter((x) => x.kind === 'no_give');
  const noReceive = exclusions.filter((x) => x.kind === 'no_receive');

  const section = (kind, title, hint, items) => {
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
          must(await sb.from('exclusions').insert({ member_id: me.id, target_member_id: select.value, kind }));
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
              must(await sb.from('exclusions').delete().eq('id', x.id));
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
        section('no_give', 'Ich möchte nicht ziehen …', 'Diese Personen möchtest du nicht beschenken.', noGive),
        section('no_receive', 'Ich möchte nicht gezogen werden von …', 'Diese Personen sollen dich nicht beschenken.', noReceive)));
}

function membersCard(group, members, me, isAdmin, reload) {
  const nameForm = h('form', { class: 'row', style: 'margin-top:.75rem' },
    h('div', { style: 'flex:1;min-width:180px' },
      h('input', { name: 'display_name', required: true, maxlength: 60, value: me.display_name, 'aria-label': 'Mein Name' })),
    h('button', { type: 'submit', class: 'secondary small' }, 'Namen ändern'));
  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(nameForm.querySelector('button'), async () => {
      must(await sb.from('members').update({ display_name: formData(nameForm).display_name.trim() }).eq('id', me.id));
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
            must(await sb.rpc('set_member_role', { p_member_id: m.id, p_role: m.role === 'admin' ? 'member' : 'admin' }));
            reload();
          }),
        }, m.role === 'admin' ? 'Admin entziehen' : 'Zum Admin machen'),
        !group.drawn_at && h('button', {
          class: 'danger small',
          onclick: (e) => {
            if (!confirm(`${m.display_name} wirklich aus der Gruppe entfernen?`)) return;
            run(e.target, async () => {
              must(await sb.rpc('remove_member', { p_member_id: m.id }));
              reload();
            });
          },
        }, 'Entfernen'))))),
    nameForm);
}

function adminCard(group, members, allWishes, inviteCode, reload) {
  const link = inviteUrl(inviteCode);
  const linkInput = h('input', { value: link, readonly: true, onclick: (e) => e.target.select() });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Einladungslink kopiert');
    } catch {
      linkInput.select();
      toast('Bitte manuell kopieren (Strg+C)');
    }
  };
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
          must(await sb.rpc('reset_draw', { p_group_id: group.id }));
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
          must(await sb.rpc('draw_names', { p_group_id: group.id }));
          toast('Ausgelost! 🎉 Jede:r sieht jetzt, wen sie/er beschenkt.');
          reload();
        });
      },
    }, '🎲 Auslosung starten');

  // Gruppe bearbeiten
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
            must(await sb.from('groups').delete().eq('id', group.id));
            toast('Gruppe gelöscht');
            navigate('#/');
          });
        },
      }, 'Gruppe löschen')));
  editForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formData(editForm);
    run(editForm.querySelector('button[type=submit]'), async () => {
      must(await sb.from('groups').update({
        name: f.name.trim(),
        budget: f.budget.trim() || null,
        event_date: f.event_date || null,
        description: f.description.trim() || null,
      }).eq('id', group.id));
      toast('Gespeichert');
      reload();
    });
  });

  const wishesByMember = (id) => allWishes.filter((w) => w.member_id === id);

  return h('div', { class: 'card' },
    h('h2', null, '🛠️ Admin-Bereich'),

    h('h3', null, 'Leute einladen'),
    h('p', { class: 'small muted' }, 'Jede:r mit diesem Link kann der Gruppe beitreten (solange noch nicht ausgelost wurde).'),
    h('div', { class: 'copybox' }, linkInput, h('button', { class: 'small', onclick: copy }, 'Kopieren')),
    h('div', { class: 'row', style: 'margin-top:.5rem' },
      share && h('button', { class: 'secondary small', onclick: share }, 'Teilen …'),
      h('button', {
        class: 'secondary small',
        onclick: (e) => {
          if (!confirm('Neuen Link erzeugen? Der alte Link funktioniert dann nicht mehr.')) return;
          run(e.target, async () => {
            must(await sb.rpc('regenerate_invite', { p_group_id: group.id }));
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
      const list = wishesByMember(m.id);
      return h('details', null,
        h('summary', null, `${m.display_name} (${list.length})`),
        wishList(list, { empty: 'Noch keine Wünsche.' }));
    })),

    h('details', { style: 'margin-top:1.25rem' },
      h('summary', null, 'Gruppe bearbeiten'),
      editForm));
}

function leaveCard(group, me, members, isAdmin) {
  if (group.drawn_at) return null;
  const onlyAdmin = isAdmin && members.filter((m) => m.role === 'admin').length === 1 && members.length > 1;
  return h('p', { class: 'small muted', style: 'text-align:center' },
    onlyAdmin
      ? 'Um die Gruppe zu verlassen, mach zuerst eine andere Person zum Admin.'
      : h('button', {
        class: 'link small',
        onclick: (e) => {
          const last = members.length === 1;
          if (!confirm(last ? 'Du bist das letzte Mitglied – die Gruppe wird gelöscht. Fortfahren?' : 'Gruppe wirklich verlassen?')) return;
          run(e.target, async () => {
            must(await sb.rpc('remove_member', { p_member_id: me.id }));
            toast('Gruppe verlassen');
            navigate('#/');
          });
        },
      }, 'Gruppe verlassen'));
}

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

window.addEventListener('hashchange', route);

if (sb) {
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((event, newSession) => {
    const changed = (session?.user?.id || null) !== (newSession?.user?.id || null);
    session = newSession;
    if (changed) route();
  });
  // PKCE-Code aus der URL entfernen, Hash (z. B. Einladung) behalten
  if (location.search.includes('code=')) {
    history.replaceState(null, '', location.pathname + location.hash);
  }
}
route();
