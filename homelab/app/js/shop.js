// Phone shopping page. Talks to the same /api as the wall display: GET /state, POST /groceries, POST /groceries/clear.
// Changes show at once and are undone with a message if the server refuses them (for example, Home Assistant is
// offline). The last list is kept on the phone, so it still opens, read-only, when the signal drops in a shop.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const norm = (s) => String(s || '').trim().toLowerCase();
const CACHE_KEY = 'hq-shop-cache-v1', STORE_KEY = 'hq-shop-store', ID_KEY = 'hq-shop-id';
const S = { stores: [], groceries: [], catalog: [], usuals: [], catOrder: { all: [] }, store: 'all', online: true, locked: false };
let wroteAt = 0, toastTimer = null, lastCleared = null;

try { S.store = localStorage.getItem(STORE_KEY) || 'all'; } catch (e) {}
try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c && c.stores) Object.assign(S, { stores: c.stores, groceries: c.groceries, catalog: c.catalog, usuals: c.usuals, catOrder: c.catOrder }); } catch (e) {}

async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { const e = new Error('locked'); e.locked = true; throw e; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
  return j;
}

function categorize(name) {
  const n = norm(name);
  const hit = S.catalog.find((c) => norm(c[0]) === n) || S.catalog.find((c) => { const a = norm(c[0]); return a.includes(n) || n.includes(a); })
    || S.catalog.find((c) => n.split(/\s+/).some((w) => w.length > 3 && norm(c[0]).includes(w)));
  return hit ? hit[1] : 'Other';
}
const storeName = (id) => (S.stores.find((s) => s.id === id) || {}).name || '';
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const defaultStore = () => (S.store === 'all' ? (S.stores[0] || {}).id : S.store);

// ------------------------------------------------------------------ messages
function toast(text, action) {
  const t = $('#toast');
  t.innerHTML = '<span>' + esc(text) + '</span>' + (action ? '<button>' + esc(action.label) + '</button>' : '');
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 3500);
}
function banner(text) { const b = $('#banner'); b.textContent = text || ''; b.hidden = !text; }
function setOnline(ok) { S.online = ok; $('#status').classList.toggle('off', !ok); if (ok && !S.locked) banner(''); else if (!ok && !S.locked) banner('No connection: showing the last list. Changes can’t be saved until you’re back online.'); }
function failed(e) {
  if (e.locked) return lock();
  if (e.status === 503) banner(e.message);
  else toast('Couldn’t save: ' + e.message);
}
function lock() { S.locked = true; $('#status').classList.add('off'); banner('This phone needs the family link. Open the link you were given (it ends in ?key=…) once, and this page will work.'); }

// ------------------------------------------------------------------ data
function apply(s) {
  Object.assign(S, { stores: s.stores, groceries: s.groceries, catalog: s.catalog, usuals: s.usuals, catOrder: s.catOrder });
  if (S.store !== 'all' && !S.stores.some((x) => x.id === S.store)) S.store = 'all';
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ stores: S.stores, groceries: S.groceries, catalog: S.catalog, usuals: S.usuals, catOrder: S.catOrder })); } catch (e) {}
  render();
}
async function refresh() {
  const started = Date.now();
  try {
    const s = await api('GET', '/state');
    if (wroteAt > started) return; // a change was made while this was loading: its answer is stale
    S.locked = false; apply(s); setOnline(true);
  } catch (e) { if (e.locked) lock(); else setOnline(false); }
}
async function save(g, undo) {
  wroteAt = Date.now();
  try { await api('POST', '/groceries', g); wroteAt = Date.now(); setOnline(true); }
  catch (e) { wroteAt = Date.now(); if (undo) undo(); render(); failed(e); }
}

