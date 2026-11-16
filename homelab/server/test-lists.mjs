// Run on Node 22+ (needs node:sqlite):  node test-lists.mjs     (MQTT is faked; no broker needed)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createLists } from './lists.mjs';

const seed = [{ id: 'costco', name: 'Costco' }, { id: 'safeway', name: 'Safeway' }, { id: 'trader_joes', name: "Trader Joe's" }, { id: 'other', name: 'Other' }];
const catalog = [['Milk', 'Dairy & Eggs'], ['Eggs', 'Dairy & Eggs'], ['Bananas', 'Produce'], ['Paper towels', 'Household']];
let up = true, t = 1e6; const sent = []; const subs = [];
const mqtt = { isUp: () => up, publish: (topic, p) => { sent.push([topic, p]); return up; }, subscribe: (pat, h) => subs.push([pat, h]), onUp: (f) => f() };
const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const L = createLists({ db, mqtt, catalog, seedShops: seed, now: () => t, onChange: () => {} });
const items = (arr) => JSON.stringify({ items: arr.map(([uid, summary, status]) => ({ uid, summary, status: status || 'needs_action' })) });
const cmds = () => sent.filter((s) => s[0].endsWith('/cmd')).map((s) => [s[0].split('/')[2], JSON.parse(s[1])]);
const names = (store) => L.groceries().filter((g) => g.store === store).map((g) => g.name + (g.done ? '*' : ''));
let n = 0; const ok = (name) => console.log('PASS', name, ++n);

L.start();
assert.equal(subs[0][0], 'photoframe/lists/+/items'); assert.deepEqual(sent.at(-1), ['photoframe/lists/refresh', 'refresh']); ok('subscribes, and asks Home Assistant to publish');
assert.deepEqual(L.shops().map((s) => s.id), ['costco', 'safeway', 'trader_joes', 'other']); ok('shops are seeded from the settings');

// --- before Home Assistant has the lists: everything is local
up = false;
assert.deepEqual(L.put({ id: 'a1', name: 'Milk', store: 'costco', qty: 2, note: '2%' }), [200, { ok: true }]);
assert.deepEqual(L.groceries().map((g) => [g.id, g.name, g.cat, g.qty, g.note]), [['a1', 'Milk', 'Dairy & Eggs', 2, '2%']]); ok('a local shop works with Home Assistant (and MQTT) down');
L.put({ id: 'a1', name: 'Milk', store: 'costco', qty: 2, note: '2%', done: true }); assert.equal(L.groceries()[0].done, true); ok('ticking a local item');
L.put({ id: 'a2', name: 'Eggs', store: 'safeway' }); L.put({ id: 'a1', name: 'Milk', store: 'safeway', qty: 2, note: '2%', done: true });
assert.deepEqual(names('safeway').sort(), ['Eggs', 'Milk*']); assert.deepEqual(names('costco'), []); ok('moving a local item to another shop');
L.put({ id: 'a3', name: 'eggs', store: 'safeway' }); assert.equal(names('safeway').length, 2); ok('the same open item is not added twice');
L.clear(['a1'], false); assert.deepEqual(names('safeway'), ['Eggs']); L.clear(['a1'], true); assert.deepEqual(names('safeway').sort(), ['Eggs', 'Milk*']); ok('clear and Undo on a local item');
assert.deepEqual(sent.filter((s) => s[0].endsWith('/cmd')), []); ok('no Home Assistant commands were sent');
L.clear(['a1', 'a2'], false);

