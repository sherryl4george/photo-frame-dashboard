// Shopping lists mirrored from Home Assistant to-do lists over MQTT.
//
// Home Assistant stays the master. For each shop (a "store" in settings.json) there is one HA to-do list whose
// entity id ends with the store id (todo.costco, todo.safeway, ...). Two HA automations (see
// home-assistant/shopping.md) publish each list's items to photoframe/lists/<store>/items and carry out
// commands published to photoframe/lists/<store>/cmd. This module keeps a copy of the lists, shows them in the
// shape the Shopping tab expects, and turns the tab's changes into commands. It never edits its own copy: a
// change shows once Home Assistant reports it (a just-added item is shown for a few seconds before that).
//
// Home Assistant to-do items only have a name and a done flag, so the aisle, quantity and note the tab shows
// are kept here (by list and item name) and guessed from the usual-items catalogue when an item comes from HA.

const norm = (s) => String(s || '').trim().toLowerCase();
const PENDING_MS = 20e3;      // show an added item this long while waiting for Home Assistant to report it
const UNDO_MS = 120e3;        // remember cleared items this long, so Undo can bring them back
const SPLIT = /^([a-z0-9_]{1,40}):(.+)$/;

export function createLists({ stores, catalog, mqtt, db = null, onChange = () => {}, now = Date.now }) {
  const storeIds = stores.map((s) => s.id);
  const lists = new Map();   // store id -> { items: [{uid, summary, done}], seen }
  const meta = new Map();    // `${store}|${norm(name)}` -> { cat, qty, note }
  const pending = [];        // { id, store, name, meta, done, ts }
  const cleared = new Map(); // item id -> { store, name, meta, ts }
  let timer = null;

  if (db) {
    db.exec('CREATE TABLE IF NOT EXISTS list_meta (key TEXT PRIMARY KEY, cat TEXT, qty INTEGER, note TEXT, updated INTEGER)');
    for (const r of db.prepare('SELECT key, cat, qty, note FROM list_meta').all()) meta.set(r.key, { cat: r.cat, qty: r.qty, note: r.note });
  }
  const mkey = (store, name) => store + '|' + norm(name);
  function saveMeta(key, m) {
    meta.set(key, m);
    if (db) db.prepare('INSERT INTO list_meta (key, cat, qty, note, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET cat = excluded.cat, qty = excluded.qty, note = excluded.note, updated = excluded.updated')
      .run(key, m.cat, m.qty, m.note, now());
  }
  function dropMeta(key) { meta.delete(key); if (db) db.prepare('DELETE FROM list_meta WHERE key = ?').run(key); }

  /** Guess an aisle from the usual-items catalogue (same idea as the tab): exact, then partial, then a word. */
  function categorize(name) {
    const n = norm(name);
    const hit = catalog.find((c) => norm(c[0]) === n) || catalog.find((c) => { const a = norm(c[0]); return a.includes(n) || n.includes(a); })
      || catalog.find((c) => n.split(/\s+/).some((w) => w.length > 3 && norm(c[0]).includes(w)));
    return hit ? hit[1] : 'Other';
  }
  const metaFor = (store, name) => meta.get(mkey(store, name)) || { cat: categorize(name), qty: 1, note: '' };

  function changed() { clearTimeout(timer); timer = setTimeout(onChange, 250); }
  function cmd(store, c) { return mqtt.publish('photoframe/lists/' + store + '/cmd', JSON.stringify(c)); }

  /** A list arrived from Home Assistant (the retained message, or a change). */
  function onItems(store, payload) {
    if (!storeIds.includes(store)) return;
    let data;
    try { data = JSON.parse(payload); } catch (e) { return; }
    const items = (Array.isArray(data.items) ? data.items : []).filter((i) => i && i.uid && typeof i.summary === 'string')
      .map((i) => ({ uid: String(i.uid), summary: i.summary.trim().slice(0, 80), done: i.status === 'completed' }));
    lists.set(store, { items, seen: now() });
    // Items we added that HA now reports: drop the placeholder, and mark done if an Undo wanted it done.
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.store !== store) continue;
      const it = items.find((x) => norm(x.summary) === norm(p.name));
      if (it) { pending.splice(i, 1); if (p.done && !it.done) cmd(store, { op: 'done', uid: it.uid, done: true }); }
    }
    changed();
  }

  /** The Shopping tab's list: every item of every list, as the tab expects it. */
  function groceries() {
    const out = [];
    const t = now();
    for (const id of storeIds) {
      const l = lists.get(id);
      if (l) for (const it of l.items) {
        const m = metaFor(id, it.summary);
        out.push({ id: id + ':' + it.uid, name: it.summary, cat: m.cat, qty: m.qty, store: id, note: m.note, done: it.done });
      }
    }
    for (const p of pending) if (t - p.ts < PENDING_MS) out.push({ id: p.id, name: p.name, cat: p.meta.cat, qty: p.meta.qty, store: p.store, note: p.meta.note, done: !!p.done });
    return out;
  }

  const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  function find(id) {
    const m = SPLIT.exec(String(id));
    if (!m || !lists.has(m[1])) return null;
    const it = lists.get(m[1]).items.find((x) => x.uid === m[2]);
    return it ? { store: m[1], item: it } : null;
  }
  const ready = () => mqtt.isUp();

  /** POST /groceries: add, tick, rename or move an item. Returns [status, body]. */
  function put(g) {
    const name = clip(g.name, 80), id = clip(g.id, 80);
    if (!id || !name) return [400, { error: 'id and name required' }];
    if (!ready()) return [503, { error: 'Home Assistant is not connected, so the list cannot be changed right now' }];
    const store = storeIds.includes(g.store) ? g.store : storeIds[0];
    const m = { cat: clip(g.cat, 40) || categorize(name), qty: Math.max(1, Math.min(99, parseInt(g.qty, 10) || 1)), note: clip(g.note, 120) };
    const hit = find(id);
    if (hit) {
      const was = hit.item;
      if (store !== hit.store) { // moved to another shop: remove here, add there
        cmd(hit.store, { op: 'remove', uid: was.uid });
        dropMeta(mkey(hit.store, was.summary));
        pending.push({ id, store, name, meta: m, done: !!g.done, ts: now() });
        saveMeta(mkey(store, name), m);
        cmd(store, { op: 'add', item: name });
      } else {
        if (norm(name) !== norm(was.summary) || name !== was.summary) { dropMeta(mkey(hit.store, was.summary)); cmd(hit.store, { op: 'rename', uid: was.uid, item: name }); was.summary = name; }
        if (!!g.done !== was.done) { cmd(hit.store, { op: 'done', uid: was.uid, done: !!g.done }); was.done = !!g.done; }
        saveMeta(mkey(hit.store, name), m);
      }
      changed();
      return [200, { ok: true }];
    }
    const p = pending.find((x) => x.id === id);
    if (p) { p.meta = m; p.done = !!g.done; saveMeta(mkey(store, name), m); changed(); return [200, { ok: true }]; }
    // A new item. If HA already has an open one with this name in this list, do not add a second.
    const same = lists.has(store) && lists.get(store).items.find((x) => !x.done && norm(x.summary) === norm(name));
    if (same) { saveMeta(mkey(store, name), m); changed(); return [200, { ok: true }]; }
    saveMeta(mkey(store, name), m);
    pending.push({ id, store, name, meta: m, done: !!g.done, ts: now() });
    cmd(store, { op: 'add', item: name });
    changed();
    return [200, { ok: true }];
  }

  /** POST /groceries/clear: remove the ticked items; with cleared:false it is Undo (put them back). */
  function clear(ids, undo) {
    if (!ready()) return [503, { error: 'Home Assistant is not connected, so the list cannot be changed right now' }];
    const t = now();
    for (const [k, v] of cleared) if (t - v.ts > UNDO_MS) cleared.delete(k);
    for (const id of ids) {
      if (undo) {
        const c = cleared.get(id);
        if (!c) continue;
        cleared.delete(id);
        saveMeta(mkey(c.store, c.name), c.meta);
        pending.push({ id, store: c.store, name: c.name, meta: c.meta, done: true, ts: t });
        cmd(c.store, { op: 'add', item: c.name });
      } else {
        const hit = find(id);
        if (!hit) continue;
        cleared.set(id, { store: hit.store, name: hit.item.summary, meta: metaFor(hit.store, hit.item.summary), ts: t });
        cmd(hit.store, { op: 'remove', uid: hit.item.uid });
        const l = lists.get(hit.store);
        l.items = l.items.filter((x) => x.uid !== hit.item.uid);
      }
    }
    changed();
    return [200, { ok: true }];
  }

  function start() {
    mqtt.subscribe('photoframe/lists/+/items', (topic, payload) => onItems(topic.split('/')[2], payload));
    mqtt.onUp(() => mqtt.publish('photoframe/lists/refresh', 'refresh')); // ask HA to publish every list again
  }
  return { start, groceries, put, clear, onItems, categorize, enabled: () => true, seen: () => storeIds.filter((s) => lists.has(s)) };
}
