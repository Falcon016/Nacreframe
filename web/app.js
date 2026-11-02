// Nacreframe dashboard. Plain ES modules, no build step, no external requests.
// Everything dynamic is built with DOM nodes / textContent (never innerHTML) so model output cannot inject markup.

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Agent colours: kept in step with the --rose/--teal/--gold/... tokens in app.css.
const PALETTE = ['#e692d6', '#4fd1c1', '#f0c674', '#74b7ff', '#7ddba0', '#8c9bff', '#b3a4ff', '#f4a98d'];
const NAMED = {
  magenta: '#e692d6',
  cyan: '#4fd1c1',
  yellow: '#f0c674',
  green: '#7ddba0',
  blue: '#74b7ff',
  red: '#f17b86',
};
const colorOf = (name, preferred) => {
  if (name === 'you') return '#8c9bff';
  if (name === 'system') return '#7a8296';
  if (preferred && (NAMED[preferred] || /^#[0-9a-f]{6}$/i.test(preferred)))
    return NAMED[preferred] ?? preferred;
  let n = 0;
  for (const c of name) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[n % PALETTE.length];
};

// ------------------------------------------------------------------------------------------------ api
class AuthError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'x-nacre': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new AuthError('Login required');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, kind = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'error' ? 7000 : 3500);
}
const guard =
  (fn) =>
  async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (!(e instanceof AuthError)) toast(e.message, 'error');
    }
  };

// ------------------------------------------------------------------------------------------------ markdown
function inline(text, parent) {
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const s = m[0];
    if (m[1]) parent.append(h('code', { text: s.slice(1, -1) }));
    else if (m[2]) parent.append(h('strong', { text: s.slice(2, -2) }));
    else if (m[3]) parent.append(h('em', { text: s.slice(1, -1) }));
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(s);
      // Only plain web links become clickable; javascript:, data: etc. are shown as text.
      if (/^https?:\/\//i.test(mm[2]))
        parent.append(h('a', { href: mm[2], target: '_blank', rel: 'noopener noreferrer', text: mm[1] }));
      else parent.append(s);
    }
    last = m.index + s.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function codeBlock(lang, lines) {
  const code = h('code');
  if (lang === 'diff' || lang === 'patch') {
    lines.forEach((l, i) => {
      const cls =
        l.startsWith('+') && !l.startsWith('+++')
          ? 'add'
          : l.startsWith('-') && !l.startsWith('---')
            ? 'del'
            : l.startsWith('@@')
              ? 'hunk'
              : '';
      code.append(h('span', { class: cls, text: l }), i < lines.length - 1 ? '\n' : '');
    });
  } else code.textContent = lines.join('\n');
  return h('pre', null, lang ? h('span', { class: 'lang', text: lang }) : null, code);
}

function md(src) {
  const root = h('div', { class: 'md' });
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const isBlockStart = (l) =>
    /^\s*```/.test(l) ||
    /^#{1,6}\s/.test(l) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(l) ||
    /^\s*>/.test(l) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = /^\s*```(\S*)/.exec(line))) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      root.append(codeBlock(m[1], body));
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (l) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const td = (tag, c) => {
        const el = h(tag);
        inline(c, el);
        return el;
      };
      root.append(
        h(
          'table',
          null,
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              head.map((c) => td('th', c)),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map((r) =>
              h(
                'tr',
                null,
                r.map((c) => td('td', c)),
              ),
            ),
          ),
        ),
      );
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const el = h('h' + Math.min(4, m[1].length));
      inline(m[2], el);
      root.append(el);
      i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      root.append(h('hr'));
      i++;
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const list = h(ordered ? 'ol' : 'ul');
      while (i < lines.length && (m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]))) {
        const li = h('li');
        inline(m[3], li);
        const depth = Math.floor(m[1].length / 2);
        if (depth) li.style.marginLeft = `${depth * 1.2}em`;
        list.append(li);
        i++;
      }
      root.append(list);
    } else if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      const bq = h('blockquote');
      inline(q.join(' '), bq);
      root.append(bq);
    } else if (!line.trim()) i++;
    else {
      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
      const p = h('p');
      inline(para.join(' '), p);
      root.append(p);
    }
  }
  return root;
}

// ------------------------------------------------------------------------------------------------ state
const S = {
  info: null,
  models: null,
  sessions: [],
  id: null,
  es: null,
  st: null,
  rendered: new Set(),
  pinned: false,
  stickBottom: true,
  shotTimer: null,
  shotSrc: null,
  sideKey: undefined,
  cardKey: undefined,
};

