/**
 * src/crypto.js  -  Cryptographic service (Phase 1)
 *
 * Classic script (no ES modules) so it also runs from file:// in mobile browsers.
 * Load order:  src/crypto.js  ->  src/db.js  ->  (later) services / UI.
 * Exposes:     window.Vault.crypto
 *
 * What it provides
 *  - SHA-256 hashing (activation codes are only ever stored/compared as hashes)
 *  - AES-GCM 256-bit encryption/decryption of media, with authenticated binding
 *    of every ciphertext to its product id + mime type (AAD)
 *  - HKDF-SHA256 derivation of a per-license content key from
 *    (device master secret + product id + license key) => the vault is useless
 *    without a matching ownership license record
 *  - Random id / license key / transaction reference generators
 *
 * HONEST SCOPE: this is a local proof-of-concept DRM. The device master secret
 * lives in IndexedDB, so anyone with devtools access to the device can recover
 * keys. It protects against casual copying of files, not a determined attacker.
 */
(function (global) {
  'use strict';

  const Vault = (global.Vault = global.Vault || {});

  const AES_KEY_BITS = 256;
  const GCM_IV_BYTES = 12;
  const GCM_TAG_BITS = 128;
  const MASTER_SECRET_BYTES = 32;
  const CODE_HASH_PREFIX = 'odp.activation.v1:';
  const HKDF_SALT_LABEL = 'odp.vault.salt.v1';
  const HKDF_INFO_PREFIX = 'odp.vault.key.v1|';
  const MEDIA_AAD_PREFIX = 'odp.media.v1|';
  // No 0/O/1/I so keys are easy to read and type on a phone.
  const LICENSE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const TXN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  class VaultCryptoError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'VaultCryptoError';
      this.code = code;
    }
  }

  // ---------------------------------------------------------------------------
  // Environment
  // ---------------------------------------------------------------------------

  function getCrypto() {
    const c = global.crypto;
    if (!c || !c.subtle || typeof c.getRandomValues !== 'function') {
      throw new VaultCryptoError(
        'UNSUPPORTED',
        'Web Crypto is unavailable. Serve the app from https://, http://localhost, or open it in a current browser.'
      );
    }
    return c;
  }

  function isSupported() {
    try {
      getCrypto();
      return true;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Byte / encoding helpers
  // ---------------------------------------------------------------------------

  function isArrayBuffer(x) {
    return Object.prototype.toString.call(x) === '[object ArrayBuffer]';
  }

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  function blobToArrayBuffer(blob) {
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  }

  /** Normalizes string | ArrayBuffer | TypedArray | Blob into a Uint8Array. */
  async function toBytes(data) {
    if (typeof data === 'string') return utf8(data);
    if (isArrayBuffer(data)) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return new Uint8Array(await blobToArrayBuffer(data));
    }
    throw new VaultCryptoError('BAD_INPUT', 'Expected a string, ArrayBuffer, typed array, or Blob.');
  }

  function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
      throw new VaultCryptoError('BAD_INPUT', 'Invalid hex string.');
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  /** Constant-time-ish string comparison (used for hash comparison). */
  function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // ---------------------------------------------------------------------------
  // Randomness & identifiers
  // ---------------------------------------------------------------------------

  function randomBytes(length) {
    if (!Number.isInteger(length) || length < 1 || length > 65536) {
      throw new VaultCryptoError('BAD_INPUT', 'randomBytes length must be an integer from 1 to 65536.');
    }
    const out = new Uint8Array(length);
    getCrypto().getRandomValues(out);
    return out;
  }

  /** Unbiased random string via rejection sampling. */
  function randomString(length, alphabet) {
    const n = alphabet.length;
    const limit = 256 - (256 % n);
    let out = '';
    while (out.length < length) {
      const bytes = randomBytes(Math.max(16, (length - out.length) * 2));
      for (let i = 0; i < bytes.length && out.length < length; i++) {
        if (bytes[i] < limit) out += alphabet[bytes[i] % n];
      }
    }
    return out;
  }

  function newUUID() {
    const c = getCrypto();
    if (typeof c.randomUUID === 'function') return c.randomUUID();
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = bytesToHex(b);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /** e.g. newId('purchase') -> "purchase_3b1f...". */
  function newId(prefix) {
    return (prefix ? prefix + '_' : '') + newUUID();
  }

  /** e.g. "LIC-7KQ2-M9XD-4HBR-EY3N" (~79 bits of entropy). */
  function generateLicenseKey() {
    return 'LIC-' + randomString(16, LICENSE_ALPHABET).match(/.{4}/g).join('-');
  }

  /** e.g. "TXN-LZ4K9A-7KQ2MX" (time-ordered prefix + random suffix). */
  function generateTransactionRef() {
    return 'TXN-' + Date.now().toString(36).toUpperCase() + '-' + randomString(6, TXN_ALPHABET);
  }

  // ---------------------------------------------------------------------------
  // Hashing
  // ---------------------------------------------------------------------------

  async function sha256Bytes(data) {
    const digest = await getCrypto().subtle.digest('SHA-256', await toBytes(data));
    return new Uint8Array(digest);
  }

  async function sha256Hex(data) {
    return bytesToHex(await sha256Bytes(data));
  }

  /**
   * Canonical form of a code: NFKC, upper-case, letters and digits only.
   * "nhzn-4k7q m9xd" and "NHZN4K7QM9XD" are the same code.
   */
  function normalizeActivationCode(input) {
    if (typeof input !== 'string') {
      throw new VaultCryptoError('BAD_CODE', 'Activation code must be a string.');
    }
    const normalized = input.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length < 8) {
      throw new VaultCryptoError('BAD_CODE', 'Activation code is too short.');
    }
    return normalized;
  }

  /** SHA-256 hex of the domain-separated, normalized code. This is what is stored. */
  async function hashActivationCode(input) {
    return sha256Hex(CODE_HASH_PREFIX + normalizeActivationCode(input));
  }

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  /** 32 random bytes; created once per device and kept by db.js. */
  function generateMasterSecret() {
    return randomBytes(MASTER_SECRET_BYTES);
  }

  /**
   * Derives a non-extractable AES-GCM-256 key bound to one license:
   *   HKDF-SHA256(masterSecret, salt, info = productId | licenseKey)
   * Same inputs => same key (deterministic), so playback can re-derive it.
   */
  async function deriveContentKey(options) {
    const { masterSecret, productId, licenseKey } = options || {};
    if (!(masterSecret instanceof Uint8Array) || masterSecret.length !== MASTER_SECRET_BYTES) {
      throw new VaultCryptoError('BAD_INPUT', 'masterSecret must be a 32-byte Uint8Array.');
    }
    if (!productId || !licenseKey) {
      throw new VaultCryptoError('BAD_INPUT', 'productId and licenseKey are required.');
    }
    const subtle = getCrypto().subtle;
    const material = await subtle.importKey('raw', masterSecret, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: utf8(HKDF_SALT_LABEL),
        info: utf8(HKDF_INFO_PREFIX + productId + '|' + licenseKey)
      },
      material,
      { name: 'AES-GCM', length: AES_KEY_BITS },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ---------------------------------------------------------------------------
  // AES-GCM
  // ---------------------------------------------------------------------------

  async function gcmParams(iv, aad) {
    const params = { name: 'AES-GCM', iv: iv, tagLength: GCM_TAG_BITS };
    if (aad !== undefined && aad !== null) params.additionalData = await toBytes(aad);
    return params;
  }

  /**
   * Encrypts data with a fresh random 96-bit IV.
   * @returns {{ciphertext: ArrayBuffer, iv: Uint8Array}}  (ciphertext includes the GCM tag)
   */
  async function encrypt(data, key, aad) {
    const plain = await toBytes(data);
    const iv = randomBytes(GCM_IV_BYTES);
    const params = await gcmParams(iv, aad);
    const ciphertext = await getCrypto().subtle.encrypt(params, key, plain);
    return { ciphertext, iv };
  }

  /**
   * @returns {Promise<ArrayBuffer>} plaintext
   * @throws VaultCryptoError('DECRYPT_FAILED') on wrong key, wrong AAD, or tampered data
   */
  async function decrypt(ciphertext, iv, key, aad) {
    const ivBytes = await toBytes(iv);
    if (ivBytes.length !== GCM_IV_BYTES) {
      throw new VaultCryptoError('BAD_INPUT', 'IV must be 12 bytes.');
    }
    const ct = await toBytes(ciphertext);
    const params = await gcmParams(ivBytes, aad);
    try {
      return await getCrypto().subtle.decrypt(params, key, ct);
    } catch (_) {
      throw new VaultCryptoError(
        'DECRYPT_FAILED',
        'Decryption failed: wrong key, wrong license, or corrupted/tampered data.'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Media vault helpers (shape matches the `media_vault` object store)
  // ---------------------------------------------------------------------------

  function mediaAad(productId, mimeType) {
    return MEDIA_AAD_PREFIX + productId + '|' + mimeType;
  }

  /**
   * Encrypts audio and returns a record that can be put() straight into `media_vault`:
   * { product_id, encrypted_audio_blob (ArrayBuffer), iv (Uint8Array), mime_type, cached_at }
   */
  async function sealMedia(data, key, options) {
    const { productId, mimeType } = options || {};
    if (!productId) throw new VaultCryptoError('BAD_INPUT', 'productId is required.');
    const mime =
      mimeType ||
      (typeof Blob !== 'undefined' && data instanceof Blob && data.type) ||
      'application/octet-stream';
    const { ciphertext, iv } = await encrypt(data, key, mediaAad(productId, mime));
    return {
      product_id: productId,
      encrypted_audio_blob: ciphertext,
      iv: iv,
      mime_type: mime,
      cached_at: Date.now()
    };
  }

  /** Decrypts a `media_vault` record into an ArrayBuffer (in memory only). */
  async function openMedia(record, key) {
    if (!record || !record.encrypted_audio_blob || !record.iv || !record.product_id) {
      throw new VaultCryptoError('BAD_INPUT', 'Not a valid media_vault record.');
    }
    return decrypt(
      record.encrypted_audio_blob,
      record.iv,
      key,
      mediaAad(record.product_id, record.mime_type)
    );
  }

  /**
   * Decrypts into a temporary Object URL for an <audio> element.
   * Call revoke() when the track is no longer playing.
   */
  async function openMediaAsObjectURL(record, key) {
    const buffer = await openMedia(record, key);
    const url = URL.createObjectURL(new Blob([buffer], { type: record.mime_type }));
    return {
      url: url,
      mimeType: record.mime_type,
      revoke() {
        URL.revokeObjectURL(url);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Self-test (used by tests/phase1.html)
  // ---------------------------------------------------------------------------

  async function selfTest() {
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
    async function expectCode(fn, code) {
      let caught = null;
      try {
        await fn();
      } catch (e) {
        caught = e;
      }
      assert(caught && caught.code === code, 'expected ' + code + ' but got ' + (caught ? caught.code || caught.message : 'no error'));
    }

    await check('Web Crypto available', async () => {
      assert(isSupported(), 'crypto.subtle missing');
    });

    await check('SHA-256 known vector ("abc")', async () => {
      const h = await sha256Hex('abc');
      assert(h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'digest mismatch: ' + h);
    });

    await check('Activation code hashing ignores case, spaces and dashes', async () => {
      const a = await hashActivationCode('nhzn-4k7q-m9xd');
      const b = await hashActivationCode('  NHZN 4K7Q M9XD ');
      const c = await hashActivationCode('NHZN4K7QM9XE');
      assert(a === b, 'normalization mismatch');
      assert(a !== c && a.length === 64, 'different codes must hash differently');
    });

    const masterSecret = generateMasterSecret();
    const productId = 'selftest_product';
    const licenseKey = generateLicenseKey();
    const payload = randomBytes(60000);
    let key = null;
    let record = null;

    await check('License key format', async () => {
      assert(/^LIC(-[A-Z0-9]{4}){4}$/.test(licenseKey), 'bad format: ' + licenseKey);
    });

    await check('AES-GCM-256 round trip (seal -> open)', async () => {
      key = await deriveContentKey({ masterSecret, productId, licenseKey });
      record = await sealMedia(payload, key, { productId, mimeType: 'audio/wav' });
      assert(record.iv.length === GCM_IV_BYTES, 'IV must be 12 bytes');
      assert(record.encrypted_audio_blob.byteLength === payload.length + GCM_TAG_BITS / 8, 'ciphertext length');
      const opened = new Uint8Array(await openMedia(record, key));
      assert(bytesEqual(opened, payload), 'plaintext mismatch');
    });

    await check('Tampered ciphertext is rejected', async () => {
      const bad = new Uint8Array(record.encrypted_audio_blob.slice(0));
      bad[100] ^= 0xff;
      await expectCode(() => openMedia(Object.assign({}, record, { encrypted_audio_blob: bad.buffer }), key), 'DECRYPT_FAILED');
    });

    await check('Different license key cannot decrypt', async () => {
      const otherKey = await deriveContentKey({ masterSecret, productId, licenseKey: generateLicenseKey() });
      await expectCode(() => openMedia(record, otherKey), 'DECRYPT_FAILED');
    });

    await check('Ciphertext cannot be re-labelled as another product', async () => {
      await expectCode(() => openMedia(Object.assign({}, record, { product_id: 'other_product' }), key), 'DECRYPT_FAILED');
    });

    await check('Key derivation is deterministic', async () => {
      const again = await deriveContentKey({ masterSecret, productId, licenseKey });
      const opened = new Uint8Array(await openMedia(record, again));
      assert(bytesEqual(opened, payload), 'derived key differs');
    });

    return { ok: results.every((r) => r.pass), results };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  Vault.crypto = Object.freeze({
    VaultCryptoError,
    GCM_IV_BYTES,
    isSupported,
    // encoding
    bytesToHex,
    hexToBytes,
    bytesToBase64,
    base64ToBytes,
    bytesEqual,
    constantTimeEqual,
    // randomness / ids
    randomBytes,
    newId,
    generateLicenseKey,
    generateTransactionRef,
    // hashing
    sha256Bytes,
    sha256Hex,
    normalizeActivationCode,
    hashActivationCode,
    // keys + AES-GCM
    generateMasterSecret,
    deriveContentKey,
    encrypt,
    decrypt,
    // media vault
    sealMedia,
    openMedia,
    openMediaAsObjectURL,
    // diagnostics
    selfTest
  });
})(typeof window !== 'undefined' ? window : globalThis);