// --- a Home Assistant list appears for a shop that has local items: they move across
up = true; sent.length = 0;
L.put({ id: 'b1', name: 'Bananas', store: 'costco', qty: 3, cat: 'Produce' });
L.put({ id: 'b2', name: 'Dragon fruit', store: 'costco', done: true });
L.onItems('costco', items([['u1', 'Bananas']]));
assert.deepEqual(cmds(), [['costco', { op: 'add', item: 'Dragon fruit' }]]); ok('local items move to the new Home Assistant list (an existing name is not added twice)');
assert.equal(L.haBacked('costco'), true); assert.equal(db.prepare("SELECT COUNT(*) c FROM groceries WHERE store = 'costco' AND cleared = 0").get().c, 0); ok('the local copy is removed');
let g = L.groceries().filter((x) => x.store === 'costco'); assert.deepEqual(g.map((x) => [x.name, x.done]), [['Bananas', false], ['Dragon fruit', true]]); assert.equal(g[0].qty, 3); ok('quantity survives the move; the item waiting for Home Assistant shows meanwhile');
sent.length = 0; L.onItems('costco', items([['u1', 'Bananas'], ['u2', 'Dragon fruit']]));
assert.deepEqual(cmds(), [['costco', { op: 'done', uid: 'u2', done: true }]]); ok('a ticked item is ticked again once Home Assistant has it');

// --- Home Assistant shops
L.onItems('nope', items([['x', 'Y']])); L.onItems('costco', 'not json'); assert.equal(names('costco').length, 2); ok('unknown shops and bad payloads are ignored');
sent.length = 0;
L.put({ id: 'n1', name: 'Eggs', store: 'costco', qty: 2, cat: 'Dairy & Eggs' }); assert.deepEqual(cmds(), [['costco', { op: 'add', item: 'Eggs' }]]); ok('adding to a Home Assistant shop sends a command');
L.onItems('costco', items([['u1', 'Bananas'], ['u2', 'Dragon fruit', 'completed'], ['u3', 'eggs']]));
g = L.groceries().filter((x) => x.store === 'costco' && x.name.toLowerCase() === 'eggs'); assert.equal(g.length, 1); assert.deepEqual([g[0].id, g[0].qty], ['costco:u3', 2]); ok('the placeholder is replaced by the real item');
sent.length = 0; L.put({ id: 'costco:u1', name: 'Bananas', store: 'costco', done: true, qty: 3 }); assert.deepEqual(cmds(), [['costco', { op: 'done', uid: 'u1', done: true }]]); ok('ticking sends done');
sent.length = 0; L.put({ id: 'costco:u1', name: 'Green bananas', store: 'costco', done: true, qty: 3 }); assert.deepEqual(cmds(), [['costco', { op: 'rename', uid: 'u1', item: 'Green bananas' }]]); ok('renaming sends rename');
sent.length = 0; L.put({ id: 'costco:u3', name: 'eggs', store: 'safeway', qty: 2 });
assert.deepEqual(cmds(), [['costco', { op: 'remove', uid: 'u3' }]]); assert.ok(names('safeway').some((x) => x.toLowerCase() === 'eggs')); ok('moving from a Home Assistant shop to a local one removes it there and keeps it here');
sent.length = 0; L.put({ id: 'safeway' + ':' + 'zz', name: 'x', store: 'costco' }); // unknown id: treated as new
L.put({ id: names('safeway').length ? L.groceries().find((x) => x.store === 'safeway').id : 'q', name: 'eggs', store: 'costco', qty: 2 });
assert.ok(cmds().some((c) => c[0] === 'costco' && c[1].op === 'add' && c[1].item === 'eggs')); ok('moving a local item into a Home Assistant shop adds it there');
sent.length = 0; L.onItems('costco', items([['u1', 'Green bananas', 'completed'], ['u2', 'Dragon fruit', 'completed']])); sent.length = 0;
L.clear(['costco:u2'], false); assert.deepEqual(cmds(), [['costco', { op: 'remove', uid: 'u2' }]]); ok('clearing a Home Assistant item removes it');
sent.length = 0; L.clear(['costco:u2'], true); assert.deepEqual(cmds(), [['costco', { op: 'add', item: 'Dragon fruit' }]]); ok('Undo adds it back');
t += 600e3; sent.length = 0; L.clear(['costco:u2'], true); assert.equal(cmds().length, 0); ok('Undo for Home Assistant items expires');