// Round before choosing the unit so 999,999 reads "1.0M" rather than "1000k".
const fmt = (n) =>
  n >= 999_500
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 9950 ? 0 : 1)}k`
      : String(n);
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

// ------------------------------------------------------------------------------------------------ login
let pollTimer;

function showLogin() {
  closeStream();
  clearInterval(pollTimer);
  pollTimer = undefined;
  // Forget the old session view, otherwise signing back in leaves a frozen transcript behind.
  S.id = null;
  S.st = null;
  S.rendered.clear();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-token').focus();
}

async function doLogin(token) {
  $('#login-err').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { token } });
    $('#login-token').value = '';
    $('#login').hidden = true;
    await start();
  } catch (e) {
    // The login form starts hidden (a #token= link skips it), so a wrong or stale token must bring it back.
    if (!(e instanceof AuthError)) {
      showLogin();
      $('#login-err').textContent = e.message;
    }
  }
}

// ------------------------------------------------------------------------------------------------ sidebar
async function refreshSessions() {
  try {
    S.sessions = (await api('/api/sessions')).sessions;
  } catch {
    return;
  }
  // The poll runs every few seconds; only rebuild the list when something changed, or keyboard focus is lost.
  const key = JSON.stringify([
    S.id,
    S.sessions.map((s) => [s.id, s.cwd, s.model, s.mode, s.running, s.swarm]),
  ]);
  if (key === S.sideKey) return;
  S.sideKey = key;
  const list = $('#side-list');
  list.replaceChildren(
    h('div', { class: 'side-title', text: 'Open sessions' }),
    ...(S.sessions.length
      ? S.sessions.map((s) => {
          const closeSession = guard(async (ev) => {
            ev.stopPropagation();
            await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
            if (S.id === s.id) closeSessionView();
            S.sideKey = undefined;
            refreshSessions();
          });
          return h(
            'button',
            {
              class: 'side-item',
              'aria-current': s.id === S.id ? 'true' : 'false',
              onclick: () => openSession(s.id),
            },
            h('span', { class: `dot ${s.running ? 'run' : ''}` }),
            h(
              'span',
              { class: 'name' },
              base(s.cwd),
              h('span', { class: 'sub', text: `${s.model ?? 'no model'} · ${s.swarm ? 'swarm' : s.mode}` }),
            ),
            h('span', {
              class: 'sub',
              title: 'Close session',
              'aria-label': `Close session ${base(s.cwd)}`,
              role: 'button',
              tabindex: '0',
              text: '×',
              onclick: closeSession,
              // A span is not a button: Enter and Space have to be wired by hand, and must not also open the session.
              onkeydown: (ev) => {
                if (ev.key !== 'Enter' && ev.key !== ' ') return;
                ev.preventDefault();
                closeSession(ev);
              },
            }),
          );
        })
      : [h('div', { class: 'note', text: 'No open sessions.' })]),
  );
}

function closeStream() {
  S.es?.close();
  S.es = null;
  clearInterval(S.shotTimer);
  S.shotTimer = null;
  S.shotSrc = null;
}

function closeSessionView() {
  closeStream();
  S.id = null;
  S.st = null;
  S.rendered.clear();
  renderEmpty();
  renderTop();
  $('#cards').replaceChildren();
  S.cardKey = undefined;
  $('#panel').hidden = true;
  $('#app').classList.remove('with-panel');
}

function gem(size) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '/favicon.svg#gem');
  svg.append(use);
  return svg;
}

function renderEmpty() {
  $('#transcript').replaceChildren(
    h(
      'div',
      { class: 'empty' },
      gem(56),
      h('h2', { text: 'What shall we build?' }),
      h('p', {
        text: 'Open a session on one of your folders. Choose a model, how much to trust it, and how isolated it should be.',
      }),
      h('button', { class: 'btn primary', onclick: () => openNewDialog(), text: 'New session' }),
    ),
  );
}

// ------------------------------------------------------------------------------------------------ session stream
function openSession(id) {
  if (S.id === id && S.es) return;
  closeStream();
  S.id = id;
  S.st = null;
  S.rendered.clear();
  S.stickBottom = true; // a new session starts at the latest message, even if the last one was scrolled up
  $('#transcript').replaceChildren(h('div', { class: 'notice', text: 'Connecting…' }));
  $('#sidebar').classList.remove('open');
  const es = new EventSource(`/api/sessions/${id}/events`);
  S.es = es;
  es.addEventListener('state', (ev) => onState(JSON.parse(ev.data)));
  es.onerror = async () => {
    $('#hint').textContent = 'Connection lost — reconnecting…';
    try {
      const { sessions } = await api('/api/sessions');
      if (!sessions.some((s) => s.id === id) && S.id === id) {
        closeSessionView();
        toast('That session was closed on the server.', 'error');
      }
    } catch {
      /* offline: EventSource keeps retrying */
    }
  };
  refreshSessions();
}

function onState(st) {
  const first = !S.st || st.reset;
  S.st = st;
  const tr = $('#transcript');
  if (first) {
    tr.replaceChildren();
    S.rendered.clear();
  }
  $('#hint').textContent = 'Enter to send · Shift+Enter for a new line';
  const live = $('#live') ?? tr.appendChild(h('div', { id: 'live' }));
  for (const item of st.items) {
    if (item.kind === 'banner' || S.rendered.has(item.id)) continue;
    S.rendered.add(item.id);
    const el = renderItem(item);
    if (el) tr.insertBefore(el, live);
  }
  if (first && !st.items.length) {
    const msg = st.session.model ? 'Ready. Type a message below.' : 'Pick a model in the top bar to begin.';
    tr.insertBefore(h('div', { class: 'notice', text: msg }), live);
  }
  renderLive(live, st);
  renderTop();
  renderCards();
  renderPanel();
  if (S.stickBottom) requestAnimationFrame(() => ($('#scroll').scrollTop = $('#scroll').scrollHeight));
}

function renderItem(item) {
  switch (item.kind) {
    case 'user':
      return h('div', { class: 'msg-user', text: item.text });
    case 'assistant': {
      const who = item.agent !== 'main' ? h('div', { class: 'who', text: item.agent }) : null;
      if (who) who.style.color = colorOf(item.agent, S.st?.live.find((a) => a.name === item.agent)?.color);
      return h('div', { class: 'msg-assistant' }, who, md(item.text));
    }
    case 'tool': {
      const cls = `tool ${item.status}`;
      const glyph = item.status === 'ok' ? '●' : item.status === 'denied' ? '⊘' : '✗';
      const head = [
        h('span', { class: 'glyph', text: glyph }),
        item.agent !== 'main' ? h('span', { class: 'tname', text: item.agent }) : null,
        h('span', { class: 'tname', text: item.name }),
        h('span', { class: 'desc', text: item.description === item.name ? '' : item.description }),
        h('span', { class: 'sum', text: item.summary }),
      ];
      return item.detail
        ? h('details', { class: cls }, h('summary', null, head), h('pre', { text: item.detail }))
        : h('div', { class: cls }, h('div', { class: 'head' }, head));
    }
    case 'notice':
      return h('div', { class: `notice ${item.level}`, text: item.text });
    case 'channel': {
      const el = h('div', { class: `channel ${item.from === 'system' ? 'system' : ''}` });
      const from = h('span', { class: 'from', text: item.from });
      from.style.color = colorOf(item.from, S.st?.live.find((a) => a.name === item.from)?.color);
      el.append(from);
      if (item.to) el.append(h('span', { class: 'to', text: `→ ${item.to}` }));
      el.append(h('span', { class: 'text', text: item.text }));
      return el;
    }
    default:
      return null;
  }
}

function renderLive(live, st) {
  const kids = [];
  const swarm = st.session.swarm.active;
  for (const a of st.live) {
    if (!a.running && !a.text) continue;
    for (const t of a.tools) {
      kids.push(
        h(
          'div',
          { class: 'tool live' },
          h(
            'div',
            { class: 'head' },
            h('span', { class: 'glyph', text: '●' }),
            swarm ? h('span', { class: 'tname', text: a.name }) : null,
            h('span', { class: 'tname', text: t.name }),
            h('span', { class: 'desc', text: t.description === t.name ? '' : t.description }),
          ),
        ),
      );
    }
    if (a.text) {
      const who = swarm ? h('div', { class: 'who', text: a.name }) : null;
      if (who) who.style.color = colorOf(a.name, a.color);
      kids.push(h('div', { class: 'msg-assistant' }, who, md(a.text)));
    } else if (a.running && !a.tools.length && !st.compacting) {
      kids.push(
        h('div', {
          class: 'thinking',
          text: `${swarm ? a.name + ' is ' : ''}${a.thinking ? 'thinking…' : 'working…'}`,
        }),
      );
    }
  }
  live.replaceChildren(...kids);
}

// ------------------------------------------------------------------------------------------------ top bar
function renderTop() {
  const st = S.st;
  const has = !!st;
  $('#title').replaceChildren(
    has ? base(st.session.cwd) : 'Nacreframe',
    has ? h('small', { text: st.session.cwd }) : '',
  );
  for (const id of ['mode', 'sandbox', 'model', 'compact', 'toggle-panel']) $(`#${id}`).disabled = !has;
  $('#send').disabled = !has;
  $('#stop').hidden = !(has && st.session.running);
  $('#version').textContent = S.info ? `v${S.info.version}` : '';
  if (!has) {
    $('#meter-text').textContent = '–';
    $('#meter-fill').style.width = '0%';
    $('#queued').textContent = '';
    return;
  }
  const mode = $('#mode');
  mode.value = st.session.mode;
  mode.className = `mode-${st.session.mode}`;
  $('#sandbox').value = st.session.sandbox;

  const sel = $('#model');
  const want = st.session.model ?? '';
  const known = new Set([...sel.options].map((o) => o.value));
  if (!known.has(want) || (S.models && sel.options.length < 2))
    fillModelSelect(sel, S.models ?? [], want, true);
  sel.value = want;

  const win = st.session.contextWindow;
  const used = st.contextTokens;
  const pct = win ? Math.min(100, Math.round((used / win) * 100)) : 0;
  const fill = $('#meter-fill');
  fill.style.width = `${pct}%`;
  fill.className = `meter-fill ${pct >= 80 ? 'hot' : pct >= 60 ? 'warn' : ''}`;
  const tick = $('#meter-tick');
  tick.hidden = !win;
  if (win && st.session.target) tick.style.left = `${Math.round((st.session.target / win) * 100)}%`;
  $('#meter-text').textContent = win ? `${pct}% · ${fmt(used)}/${fmt(win)}` : 'unknown window';
  $('#meter').title = win
    ? `Context ${used.toLocaleString()} of ${win.toLocaleString()} tokens (${st.session.contextSource}). Automatic compaction starts at ${st.session.target.toLocaleString()} tokens (the tick), and the chat pauses until it finishes.`
    : 'No model selected yet.';
  $('#queued').textContent = st.queued
    ? `${st.queued} message${st.queued > 1 ? 's' : ''} queued`
    : `↑${fmt(st.tokens.input)} ↓${fmt(st.tokens.output)} tokens`;
  $('#input').placeholder = !st.session.model
    ? 'Pick a model first…'
    : st.session.swarm.active
      ? `Message the team (lead: ${st.session.swarm.names[0]}) · @name to address one agent`
      : st.session.running
        ? 'Type to steer the agent…'
        : 'Ask anything…';
}

