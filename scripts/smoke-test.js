'use strict';

/* Offline smoke test: no network, no Telegram connection. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { normalizePhone, detectCountry, listCountries, flagFromIso } = require('../src/utils/phone');
const { verifyInitData, InitDataError } = require('../src/utils/telegram-init-data');
const { SessionStore } = require('../src/services/session-store');
const { LoginAttemptStore } = require('../src/services/login-attempts');

const BOT_TOKEN = '1234567890:AAHtesttesttesttesttesttesttesttesttesttest';

/**
 * Build a real teleproto StringSession string the same way StringSession.save()
 * does: "1" + base64(dcId, addrLen, address, port, 256-byte auth key).
 */
function buildStringSession({ dcId = 2, address = '149.154.167.51', port = 443 } = {}) {
  const addr = Buffer.from(address, 'utf8');
  const len = Buffer.alloc(2);
  len.writeInt16BE(addr.length, 0);
  const portBuf = Buffer.alloc(2);
  portBuf.writeInt16BE(port, 0);
  const key = Buffer.alloc(256, 0x5a);
  return '1' + Buffer.concat([Buffer.from([dcId]), len, addr, portBuf, key]).toString('base64');
}

const REAL_SESSION = buildStringSession();

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\nphone normalisation');
check('accepts +880 national number', () => {
  assert.equal(normalizePhone('+8801712345678').e164, '+8801712345678');
});
check('strips spaces, dashes and brackets', () => {
  assert.equal(normalizePhone('+880 (1712) 345-678').e164, '+8801712345678');
});
check('accepts 00 international prefix', () => {
  assert.equal(normalizePhone('008801712345678').e164, '+8801712345678');
});
check('accepts bare dial + subscriber number', () => {
  assert.equal(normalizePhone('8801712345678').e164, '+8801712345678');
});
check('uses the country select for national input', () => {
  assert.equal(normalizePhone('01712345678', { iso: 'BD' }).e164, '+8801712345678');
});
check('handles US trunk prefix', () => {
  assert.equal(normalizePhone('(415) 555-2671', { iso: 'US' }).e164, '+14155552671');
});
check('handles +1 NANP area codes', () => {
  assert.equal(normalizePhone('+14155552671').iso, 'US');
  assert.equal(normalizePhone('+14165551212').iso, 'CA');
  assert.equal(normalizePhone('+12425551212').iso, 'BS');
});
check('shared dial codes default to the main country', () => {
  assert.equal(normalizePhone('+447400123456').iso, 'GB');
  assert.equal(normalizePhone('+4740001234').iso, 'NO');
  // +7 is genuinely ambiguous; RU wins unless the user picks Kazakhstan.
  assert.equal(normalizePhone('+79001234567').iso, 'RU');
  assert.equal(normalizePhone('+79001234567', { iso: 'KZ' }).iso, 'KZ');
});
check('re-parses bare dial + subscriber digits', () => {
  assert.equal(normalizePhone('8801712345678', { iso: 'BD' }).e164, '+8801712345678');
});
check('handles UK trunk zero', () => {
  assert.equal(normalizePhone('07400123456', { iso: 'GB' }).e164, '+447400123456');
});
check('rejects a national number with no country', () => {
  assert.throws(() => normalizePhone('1712345678'), /country/i);
});
check('rejects too-short numbers', () => {
  assert.throws(() => normalizePhone('+8801234'), /valid/i);
});
check('rejects letters', () => {
  assert.throws(() => normalizePhone('+880abcdefgh'), /only contain/i);
});
check('detects the country from a typed prefix', () => {
  assert.equal(detectCountry('+880').iso, 'BD');
  assert.equal(detectCountry('+44 7400').iso, 'GB');
  assert.equal(detectCountry('+1 416 555 1212').iso, 'CA');
  assert.equal(detectCountry('1712'), null);
  assert.equal(detectCountry('+880abcd'), null);
});
check('flagFromIso builds a regional indicator pair', () => {
  assert.equal(flagFromIso('BD'), '\u{1F1E7}\u{1F1E9}');
  assert.equal(flagFromIso('xx'), '\u{1F1FD}\u{1F1FD}');
  assert.equal(flagFromIso('usa'), '');
  assert.equal(flagFromIso(undefined), '');
});
check('every country row is well formed', () => {
  const list = listCountries();
  assert.ok(list.length > 180, `expected a full country list, got ${list.length}`);
  for (const c of list) {
    assert.match(c.iso, /^[A-Z]{2}$/, c.name);
    assert.match(c.dial, /^\d{1,3}$/, `${c.name} dial`);
    assert.ok(c.nslen[0] <= c.nslen[1], `${c.name} nslen`);
    assert.equal([...flagFromIso(c.iso)].length, 2, c.name);
  }
});
check('country list has no duplicate ISO codes', () => {
  const seen = new Set();
  for (const c of listCountries()) {
    assert.ok(!seen.has(c.iso), `duplicate ${c.iso}`);
    seen.add(c.iso);
  }
});

