// Run: node test-lists.mjs   (no broker needed: MQTT is faked)
import assert from 'node:assert/strict';
import { createLists } from './lists.mjs';

const stores = [{ id: 'costco', name: 'Costco' }, { id: 'safeway', name: 'Safeway' }, { id: 'trader_joes', name: "Trader Joe's" }, { id: 'other', name: 'Other' }];
const catalog = [['Milk', 'Dairy & Eggs'], ['Eggs', 'Dairy & Eggs'], ['Bananas', 'Produce'], ['Paper towels', 'Household']];
let up = true, t = 1e6; const sent = []; const subs = [];
const mqtt = { isUp: () => up, publish: (topic, p) => { sent.push([topic, p]); return up; }, subscribe: (pat, h) => subs.push([pat, h]), onUp: (f) => f() };
const L = createLists({ stores, catalog, mqtt, now: () => t, onChange: () => {} });
const items = (arr) => JSON.stringify({ items: arr.map(([uid, summary, status]) => ({ uid, summary, status: status || 'needs_action' })) });
const cmds = () => sent.filter((s) => s[0].endsWith('/cmd')).map((s) => [s[0].split('/')[2], JSON.parse(s[1])]);
let n = 0; const ok = (name) => console.log('PASS', name, ++n);

L.start();
assert.equal(subs[0][0], 'photoframe/lists/+/items'); ok('subscribes to the list topics');
assert.deepEqual(sent.at(-1), ['photoframe/lists/refresh', 'refresh']); ok('asks Home Assistant to publish every list');

L.onItems('costco', items([['u1', 'Milk'], ['u2', 'Paper towels', 'completed'], ['u3', 'Dragon fruit']]));
let g = L.groceries();
assert.deepEqual(g.map((x) => [x.id, x.name, x.cat, x.store, x.done]), [['costco:u1', 'Milk', 'Dairy & Eggs', 'costco', false], ['costco:u2', 'Paper towels', 'Household', 'costco', true], ['costco:u3', 'Dragon fruit', 'Other', 'costco', false]]);
ok('HA items map to the tab, aisle guessed from the catalogue');
L.onItems('nope', items([['x', 'Y']])); L.onItems('costco', 'not json'); assert.equal(L.groceries().length, 3); ok('unknown lists and bad payloads are ignored');

sent.length = 0;
assert.deepEqual(L.put({ id: 'new1', name: 'Bananas', store: 'safeway', qty: 3, cat: 'Produce', note: 'ripe' }), [200, { ok: true }]);
assert.deepEqual(cmds(), [['safeway', { op: 'add', item: 'Bananas' }]]);
g = L.groceries().find((x) => x.id === 'new1'); assert.deepEqual([g.name, g.qty, g.note, g.store], ['Bananas', 3, 'ripe', 'safeway']); ok('adding sends a command and shows a placeholder at once');
L.onItems('safeway', items([['s1', 'bananas']]));
g = L.groceries().filter((x) => x.store === 'safeway'); assert.equal(g.length, 1); assert.deepEqual([g[0].id, g[0].qty, g[0].note], ['safeway:s1', 3, 'ripe']); ok('the placeholder is replaced by the real item, keeping qty and note');
assert.deepEqual(L.put({ id: 'new2', name: 'BANANAS', store: 'safeway' }), [200, { ok: true }]); assert.equal(cmds().length, 1); ok('the same open item is not added twice');

sent.length = 0;
L.put({ id: 'costco:u1', name: 'Milk', store: 'costco', done: true });
assert.deepEqual(cmds(), [['costco', { op: 'done', uid: 'u1', done: true }]]);
assert.equal(L.groceries().find((x) => x.id === 'costco:u1').done, true); ok('ticking sends done and shows it');
sent.length = 0; L.put({ id: 'costco:u1', name: 'Oat milk', store: 'costco', done: true });
assert.deepEqual(cmds(), [['costco', { op: 'rename', uid: 'u1', item: 'Oat milk' }]]); ok('renaming sends rename');
sent.length = 0; L.put({ id: 'costco:u3', name: 'Dragon fruit', store: 'trader_joes' });
assert.deepEqual(cmds(), [['costco', { op: 'remove', uid: 'u3' }], ['trader_joes', { op: 'add', item: 'Dragon fruit' }]]); ok('moving to another shop removes here and adds there');

sent.length = 0; L.clear(['costco:u2'], false);
assert.deepEqual(cmds(), [['costco', { op: 'remove', uid: 'u2' }]]); assert.ok(!L.groceries().some((x) => x.id === 'costco:u2')); ok('clearing removes the item');
sent.length = 0; L.clear(['costco:u2'], true);
assert.deepEqual(cmds(), [['costco', { op: 'add', item: 'Paper towels' }]]); ok('Undo adds it back');
sent.length = 0; L.onItems('costco', items([['u1', 'Oat milk', 'completed'], ['u9', 'Paper towels']]));
assert.deepEqual(cmds(), [['costco', { op: 'done', uid: 'u9', done: true }]]); ok('an Undone item is ticked again once it returns');
t += 600e3; sent.length = 0; L.clear(['costco:u2'], true); assert.equal(cmds().length, 0); ok('Undo expires');

up = false; sent.length = 0;
assert.equal(L.put({ id: 'z', name: 'Eggs', store: 'costco' })[0], 503); assert.equal(L.clear(['costco:u1'], false)[0], 503); assert.equal(sent.length, 0); ok('offline: changes are refused, nothing is queued');
assert.equal(L.groceries().length > 0, true); ok('offline: the last known lists still show');
assert.equal(L.put({ name: 'x' })[0], 400); ok('bad input is rejected');
console.log('\nall ' + n + ' passed');