function fillModelSelect(sel, models, current, withPlaceholder) {
  const opts = [];
  if (withPlaceholder || !current)
    opts.push(h('option', { value: '', text: current ? '' : 'Select a model…' }));
  const seen = new Set();
  for (const m of models) {
    seen.add(m.spec);
    const ctx = m.contextWindow ? ` · ${fmt(m.contextWindow)}` : '';
    opts.push(h('option', { value: m.spec, text: `${m.spec}${ctx}${m.loaded ? ' ●' : ''}` }));
  }
  if (current && !seen.has(current)) opts.push(h('option', { value: current, text: current }));
  sel.replaceChildren(...opts);
}

// ------------------------------------------------------------------------------------------------ cards (approval, question, compaction)
function renderCards() {
  const st = S.st;
  const cards = $('#cards');
  if (!st) {
    S.cardKey = undefined;
    return void cards.replaceChildren();
  }
  // State arrives many times a second while the agent streams. Rebuilding the cards each time would wipe
  // whatever the user is typing into an answer or note box, so rebuild only when their content changed.
  // The session id is part of the key: approval ids are per session, and a stale card must never survive a switch.
  const idKey = JSON.stringify([S.id, st.approval?.id ?? null, st.question?.id ?? null]);
  const key = JSON.stringify([
    idKey,
    st.approval?.pending ?? null,
    st.compacting ? (st.compacting.pct ?? 'c') : null,
    st.compacting || /compact/i.test(st.status ?? '') ? 'compact' : (st.status ?? ''),
  ]);
  if (key === S.cardKey) return;
  if (cards.querySelector('input:focus') && S.cardIdKey === idKey) return; // same card, only a counter changed
  S.cardKey = key;
  S.cardIdKey = idKey;
  const out = [];
  if (st.compacting || (st.status && /compact/i.test(st.status))) {
    out.push(
      h(
        'div',
        { class: 'card banner-pause', role: 'status' },
        h('h3', { text: `⏸ Compacting context (${st.compacting?.pct ?? '80+'}%) — chat paused` }),
        h('div', {
          class: 'reason',
          text: 'Older messages are being summarised so the conversation never overflows. Nothing is deleted from the saved history. Anything you send now is queued and delivered right after.',
        }),
      ),
    );
  } else if (st.status) out.push(h('div', { class: 'notice', text: st.status }));

  if (st.approval) {
    const a = st.approval;
    const note = h('input', {
      type: 'text',
      placeholder: 'Or tell it what to do instead…',
      'aria-label': 'Feedback',
    });
    const sid = S.id;
    let sent = false; // one decision per card: a double click or a held key must not post twice
    const send = async (body) => {
      if (sent) return;
      sent = true;
      const ok = await guard(async () => {
        await api(`/api/sessions/${sid}/approval`, { method: 'POST', body: { id: a.id, ...body } });
        return true;
      })();
      if (!ok) sent = false; // the request failed (already toasted): let the user try again
    };
    out.push(
      h(
        'div',
        { class: 'card approval', role: 'alertdialog', 'aria-label': 'Approval needed' },
        h('h3', {
          text: `Approval needed${a.agentId !== 'main' ? ` · ${a.agentId}` : ''}${a.pending > 1 ? ` · ${a.pending - 1} more waiting` : ''}`,
        }),
        h('div', null, h('strong', { text: a.toolName }), ' ', h('span', { text: a.description })),
        h('div', { class: 'reason', text: a.reason }),
        a.preview ? h('pre', null, diffNodes(a.preview.split('\n').slice(0, 60))) : null,
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'btn primary',
            'data-key': 'y',
            onclick: () => send({ allow: true }),
            text: 'Allow once (y)',
          }),
          h('button', {
            class: 'btn',
            'data-key': 'a',
            onclick: () => send({ allow: true, always: true }),
            text: `Always allow ${a.grantLabel} (a)`,
          }),
          h('button', {
            class: 'btn danger',
            'data-key': 'n',
            onclick: () => send({ allow: false }),
            text: 'Deny (n)',
          }),
        ),
        h(
          'div',
          { class: 'row' },
          note,
          h('button', {
            class: 'btn small',
            onclick: () => send({ allow: false, feedback: note.value }),
            text: 'Deny with note',
          }),
        ),
      ),
    );
  }
  if (st.question) {
    const q = st.question;
    const reply = (text) =>
      guard(() => api(`/api/sessions/${S.id}/answer`, { method: 'POST', body: { id: q.id, text } }))();
    const field = h('input', { type: 'text', placeholder: 'Your answer…', 'aria-label': 'Answer' });
    out.push(
      h(
        'div',
        { class: 'card question' },
        h('h3', { text: `Question${q.agent !== 'main' ? ` · ${q.agent}` : ''}` }),
        h('div', { text: q.question }),
        h(
          'div',
          { class: 'row' },
          (q.options ?? []).map((o) => h('button', { class: 'btn', onclick: () => reply(o), text: o })),
        ),
        h(
          'div',
          { class: 'row' },
          field,
          h('button', {
            class: 'btn primary small',
            onclick: () => reply(field.value || '(no answer)'),
            text: 'Answer',
          }),
        ),
      ),
    );
  }
  cards.replaceChildren(...out);
}

