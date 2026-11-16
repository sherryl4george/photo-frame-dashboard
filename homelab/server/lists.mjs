// The shopping list. Each shop is either
//   * backed by a Home Assistant to-do list (entity todo.shopping_<shop id>), mirrored over MQTT, with Home Assistant
//     as the master; or
//   * local, kept in this server's SQLite, until a Home Assistant list with that name appears. The items are then
//     moved across automatically.
//
// Two HA automations (home-assistant/shopping.md) publish each list to photoframe/lists/<shop id>/items and carry
// out commands published to photoframe/lists/<shop id>/cmd. Home Assistant to-do items only have a name and a done
// flag, so aisle, quantity and note are kept here (by shop and item name); an item added in Home Assistant gets its
// aisle guessed from what was used before, then from the usual-items catalogue.
//
// Also kept here: the shops themselves (add, rename, delete) and the history of items used ("recent items").

const norm = (s) => String(s || '').trim().toLowerCase();
const PENDING_MS = 20e3;      // show an added item this long while waiting for Home Assistant to report it
const UNDO_MS = 120e3;        // remember cleared Home Assistant items this long, so Undo can put them back
const SPLIT = /^([a-z0-9_]{1,40}):(.+)$/;
const MAX_SHOPS = 12;
const slug = (name) => norm(name).replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export function createLists({ db, mqtt, catalog, seedShops = [], onChange = () => {}, now = Date.now }) {
  const ha = new Map();      // shop id -> { items: [{uid, summary, done}], seen }   (only shops with a Home Assistant list)
  const meta = new Map();    // `${shop}|${norm(name)}` -> { cat, qty, note }
  const pending = [];        // { id, store, name, meta, done, ts }: added, not yet reported back by Home Assistant
  const cleared = new Map(); // Home Assistant item id -> { store, name, meta, ts }
  let timer = null;

  db.exec('CREATE TABLE IF NOT EXISTS list_meta (key TEXT PRIMARY KEY, cat TEXT, qty INTEGER, note TEXT, updated INTEGER)');
  for (const r of db.prepare('SELECT key, cat, qty, note FROM list_meta').all()) meta.set(r.key, { cat: r.cat, qty: r.qty, note: r.note });
  const mkey = (store, name) => store + '|' + norm(name);
  function saveMeta(key, m) {
    meta.set(key, m);
    db.prepare('INSERT INTO list_meta (key, cat, qty, note, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET cat = excluded.cat, qty = excluded.qty, note = excluded.note, updated = excluded.updated')
      .run(key, m.cat, m.qty, m.note, now());
  }
  function dropMeta(key) { meta.delete(key); db.prepare('DELETE FROM list_meta WHERE key = ?').run(key); }

  // ---------------------------------------------------------------- shops
  const shopRows = () => db.prepare('SELECT id, name FROM shops ORDER BY (id = 'other'), position, rowid').all();
  if (!shopRows().length) seedShops.forEach((s, i) => db.prepare('INSERT OR IGNORE INTO shops (id, name, position) VALUES (?, ?, ?)').run(s.id, s.name, i));
  const shopIds = () => shopRows().map((s) => s.id);
  function addShop(name) {
    name = clip(name, 30);
    const id = slug(name);
    if (!name || !id) return [400, { error: 'Give the shop a name' }];
    if (shopRows().length >= MAX_SHOPS) return [400, { error: 'That is the most shops there is room for' }];
    if (shopIds().includes(id)) return [409, { error: 'There is already a shop called that' }];
    db.prepare('INSERT INTO shops (id, name, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM shops))').run(id, name);
    changed();
    return [200, { ok: true, id, name, haName: 'Shopping ' + name.replace(/['’`]/g, ''), haEntity: 'todo.shopping_' + id }];
  }
  function renameShop(id, name) {
    name = clip(name, 30);
    if (!name) return [400, { error: 'Give the shop a name' }];
    if (!shopIds().includes(id)) return [404, { error: 'No such shop' }];
    db.prepare('UPDATE shops SET name = ? WHERE id = ?').run(name, id);
    changed();
    return [200, { ok: true }];
  }
  function deleteShop(id) {
    if (!shopIds().includes(id)) return [404, { error: 'No such shop' }];
    if (groceries().some((g) => g.store === id)) return [409, { error: 'Clear this shop’s items first' }];
    db.prepare('DELETE FROM shops WHERE id = ?').run(id);
    ha.delete(id);
    changed();
    return [200, { ok: true }];
  }

  // ---------------------------------------------------------------- history (recent items) and aisles
  function categorize(name) {
    const n = norm(name);
    const past = db.prepare('SELECT cat FROM recent WHERE key = ?').get(n);
    if (past) return past.cat;
    const hit = catalog.find((c) => norm(c[0]) === n) || catalog.find((c) => { const a = norm(c[0]); return a.includes(n) || n.includes(a); })
      || catalog.find((c) => n.split(/\s+/).some((w) => w.length > 3 && norm(c[0]).includes(w)));
    return hit ? hit[1] : 'Other';
  }
  function remember(name, cat, bump) {
    const k = norm(name);
    if (!k) return;
    const t = now();
    if (bump) db.prepare('INSERT INTO recent (key, name, cat, uses, last) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET uses = uses + 1, last = excluded.last, cat = excluded.cat, name = excluded.name').run(k, name, cat, t);
    else db.prepare('INSERT INTO recent (key, name, cat, uses, last) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET cat = excluded.cat').run(k, name, cat, t);
  }
  const recent = (limit = 60) => db.prepare('SELECT name, cat FROM recent ORDER BY last DESC, uses DESC LIMIT ?').all(limit);
  const metaFor = (store, name) => meta.get(mkey(store, name)) || { cat: categorize(name), qty: 1, note: '' };

  function changed() { clearTimeout(timer); timer = setTimeout(onChange, 250); }
  const cmd = (store, c) => mqtt.publish('photoframe/lists/' + store + '/cmd', JSON.stringify(c));
  const ready = () => mqtt.isUp();
  const haDown = () => [503, { error: 'Home Assistant is not connected, so this list cannot be changed right now' }];
  const isHa = (store) => ha.has(store);

  // ---------------------------------------------------------------- local items (shops without a Home Assistant list)
  const localRows = (store) => db.prepare('SELECT id, name, cat, qty, store, note, done FROM groceries WHERE store = ? AND cleared = 0 ORDER BY updated_at').all(store);
  const localRow = (id) => db.prepare('SELECT id, name, cat, qty, store, note, done FROM groceries WHERE id = ? AND cleared = 0').get(id);
  function localSave(g, m, store) {
    db.prepare('INSERT INTO groceries (id, name, cat, qty, store, note, done, cleared, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, cat = excluded.cat, qty = excluded.qty, store = excluded.store, note = excluded.note, done = excluded.done, cleared = 0, updated_at = excluded.updated_at')
      .run(g.id, g.name, m.cat, m.qty, store, m.note, g.done ? 1 : 0, now());
  }

  // ---------------------------------------------------------------- Home Assistant lists
  /** A list arrived from Home Assistant (the retained message, or a change). */
  function onItems(store, payload) {
    if (!shopIds().includes(store)) return;
    let data;
    try { data = JSON.parse(payload); } catch (e) { return; }
    const items = (Array.isArray(data.items) ? data.items : []).filter((i) => i && i.uid && typeof i.summary === 'string')
      .map((i) => ({ uid: String(i.uid), summary: i.summary.trim().slice(0, 80), done: i.status === 'completed' }));
    const first = !ha.has(store), sig = JSON.stringify(items);
    if (!first && ha.get(store).sig === sig) { ha.get(store).seen = now(); return; } // republished with no change: nothing to do
    const before = new Set((ha.get(store) || { items: [] }).items.map((i) => i.uid));
    ha.set(store, { items, seen: now(), sig });
    for (const it of items) if (first || !before.has(it.uid)) remember(it.summary, metaFor(store, it.summary).cat, false); // used from Home Assistant too
    for (let i = pending.length - 1; i >= 0; i--) { // our own additions, now reported back
      const p = pending[i];
      if (p.store !== store) continue;
      const it = items.find((x) => norm(x.summary) === norm(p.name));
      if (it) { pending.splice(i, 1); if (p.done && !it.done) cmd(store, { op: 'done', uid: it.uid, done: true }); }
    }
    if (first) { // this shop just became a Home Assistant list: move its local items across
      for (const r of localRows(store)) {
        saveMeta(mkey(store, r.name), { cat: r.cat, qty: r.qty, note: r.note });
        if (!items.some((x) => norm(x.summary) === norm(r.name))) { pending.push({ id: r.id, store, name: r.name, meta: { cat: r.cat, qty: r.qty, note: r.note }, done: !!r.done, ts: now() }); cmd(store, { op: 'add', item: r.name }); }
        db.prepare('DELETE FROM groceries WHERE id = ?').run(r.id);
      }
    }
    changed();
  }
  function findHa(id) {
    const m = SPLIT.exec(String(id));
    if (!m || !ha.has(m[1])) return null;
    const it = ha.get(m[1]).items.find((x) => x.uid === m[2]);
    return it ? { store: m[1], item: it } : null;
  }

  /** Everything the Shopping tab and the phone page show. */
  function groceries() {
    const out = [], t = now();
    for (const { id } of shopRows()) {
      if (ha.has(id)) {
        for (const it of ha.get(id).items) { const m = metaFor(id, it.summary); out.push({ id: id + ':' + it.uid, name: it.summary, cat: m.cat, qty: m.qty, store: id, note: m.note, done: it.done }); }
      } else for (const r of localRows(id)) out.push({ id: r.id, name: r.name, cat: r.cat, qty: r.qty, store: r.store, note: r.note, done: !!r.done });
    }
    for (const p of pending) if (t - p.ts < PENDING_MS) out.push({ id: p.id, name: p.name, cat: p.meta.cat, qty: p.meta.qty, store: p.store, note: p.meta.note, done: !!p.done });
    return out;
  }

  // ---------------------------------------------------------------- changes from the page
  /** POST /groceries: add, tick, rename, change or move an item. Returns [status, body]. */
  function put(g) {
    const name = clip(g.name, 80), id = clip(g.id, 80);
    if (!id || !name) return [400, { error: 'id and name required' }];
    const ids = shopIds();
    if (!ids.length) return [400, { error: 'Add a shop first' }];
    const store = ids.includes(g.store) ? g.store : ids[0];
    const m = { cat: clip(g.cat, 40) || categorize(name), qty: Math.max(1, Math.min(99, parseInt(g.qty, 10) || 1)), note: clip(g.note, 120) };
    const hit = findHa(id), loc = hit ? null : localRow(id), toHa = isHa(store);
    if (!hit && !loc && SPLIT.test(id) && !pending.some((x) => x.id === id)) return [404, { error: 'That item has changed since this page loaded. Refreshing…' }]; // a stale tap must not bring a deleted item back
    if ((hit || toHa) && !ready()) return haDown();

    if (hit) {
      const was = hit.item;
      if (store !== hit.store) { // moved to another shop
        cmd(hit.store, { op: 'remove', uid: was.uid });
        dropMeta(mkey(hit.store, was.summary));
        saveMeta(mkey(store, name), m);
        if (toHa) { pending.push({ id, store, name, meta: m, done: !!g.done, ts: now() }); cmd(store, { op: 'add', item: name }); }
        else localSave({ id, name, done: g.done }, m, store);
        ha.get(hit.store).items = ha.get(hit.store).items.filter((x) => x.uid !== was.uid);
      } else {
        if (name !== was.summary) { dropMeta(mkey(hit.store, was.summary)); cmd(hit.store, { op: 'rename', uid: was.uid, item: name }); was.summary = name; }
        if (!!g.done !== was.done) { cmd(hit.store, { op: 'done', uid: was.uid, done: !!g.done }); was.done = !!g.done; }
        saveMeta(mkey(hit.store, name), m);
      }
      remember(name, m.cat, false);
      changed();
      return [200, { ok: true }];
    }
    if (loc) { // a local item
      if (toHa) { // moved into a Home Assistant shop
        db.prepare('DELETE FROM groceries WHERE id = ?').run(id);
        saveMeta(mkey(store, name), m);
        pending.push({ id, store, name, meta: m, done: !!g.done, ts: now() });
        cmd(store, { op: 'add', item: name });
      } else localSave({ id, name, done: g.done }, m, store);
      remember(name, m.cat, false);
      changed();
      return [200, { ok: true }];
    }
    const p = pending.find((x) => x.id === id);
    if (p) { p.meta = m; p.done = !!g.done; saveMeta(mkey(store, name), m); changed(); return [200, { ok: true }]; }
    // A new item.
    if (toHa) {
      const same = ha.get(store).items.find((x) => !x.done && norm(x.summary) === norm(name));
      if (!same) { pending.push({ id, store, name, meta: m, done: !!g.done, ts: now() }); cmd(store, { op: 'add', item: name }); }
      saveMeta(mkey(store, name), m);
    } else {
      const same = localRows(store).find((x) => !x.done && norm(x.name) === norm(name));
      if (!same) localSave({ id, name, done: g.done }, m, store);
    }
    remember(name, m.cat, true);
    changed();
    return [200, { ok: true }];
  }

  /** POST /groceries/clear: remove items; with undo it puts them back. */
  function clear(ids, undo) {
    const t = now();
    for (const [k, v] of cleared) if (t - v.ts > UNDO_MS) cleared.delete(k);
    const needsHa = ids.some((id) => (undo ? cleared.has(id) : findHa(id)));
    if (needsHa && !ready()) return haDown();
    for (const id of ids) {
      if (undo) {
        const c = cleared.get(id);
        if (c) {
          cleared.delete(id);
          saveMeta(mkey(c.store, c.name), c.meta);
          pending.push({ id, store: c.store, name: c.name, meta: c.meta, done: true, ts: t });
          cmd(c.store, { op: 'add', item: c.name });
        } else db.prepare('UPDATE groceries SET cleared = 0, updated_at = ? WHERE id = ?').run(t, id);
      } else {
        const hit = findHa(id);
        if (hit) {
          cleared.set(id, { store: hit.store, name: hit.item.summary, meta: metaFor(hit.store, hit.item.summary), ts: t });
          cmd(hit.store, { op: 'remove', uid: hit.item.uid });
          remember(hit.item.summary, metaFor(hit.store, hit.item.summary).cat, false);
          const l = ha.get(hit.store); l.items = l.items.filter((x) => x.uid !== hit.item.uid);
        } else {
          const r = localRow(id);
          if (r) { remember(r.name, r.cat, false); db.prepare('UPDATE groceries SET cleared = 1, updated_at = ? WHERE id = ?').run(t, id); }
          const pi = pending.findIndex((x) => x.id === id);
          if (pi >= 0) pending.splice(pi, 1);
        }
      }
    }
    db.prepare('DELETE FROM groceries WHERE cleared = 1 AND updated_at < ?').run(t - 30 * 864e5);
    changed();
    return [200, { ok: true }];
  }

  function start() {
    mqtt.subscribe('photoframe/lists/+/items', (topic, payload) => onItems(topic.split('/')[2], payload));
    mqtt.onUp(() => mqtt.publish('photoframe/lists/refresh', 'refresh')); // ask HA to publish every list again
  }
  return { start, shops: shopRows, addShop, renameShop, deleteShop, groceries, recent, put, clear, onItems, categorize, haBacked: (s) => isHa(s) };
}
