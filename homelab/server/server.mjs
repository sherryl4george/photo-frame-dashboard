// Home HQ homelab server: serves the built dashboard and the JSON API it talks to.
// Replaces the Cloudflare Worker for: photos, weather, shopping list, notes and frame check-ins.
// Calendar and Home Assistant answer "nothing configured" for now.
//
//   PHOTOFRAME_DIR  base folder (default /opt/photoframe): app/ config/ data/
//   PORT            listen port (default 8080)
//
// Needs Node 22+ (built-in node:sqlite). No npm packages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PHOTOFRAME_DIR || '/opt/photoframe';
const PORT = +(process.env.PORT || 8080);
const APP_DIR = path.join(BASE, 'app'), DATA_DIR = path.join(BASE, 'data'), PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DAY_MS = 864e5;

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw e; } };
const SETTINGS = readJson(path.join(BASE, 'config', 'settings.json'));
// Secrets: environment variables first (systemd loads config/secrets.env into the service), then the older
// config/secrets.json as a fallback. Values are never logged.
const SECRET_NAMES = ['DASHBOARD_KEY', 'MQTT_HOST', 'MQTT_USER', 'MQTT_PASS', 'HA_TOKEN'];
const SECRETS = Object.assign({}, readJson(path.join(BASE, 'config', 'secrets.json'), {}));
const fromEnv = SECRET_NAMES.filter((k) => process.env[k]);
fromEnv.forEach((k) => { SECRETS[k] = process.env[k]; });
if (!SECRETS.DASHBOARD_KEY || SECRETS.DASHBOARD_KEY.length < 16) { console.error('DASHBOARD_KEY (at least 16 characters) is missing: set it in config/secrets.env'); process.exit(1); }
console.log('secrets: ' + (fromEnv.length ? fromEnv.length + ' from the environment (secrets.env)' : 'from secrets.json') + (SECRETS.DASHBOARD_KEY && !process.env.DASHBOARD_KEY ? ', DASHBOARD_KEY from secrets.json' : ''));

const db = new DatabaseSync(path.join(DATA_DIR, 'photoframe.db'));
db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));

// ------------------------------------------------------------------ config the page sees
const hexRgb = (hex) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const people = (SETTINGS.people || []).map((p) => {
  const [r, g, b] = hexRgb(p.color || '#888888');
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
  return { id: p.id, name: p.name, color: p.color, rgb: r + ' ' + g + ' ' + b, ink: light ? '#111111' : '#FFFFFF', tracked: false };
});
const shop = SETTINGS.shopping || {};
const cats = shop.categories || ['Other'];
const stores = shop.stores && shop.stores.length ? shop.stores : [{ id: 'grocer', name: 'Groceries' }];
const catOrder = { all: cats };
stores.forEach((s) => { catOrder[s.id] = (shop.storeOrder && shop.storeOrder[s.id]) || cats; });
const catalog = [];
Object.keys(shop.catalog || {}).forEach((cat) => shop.catalog[cat].forEach((name) => catalog.push([name, cat])));
const TZ = SETTINGS.timezone || 'UTC';
const LOC = SETTINGS.location || null;

// ------------------------------------------------------------------ helpers
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max || 200) : '');
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const bad = (res, msg, status) => send(res, status || 400, { error: msg });
const readBody = (req, max = 1e6) => new Promise((ok, fail) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > max) { fail(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { ok({}); } });
  req.on('error', fail);
});
const keyBuf = Buffer.from(SECRETS.DASHBOARD_KEY);
const sameKey = (a) => { if (!a) return false; const x = Buffer.from(String(a)); return x.length === keyBuf.length && crypto.timingSafeEqual(x, keyBuf); };
const cookieKey = (req) => { const m = /(?:^|;\s*)hq=([^;]+)/.exec(req.headers.cookie || ''); try { return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; } };

function cached(key, ttlMs, compute) {
  const row = db.prepare('SELECT value, expires FROM cache WHERE key = ?').get(key);
  if (row && row.expires > Date.now()) return Promise.resolve(JSON.parse(row.value));
  return compute().then((value) => {
    db.prepare('INSERT INTO cache (key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires')
      .run(key, JSON.stringify(value), Date.now() + ttlMs);
    return value;
  }).catch((err) => { if (row) return JSON.parse(row.value); throw err; }); // stale beats nothing
}