// --- offline
up = false; sent.length = 0;
assert.equal(L.put({ id: 'z', name: 'Milk', store: 'costco' })[0], 503); assert.equal(L.clear(['costco:u1'], false)[0], 503); assert.equal(sent.length, 0); ok('a Home Assistant shop refuses changes while offline');
assert.equal(L.put({ id: 'loc', name: 'Soup', store: 'other' })[0], 200); ok('a local shop still works offline');
assert.equal(L.groceries().some((x) => x.store === 'costco'), true); ok('the last known Home Assistant items still show');
assert.equal(L.put({ name: 'x' })[0], 400); ok('bad input is rejected');

// --- shops
up = true;
assert.deepEqual(L.addShop("Whole Foods"), [200, { ok: true, id: 'whole_foods', name: 'Whole Foods', haName: 'Shopping Whole Foods', haEntity: 'todo.shopping_whole_foods' }]); ok('adding a shop gives the Home Assistant list name to create');
const tj = L.addShop("Joe's Market"); assert.equal(tj[1].id, 'joes_market'); assert.equal(tj[1].haName, 'Shopping Joes Market'); ok('apostrophes are dropped from ids and list names');
assert.equal(L.addShop('whole  foods')[0], 409); assert.equal(L.addShop('  ')[0], 400); assert.equal(L.addShop('!!!')[0], 400); ok('duplicates and empty names are refused');
assert.deepEqual(L.shops().map((s) => s.id).slice(-3), ['whole_foods', 'joes_market', 'other']); ok('new shops go at the end, but Other is always last');
L.put({ id: 'w1', name: 'Kale', store: 'whole_foods' }); assert.deepEqual(names('whole_foods'), ['Kale']); ok('a new shop works at once, locally');
assert.equal(L.deleteShop('whole_foods')[0], 409); L.clear(['w1'], false); assert.equal(L.deleteShop('whole_foods')[0], 200); assert.ok(!L.shops().some((s) => s.id === 'whole_foods')); ok('a shop with items cannot be deleted; an empty one can');
assert.equal(L.renameShop('joes_market', "Joe's Market (Bellevue)")[0], 200); assert.equal(L.shops().find((s) => s.id === 'joes_market').name, "Joe's Market (Bellevue)"); assert.equal(L.renameShop('nope', 'x')[0], 404); ok('renaming a shop keeps its id');
for (let i = 0; i < 20; i++) L.addShop('Shop ' + i); assert.equal(L.shops().length, 12); ok('there is a limit on shops');

// --- recent items and learning aisles
const r = L.recent(); assert.ok(r.length > 3); assert.ok(r.some((x) => x.name === 'Eggs')); ok('items used are remembered');
L.put({ id: 'c1', name: 'Oat creamer', store: 'other', cat: 'Dairy & Eggs' }); L.clear(['c1'], false);
assert.equal(L.categorize('oat creamer'), 'Dairy & Eggs'); assert.equal(L.categorize('Mystery item'), 'Other'); ok('the aisle you chose is remembered for next time');
L.onItems('costco', items([['u1', 'Green bananas', 'completed'], ['h1', 'Sourdough']]));
assert.ok(L.recent(200).some((x) => x.name === 'Sourdough')); ok('items added in Home Assistant become suggestions too');
assert.equal(L.recent(5).length, 5); ok('the recent list is limited');
// --- stale ids
up = true; sent.length = 0;
assert.equal(L.put({ id: 'costco:gone123', name: 'Ghost', store: 'costco' })[0], 404); assert.equal(cmds().length, 0); assert.ok(!L.groceries().some((x) => x.name === 'Ghost')); ok('a tap on an item that no longer exists is refused, not re-created');
assert.equal(L.put({ id: 'brandnewid', name: 'Fresh', store: 'costco' })[0], 200); ok('a genuinely new item (client id) is still added');
console.log('\nall ' + n + ' passed');
