// Phone shopping page. Talks to the same /api as the wall display.
//   * Large tiles by aisle; tap to tick, long-press or ⋯ to edit; search; recent items; emoji icons.
//   * Changes show at once. If the signal drops (or Home Assistant is away) they are kept in a queue on the phone and
//     sent, in order, when it is back. The last list stays visible meanwhile.
import { foodIcon } from './foodicons.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const K = { last: 'hq-shop-last', cache: 'hq-shop-cache-v2', store: 'hq-shop-store', id: 'hq-shop-id', queue: 'hq-shop-queue', layout: 'hq-shop-layout', wake: 'hq-shop-wake' };
const S = { stores: [], groceries: [], catalog: [], usuals: [], recent: [], catOrder: { all: [] }, store: 'all', online: true, locked: false, queue: [], layout: 'tiles', wake: false, query: '' };
let wroteAt = 0, toastTimer = null, flushing = false, wakeLock = null;

const load = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
S.last = load(K.last, ''); S.store = load(K.store, 'all'); S.layout = load(K.layout, 'tiles'); S.wake = load(K.wake, false); S.queue = load(K.queue, []);
{ const c = load(K.cache, null); if (c && c.stores) Object.assign(S, c); }

async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { const e = new Error('locked'); e.locked = true; throw e; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
  return j;
}
const queueable = (e) => !e.locked && (!e.status || e.status === 503); // no connection, or Home Assistant away

// ------------------------------------------------------------------ helpers
const storeName = (id) => (S.stores.find((s) => s.id === id) || {}).name || '';
const defaultStore = () => (S.store === 'all' ? (S.stores[0] || {}).id : S.store);
function catFor(name) {
  const n = plain(name);
  const past = S.recent.find((r) => plain(r.name) === n); if (past) return past.cat;
  const hit = S.catalog.find((c) => plain(c[0]) === n) || S.catalog.find((c) => { const a = plain(c[0]); return a.includes(n) || n.includes(a); })
    || S.catalog.find((c) => n.split(/\s+/).some((w) => w.length > 3 && plain(c[0]).includes(w)));
  return hit ? hit[1] : 'Other';
}
function suggestions(q) {
  const n = plain(q);
  if (!n) return [];
  const pool = S.recent.map((r) => [r.name, r.cat]).concat(S.catalog).concat(S.usuals.map((u) => [u, catFor(u)]));
  const seen = new Set(), out = [];
  [(x) => plain(x[0]).startsWith(n), (x) => plain(x[0]).indexOf(n) > 0].forEach((test) => pool.forEach((x) => { const k = plain(x[0]); if (test(x) && !seen.has(k)) { seen.add(k); out.push(x); } }));
  return out.slice(0, 6);
}

// ------------------------------------------------------------------ messages
function toast(text, action) {
  const t = $('#toast');
  t.innerHTML = '<span>' + esc(text) + '</span>' + (action ? '<button>' + esc(action.label) + '</button>' : '');
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 3500);
}
function status() {
  const b = $('#banner'); let msg = '';
  if (S.locked) msg = 'This phone needs the family link. Open the link you were given (it ends in ?key=…) once, and this page will work.';
  else if (!S.online) msg = 'No connection' + (S.queue.length ? ': ' + S.queue.length + ' change' + (S.queue.length === 1 ? '' : 's') + ' waiting to sync.' : ': showing the last list.');
  else if (S.queue.length) msg = S.queue.length + ' change' + (S.queue.length === 1 ? '' : 's') + ' waiting to sync…';
  b.textContent = msg; b.hidden = !msg;
  $('#status').classList.toggle('off', S.locked || !S.online);
}

// ------------------------------------------------------------------ sending changes (with a queue for when there is no signal)
const persistQueue = () => keep(K.queue, S.queue);
async function run(op) { return api('POST', op.t === 'put' ? '/groceries' : '/groceries/clear', op.body); }
async function send(op) {
  wroteAt = Date.now();
  if (S.queue.length || !S.online) { S.queue.push(op); persistQueue(); render(); flush(); return; }
  try { await run(op); wroteAt = Date.now(); }
  catch (e) {
    wroteAt = Date.now();
    if (e.locked) { S.locked = true; status(); return; }
    if (queueable(e)) { S.queue.push(op); persistQueue(); S.online = !!e.status; render(); status(); }
    else { toast('Couldn’t save: ' + e.message); refresh(true); }
  }
}
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (S.queue.length) {
      try { await run(S.queue[0]); S.queue.shift(); persistQueue(); S.online = true; }
      catch (e) {
        if (e.locked) { S.locked = true; break; }
        if (queueable(e)) { S.online = !!e.status; break; }
        S.queue.shift(); persistQueue(); toast('One change could not be saved: ' + e.message);
      }
    }
  } finally { flushing = false; }
  render(); status();
  if (!S.queue.length) refresh(true);
}