console.log('\ntelegram init data');
function signInitData(fields) {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const goodFields = {
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: 'AAH_test',
  user: JSON.stringify({ id: 424242, first_name: 'Test', username: 'tester', language_code: 'en' }),
  start_param: 'open',
};

check('accepts a correctly signed payload', () => {
  const result = verifyInitData(signInitData(goodFields), BOT_TOKEN, { maxAgeSec: 3600 });
  assert.equal(result.user.id, '424242');
  assert.equal(result.user.username, 'tester');
  assert.equal(result.startParam, 'open');
});

check('rejects a tampered user id', () => {
  // Sign first, then swap the payload: the HMAC must no longer match.
  const signed = signInitData(goodFields);
  const tampered = signed.replace(encodeURIComponent(JSON.stringify({ id: 424242, first_name: 'Test', username: 'tester', language_code: 'en' })), encodeURIComponent(JSON.stringify({ id: 1 })));
  assert.notEqual(signed, tampered, 'the fixture must actually differ');
  assert.throws(() => verifyInitData(tampered, BOT_TOKEN, { maxAgeSec: 3600 }), InitDataError);
});

check('rejects a payload signed with another bot token', () => {
  const other = '999:AAHtesttesttesttesttesttesttesttesttesttest';
  assert.throws(() => verifyInitData(signInitData(goodFields), other, { maxAgeSec: 3600 }), InitDataError);
});

check('rejects an empty payload', () => {
  assert.throws(() => verifyInitData('', BOT_TOKEN), InitDataError);
});

// Regression cover for real-world WebApp payloads. Telegram percent-encodes
// values into init_data, so if we ever build the data-check-string from
// encoded values instead of decoded ones (or mishandle '+' vs ' '), every
// genuine login breaks with init_data_signature_invalid.
const trickyNames = ['Alim+Hasan', 'A&B=C "q"', 'Ünïcodé 😀', '100% Real', 'a/b?c=d'];

for (const name of trickyNames) {
  check(`accepts a payload whose user name is "${name}"`, () => {
    const fields = {
      ...goodFields,
      user: JSON.stringify({ id: 424242, first_name: name, username: 'tester' }),
    };
    const result = verifyInitData(signInitData(fields), BOT_TOKEN, { maxAgeSec: 3600 });
    assert.equal(result.user.firstName, name);
  });
}

check('accepts a payload carrying chat and receiver fields', () => {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat_instance: '-1234567890123456789',
    chat_type: 'supergroup',
    receiver: '8969566908',
    start_param: 'ref_abc',
    user: JSON.stringify({ id: 424242, first_name: 'Test' }),
  };
  const result = verifyInitData(signInitData(fields), BOT_TOKEN, { maxAgeSec: 3600 });
  assert.equal(result.chatType, 'supergroup');
  assert.equal(result.startParam, 'ref_abc');
});

