'use strict';

/* End-to-end HTTP checks against a locally booted server. No Telegram network. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config();

const BOT_TOKEN = process.env.SMOKE_BOT_TOKEN || process.env.BOT_TOKEN;
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3100';

if (!BOT_TOKEN) {
  console.error('Set BOT_TOKEN in .env (or SMOKE_BOT_TOKEN) to sign test init data.');
  process.exit(1);
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

function signInitData(userId) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAH_smoke',
    user: JSON.stringify({ id: userId, first_name: 'Smoke', username: 'smoke' }),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function call(pathname, { method = 'GET', body, initData } = {}) {
  return fetch(BASE + pathname, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
}

(async () => {
  const good = signInitData(777001);
  const other = signInitData(777002);

  console.log('\nhttp surface');

  await check('GET /healthz reports liveness', async () => {
    const res = await call('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.sessions, 'number');
  });

  await check('GET / serves the webapp shell', async () => {
    const res = await fetch(BASE + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /telegram-web-app\.js/);
    assert.match(html, /id="screen-phone"/);
  });

  await check('GET /assets/styles.css is served', async () => {
    const res = await fetch(BASE + '/assets/styles.css');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/css/);
  });

  await check('GET /shared/countries.json is served', async () => {
    const res = await fetch(BASE + '/shared/countries.json');
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list) && list.length > 180);
  });

  await check('CSP allows the Telegram iframe and blocks framing elsewhere', async () => {
    const res = await fetch(BASE + '/');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors[^;]*web\.telegram\.org/);
    assert.match(csp, /script-src[^;]*https:\/\/telegram\.org/);
  });

  await check('unknown API route returns a JSON 404', async () => {
    const res = await call('/api/nope', { initData: good });
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
  });

  console.log('\nauth guards');

  await check('API rejects a request with no init data', async () => {
    const res = await call('/api/auth/status');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'unauthorized');
  });

  await check('API rejects a forged init data header', async () => {
    const res = await call('/api/auth/status', { initData: 'auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'init_data_signature_invalid');
  });

  await check('status is anonymous for a fresh user', async () => {
    const res = await call('/api/auth/status', { initData: good });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'anonymous');
  });

  console.log('\nphone validation over HTTP');

  await check('rejects an empty number', async () => {
    const res = await call('/api/auth/start', { method: 'POST', body: { phone: '' }, initData: good });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'phone_empty');
  });

  await check('rejects a number with letters', async () => {
    const res = await call('/api/auth/start', { method: 'POST', body: { phone: 'abc' }, initData: good });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'phone_invalid');
  });

  await check('rejects an impossible national number', async () => {
    const res = await call('/api/auth/start', { method: 'POST', body: { phone: '+8801234' }, initData: good });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'nsn_invalid');
  });

  await check('rejects an unknown country select value', async () => {
    const res = await call('/api/auth/start', {
      method: 'POST',
      body: { phone: '1712345678', country: 'ZZ' },
      initData: good,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'country_unknown');
  });

  console.log('\nverify guards');

  await check('verify requires an attempt id', async () => {
    const res = await call('/api/auth/verify', { method: 'POST', body: {}, initData: good });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'attempt_id_required');
  });

  await check('verify rejects an unknown attempt id', async () => {
    const res = await call('/api/auth/verify', {
      method: 'POST',
      body: { attemptId: 'f'.repeat(32), code: '12345' },
      initData: good,
    });
    assert.equal(res.status, 410);
    assert.equal(res.body.error, 'flow_expired');
  });

  await check('malformed JSON returns a clean 400', async () => {
    const res = await fetch(`${BASE}/api/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': good },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'invalid_json');
    const after = await call('/healthz');
    assert.equal(after.status, 200);
  });

  console.log('\ncross-user isolation');
  await check('each Telegram user gets its own anonymous state', async () => {
    const a = await call('/api/auth/status', { initData: good });
    const b = await call('/api/auth/status', { initData: other });
    assert.equal(a.status, 200);
    assert.equal(a.body.status, 'anonymous');
    assert.equal(b.status, 200);
    assert.equal(b.body.status, 'anonymous');
  });

  console.log(`\n${passed} http checks passed\n`);
})();
