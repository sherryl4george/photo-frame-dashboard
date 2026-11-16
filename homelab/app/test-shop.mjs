// Smoke test for the shopping page: load js/shop.js against a fake browser, tick an item, change shop, open a sheet,
// and check the page redraws without throwing. (It once threw only after an item was ticked, which froze the page.)
//   node test-shop.mjs
import assert from 'node:assert/strict';

const els = {};
const el = (id) => els[id] || (els[id] = {
  id, innerHTML: '', textContent: '', hidden: false, value: '', placeholder: '', dataset: {}, handlers: {},
  classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, style: {},
  addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }, querySelector() { return el(id + '>x'); },
  blur() {}, focus() {}, select() {},
});
const store = {};
const state = {
  stores: [{ id: 'costco', name: 'Costco', ha: true }, { id: 'safeway', name: 'Safeway', ha: false }],
  groceries: [
    { id: 'costco:u1', name: 'Milk', cat: 'Dairy & Eggs', qty: 2, store: 'costco', note: '2%', done: false },
    { id: 'costco:u2', name: 'Eggs', cat: 'Dairy & Eggs', qty: 1, store: 'costco', note: '', done: true },
    { id: 'l1', name: 'Soup', cat: 'Pantry', qty: 1, store: 'safeway', note: '', done: false },
  ],
  catalog: [['Milk', 'Dairy & Eggs'], ['Bananas', 'Produce']], usuals: ['Bread'], recent: [{ name: 'Butter', cat: 'Dairy & Eggs' }], catOrder: { all: [] },
};
const posts = [];
globalThis.document = { querySelector: (s) => el(s), addEventListener(t, f) { el('document').addEventListener(t, f); }, body: el('body'), activeElement: null, hidden: false, createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, fillText() {}, getImageData: () => ({ data: [0] }) }) }) };
globalThis.window = { addEventListener() {}, parent: null, location: { search: '', origin: 'http://x' } }; window.parent = window;
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
globalThis.location = window.location;
globalThis.fetch = async (url, opt = {}) => {
  if ((opt.method || 'GET') === 'POST') posts.push([url, JSON.parse(opt.body)]);
  return { ok: true, status: 200, json: async () => (url.endsWith('/state') ? state : { ok: true }) };
};
const fail = []; process.on('unhandledRejection', (e) => fail.push(e)); process.on('uncaughtException', (e) => fail.push(e));
const tick = () => new Promise((r) => setTimeout(r, 30));

const timeout = setTimeout(() => { console.error('FAIL: the page did not finish (a draw probably threw)'); process.exit(1); }, 8000);
process.on('uncaughtException', (e) => { console.error('FAIL: ' + e.message); process.exit(1); });
await import('./js/shop.js');
await tick();
let list = el('#list').innerHTML;
assert.match(list, /Milk/); assert.match(list, /In the cart/); assert.match(list, /Eggs/); assert.ok(!fail.length, 'no errors on first draw: ' + fail);
console.log('PASS first draw: tabs, list and the In the cart section');

const click = (target) => el('#list').handlers.click.forEach((f) => f({ target }));
const tileTarget = (id) => ({ closest: (s) => (s === '.tile' ? { dataset: { id } } : null) });
click(tileTarget('costco:u1')); await tick();
assert.ok(!fail.length, 'ticking threw: ' + fail);
assert.deepEqual(posts.at(-1)[1].done, true); assert.equal(posts.at(-1)[0], '/api/groceries');
assert.match(el('#list').innerHTML, /In the cart · 2/); console.log('PASS ticking an item moves it into the cart and sends it');

click(tileTarget('costco:u1')); await tick();
assert.match(el('#list').innerHTML, /In the cart · 1/); assert.equal(posts.at(-1)[1].done, false); console.log('PASS ticking it again puts it back');

const docClick = (dataset) => el('document').handlers.click.forEach((f) => f({ target: { closest: () => ({ dataset }) } }));
docClick({ tab: 'safeway' }); await tick(); assert.match(el('#list').innerHTML, /Soup/); assert.ok(!/Milk/.test(el('#list').innerHTML)); assert.ok(!fail.length, 'tab switch threw: ' + fail); console.log('PASS switching shop');
docClick({ tab: 'all' }); await tick(); assert.match(el('#list').innerHTML, /Costco · /); console.log('PASS the All tab groups by shop');
docClick({ act: 'edit', id: 'costco:u1' }); assert.match(el('#sheet').innerHTML, /Edit item/); assert.ok(!/Aisle/.test(el('#sheet').innerHTML)); console.log('PASS the edit sheet opens (no aisle field)');
docClick({ act: 'clear' }); await tick(); assert.ok(!fail.length, 'clear threw: ' + fail); assert.equal(posts.at(-1)[0], '/api/groceries/clear'); console.log('PASS clearing the cart sends the ids');
el('#layoutbtn').handlers.click.forEach((f) => f()); await tick(); assert.ok(!fail.length, 'layout switch threw: ' + fail); console.log('PASS the layout button');
el('#addform').handlers.submit.forEach((f) => { el('#addin').value = 'Bananas, ripe'; f({ preventDefault() {} }); }); await tick();
assert.ok(!fail.length, 'adding threw: ' + fail); console.log('PASS adding from All asks which shop (a sheet opens): ' + /Add “/.test(el('#sheet').innerHTML));
assert.ok(!fail.length); clearTimeout(timeout); console.log('\nall passed');
process.exit(0);