// ------------------------------------------------------------------ actions
function addItem(raw) {
  const name = raw.trim();
  if (!name || !S.stores.length) return;
  const store = defaultStore();
  const same = S.groceries.find((g) => g.store === store && norm(g.name) === norm(name));
  if (same) {
    if (same.done) { same.done = false; render(); save(same, () => { same.done = true; }); toast('Back on the list: ' + same.name); }
    else toast('Already on the list');
    return;
  }
  const cat = S.catalog.find((c) => norm(c[0]) === norm(name));
  const g = { id: uid(), name: cat ? cat[0] : cap(name), cat: categorize(name), qty: 1, store, done: false, note: '' };
  S.groceries.push(g); render();
  save(g, () => { S.groceries = S.groceries.filter((x) => x !== g); });
}
function tick(id) {
  const g = S.groceries.find((x) => x.id === id);
  if (!g) return;
  g.done = !g.done; render();
  save(g, () => { g.done = !g.done; });
}
function clearDone() {
  const gone = S.groceries.filter((g) => g.done && (S.store === 'all' || g.store === S.store));
  if (!gone.length) return;
  removeItems(gone, 'Cleared ' + gone.length + (gone.length === 1 ? ' item' : ' items'));
}
function removeItems(gone, message) {
  const ids = gone.map((g) => g.id);
  S.groceries = S.groceries.filter((g) => !ids.includes(g.id)); render();
  wroteAt = Date.now();
  api('POST', '/groceries/clear', { ids }).then(() => { wroteAt = Date.now(); }, (e) => { wroteAt = Date.now(); S.groceries = S.groceries.concat(gone); render(); failed(e); });
  lastCleared = gone;
  toast(message, { label: 'Undo', run: () => {
    S.groceries = S.groceries.concat(gone); render();
    api('POST', '/groceries/clear', { ids, cleared: false }).then(() => { wroteAt = Date.now(); }, failed);
  } });
}