// ------------------------------------------------------------------ weather (Open-Meteo, no key)
const wxCond = (code, isDay) => {
  if (code <= 1) return isDay ? 'sun' : 'moon';
  if (code === 2) return 'partly';
  if (code === 3 || code === 45 || code === 48) return 'cloud';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain';
};
async function getWeather() {
  if (!LOC) return { none: true };
  const w = await cached('weather', 15 * 60e3, async () => {
    const f = LOC.units === 'fahrenheit';
    const q = new URLSearchParams({
      latitude: LOC.lat, longitude: LOC.lon, timezone: TZ, forecast_days: '2',
      temperature_unit: f ? 'fahrenheit' : 'celsius', wind_speed_unit: f ? 'mph' : 'kmh',
      hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
      daily: 'temperature_2m_max,temperature_2m_min',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m',
    });
    const r = await fetch('https://api.open-meteo.com/v1/forecast?' + q, { signal: AbortSignal.timeout(10e3) });
    if (!r.ok) throw new Error('weather: HTTP ' + r.status);
    const j = await r.json(), h = j.hourly;
    return {
      day: h.time[0].slice(0, 10), units: f ? 'fahrenheit' : 'celsius',
      t: h.temperature_2m.map(Math.round), p: h.precipitation_probability.map((x) => x || 0),
      c: h.weather_code.map((code, i) => wxCond(code, h.is_day[i])),
      hi: Math.round(j.daily.temperature_2m_max[0]), lo: Math.round(j.daily.temperature_2m_min[0]),
      feels: Math.round(j.current.apparent_temperature), humidity: j.current.relative_humidity_2m,
      wind: Math.round(j.current.wind_speed_10m), now: Math.round(j.current.temperature_2m),
    };
  });
  return Object.assign({}, w, { warnings: [] });
}

// ------------------------------------------------------------------ state, lists, notes
const liveNotes = () => db.prepare('SELECT id, text, from_id, to_id, created, expires FROM notes WHERE cleared IS NULL AND (expires IS NULL OR expires > ?) ORDER BY created DESC LIMIT 20')
  .all(Date.now()).map((n) => ({ id: n.id, text: n.text, from: n.from_id, to: n.to_id, created: n.created, expires: n.expires }));

function getState() {
  return {
    people, stores, catOrder, catalog, usuals: shop.usuals || [],
    groceries: db.prepare('SELECT id, name, cat, qty, store, note, done FROM groceries WHERE cleared = 0 ORDER BY updated_at').all().map((g) => ({ ...g, done: !!g.done })),
    photos: db.prepare('SELECT id, o, date, place, from_id, fav FROM photos ORDER BY date DESC').all()
      .map((p) => ({ id: p.id, o: p.o, date: p.date, place: p.place, from: p.from_id, fav: !!p.fav, tag: p.date })),
    hasHome: false, scenes: [], cameras: [], bins: null, notes: liveNotes(), awayOffMinutes: 0,
  };
}

function putGrocery(b) {
  const id = str(b.id, 64), name = str(b.name, 80);
  if (!id || !name) return [400, { error: 'id and name required' }];
  const store = stores.some((s) => s.id === b.store) ? b.store : stores[0].id;
  db.prepare('INSERT INTO groceries (id, name, cat, qty, store, note, done, cleared, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET name = excluded.name, cat = excluded.cat, qty = excluded.qty, store = excluded.store, note = excluded.note, done = excluded.done, cleared = 0, updated_at = excluded.updated_at')
    .run(id, name, str(b.cat, 40) || 'Other', Math.max(1, Math.min(99, parseInt(b.qty, 10) || 1)), store, str(b.note, 120), b.done ? 1 : 0, Date.now());
  return [200, { ok: true }];
}
function clearGroceries(b) {
  const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
  const now = Date.now(), up = db.prepare('UPDATE groceries SET cleared = ?, updated_at = ? WHERE id = ?');
  ids.forEach((id) => up.run(b.cleared === false ? 0 : 1, now, id));
  db.prepare('DELETE FROM groceries WHERE cleared = 1 AND updated_at < ?').run(now - 30 * DAY_MS);
  return [200, { ok: true }];
}
function putNote(b) {
  const id = str(b.id, 40), text = str(b.text, 140), person = (pid) => people.find((p) => p.id === pid);
  if (!/^[a-z0-9]{6,40}$/.test(id) || !text || !person(b.from)) return [400, { error: 'id, text and from (a person) required' }];
  const to = b.to === 'all' || person(b.to) ? b.to : 'all';
  const expires = typeof b.expires === 'number' && b.expires > Date.now() ? b.expires : null;
  db.prepare('INSERT INTO notes (id, text, from_id, to_id, created, expires, cleared) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET text = excluded.text, to_id = excluded.to_id, expires = excluded.expires')
    .run(id, text, b.from, to, Date.now(), expires);
  return [200, { ok: true, notes: liveNotes() }];
}
const clearNote = (id, undo) => { db.prepare('UPDATE notes SET cleared = ? WHERE id = ?').run(undo ? null : Date.now(), id); return [200, { ok: true, notes: liveNotes() }]; };

