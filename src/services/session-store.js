'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const logger = require('../logger');

const INDEX_FILE = 'index.json';
const SESSION_SUFFIX = '.session';
const INDEX_VERSION = 2;

/**
 * Filesystem-backed store for teleproto StringSession blobs.
 *
 * Layout (DATA_DIR, mounted as a Docker volume):
 *   data/index.json                  -> { version, byPhone, byOwner }
 *   data/sessions/<digits>.session   -> teleproto StringSession string
 *
 * Two different Telegram identities matter here and must not be conflated:
 *   telegramUserId     the account that owns the phone number being signed in
 *   ownerTelegramUserId the WebApp user who started the login
 * A single operator signs in many different phone numbers, so byOwner — not by
 * phone account — is what "have I already connected a number?" is answered with.
 *
 * Writes are serialised through a promise chain so concurrent logins can never
 * interleave and corrupt the index.
 */
class SessionStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.sessionDir = path.join(dataDir, 'sessions');
    this.indexFile = path.join(dataDir, INDEX_FILE);
    this.index = { version: INDEX_VERSION, byPhone: {}, byOwner: {} };
    this.queue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.sessionDir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.indexFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.index = {
        version: INDEX_VERSION,
        byPhone: parsed.byPhone || {},
        byOwner: parsed.byOwner || {},
      };
      // v1 keyed byOwner by the signed-in phone account, which cannot be
      // trusted for ownership. The mapping is rebuilt as sessions are re-saved.
      if (parsed.byUser && !parsed.byOwner) {
        logger.warn('Upgraded a v1 session index; owner lookups start empty until each number is saved again');
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        await this.#persist();
        logger.info(`Created a fresh session index at ${this.indexFile}`);
      } else {
        throw new Error(`Could not read ${this.indexFile}: ${err.message}`);
      }
    }
  }

  #sessionPath(phoneDigits) {
    return path.join(this.sessionDir, `${phoneDigits}${SESSION_SUFFIX}`);
  }

  /** Serialise index writes; the callback receives the mutable index. */
  #transaction(fn) {
    const run = this.queue.then(async () => {
      const result = await fn(this.index);
      await this.#persist();
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #persist() {
    const tmp = `${this.indexFile}.${process.pid}.tmp`;
    const payload = `${JSON.stringify(this.index, null, 2)}\n`;
    await fsp.writeFile(tmp, payload, { mode: 0o600 });
    await fsp.chmod(tmp, 0o600).catch(() => {});
    await fsp.rename(tmp, this.indexFile);
  }

  #readSessionFile(phoneDigits) {
    try {
      return fs.readFileSync(this.#sessionPath(phoneDigits), 'utf8').trim();
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  getByPhone(phoneDigits) {
    return this.index.byPhone[phoneDigits] || null;
  }

  getByTelegramUser(ownerTelegramUserId) {
    return this.index.byOwner[String(ownerTelegramUserId)] || null;
  }

  /** Returns { session, meta } or null. */
  read(phoneDigits) {
    const meta = this.getByPhone(phoneDigits);
    if (!meta) return null;
    const session = this.#readSessionFile(phoneDigits);
    if (!session) return null;
    // teleproto writes `StringSession.save()` as "1" + standard base64. Anything
    // else means an interrupted write and would throw on the next read.
    if (!/^1[A-Za-z0-9+/]+={0,2}$/.test(session)) return null;
    return { session, meta };
  }

  list() {
    return Object.values(this.index.byPhone).map(({ session, ...meta }) => meta);
  }

  count() {
    return Object.keys(this.index.byPhone).length;
  }

  async save({ phoneDigits, session, telegramUserId, ownerTelegramUserId, username, firstName, lastName }) {
    await this.#transaction(async () => {
      const file = this.#sessionPath(phoneDigits);
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, `${session.trim()}\n`, { mode: 0o600 });
      await fsp.chmod(tmp, 0o600).catch(() => {});
      await fsp.rename(tmp, file);

      const previous = this.index.byPhone[phoneDigits];
      // Only one WebApp user may own a given number at a time.
      if (previous?.ownerTelegramUserId && previous.ownerTelegramUserId !== String(ownerTelegramUserId)) {
        delete this.index.byOwner[previous.ownerTelegramUserId];
      }

      const now = new Date().toISOString();
      this.index.byPhone[phoneDigits] = {
        phoneDigits,
        telegramUserId: String(telegramUserId),
        ownerTelegramUserId: String(ownerTelegramUserId),
        username: username || '',
        firstName: firstName || '',
        lastName: lastName || '',
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        lastVerifiedAt: previous?.lastVerifiedAt || null,
      };
      this.index.byOwner[String(ownerTelegramUserId)] = this.index.byPhone[phoneDigits];
    });
    return this.index.byPhone[phoneDigits];
  }

  async touchVerified(phoneDigits) {
    return this.#transaction((index) => {
      const meta = index.byPhone[phoneDigits];
      if (meta) meta.lastVerifiedAt = new Date().toISOString();
      return meta || null;
    });
  }

  async remove(phoneDigits) {
    return this.#transaction(async (index) => {
      const meta = index.byPhone[phoneDigits];
      if (!meta) return false;
      delete index.byPhone[phoneDigits];
      // byOwner maps an opener to a single number; only drop it if it still
      // points at the number being removed.
      if (meta.ownerTelegramUserId && index.byOwner[meta.ownerTelegramUserId]?.phoneDigits === phoneDigits) {
        delete index.byOwner[meta.ownerTelegramUserId];
      }
      try {
        await fsp.unlink(this.#sessionPath(phoneDigits));
      } catch (err) {
        if (err.code !== 'ENOENT') logger.warn(`Could not delete session file for ${phoneDigits}: ${err.message}`);
      }
      return true;
    });
  }
}

module.exports = { SessionStore };