// ------------------------------------------------------------------ data
function apply(s) {
  Object.assign(S, { stores: s.stores, groceries: s.groceries, catalog: s.catalog, usuals: s.usuals, recent: s.recent || [], catOrder: s.catOrder });
  if (S.store !== 'all' && !S.stores.some((x) => x.id === S.store)) S.store = 'all';
  render();
}
function saveCache() { keep(K.cache, { stores: S.stores, groceries: S.groceries, catalog: S.catalog, usuals: S.usuals, recent: S.recent, catOrder: S.catOrder }); }
async function refresh(force) {
  const started = Date.now();
  if (S.queue.length) { await flush(); if (S.queue.length) return; } // never overwrite changes that have not been sent
  try {
    const s = await api('GET', '/state');
    if (!force && wroteAt > started) return; // a change was made while this was loading: its answer is stale
    S.locked = false; S.online = true; apply(s);
  } catch (e) { if (e.locked) S.locked = true; else S.online = false; }
  status();
}

// ------------------------------------------------------------------ actions
function addItem(raw, picked, shop) {
  if (!raw.trim() || !S.stores.length) return;
  if (!shop && S.store === 'all') return askShop(raw, picked); // from "All" there is no obvious shop: ask
  const comma = raw.indexOf(',');
  let name = (comma >= 0 ? raw.slice(0, comma) : raw).trim(); const note = comma >= 0 ? raw.slice(comma + 1).trim() : '';
  if (!name || !S.stores.length) return;
  if (!picked) { const first = suggestions(name)[0]; if (first && plain(first[0]).startsWith(plain(name))) name = first[0]; } // Enter takes the top suggestion
  const store = shop || S.store;
  S.last = store; keep(K.last, store);
  const same = S.groceries.find((g) => g.store === store && plain(g.name) === plain(name));
  if (same) {
    if (same.done) { same.done = false; render(); send({ t: 'put', body: same }); toast('Back on the list: ' + same.name); }
    else toast('Already on the list');
    return;
  }
  const g = { id: uid(), name: S.catalog.find((c) => plain(c[0]) === plain(name))?.[0] || cap(name), cat: catFor(name), qty: 1, store, done: false, note };
  S.groceries.push(g); render(); send({ t: 'put', body: g });
  if (S.store === 'all') toast('Added ' + g.name + ' to ' + storeName(store));
}
function askShop(raw, picked) {
  const name = raw.split(',')[0].trim();
  const order = S.stores.slice().sort((a, b) => (b.id === S.last) - (a.id === S.last));
  sheet('<h2>Add “' + esc(name) + '” to…</h2><div class="shoppick">' + order.map((s) => '<button data-pickshop="' + esc(s.id) + '">' + esc(s.name) + '<small>' + S.groceries.filter((g) => !g.done && g.store === s.id).length + ' to buy</small></button>').join('') + '</div><div class="actions"><button data-sheet="cancel">Cancel</button></div>');
  $('#sheet').dataset.pending = JSON.stringify({ raw, picked: !!picked });
}
function tick(id) {
  const g = S.groceries.find((x) => x.id === id);
  if (!g) return;
  g.done = !g.done; render(); send({ t: 'put', body: g });
}
function removeItems(gone, message) {
  const ids = gone.map((g) => g.id);
  S.groceries = S.groceries.filter((g) => !ids.includes(g.id)); render();
  send({ t: 'clear', body: { ids } });
  toast(message, { label: 'Undo', run: () => { S.groceries = S.groceries.concat(gone); render(); send({ t: 'clear', body: { ids, cleared: false } }); } });
}
function clearDone() {
  const gone = S.groceries.filter((g) => g.done && (S.store === 'all' || g.store === S.store));
  if (gone.length) removeItems(gone, 'Cleared ' + gone.length + (gone.length === 1 ? ' item' : ' items'));
}

