/**
 * src/db.js  -  IndexedDB layer (Phase 1)
 *
 * Classic script (no ES modules). Requires src/crypto.js to be loaded first.
 * Exposes: window.Vault.db
 *
 * Object stores
 *   users               id
 *   products            id
 *   purchases           id
 *   ownership_licenses  id                 (unique per user+product)
 *   activation_codes    code_hash          (hashes only, never plaintext codes)
 *   media_vault         product_id         (AES-GCM ciphertext as ArrayBuffer)
 *   meta                key                (device master secret, seed version, current user)
 *
 * Transaction rule: inside transact() only await IndexedDB requests (via req()).
 * Awaiting anything else (fetch, crypto.subtle, timers) lets the transaction
 * auto-commit. Do crypto/network work BEFORE opening the transaction.
 * A failed request aborts the whole transaction (atomic all-or-nothing).
 */
(function (global) {
  'use strict';

  const Vault = (global.Vault = global.Vault || {});

  const DB_NAME = 'music_ownership_platform';
  const DB_VERSION = 1;
  const SEED_VERSION = 1;

  const STORES = Object.freeze({
    USERS: 'users',
    PRODUCTS: 'products',
    PURCHASES: 'purchases',
    LICENSES: 'ownership_licenses',
    CODES: 'activation_codes',
    VAULT: 'media_vault',
    META: 'meta'
  });

  const LICENSE_STATUS = Object.freeze({ ACTIVE: 'active', REVOKED: 'revoked' });

  const META_KEYS = Object.freeze({
    DEVICE_SECRET: 'device_master_secret',
    SEED_VERSION: 'seed_version',
    CURRENT_USER: 'current_user_id'
  });

  const DEFAULT_USER = Object.freeze({ id: 'user_local_default', username: 'listener' });

  // Note: booleans and null are NOT valid IndexedDB keys, so fields such as
  // activation_codes.is_redeemed are stored but deliberately not indexed.
  const SCHEMA = [
    {
      name: STORES.USERS,
      keyPath: 'id',
      indexes: [{ name: 'username', keyPath: 'username', unique: true }]
    },
    {
      name: STORES.PRODUCTS,
      keyPath: 'id',
      indexes: [
        { name: 'artist', keyPath: 'artist' },
        { name: 'type', keyPath: 'type' }
      ]
    },
    {
      name: STORES.PURCHASES,
      keyPath: 'id',
      indexes: [
        { name: 'user_id', keyPath: 'user_id' },
        { name: 'product_id', keyPath: 'product_id' },
        { name: 'user_product', keyPath: ['user_id', 'product_id'] },
        { name: 'timestamp', keyPath: 'timestamp' }
      ]
    },
    {
      name: STORES.LICENSES,
      keyPath: 'id',
      indexes: [
        { name: 'user_id', keyPath: 'user_id' },
        { name: 'product_id', keyPath: 'product_id' },
        { name: 'purchase_id', keyPath: 'purchase_id' },
        // One license record per user+product. Revoking sets status='revoked'
        // on the same record; re-granting updates it (no duplicates).
        { name: 'user_product', keyPath: ['user_id', 'product_id'], unique: true },
        { name: 'status', keyPath: 'status' }
      ]
    },
    {
      name: STORES.CODES,
      keyPath: 'code_hash',
      indexes: [{ name: 'product_id', keyPath: 'product_id' }]
    },
    {
      name: STORES.VAULT,
      keyPath: 'product_id',
      indexes: [{ name: 'cached_at', keyPath: 'cached_at' }]
    },
    { name: STORES.META, keyPath: 'key', indexes: [] }
  ];

  // ---------------------------------------------------------------------------
  // Seed data
  // ---------------------------------------------------------------------------
  // Catalog audio is generated offline by the Phase 2 media service from the
  // `synth://` URL parameters, so the MVP needs no network and no audio files.
  // Prices are integer minor units (cents).

  const CATALOG = [
    {
      id: 'prod_neon_horizon',
      title: 'Neon Horizon',
      artist: 'Aria Vance',
      album: 'Night Signals',
      price: 199,
      hue: [265, 200],
      synth: { root: 220.0, scale: 'minor', bpm: 100, bars: 12, wave: 'sawtooth', seed: 11 },
      description: 'Glossy synth-pop built on a driving minor-key arpeggio.'
    },
    {
      id: 'prod_midnight_loop',
      title: 'Midnight Loop',
      artist: 'Kade Orion',
      album: 'Loop Theory',
      price: 129,
      hue: [230, 290],
      synth: { root: 196.0, scale: 'dorian', bpm: 84, bars: 12, wave: 'triangle', seed: 23 },
      description: 'Slow, hypnotic late-night groove with a dorian melody.'
    },
    {
      id: 'prod_coastal_drift',
      title: 'Coastal Drift',
      artist: 'Marin Solace',
      album: 'Salt & Static',
      price: 149,
      hue: [190, 160],
      synth: { root: 261.63, scale: 'major', bpm: 112, bars: 16, wave: 'sine', seed: 37 },
      description: 'Bright, breezy major-key instrumental for the open road.'
    },
    {
      id: 'prod_ember_pulse',
      title: 'Ember Pulse',
      artist: 'Aria Vance',
      album: 'Night Signals',
      price: 129,
      hue: [20, 350],
      synth: { root: 174.61, scale: 'minor', bpm: 128, bars: 16, wave: 'square', seed: 41 },
      description: 'High-energy pulse track with a gritty square-wave lead.'
    },
    {
      id: 'prod_paper_moons',
      title: 'Paper Moons',
      artist: 'The Quiet Circuit',
      album: 'Analog Dreams',
      price: 99,
      hue: [45, 15],
      synth: { root: 293.66, scale: 'pentatonic', bpm: 72, bars: 8, wave: 'sine', seed: 59 },
      description: 'Gentle pentatonic lullaby, warm and unhurried.'
    },
    {
      id: 'prod_glass_garden',
      title: 'Glass Garden',
      artist: 'Marin Solace',
      album: 'Salt & Static',
      price: 149,
      hue: [170, 120],
      synth: { root: 329.63, scale: 'pentatonic', bpm: 96, bars: 12, wave: 'triangle', seed: 73 },
      description: 'Shimmering, crystalline textures over a steady pulse.'
    }
  ];

  // DEV FIXTURE: plaintext test codes live only here. The database stores their
  // SHA-256 hashes exclusively. A real deployment ships pre-computed hashes.
  const TEST_ACTIVATION_CODES = Object.freeze([
    Object.freeze({ code: 'NHZN-4K7Q-M9XD', product_id: 'prod_neon_horizon' }),
    Object.freeze({ code: 'MDLP-7RT2-C5WA', product_id: 'prod_midnight_loop' }),
    Object.freeze({ code: 'CSTL-9HB3-E6YN', product_id: 'prod_coastal_drift' }),
    Object.freeze({ code: 'EMBR-2VJ8-P4KF', product_id: 'prod_ember_pulse' }),
    Object.freeze({ code: 'PPMN-5XQ9-T3LZ', product_id: 'prod_paper_moons' }),
    Object.freeze({ code: 'GLSS-8CD6-H2RW', product_id: 'prod_glass_garden' })
  ]);

  function escapeXml(str) {
    return String(str).replace(/[<>&'"]/g, (ch) => {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch];
    });
  }

  /** Self-contained SVG cover art as a data: URI (works offline). */
  function makeCover(title, hueA, hueB) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="hsl(' + hueA + ',70%,45%)"/>' +
      '<stop offset="1" stop-color="hsl(' + hueB + ',75%,25%)"/>' +
      '</linearGradient></defs>' +
      '<rect width="400" height="400" fill="url(#g)"/>' +
      '<circle cx="300" cy="110" r="70" fill="rgba(255,255,255,0.14)"/>' +
      '<circle cx="110" cy="310" r="120" fill="rgba(0,0,0,0.18)"/>' +
      '<text x="28" y="356" font-family="Helvetica,Arial,sans-serif" font-size="34" font-weight="700" fill="#ffffff">' +
      escapeXml(title) +
      '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function synthUrl(id, p) {
    return (
      'synth://' + id +
      '?root=' + p.root +
      '&scale=' + p.scale +
      '&bpm=' + p.bpm +
      '&bars=' + p.bars +
      '&wave=' + p.wave +
      '&seed=' + p.seed
    );
  }

  function synthDurationSec(p) {
    return Math.round((p.bars * 4 * 60) / p.bpm);
  }

  function buildSeedProducts() {
    return CATALOG.map((c) => ({
      id: c.id,
      title: c.title,
      artist: c.artist,
      album: c.album,
      cover_url: makeCover(c.title, c.hue[0], c.hue[1]),
      media_source_url: synthUrl(c.id, c.synth),
      type: 'single',
      price: c.price,
      currency: 'USD',
      duration_sec: synthDurationSec(c.synth),
      description: c.description
    }));
  }

  // ---------------------------------------------------------------------------
  // Connection + promise helpers
  // ---------------------------------------------------------------------------

  let dbPromise = null;
  let initPromise = null;

  function requireCrypto() {
    if (!Vault.crypto) {
      throw new Error('src/crypto.js must be loaded before src/db.js.');
    }
    return Vault.crypto;
  }

  function createSchema(db, tx) {
    SCHEMA.forEach((def) => {
      const store = db.objectStoreNames.contains(def.name)
        ? tx.objectStore(def.name)
        : db.createObjectStore(def.name, { keyPath: def.keyPath });
      def.indexes.forEach((ix) => {
        if (!store.indexNames.contains(ix.name)) {
          store.createIndex(ix.name, ix.keyPath, { unique: !!ix.unique });
        }
      });
    });
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error('IndexedDB is not available in this browser context.'));
        return;
      }
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        createSchema(request.result, request.transaction);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab wants to upgrade/delete: get out of the way.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
          initPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
          initPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        console.warn('[db] Open blocked: close other tabs that use this app.');
      };
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  /** Wraps an IDBRequest in a promise. Do not preventDefault: errors must abort the transaction. */
  function req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Runs `work(stores, tx)` inside one transaction.
   * `stores` maps store name -> IDBObjectStore. `work` may be async but must only
   * await IndexedDB requests. Resolves with work's return value after the
   * transaction commits; rejects (and rolls back) if anything throws.
   */
  async function transact(storeNames, mode, work) {
    const db = await open();
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(names, mode);
      } catch (err) {
        reject(err);
        return;
      }
      let result;
      let workError = null;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => {
        reject(workError || tx.error || new DOMException('Transaction aborted', 'AbortError'));
      };
      const stores = {};
      names.forEach((n) => {
        stores[n] = tx.objectStore(n);
      });
      let running;
      try {
        running = Promise.resolve(work(stores, tx));
      } catch (err) {
        running = Promise.reject(err);
      }
      running.then(
        (value) => {
          result = value;
        },
        (err) => {
          workError = err;
          try {
            tx.abort();
          } catch (_) {
            /* already finished or aborting */
          }
        }
      );
    });
  }

  const orNull = (value) => (value === undefined ? null : value);

  // ---------------------------------------------------------------------------
  // Generic CRUD (each call is its own transaction)
  // ---------------------------------------------------------------------------

  function get(store, key) {
    return transact(store, 'readonly', (s) => req(s[store].get(key))).then(orNull);
  }

  function getAll(store, query, count) {
    return transact(store, 'readonly', (s) => req(s[store].getAll(query, count)));
  }

  function getFromIndex(store, indexName, query) {
    return transact(store, 'readonly', (s) => req(s[store].index(indexName).get(query))).then(orNull);
  }

  function getAllFromIndex(store, indexName, query, count) {
    return transact(store, 'readonly', (s) => req(s[store].index(indexName).getAll(query, count)));
  }

  /** Insert or replace. Resolves with the record's key. */
  function put(store, value) {
    return transact(store, 'readwrite', (s) => req(s[store].put(value)));
  }

  /** Insert only. Rejects with ConstraintError if the key/unique index already exists. */
  function add(store, value) {
    return transact(store, 'readwrite', (s) => req(s[store].add(value)));
  }

  function remove(store, key) {
    return transact(store, 'readwrite', (s) => req(s[store].delete(key)));
  }

  function count(store) {
    return transact(store, 'readonly', (s) => req(s[store].count()));
  }

  function clear(store) {
    return transact(store, 'readwrite', (s) => req(s[store].clear()));
  }

  // ---------------------------------------------------------------------------
  // Seeding, device secret, users
  // ---------------------------------------------------------------------------

  async function seedIfNeeded() {
    const crypto = requireCrypto();
    const marker = await get(STORES.META, META_KEYS.SEED_VERSION);
    if (marker && marker.value >= SEED_VERSION) return false;

    // Hash BEFORE opening the transaction (crypto.subtle would auto-commit it).
    const codeRecords = [];
    for (const entry of TEST_ACTIVATION_CODES) {
      codeRecords.push({
        code_hash: await crypto.hashActivationCode(entry.code),
        product_id: entry.product_id,
        is_redeemed: false,
        redeemed_by: null,
        redeemed_at: null
      });
    }
    const products = buildSeedProducts();
    const now = Date.now();

    await transact(
      [STORES.PRODUCTS, STORES.CODES, STORES.USERS, STORES.META],
      'readwrite',
      async (s) => {
        // Catalog is authoritative: upsert.
        await Promise.all(products.map((p) => req(s[STORES.PRODUCTS].put(p))));

        // Never overwrite a code: it may already be redeemed.
        for (const rec of codeRecords) {
          const existing = await req(s[STORES.CODES].get(rec.code_hash));
          if (!existing) await req(s[STORES.CODES].put(rec));
        }

        const user = await req(s[STORES.USERS].get(DEFAULT_USER.id));
        if (!user) {
          await req(
            s[STORES.USERS].put({
              id: DEFAULT_USER.id,
              username: DEFAULT_USER.username,
              created_at: now
            })
          );
        }

        const current = await req(s[STORES.META].get(META_KEYS.CURRENT_USER));
        if (!current) {
          await req(
            s[STORES.META].put({ key: META_KEYS.CURRENT_USER, value: DEFAULT_USER.id, updated_at: now })
          );
        }

        await req(
          s[STORES.META].put({ key: META_KEYS.SEED_VERSION, value: SEED_VERSION, updated_at: now })
        );
      }
    );
    return true;
  }

  /**
   * Returns the per-device master secret (Uint8Array, 32 bytes), creating it
   * atomically on first use. If it were ever lost, cached vault items become
   * undecryptable and must be re-downloaded from their source.
   */
  async function getDeviceSecret() {
    const crypto = requireCrypto();
    const fresh = crypto.generateMasterSecret();
    return transact(STORES.META, 'readwrite', async (s) => {
      const existing = await req(s[STORES.META].get(META_KEYS.DEVICE_SECRET));
      if (existing && existing.value instanceof Uint8Array && existing.value.length === 32) {
        return existing.value;
      }
      await req(
        s[STORES.META].put({ key: META_KEYS.DEVICE_SECRET, value: fresh, updated_at: Date.now() })
      );
      return fresh;
    });
  }

  async function getCurrentUser() {
    const pointer = await get(STORES.META, META_KEYS.CURRENT_USER);
    if (!pointer) return null;
    return get(STORES.USERS, pointer.value);
  }

  // ---------------------------------------------------------------------------
  // Storage durability
  // ---------------------------------------------------------------------------

  /** Asks the browser not to evict our data under storage pressure. */
  async function requestPersistence() {
    try {
      const sm = global.navigator && global.navigator.storage;
      if (!sm || typeof sm.persist !== 'function') return false;
      if (typeof sm.persisted === 'function' && (await sm.persisted())) return true;
      return await sm.persist();
    } catch (_) {
      return false;
    }
  }

  async function getStorageEstimate() {
    try {
      const sm = global.navigator && global.navigator.storage;
      if (!sm || typeof sm.estimate !== 'function') return null;
      const { usage, quota } = await sm.estimate();
      return { usage: usage || 0, quota: quota || 0 };
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Init / reset
  // ---------------------------------------------------------------------------

  /** Opens the DB, seeds it once, ensures the device secret, requests persistence. Idempotent. */
  function init() {
    if (!initPromise) {
      initPromise = (async () => {
        requireCrypto();
        await open();
        const seeded = await seedIfNeeded();
        await getDeviceSecret();
        const persisted = await requestPersistence();
        const user = await getCurrentUser();
        return { seeded, persisted, user };
      })().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    return initPromise;
  }

  /** Deletes the whole database (dev/testing). Call init() afterwards to re-seed. */
  async function reset() {
    if (dbPromise) {
      try {
        (await dbPromise).close();
      } catch (_) {
        /* ignore */
      }
    }
    dbPromise = null;
    initPromise = null;
    await new Promise((resolve, reject) => {
      const request = global.indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        console.warn('[db] Delete blocked: close other tabs that use this app.');
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  async function verify() {
    await init();
    const db = await open();
    const report = { ok: true, dbName: DB_NAME, version: db.version, stores: {}, checks: [] };

    function check(name, pass, detail) {
      report.checks.push({ check: name, pass: !!pass, detail: detail === undefined ? undefined : detail });
      if (!pass) report.ok = false;
    }

    const existing = Array.from(db.objectStoreNames);
    const readTx = db.transaction(existing, 'readonly');
    SCHEMA.forEach((def) => {
      if (!existing.includes(def.name)) return;
      report.stores[def.name] = {
        indexes: Array.from(readTx.objectStore(def.name).indexNames)
      };
    });

    for (const def of SCHEMA) {
      const present = existing.includes(def.name);
      check('store "' + def.name + '" exists', present);
      if (!present) continue;
      report.stores[def.name].count = await count(def.name);
      const have = report.stores[def.name].indexes;
      const missing = def.indexes.map((i) => i.name).filter((n) => !have.includes(n));
      check('store "' + def.name + '" has all indexes', missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : undefined);
    }

    check('products seeded', (report.stores[STORES.PRODUCTS] || {}).count >= CATALOG.length, (report.stores[STORES.PRODUCTS] || {}).count);
    check('activation codes seeded', (report.stores[STORES.CODES] || {}).count >= TEST_ACTIVATION_CODES.length, (report.stores[STORES.CODES] || {}).count);

    const user = await getCurrentUser();
    check('default user present', user && user.id === DEFAULT_USER.id, user ? user.username : null);

    const secret = await getDeviceSecret();
    check('device master secret is 32 bytes', secret instanceof Uint8Array && secret.length === 32);

    const codes = await getAll(STORES.CODES);
    check('activation codes are stored as 64-char SHA-256 hashes only', codes.every((c) => /^[0-9a-f]{64}$/.test(c.code_hash)));

    const sample = TEST_ACTIVATION_CODES[0];
    const sampleHash = await requireCrypto().hashActivationCode(sample.code);
    const sampleRec = await get(STORES.CODES, sampleHash);
    check('test code hash resolves to its product', sampleRec && sampleRec.product_id === sample.product_id);

    report.storage = await getStorageEstimate();
    report.persistent = !!(global.navigator && global.navigator.storage && global.navigator.storage.persisted && (await global.navigator.storage.persisted()));
    return report;
  }

  /** Integration test: crypto + IndexedDB together. Cleans up after itself. */
  async function selfTest() {
    await init();
    const crypto = requireCrypto();
    const results = [];

    function assert(cond, msg) {
      if (!cond) throw new Error(msg);
    }
    async function check(name, fn) {
      try {
        await fn();
        results.push({ test: name, pass: true });
      } catch (err) {
        results.push({ test: name, pass: false, detail: String((err && err.message) || err) });
      }
    }

    await check('Vault round trip: encrypt -> IndexedDB -> read -> decrypt', async () => {
      const productId = 'selftest_product';
      const secret = await getDeviceSecret();
      const key = await crypto.deriveContentKey({
        masterSecret: secret,
        productId: productId,
        licenseKey: crypto.generateLicenseKey()
      });
      const plain = crypto.randomBytes(50000);
      const record = await crypto.sealMedia(plain, key, { productId: productId, mimeType: 'audio/wav' });
      try {
        await put(STORES.VAULT, record);
        const stored = await get(STORES.VAULT, productId);
        assert(stored && stored.encrypted_audio_blob.byteLength === plain.length + 16, 'stored ciphertext missing or wrong size');
        const opened = new Uint8Array(await crypto.openMedia(stored, key));
        assert(crypto.bytesEqual(opened, plain), 'decrypted bytes differ');
      } finally {
        await remove(STORES.VAULT, productId);
      }
    });

    await check('Unique index blocks a second license for the same user+product', async () => {
      const base = {
        user_id: 'selftest_user',
        product_id: 'selftest_product',
        purchase_id: 'selftest_purchase',
        license_key: 'LIC-TEST',
        granted_at: Date.now(),
        status: LICENSE_STATUS.ACTIVE
      };
      try {
        await add(STORES.LICENSES, Object.assign({ id: 'selftest_license_1' }, base));
        let blocked = false;
        try {
          await add(STORES.LICENSES, Object.assign({ id: 'selftest_license_2' }, base));
        } catch (err) {
          blocked = !!err && err.name === 'ConstraintError';
        }
        assert(blocked, 'duplicate license was accepted');
      } finally {
        await remove(STORES.LICENSES, 'selftest_license_1');
        await remove(STORES.LICENSES, 'selftest_license_2');
      }
    });

    await check('Failed transaction rolls back completely', async () => {
      const marker = { key: 'selftest_marker', value: 1, updated_at: Date.now() };
      let failed = false;
      try {
        await transact(STORES.META, 'readwrite', async (s) => {
          await req(s[STORES.META].put(marker));
          throw new Error('forced failure');
        });
      } catch (_) {
        failed = true;
      }
      assert(failed, 'transaction should have rejected');
      assert((await get(STORES.META, 'selftest_marker')) === null, 'partial write was not rolled back');
    });

    return { ok: results.every((r) => r.pass), results };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  Vault.db = Object.freeze({
    DB_NAME,
    DB_VERSION,
    STORES,
    LICENSE_STATUS,
    DEFAULT_USER_ID: DEFAULT_USER.id,
    TEST_ACTIVATION_CODES,
    // lifecycle
    open,
    init,
    reset,
    // transactions + CRUD
    transact,
    req,
    get,
    getAll,
    getFromIndex,
    getAllFromIndex,
    put,
    add,
    remove,
    count,
    clear,
    // domain helpers
    getDeviceSecret,
    getCurrentUser,
    // durability
    requestPersistence,
    getStorageEstimate,
    // diagnostics
    verify,
    selfTest
  });
})(typeof window !== 'undefined' ? window : globalThis);