function diffNodes(lines) {
  const frag = document.createDocumentFragment();
  lines.forEach((l, i) => {
    const cls =
      l.startsWith('+') && !l.startsWith('+++')
        ? 'add'
        : l.startsWith('-') && !l.startsWith('---')
          ? 'del'
          : l.startsWith('@@')
            ? 'hunk'
            : '';
    frag.append(h('span', { class: cls, text: l }), i < lines.length - 1 ? '\n' : '');
  });
  return frag;
}

// ------------------------------------------------------------------------------------------------ side panel
function renderPanel() {
  const st = S.st;
  const panel = $('#panel');
  const todos = (st?.todos ?? []).filter(Boolean);
  const hasTodos = todos.length && !todos.every((t) => t.status === 'completed');
  const swarm = st?.session.swarm.active;
  const browser = st?.browser.open;
  const show = !!st && (S.pinned || hasTodos || swarm || browser);
  $('#app').classList.toggle('with-panel', show);
  panel.hidden = !show;
  // Below 1100px the panel is an overlay that only shows with .open; without this the Panel button did nothing there.
  panel.classList.toggle('open', S.pinned);
  if (!show) return void scheduleShot(false);

  // Below 1100px the panel slides over the top bar, hiding the Panel button: give it a way to close itself.
  // (CSS shows this header only in that overlay mode.)
  const cards = [
    h(
      'div',
      { class: 'panel-head' },
      h('span', { text: 'Details' }),
      h('button', {
        class: 'btn small',
        'aria-label': 'Close details panel',
        onclick: () => {
          S.pinned = false;
          renderPanel();
        },
        text: 'Close',
      }),
    ),
  ];
  if (hasTodos) {
    cards.push(
      h(
        'div',
        { class: 'pcard' },
        h('h4', { text: 'Tasks' }),
        todos.map((t) =>
          h(
            'div',
            { class: `todo ${t.status}` },
            h('span', { text: t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐' }),
            h('span', { text: t.content }),
          ),
        ),
      ),
    );
  }
  if (swarm) {
    cards.push(
      h(
        'div',
        { class: 'pcard' },
        h(
          'h4',
          null,
          'Swarm',
          h('button', {
            class: 'btn small',
            onclick: guard(() =>
              api(`/api/sessions/${S.id}/swarm`, { method: 'POST', body: { action: 'stop' } }),
            ),
            text: 'Stop',
          }),
        ),
        st.live.map((a) => {
          const dot = h('span', { class: `dot ${a.running ? 'run' : ''}` });
          dot.style.background = a.running ? colorOf(a.name, a.color) : '';
          const name = h('strong', { text: a.name });
          name.style.color = colorOf(a.name, a.color);
          const last = a.text.split('\n').filter(Boolean).slice(-1)[0] ?? a.tools.at(-1)?.description ?? '';
          return h(
            'div',
            { class: 'agent' },
            dot,
            h(
              'div',
              null,
              name,
              h('span', { class: 'role', text: a.role ?? '' }),
              last ? h('span', { class: 'role', text: a.running ? `▸ ${last.slice(0, 90)}` : '' }) : null,
            ),
          );
        }),
      ),
    );
  } else {
    cards.push(
      h(
        'div',
        { class: 'pcard' },
        h('h4', { text: 'Swarm' }),
        h('div', { class: 'note', text: 'Let several agents collaborate in a shared channel.' }),
        h(
          'div',
          { class: 'row' },
          (S.info?.swarmPresets ?? []).map((p) =>
            h('button', {
              class: 'btn small',
              onclick: guard(() =>
                api(`/api/sessions/${S.id}/swarm`, { method: 'POST', body: { action: 'start', arg: p } }),
              ),
              text: p,
            }),
          ),
        ),
      ),
    );
  }
  if (browser) {
    const holder = st.browser.holder;
    cards.push(
      h(
        'div',
        { class: 'pcard' },
        h('h4', { text: 'Live browser' }),
        h('div', { class: 'url', text: st.browser.url ?? 'about:blank' }),
        h('img', { class: 'shot', id: 'shot', alt: 'Live view of the browser the agent controls' }),
        h('div', { class: 'note', text: st.browser.lastAction ?? '' }),
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'btn small',
            onclick: guard(() =>
              api(`/api/sessions/${S.id}/browser`, {
                method: 'POST',
                body: { action: holder === 'user' ? 'release' : 'takeover' },
              }),
            ),
            text: holder === 'user' ? 'Give back to agent' : 'Pause agent',
          }),
          h('button', {
            class: 'btn small',
            onclick: guard(() =>
              api(`/api/sessions/${S.id}/browser`, { method: 'POST', body: { action: 'close' } }),
            ),
            text: 'Close',
          }),
        ),
      ),
    );
  }
  cards.push(
    h(
      'div',
      { class: 'pcard' },
      h('h4', { text: 'Session' }),
      h('div', { class: 'note', text: `${st.session.sandboxDescription}` }),
      h(
        'div',
        { class: 'row' },
        h('button', {
          class: 'btn small',
          onclick: guard(() => api(`/api/sessions/${S.id}/new`, { method: 'POST', body: {} })),
          text: 'New conversation',
        }),
      ),
    ),
  );
  panel.replaceChildren(...cards);
  // The image element is rebuilt with the panel on every state update: put the last frame straight back so it
  // does not blink empty until the next fetch.
  const shot = $('#shot');
  if (shot && S.shotSrc) shot.src = S.shotSrc;
  scheduleShot(!!browser);
}