// ------------------------------------------------------------------ views
function tile(g, showShop, waiting) {
  const sub = g.note || '';
  return '<div class="tile' + (g.done ? ' done' : '') + (waiting.has(g.id) ? ' wait' : '') + '" data-id="' + esc(g.id) + '">' +
    '<div class="ico">' + foodIcon(g.name, g.cat) + '</div><div class="tname">' + esc(g.name) + '</div>' + (sub ? '<div class="tsub">' + esc(sub) + '</div>' : '') +
    (g.qty > 1 ? '<span class="badge">×' + g.qty + '</span>' : '') + (showShop ? '<span class="shopname">' + esc(storeName(g.store)) + '</span>' : '') +
    '<button class="tmore" data-act="edit" data-id="' + esc(g.id) + '" aria-label="Edit ' + esc(g.name) + '">⋯</button></div>';
}
function render() {
  const q = plain(S.query);
  const inStore = (g) => (S.store === 'all' || g.store === S.store) && (!q || plain(g.name).includes(q) || plain(g.note).includes(q));
  const open = S.groceries.filter((g) => !g.done), items = S.groceries.filter(inStore);
  const waiting = new Set(S.queue.filter((o) => o.t === 'put').map((o) => o.body.id));
  $('#tabs').innerHTML = [['all', 'All']].concat(S.stores.map((s) => [s.id, s.name])).map(([id, label]) => {
    const n = open.filter((g) => id === 'all' || g.store === id).length;
    return '<button class="tab' + (S.store === id ? ' on' : '') + '" data-tab="' + esc(id) + '">' + esc(label) + (n ? '<b>' + n + '</b>' : '') + '</button>';
  }).join('') + '<button class="tab plus" data-act="shops" aria-label="Add a shop">+ Shop</button>';
  const order = (S.catOrder[S.store] || S.catOrder.all || []).filter((c) => c !== 'Other').concat(['Other']);
  const showShop = S.store === 'all' && S.stores.length > 1;
  const todo = items.filter((g) => !g.done), done = items.filter((g) => g.done);
  let html = '';
  const aisleOf = (g) => { const i = order.indexOf(g.cat || 'Other'); return i < 0 ? order.length - 1 : i; };
  if (S.store === 'all') { // everything to buy, shop by shop
    S.stores.forEach((s) => {
      const mine = todo.filter((g) => g.store === s.id).sort((a, b) => aisleOf(a) - aisleOf(b));
      if (mine.length) html += '<div class="aisle shophead">' + esc(s.name) + ' · ' + mine.length + '</div><div class="grid">' + mine.map((g) => tile(g, false, waiting)).join('') + '</div>';
    });
  } else order.forEach((cat) => {
    const mine = todo.filter((g) => (g.cat || 'Other') === cat || (cat === 'Other' && !order.includes(g.cat)));
    if (mine.length) html += '<div class="aisle">' + esc(cat) + '</div><div class="grid">' + mine.map((g) => tile(g, false, waiting)).join('') + '</div>';
  });
  if (!todo.length) html += '<div class="empty">' + (q ? 'Nothing matches.' : done.length ? 'Everything is in the cart.' : 'Nothing to buy.') + '</div>';
  if (done.length) html += '<div class="donehead"><div class="aisle">In the cart · ' + done.length + '</div><button class="clear" data-act="clear">Clear</button></div><div class="grid">' + done.map((g) => tile(g, showShop, waiting)).join('') + '</div>';
  $('#addin').placeholder = S.store === 'all' ? 'Add an item (I’ll ask which shop)' : 'Add to ' + storeName(S.store) + '  (Milk, 2 liters)';
  const list = $('#list'); list.innerHTML = html; list.classList.toggle('rows', S.layout === 'rows');
  const have = new Set(S.groceries.filter((g) => !g.done && (S.store === 'all' || g.store === S.store)).map((g) => plain(g.name)));
  const pool = S.recent.map((r) => r.name).concat(S.usuals);
  const seen = new Set();
  $('#recent').innerHTML = pool.filter((n) => { const k = plain(n); if (seen.has(k) || have.has(k)) return false; seen.add(k); return true; }).slice(0, 24)
    .map((n) => '<button class="chip" data-add="' + esc(n) + '">' + foodIcon(n, catFor(n)) + ' ' + esc(n) + '</button>').join('');
  if (S.queue.length) saveCache(); status();
}
function showSuggest(q) {
  const box = $('#suggest'), hits = suggestions(q.split(',')[0]);
  box.innerHTML = hits.map((c) => '<button data-add="' + esc(c[0]) + '"><span>' + foodIcon(c[0], c[1]) + ' ' + esc(c[0]) + '</span><small>' + esc(c[1]) + '</small></button>').join('');
  box.hidden = !hits.length;
}

