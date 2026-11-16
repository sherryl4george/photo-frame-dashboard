// MQTT bridge: shows each frame as a Home Assistant device (MQTT discovery) and turns Home Assistant's
// commands into messages for the frame. Needs MQTT_HOST, MQTT_USER, MQTT_PASS (config/secrets.env).
//
//   photoframe/bridge/availability        online | offline (the broker publishes "offline" if we vanish)
//   photoframe/<frame>/availability       online | offline
//   photoframe/<frame>/state              JSON of the frame's state
//   photoframe/<frame>/<name>/set         commands from Home Assistant (screen, style, seconds, details, weather, slideshow, reload)
//
// Only the command names and value ranges below are accepted; anything else is ignored.
import mqtt from 'mqtt';

const BASE = 'photoframe';
const STYLES = ['auto', 'cover', 'pair', 'collage', 'polaroid'];
const FRAME_ID = /^[a-z0-9]{6,40}$/;

/** Validate a command from MQTT. Returns what to send to the frame, or null. */
export function parseCommand(key, payload) {
  const v = String(payload).trim();
  const on = (x) => (x === 'ON' ? true : x === 'OFF' ? false : null);
  switch (key) {
    case 'screen': { const b = on(v); return b === null ? null : { cmd: 'screen', value: b ? 'on' : 'off' }; }
    case 'style': return STYLES.includes(v) ? { cmd: 'style', value: v } : null;
    case 'seconds': { const n = Math.round(Number(v) / 5) * 5; return Number.isFinite(n) && n >= 5 && n <= 120 ? { cmd: 'seconds', value: n } : null; }
    case 'details': case 'weather': { const b = on(v); return b === null ? null : { cmd: key, value: b }; }
    case 'slideshow': case 'reload': return v === 'PRESS' ? { cmd: key, value: true } : null;
    default: return null;
  }
}