function frameBeat(b) {
  const id = str(b.id, 40);
  if (!/^[a-z0-9]{6,40}$/.test(id)) return [400, { error: 'id required' }];
  const row = { id, name: str(b.name, 40) || 'Frame', version: str(b.version, 20), build: str(b.build, 40), kiosk: str(b.kiosk, 20),
    rssi: typeof b.rssi === 'number' ? Math.round(b.rssi) : null, model: str(b.model, 60), android: str(b.android, 10),
    loaded: typeof b.loaded === 'number' ? b.loaded : null, seen: Date.now() };
  db.prepare('INSERT INTO cache (key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires')
    .run('frame:' + id, JSON.stringify(row), Date.now() + 30 * DAY_MS);
  return [200, { ok: true, replaced: 0 }];
}
const listFrames = () => db.prepare("SELECT value FROM cache WHERE key LIKE 'frame:%' AND expires > ?").all(Date.now()).map((r) => JSON.parse(r.value)).sort((a, b) => (a.name < b.name ? -1 : 1));

// ------------------------------------------------------------------ photos
function servePhoto(req, res, id, kind) {
  if (!/^[0-9a-f]{16}$/.test(id)) return bad(res, 'not found', 404);
  const file = path.join(PHOTO_DIR, kind, id + '.jpg');
  fs.stat(file, (err, st) => {
    if (err) return bad(res, 'not found', 404);
    const etag = '"' + st.size + '-' + Math.round(st.mtimeMs) + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': st.size, 'cache-control': 'private, max-age=31536000, immutable', etag });
    fs.createReadStream(file).pipe(res);
  });
}
function deletePhoto(id) {
  if (!/^[0-9a-f]{16}$/.test(id)) return;
  ['full', 'small', 'bg'].forEach((k) => fs.rmSync(path.join(PHOTO_DIR, k, id + '.jpg'), { force: true }));
  db.prepare('DELETE FROM photos WHERE id = ?').run(id);
}

// ------------------------------------------------------------------ routing
async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api/, ''), m = req.method;
  let r;
  const reply = (pair) => send(res, pair[0], pair[1]);
  if (p === '/state' && m === 'GET') return send(res, 200, getState());
  if (p === '/weather' && m === 'GET') return send(res, 200, await getWeather().catch((e) => ({ error: e.message })));
  if (p === '/calendar' && m === 'GET') return send(res, 200, { events: [], errors: [], checked: Date.now() });
  if (p.indexOf('/home') === 0) return send(res, 200, { none: true });
  if (p === '/alerts' && m === 'GET') return send(res, 200, { seq: 0 });
  if (p === '/frames' && m === 'POST') return reply(frameBeat(await readBody(req)));
  if (p === '/frames' && m === 'GET') return send(res, 200, listFrames());
  if (p === '/notes' && m === 'POST') return reply(putNote(await readBody(req)));
  if ((r = /^\/notes\/([a-z0-9]{6,40})$/.exec(p)) && m === 'DELETE') return reply(clearNote(r[1], false));
  if ((r = /^\/notes\/([a-z0-9]{6,40})\/restore$/.exec(p)) && m === 'POST') return reply(clearNote(r[1], true));
  if (p === '/groceries' && m === 'POST') return reply(putGrocery(await readBody(req)));
  if (p === '/groceries/clear' && m === 'POST') return reply(clearGroceries(await readBody(req)));
  if (p === '/photos' && m === 'POST') return bad(res, 'Photos are added with importer.py on the server, not from the page', 501);
  if ((r = /^\/photos\/([0-9a-f]{16})$/.exec(p))) {
    if (m === 'GET') return servePhoto(req, res, r[1], url.searchParams.has('b') ? 'bg' : url.searchParams.has('s') ? 'small' : 'full');
    if (m === 'PATCH') { db.prepare('UPDATE photos SET fav = ? WHERE id = ?').run((await readBody(req)).fav ? 1 : 0, r[1]); return send(res, 200, { ok: true }); }
    if (m === 'DELETE') { deletePhoto(r[1]); return send(res, 200, { ok: true }); }
  }
  return bad(res, 'not found', 404);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(APP_DIR, rel));
  if (file !== APP_DIR && !file.startsWith(APP_DIR + path.sep)) return bad(res, 'not found', 404);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return bad(res, 'not found', 404);
    const ext = path.extname(file), hashed = /\/assets\//.test(rel);
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': st.size,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // ?key=… on any page: remember it in a cookie (plain HTTP on the LAN, so no Secure flag) and drop it from the address bar.
    const given = url.searchParams.get('key');
    if (given != null && url.pathname.indexOf('/api/') !== 0) {
      if (!sameKey(given)) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Wrong key'); }
      url.searchParams.delete('key');
      res.writeHead(302, { location: url.pathname + url.search, 'set-cookie': 'hq=' + encodeURIComponent(given) + '; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax' });
      return res.end();
    }
    if (url.pathname.indexOf('/api/') !== 0) return serveStatic(req, res, url);
    if (!sameKey(cookieKey(req) || req.headers['x-hq-key'])) return bad(res, 'locked', 401);
    await api(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) bad(res, String(err.message || err), 500); else res.end();
  }
}).listen(PORT, '0.0.0.0', () => console.log('Home HQ listening on :' + PORT + ' (' + BASE + ')'));