check('a signature mismatch reports the owning bot id for diagnosis', () => {
  const other = '1111111111:AAHsomeothertokenforsimulationonlynotreal';
  const fields = { ...goodFields, receiver: '8969566908' };
  try {
    verifyInitData(signInitData(fields), other, { maxAgeSec: 3600 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'init_data_signature_invalid');
    // These are the values that make a token mismatch diagnosable from the log.
    assert.equal(err.details.receiver, '8969566908');
    assert.ok(err.details.fields.includes('user'));
    assert.ok(err.details.payloadBytes > 0);
    assert.ok(!('hash' in err.details), 'the hash must never be logged');
  }
});

check('rejects stale init data', () => {
  const stale = { ...goodFields, auth_date: String(Math.floor(Date.now() / 1000) - 7200) };
  assert.throws(() => verifyInitData(signInitData(stale), BOT_TOKEN, { maxAgeSec: 3600 }), InitDataError);
});

(async () => {
  console.log('\nsession store');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lamiya-'));
  const store = new SessionStore({ dataDir: dir });
  await store.init();

  check('index starts empty', () => assert.equal(store.count(), 0));
  check('read of an unknown number returns null', () => assert.equal(store.read('8801'), null));

  await store.save({
    phoneDigits: '8801712345678',
    session: REAL_SESSION,
    telegramUserId: '999000111',
    ownerTelegramUserId: '424242',
    username: 'tester',
    firstName: 'Test',
  });

  const stored = store.read('8801712345678');
  check('session round-trips', () => {
    assert.equal(stored.session, REAL_SESSION);
    assert.equal(stored.meta.telegramUserId, '999000111');
  });
  check('teleproto can parse what we stored', () => {
    const { StringSession } = require('teleproto/sessions');
    const parsed = new StringSession(stored.session);
    assert.equal(parsed.dcId, 2);
    assert.equal(parsed.serverAddress, '149.154.167.51');
    assert.equal(parsed.port, 443);
  });
  check('lookup is keyed by the WebApp owner, not the phone account', () => {
    // The operator (424242) signed in someone else's number (999000111); the
    // status endpoint must answer for the operator.
    assert.equal(store.getByTelegramUser('424242').phoneDigits, '8801712345678');
    assert.equal(store.getByTelegramUser('999000111'), null);
  });

  await store.save({
    phoneDigits: '8801812345678',
    session: buildStringSession({ dcId: 1, address: '149.154.175.50' }),
    telegramUserId: '888777',
    ownerTelegramUserId: '424242',
  });
  await store.remove('8801712345678');
  check('removing one number keeps the owner index for the others', () => {
    assert.equal(store.getByTelegramUser('424242').phoneDigits, '8801812345678');
    assert.equal(store.count(), 1);
  });

  await store.touchVerified('8801812345678');
  check('lastVerifiedAt is stamped', () => {
    assert.ok(store.getByPhone('8801812345678').lastVerifiedAt);
  });

  await store.remove('8801812345678');
  check('remove clears both indexes', () => {
    assert.equal(store.count(), 0);
    assert.equal(store.getByTelegramUser('424242'), null);
  });
  await assert.rejects(fsp.stat(path.join(dir, 'sessions', '8801712345678.session')));

  const reloaded = new SessionStore({ dataDir: dir });
  await reloaded.init();
  check('index reloads from disk', () => assert.equal(reloaded.count(), 0));

  await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify({
    version: 1,
    byPhone: { '8801999999999': { phoneDigits: '8801999999999', telegramUserId: '5' } },
    byUser: { '5': { phoneDigits: '8801999999999', telegramUserId: '5' } },
  }));  const afterIndexEdit = new SessionStore({ dataDir: dir });
  await afterIndexEdit.init();
  check('read ignores an index entry with no session file', () => {
    assert.ok(afterIndexEdit.getByPhone('8801999999999'));
    assert.equal(afterIndexEdit.read('8801999999999'), null);
  });

  await fsp.writeFile(path.join(dir, 'sessions', '8801999999999.session'), 'garbage\n');
  check('read rejects a corrupt session file', () => {
    assert.equal(afterIndexEdit.read('8801999999999'), null);
  });

  check('a v1 index is upgraded, not trusted for owner lookups', () => {
    assert.equal(afterIndexEdit.getByTelegramUser('5'), null);
  });

  await fsp.writeFile(path.join(dir, 'index.json'), '{ this is not json');
  await assert.rejects(new SessionStore({ dataDir: dir }).init(), /Could not read/);

  await fsp.rm(dir, { recursive: true, force: true });

  console.log('\nlogin attempt store');
  const attempts = new LoginAttemptStore({ ttlMs: 50, maxAttempts: 2, resendCooldownMs: 10_000 });
  const attempt = attempts.create({ phoneDigits: '8801', e164: '+8801', telegramUserId: '7' });
  check('attempt is retrievable by id', () => assert.equal(attempts.get(attempt.id).id, attempt.id));
  check('attempt is retrievable by phone', () => assert.equal(attempts.getByPhone('8801').id, attempt.id));
  check('cooldown is reported', () => assert.ok(attempts.resendCooldownRemaining('8801') > 0));
  check('other phones have no cooldown', () => assert.equal(attempts.resendCooldownRemaining('9999'), 0));

  check('attempts are consumed', () => {
    assert.equal(attempts.consumeAttempt(attempt), true);
    assert.equal(attempts.consumeAttempt(attempt), false);
  });

  check('a new attempt for the same phone replaces the old one', () => {
    attempts.create({ phoneDigits: '8801', e164: '+8801', telegramUserId: '7' });
    assert.equal(attempts.attempts.size, 1);
  });

  check('a different user cannot reuse the id', () => {
    assert.equal(attempts.get(attempt.id), null);
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  check('expired attempts are dropped on read', () => {
    assert.equal(attempts.getByPhone('8801'), null);
    assert.equal(attempts.attempts.size, 0);
  });
  attempts.stop();

  console.log(`\n${passed} checks passed\n`);
})();