export function startMqtt(secrets, onCommand, log = console) {
  if (!secrets.MQTT_HOST) { log.log('mqtt: not configured (MQTT_HOST is not set)'); return null; }
  const prefix = secrets.MQTT_DISCOVERY_PREFIX || 'homeassistant';
  const known = new Map();   // frame id -> last discovery signature
  const lastState = new Map(); // frame id -> last state JSON string
  const lastAvail = new Map();
  let up = false;
  const subs = [];       // { pattern, handler }: other modules (the shopping lists) listening on their own topics
  const upHandlers = []; // run each time the broker connection comes up
  const matches = (pattern, topic) => { const p = pattern.split('/'), t = topic.split('/'); return p.length === t.length && p.every((x, i) => x === '+' || x === t[i]); };

  const client = mqtt.connect('mqtt://' + secrets.MQTT_HOST + ':' + (secrets.MQTT_PORT || 1883), {
    username: secrets.MQTT_USER, password: secrets.MQTT_PASS, clientId: 'photoframe-server',
    clean: true, reconnectPeriod: 5000, connectTimeout: 10000, keepalive: 30,
    will: { topic: BASE + '/bridge/availability', payload: 'offline', retain: true, qos: 1 },
  });
  const pub = (topic, payload, retain = true) => { if (up) client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { retain, qos: 1 }); };

  function discovery(f) {
    const id = f.id;
    const device = { identifiers: ['photoframe_' + id], name: f.name || 'Photo frame', manufacturer: 'Home HQ', model: f.model || 'Wall display', sw_version: f.version || undefined };
    const avail = [{ topic: BASE + '/bridge/availability' }, { topic: BASE + '/' + id + '/availability' }];
    const t = (k) => BASE + '/' + id + '/' + k + '/set';
    const state = BASE + '/' + id + '/state';
    const base = (obj, extra) => Object.assign({ unique_id: 'photoframe_' + id + '_' + obj, device, availability: avail, availability_mode: 'all', state_topic: state }, extra);
    const onoff = (path) => "{{ 'ON' if " + path + " else 'OFF' }}";
    return {
      [`switch/${id}/screen`]: base('screen', { name: 'Screen', icon: 'mdi:monitor', value_template: onoff('value_json.screen'), command_topic: t('screen'), payload_on: 'ON', payload_off: 'OFF' }),
      [`select/${id}/style`]: base('style', { name: 'Slideshow style', icon: 'mdi:image-multiple', options: STYLES, value_template: '{{ value_json.slideshow.layout }}', command_topic: t('style'), entity_category: 'config' }),
      [`number/${id}/seconds`]: base('seconds', { name: 'Seconds per photo', icon: 'mdi:timer-outline', min: 5, max: 120, step: 5, unit_of_measurement: 's', mode: 'box', value_template: '{{ value_json.slideshow.interval }}', command_topic: t('seconds'), entity_category: 'config' }),
      [`switch/${id}/details`]: base('details', { name: 'Show photo details', icon: 'mdi:map-marker', value_template: onoff('value_json.slideshow.details'), command_topic: t('details'), payload_on: 'ON', payload_off: 'OFF', entity_category: 'config' }),
      [`switch/${id}/weather`]: base('weather', { name: 'Show weather', icon: 'mdi:weather-partly-cloudy', value_template: onoff('value_json.slideshow.weather'), command_topic: t('weather'), payload_on: 'ON', payload_off: 'OFF', entity_category: 'config' }),
      [`button/${id}/slideshow`]: { unique_id: 'photoframe_' + id + '_slideshow', device, availability: avail, availability_mode: 'all', name: 'Start slideshow', icon: 'mdi:play-box', command_topic: t('slideshow'), payload_press: 'PRESS' },
      [`button/${id}/reload`]: { unique_id: 'photoframe_' + id + '_reload', device, availability: avail, availability_mode: 'all', name: 'Reload page', icon: 'mdi:refresh', command_topic: t('reload'), payload_press: 'PRESS', entity_category: 'config' },
      [`sensor/${id}/mode`]: base('mode', { name: 'Mode', icon: 'mdi:view-dashboard', value_template: '{{ value_json.mode }}' }),
      [`sensor/${id}/wifi`]: base('wifi', { name: 'Wi-Fi signal', device_class: 'signal_strength', unit_of_measurement: 'dBm', state_class: 'measurement', value_template: "{{ value_json.rssi if value_json.rssi is not none else 'unknown' }}", entity_category: 'diagnostic' }),
      [`sensor/${id}/version`]: base('version', { name: 'Software version', value_template: '{{ value_json.version }}', entity_category: 'diagnostic' }),
      [`sensor/${id}/kiosk`]: base('kiosk', { name: 'Kiosk app version', value_template: '{{ value_json.kiosk }}', entity_category: 'diagnostic' }),
      [`binary_sensor/${id}/online`]: { unique_id: 'photoframe_' + id + '_online', device, availability: [{ topic: BASE + '/bridge/availability' }], name: 'Online', device_class: 'connectivity', state_topic: BASE + '/' + id + '/availability', payload_on: 'online', payload_off: 'offline' },
    };
  }

  client.on('connect', () => {
    up = true;
    log.log('mqtt: connected to ' + secrets.MQTT_HOST);
    client.publish(BASE + '/bridge/availability', 'online', { retain: true, qos: 1 });
    client.subscribe(BASE + '/+/+/set', { qos: 1 });
    subs.forEach((x) => client.subscribe(x.pattern, { qos: 1 }));
    known.clear(); lastState.clear(); lastAvail.clear(); // a new session: publish everything again
    api.onReady && api.onReady();
    upHandlers.forEach((f) => f());
  });
  client.on('reconnect', () => { up = false; });
  client.on('close', () => { up = false; });
  client.on('error', (e) => log.error('mqtt: ' + e.message));
  client.on('message', (topic, payload) => {
    subs.forEach((x) => { if (matches(x.pattern, topic)) x.handler(topic, payload.toString()); });
    const m = /^photoframe\/([a-z0-9]{6,40})\/([a-z]+)\/set$/.exec(topic);
    if (!m || !FRAME_ID.test(m[1])) return;
    const c = parseCommand(m[2], payload.toString());
    if (c) onCommand(m[1], c); else log.log('mqtt: ignored ' + m[2] + ' command');
  });

  const api = {
    onReady: null,
    isUp: () => up,
    onUp(f) { upHandlers.push(f); if (up) f(); },
    subscribe(pattern, handler) { subs.push({ pattern, handler }); if (up) client.subscribe(pattern, { qos: 1 }); },
    publish(topic, payload, opts = {}) { if (!up) return false; client.publish(topic, payload, { retain: !!opts.retain, qos: 1 }); return true; },
    /** Make sure Home Assistant knows this frame, then publish its state and availability when they change. */
    frame(f, state, online) {
      if (!up || !FRAME_ID.test(f.id)) return;
      const sig = JSON.stringify([f.name, f.model, f.version]);
      if (known.get(f.id) !== sig) {
        const d = discovery(f);
        for (const [path, cfg] of Object.entries(d)) pub(prefix + '/' + path + '/config', cfg);
        known.set(f.id, sig);
      }
      const s = JSON.stringify(state);
      if (lastState.get(f.id) !== s) { lastState.set(f.id, s); pub(BASE + '/' + f.id + '/state', s); }
      const a = online ? 'online' : 'offline';
      if (lastAvail.get(f.id) !== a) { lastAvail.set(f.id, a); pub(BASE + '/' + f.id + '/availability', a); }
    },
    /** Remove a frame from Home Assistant (empty retained messages delete the entities). */
    forget(id) {
      if (!FRAME_ID.test(id)) return;
      for (const path of Object.keys(discovery({ id }))) pub(prefix + '/' + path + '/config', '');
      pub(BASE + '/' + id + '/state', ''); pub(BASE + '/' + id + '/availability', '');
      known.delete(id); lastState.delete(id); lastAvail.delete(id);
    },
    close() { try { client.publish(BASE + '/bridge/availability', 'offline', { retain: true, qos: 1 }, () => client.end()); } catch (e) { client.end(); } },
  };
  return api;
}