function scheduleShot(on) {
  if (!on || !$('#shot')) {
    clearInterval(S.shotTimer);
    S.shotTimer = null;
    S.shotSrc = null;
    return;
  }
  // renderPanel runs on every streamed update; restarting the timer (and fetching at once) each time would
  // hammer the server with screenshot requests. Start it once and let it run.
  if (S.shotTimer) return;
  const tick = () => {
    const sid = S.id;
    if (document.hidden || !sid) return;
    const probe = new Image();
    probe.onload = () => {
      if (S.id !== sid) return; // the user switched sessions while this frame was loading
      S.shotSrc = probe.src;
      const target = $('#shot');
      if (target) target.src = probe.src;
    };
    probe.src = `/api/sessions/${sid}/browser.jpg?t=${Date.now()}`;
  };
  tick();
  S.shotTimer = setInterval(tick, 1500);
}

// ------------------------------------------------------------------------------------------------ composer
const input = () => $('#input');

// "/compact", "/mode auto"… but not a message that merely starts with a path, like "/home/me/notes.txt is empty".
const isCommand = (text) => /^\/[a-z][\w-]*(\s|$)/i.test(text);

async function sendMessage(text) {
  if (!S.id || !text.trim()) return;
  if (isCommand(text)) return slash(text);
  if (!S.st?.session.model) return toast('Pick a model first.', 'error');
  await api(`/api/sessions/${S.id}/prompt`, { method: 'POST', body: { text } });
}