// ------------------------------------------------------------------ sheets
function sheet(html) { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); /* close the keyboard so it cannot cover the popup */ const sh = $('#sheet'); sh.innerHTML = '<div class="card">' + html + '</div>'; sh.hidden = false; }
function closeSheet() { const sh = $('#sheet'); sh.hidden = true; sh.innerHTML = ''; delete sh.dataset.id; }
function openEdit(id) {
  const g = S.groceries.find((x) => x.id === id);
  if (!g) return;
  const cats = (S.catOrder.all || []).concat(['Other']).filter((c, i, a) => a.indexOf(c) === i);
  sheet('<h2>' + foodIcon(g.name, g.cat) + ' Edit item</h2><label>Name</label><input type="text" id="ename" value="' + esc(g.name) + '" maxlength="80">' +
    '<label>Quantity</label><div class="stepper"><button data-q="-1">−</button><span id="eqty">' + g.qty + '</span><button data-q="1">+</button></div>' +
    '<label>Note</label><input type="text" id="enote" value="' + esc(g.note || '') + '" maxlength="120" placeholder="Brand, size…">' +
    '<label>Shop</label><select id="estore">' + S.stores.map((s) => '<option value="' + esc(s.id) + '"' + (s.id === g.store ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select>' +
    '<label>Aisle</label><select id="ecat">' + cats.map((c) => '<option' + (c === g.cat ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
    '<div class="actions"><button class="del" data-sheet="del">Delete</button><button data-sheet="cancel">Cancel</button><button class="go" data-sheet="save">Save</button></div>');
  $('#sheet').dataset.id = id;
}
function openMenu() {
  const sw = (on) => '<span class="switch' + (on ? ' on' : '') + '"></span>';
  sheet('<h2>Shopping</h2><div class="menu">' +
    '<button class="row" data-menu="layout">Large tiles' + sw(S.layout === 'tiles') + '</button>' +
    ('wakeLock' in navigator ? '<button class="row" data-menu="wake">Keep the screen on' + sw(S.wake) + '</button>' : '') +
    '<button class="row" data-act="shops">Manage shops<span>›</span></button></div>' +
    '<div class="actions"><button data-sheet="cancel">Close</button></div>');
}
function openShops(note) {
  sheet('<h2>Shops</h2>' + (note ? '<p class="hint">' + note + '</p>' : '') +
    S.stores.map((s) => '<div class="shoprow"><input type="text" value="' + esc(s.name) + '" data-rename="' + esc(s.id) + '" maxlength="30" aria-label="Shop name">' +
      '<span class="pill' + (s.ha ? ' ha' : '') + '">' + (s.ha ? 'Home Assistant' : 'Local') + '</span><button class="del2" data-delshop="' + esc(s.id) + '" aria-label="Delete ' + esc(s.name) + '">✕</button></div>').join('') +
    '<label>Add a shop</label><div class="shoprow"><input type="text" id="newshop" placeholder="Shop name" maxlength="30"><button class="go2" data-newshop="1">Add</button></div>' +
    '<p class="hint">A new shop works straight away on the phones and the wall display. To see it in Home Assistant as well, create a to-do list there named “Shopping <b>shop name</b>” (without punctuation); the items then move across by themselves.</p>' +
    '<div class="actions"><button class="go" data-sheet="cancel">Done</button></div>');
}
async function shopCall(method, path, body, ok) {
  try { const r = await api(method, path, body); await refresh(true); if (ok) ok(r); } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ events
document.addEventListener('click', (e) => {
  const t = e.target.closest('button'), sh = $('#sheet');
  if (e.target === sh) return closeSheet();
  if (!t) return;
  if (t.dataset.tab) { S.store = t.dataset.tab; keep(K.store, S.store); render(); return; }
  if (t.dataset.act === 'edit') return openEdit(t.dataset.id);
  if (t.dataset.act === 'clear') return clearDone();
  if (t.dataset.act === 'shops') return openShops();
  if (t.dataset.pickshop) { let p = {}; try { p = JSON.parse(sh.dataset.pending || '{}'); } catch (x) {} closeSheet(); $('#addin').value = ''; $('#suggest').hidden = true; return addItem(p.raw || '', p.picked, t.dataset.pickshop); }
  if (t.dataset.add) { $('#addin').value = ''; $('#suggest').hidden = true; return addItem(t.dataset.add, true); }
  if (t.dataset.q) { const el = $('#eqty'); el.textContent = Math.max(1, Math.min(99, +el.textContent + +t.dataset.q)); return; }
  if (t.dataset.menu === 'layout') { S.layout = S.layout === 'tiles' ? 'rows' : 'tiles'; keep(K.layout, S.layout); render(); return openMenu(); }
  if (t.dataset.menu === 'wake') { S.wake = !S.wake; keep(K.wake, S.wake); applyWake(); return openMenu(); }
  if (t.dataset.delshop) { const s = S.stores.find((x) => x.id === t.dataset.delshop); return shopCall('DELETE', '/shops/' + t.dataset.delshop, null, () => openShops('Deleted ' + (s ? s.name : 'the shop') + '.')); }
  if (t.dataset.newshop) { const name = $('#newshop').value.trim(); if (!name) return; return shopCall('POST', '/shops', { name }, (r) => { S.store = r.id; keep(K.store, S.store); render(); openShops('Added <b>' + esc(r.name) + '</b>. For Home Assistant, name its to-do list “' + esc(r.haName) + '” (entity <b>' + esc(r.haEntity) + '</b>).'); }); }
  if (t.dataset.sheet === 'cancel') return closeSheet();
  const g = S.groceries.find((x) => x.id === sh.dataset.id);
  if (t.dataset.sheet === 'del' && g) { closeSheet(); return removeItems([g], 'Deleted ' + g.name); }
  if (t.dataset.sheet === 'save' && g) {
    Object.assign(g, { name: $('#ename').value.trim() || g.name, qty: +$('#eqty').textContent, note: $('#enote').value.trim(), store: $('#estore').value, cat: $('#ecat').value });
    closeSheet(); render(); send({ t: 'put', body: g });
  }
});
document.addEventListener('change', (e) => { const el = e.target; if (el.dataset && el.dataset.rename) shopCall('PATCH', '/shops/' + el.dataset.rename, { name: el.value }); });
$('#addform').addEventListener('submit', (e) => { e.preventDefault(); const i = $('#addin'); addItem(i.value); i.value = ''; $('#suggest').hidden = true; });
$('#addin').addEventListener('input', (e) => showSuggest(e.target.value));
$('#menubtn').addEventListener('click', openMenu);
$('#searchbtn').addEventListener('click', () => { const s = $('#search'); s.hidden = !s.hidden; if (s.hidden) { s.value = ''; S.query = ''; render(); } else s.focus(); });
$('#search').addEventListener('input', (e) => { S.query = e.target.value; render(); });

// tiles: tap ticks, a long press edits; scrolling cancels both
let press = null;
const list = $('#list');
list.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tile');
  if (!el || e.target.closest('.tmore')) return;
  press = { id: el.dataset.id, x: e.clientX, y: e.clientY, long: false };
  press.timer = setTimeout(() => { if (press) { press.long = true; if (navigator.vibrate) navigator.vibrate(15); openEdit(press.id); } }, 480);
});
list.addEventListener('pointermove', (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) { clearTimeout(press.timer); press = null; } });
list.addEventListener('pointerup', () => { if (!press) return; clearTimeout(press.timer); const p = press; press = null; if (!p.long) tick(p.id); });
list.addEventListener('pointercancel', () => { if (press) { clearTimeout(press.timer); press = null; } });
list.addEventListener('contextmenu', (e) => e.preventDefault());

// ------------------------------------------------------------------ keep the screen on while shopping
async function applyWake() {
  try {
    if (S.wake && 'wakeLock' in navigator && !document.hidden) { if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } }
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

// ------------------------------------------------------------------ start, and stay live
render(); status(); applyWake();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 20000);
setInterval(() => { if (S.queue.length && !document.hidden) flush(); }, 8000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); applyWake(); } });
window.addEventListener('online', () => refresh());
try {
  let id = localStorage.getItem(K.id);
  if (!id) { id = 'p' + Math.random().toString(36).slice(2, 12); localStorage.setItem(K.id, id); }
  if (window.EventSource) new EventSource('/api/events?frame=' + id).onmessage = (m) => { try { if (JSON.parse(m.data).cmd === 'refresh') refresh(); } catch (e) {} };
} catch (e) {}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/shop-sw.js', { scope: '/shop' }).catch(() => {});
window.addEventListener('pagehide', saveCache);