// ------------------------------------------------------------------ views
function row(g, showShop) {
  return '<div class="item' + (g.done ? ' done' : '') + '"><button class="check" data-act="tick" data-id="' + esc(g.id) + '" aria-label="' + (g.done ? 'Put back' : 'Tick off') + ' ' + esc(g.name) + '"></button>' +
    '<button class="name" data-act="tick" data-id="' + esc(g.id) + '"><b>' + esc(g.name) + '</b>' + (g.note ? '<small>' + esc(g.note) + '</small>' : '') + '</button>' +
    (g.qty > 1 ? '<span class="qty">×' + g.qty + '</span>' : '') + (showShop ? '<span class="shopname">' + esc(storeName(g.store)) + '</span>' : '') +
    '<button class="more" data-act="edit" data-id="' + esc(g.id) + '" aria-label="Edit ' + esc(g.name) + '">⋯</button></div>';
}
function render() {
  const inStore = (g) => S.store === 'all' || g.store === S.store;
  const open = S.groceries.filter((g) => !g.done), items = S.groceries.filter(inStore);
  $('#tabs').innerHTML = [['all', 'All']].concat(S.stores.map((s) => [s.id, s.name])).map(([id, label]) => {
    const n = open.filter((g) => id === 'all' || g.store === id).length;
    return '<button class="tab' + (S.store === id ? ' on' : '') + '" data-tab="' + esc(id) + '">' + esc(label) + (n ? '<b>' + n + '</b>' : '') + '</button>';
  }).join('');
  const order = (S.catOrder[S.store] || S.catOrder.all || []).filter((c) => c !== 'Other').concat(['Other']);
  const showShop = S.store === 'all' && S.stores.length > 1;
  const todo = items.filter((g) => !g.done), done = items.filter((g) => g.done);
  let html = '';
  order.forEach((cat) => {
    const mine = todo.filter((g) => (g.cat || 'Other') === cat || (cat === 'Other' && !order.includes(g.cat)));
    if (mine.length) html += '<div class="aisle">' + esc(cat) + '</div>' + mine.map((g) => row(g, showShop)).join('');
  });
  if (!todo.length) html += '<div class="empty">' + (done.length ? 'Everything is in the cart.' : 'Nothing to buy.') + '</div>';
  if (done.length) html += '<div class="donehead"><div class="aisle" style="margin:0">In the cart · ' + done.length + '</div><button class="clear" data-act="clear">Clear</button></div>' + done.map((g) => row(g, showShop)).join('');
  $('#list').innerHTML = html;
  const have = new Set(todo.map((g) => norm(g.name)));
  $('#usuals').innerHTML = S.usuals.filter((u) => !have.has(norm(u))).map((u) => '<button class="chip" data-usual="' + esc(u) + '">+ ' + esc(u) + '</button>').join('');
}
function suggest(q) {
  const box = $('#suggest'), n = norm(q);
  if (!n) { box.hidden = true; return; }
  const hits = S.catalog.filter((c) => norm(c[0]).startsWith(n)).concat(S.catalog.filter((c) => norm(c[0]).indexOf(n) > 0)).slice(0, 5);
  box.innerHTML = hits.map((c) => '<button data-usual="' + esc(c[0]) + '"><span>' + esc(c[0]) + '</span><small>' + esc(c[1]) + '</small></button>').join('');
  box.hidden = !hits.length;
}
function openSheet(id) {
  const g = S.groceries.find((x) => x.id === id);
  if (!g) return;
  const cats = (S.catOrder.all || []).concat(['Other']).filter((c, i, a) => a.indexOf(c) === i);
  const sh = $('#sheet');
  sh.innerHTML = '<div class="card"><h2>Edit item</h2><label>Name</label><input type="text" id="ename" value="' + esc(g.name) + '" maxlength="80">' +
    '<label>Quantity</label><div class="stepper"><button data-q="-1">−</button><span id="eqty">' + g.qty + '</span><button data-q="1">+</button></div>' +
    '<label>Note</label><input type="text" id="enote" value="' + esc(g.note || '') + '" maxlength="120" placeholder="Brand, size…">' +
    '<label>Shop</label><select id="estore">' + S.stores.map((s) => '<option value="' + esc(s.id) + '"' + (s.id === g.store ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select>' +
    '<label>Aisle</label><select id="ecat">' + cats.map((c) => '<option' + (c === g.cat ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
    '<div class="actions"><button class="del" data-sheet="del">Delete</button><button data-sheet="cancel">Cancel</button><button class="go" data-sheet="save">Save</button></div></div>';
  sh.hidden = false; sh.dataset.id = id;
}
function closeSheet() { const sh = $('#sheet'); sh.hidden = true; sh.innerHTML = ''; }

// ------------------------------------------------------------------ events
document.addEventListener('click', (e) => {
  const t = e.target.closest('button'), sh = $('#sheet');
  if (e.target === sh) return closeSheet();
  if (!t) return;
  if (t.dataset.tab) { S.store = t.dataset.tab; try { localStorage.setItem(STORE_KEY, S.store); } catch (x) {} render(); return; }
  if (t.dataset.act === 'tick') return tick(t.dataset.id);
  if (t.dataset.act === 'edit') return openSheet(t.dataset.id);
  if (t.dataset.act === 'clear') return clearDone();
  if (t.dataset.usual) { $('#addin').value = ''; suggest(''); return addItem(t.dataset.usual); }
  if (t.dataset.q) { const el = $('#eqty'); el.textContent = Math.max(1, Math.min(99, +el.textContent + +t.dataset.q)); return; }
  if (t.dataset.sheet === 'cancel') return closeSheet();
  const g = S.groceries.find((x) => x.id === sh.dataset.id);
  if (t.dataset.sheet === 'del' && g) { closeSheet(); return removeItems([g], 'Deleted ' + g.name); }
  if (t.dataset.sheet === 'save' && g) {
    const name = $('#ename').value.trim() || g.name, was = Object.assign({}, g);
    Object.assign(g, { name, qty: +$('#eqty').textContent, note: $('#enote').value.trim(), store: $('#estore').value, cat: $('#ecat').value });
    closeSheet(); render(); save(g, () => Object.assign(g, was));
  }
});
$('#addform').addEventListener('submit', (e) => { e.preventDefault(); const i = $('#addin'); addItem(i.value); i.value = ''; suggest(''); });
$('#addin').addEventListener('input', (e) => suggest(e.target.value));

// ------------------------------------------------------------------ live updates
render();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', refresh);
try {
  let id = localStorage.getItem(ID_KEY);
  if (!id) { id = 'p' + Math.random().toString(36).slice(2, 12); localStorage.setItem(ID_KEY, id); }
  if (window.EventSource) new EventSource('/api/events?frame=' + id).onmessage = (m) => { try { if (JSON.parse(m.data).cmd === 'refresh') refresh(); } catch (e) {} };
} catch (e) {}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/shop-sw.js', { scope: '/shop' }).catch(() => {});