async function slash(text) {
  const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  const post = (path, body) => api(`/api/sessions/${S.id}/${path}`, { method: 'POST', body });
  switch (cmd) {
    case 'compact': {
      const r = await post('compact', { instructions: arg || undefined });
      return toast(r.compacted ? 'Context compacted.' : 'Nothing to compact yet.');
    }
    case 'clear':
    case 'new':
      return void (await post('new', {}));
    case 'stop':
      return void (await post('abort', {}));
    case 'mode':
      return void (await post('settings', { mode: arg }));
    case 'sandbox':
      return void (await post('settings', { sandbox: arg }));
    case 'model':
      return void (await post('settings', { model: arg }));
    case 'swarm':
      return void (await post(
        'swarm',
        arg === 'stop' ? { action: 'stop' } : { action: 'start', arg: arg || 'duo' },
      ));
    default:
      return toast(
        'Commands: /compact [focus] · /clear · /stop · /mode <m> · /sandbox <s> · /model <provider/model> · /swarm <duo|trio|stop>',
      );
  }
}

function autosize() {
  const el = input();
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

// ------------------------------------------------------------------------------------------------ new-session dialog
let savedTimer;
async function openNewDialog() {
  const dlg = $('#new-dialog');
  $('#roots').replaceChildren(...(S.info?.roots ?? []).map((r) => h('option', { value: r })));
  if (!$('#nf-cwd').value) $('#nf-cwd').value = S.info?.roots[0] ?? '';
  $('#nf-approval').value = S.info?.defaults.approval ?? 'ask';
  $('#nf-sandbox').value = S.info?.defaults.sandbox ?? 'guard';
  $('#nf-note').textContent = 'Asking providers which models they have…';
  dlg.showModal();
  try {
    S.models = (await api('/api/models')).models;
  } catch {
    S.models = [];
  }
  fillModelSelect($('#nf-model'), S.models, S.info?.defaults.model ?? '', false);
  if (S.info?.defaults.model) $('#nf-model').value = S.info.defaults.model;
  $('#nf-note').textContent = S.models.length
    ? 'Context windows are read from each server; compaction starts at 80% of them.'
    : 'No provider answered. Start a local server (llama.cpp, Ollama, LM Studio) or add an API key, then reopen this dialog.';
  loadSaved();
}

let savedSeq = 0;
async function loadSaved() {
  const seq = ++savedSeq;
  const sel = $('#nf-resume');
  sel.replaceChildren(h('option', { value: '', text: 'Start fresh' }));
  try {
    const saved = await api(`/api/saved?cwd=${encodeURIComponent($('#nf-cwd').value)}`);
    if (seq !== savedSeq) return; // a newer lookup (typing continued) has superseded this answer
    for (const s of saved.sessions)
      sel.append(h('option', { value: `session:${s.id}`, text: `Conversation — ${s.preview}` }));
    for (const s of saved.swarms)
      sel.append(
        h('option', {
          value: `swarm:${s.id}`,
          text: `Swarm ${s.name} (${s.agents.join(', ')}) — ${s.messages} messages`,
        }),
      );
  } catch {
    /* folder not allowed or typing in progress */
  }
}

// ------------------------------------------------------------------------------------------------ boot
async function start() {
  try {
    S.info = await api('/api/info');
  } catch (e) {
    if (e instanceof AuthError) return;
    throw e;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#version').textContent = `v${S.info.version}`;
  api('/api/models')
    .then((r) => (S.models = r.models))
    .catch(() => {});
  await refreshSessions();
  if (S.sessions.length === 1) openSession(S.sessions[0].id);
  else if (!S.id) renderEmpty();
  renderTop();
  // One poller only: signing in again (after the cookie expires) must not stack another.
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshSessions, 6000);
}

function wire() {
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    doLogin($('#login-token').value.trim());
  });
  $('#logout').addEventListener(
    'click',
    guard(async () => {
      await api('/api/logout', { method: 'POST', body: {} });
      closeSessionView();
      showLogin();
    }),
  );
  $('#new-session').addEventListener('click', () => openNewDialog());
  $('#nf-cancel').addEventListener('click', () => $('#new-dialog').close());
  $('#nf-cwd').addEventListener('input', () => {
    clearTimeout(savedTimer);
    savedTimer = setTimeout(loadSaved, 300);
  });
  $('#new-form').addEventListener(
    'submit',
    guard(async (e) => {
      e.preventDefault();
      const resume = $('#nf-resume').value;
      const body = {
        cwd: $('#nf-cwd').value.trim(),
        model: $('#nf-model').value || undefined,
        approval: $('#nf-approval').value,
        sandbox: $('#nf-sandbox').value,
        ...(resume.startsWith('session:') ? { resume: resume.slice(8) } : {}),
        ...(resume.startsWith('swarm:') ? { swarmResume: resume.slice(6) } : {}),
      };
      $('#nf-create').disabled = true;
      try {
        const { id } = await api('/api/sessions', { method: 'POST', body });
        $('#new-dialog').close();
        await refreshSessions();
        openSession(id);
      } finally {
        $('#nf-create').disabled = false;
      }
    }),
  );

  $('#composer').addEventListener(
    'submit',
    guard(async (e) => {
      e.preventDefault();
      const text = input().value;
      if (!text.trim()) return;
      // Check before clearing the box, so a message is never silently thrown away.
      if (!S.id) return toast('Open or create a session first.', 'error');
      if (!isCommand(text) && !S.st?.session.model) return toast('Pick a model first.', 'error');
      input().value = '';
      autosize();
      S.stickBottom = true;
      try {
        await sendMessage(text);
      } catch (err) {
        // The request failed: give the text back (unless they already started typing something else).
        if (!input().value) {
          input().value = text;
          autosize();
        }
        throw err;
      }
    }),
  );
  input().addEventListener('input', autosize);
  input().addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    } else if (e.key === 'Escape' && S.st?.session.running) {
      guard(() => api(`/api/sessions/${S.id}/abort`, { method: 'POST', body: {} }))();
    }
  });
  $('#stop').addEventListener(
    'click',
    guard(() => api(`/api/sessions/${S.id}/abort`, { method: 'POST', body: {} })),
  );
  $('#compact').addEventListener(
    'click',
    guard(async () => {
      const r = await api(`/api/sessions/${S.id}/compact`, { method: 'POST', body: {} });
      toast(r.compacted ? 'Context compacted.' : 'Nothing to compact yet.');
    }),
  );
  $('#mode').addEventListener(
    'change',
    guard((e) => api(`/api/sessions/${S.id}/settings`, { method: 'POST', body: { mode: e.target.value } })),
  );
  $('#sandbox').addEventListener(
    'change',
    guard((e) =>
      api(`/api/sessions/${S.id}/settings`, { method: 'POST', body: { sandbox: e.target.value } }),
    ),
  );
  $('#model').addEventListener(
    'change',
    guard(async (e) => {
      if (!e.target.value) return;
      await api(`/api/sessions/${S.id}/settings`, { method: 'POST', body: { model: e.target.value } });
    }),
  );
  $('#toggle-panel').addEventListener('click', () => {
    S.pinned = !S.pinned;
    renderPanel();
  });
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#scroll').addEventListener('scroll', () => {
    const el = $('#scroll');
    S.stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  });
  document.addEventListener('keydown', (e) => {
    if (
      !S.st?.approval ||
      e.repeat || // a held key must not approve (or deny) several things in a row
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') ||
      $('dialog[open]') // a modal is in front of the approval card: the keystroke is not meant for it
    )
      return;
    const btn = $(`#cards [data-key="${e.key.toLowerCase()}"]`); // Caps Lock gives "Y"
    if (btn) {
      e.preventDefault();
      btn.click();
    }
  });
  // On a phone the session list is an overlay: tapping the conversation should put it away.
  $('#main').addEventListener('click', (e) => {
    if (!e.target.closest('#menu-btn')) $('#sidebar').classList.remove('open');
  });
}

wire();
const hashToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (hashToken) {
  // The fragment never reaches the server or its logs; remove it from the address bar straight away.
  history.replaceState(null, '', location.pathname + location.search);
  doLogin(hashToken);
} else {
  start().catch((e) => {
    if (!(e instanceof AuthError)) toast(e.message, 'error');
  });
}
