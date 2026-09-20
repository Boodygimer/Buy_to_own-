/**
 * src/services/media.js  -  Media service (Phase 2)
 *
 * Classic script. Load order:
 *   src/crypto.js -> src/db.js -> src/services/ownership.js -> src/services/media.js
 * Exposes: window.Vault.media
 *
 * Pipeline (each step is a separate, explicit call):
 *   owned license  ->  cacheProduct()  ->  encrypted record in media_vault
 *                  ->  openForPlayback()  ->  decrypted in-memory blob: URL lease
 *
 *  - cacheProduct()      requires an ACTIVE license (re-checked inside the write
 *                        transaction), obtains the audio (offline synth:// or
 *                        fetch), encrypts it with a per-license AES-GCM key and
 *                        stores ciphertext only.
 *  - openForPlayback()   re-verifies the license on every call, so a file that
 *                        exists in the vault is NOT playable without ownership.
 *                        Plaintext exists only in memory, behind a temporary
 *                        object URL that the caller releases via lease.revoke().
 *
 * Synthetic audio: `synth://<id>?root=<Hz>&scale=<name>&bpm=<n>&bars=<n>&wave=<name>&seed=<n>`
 * renders a deterministic 22.05 kHz mono 16-bit WAV (bass, pads, lead, drums)
 * in plain JavaScript: same URL => byte-identical audio, no network, no
 * AudioContext (so it also works before a user gesture and in tests).
 */
(function (global) {
  'use strict';

  const Vault = (global.Vault = global.Vault || {});
  if (!Vault.crypto || !Vault.db || !Vault.ownership) {
    throw new Error('Load crypto.js, db.js and services/ownership.js before services/media.js.');
  }

  const vcrypto = Vault.crypto;
  const db = Vault.db;
  const ownership = Vault.ownership;
  const req = db.req;
  const S = db.STORES;

  const SAMPLE_RATE = 22050;
  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    pentatonic: [0, 2, 4, 7, 9]
  };
  const WAVES = ['sine', 'triangle', 'square', 'sawtooth'];
  // Chord roots as scale-degree indexes, one chord per bar.
  const PROGRESSIONS = [
    [0, 5, 3, 4],
    [0, 3, 4, 3],
    [0, 4, 5, 3],
    [0, 2, 3, 4]
  ];
  const LEAD_STEPS = [-2, -1, -1, 0, 1, 1, 2];

  class MediaError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'MediaError';
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  // ---------------------------------------------------------------------------
  // Events: 'cached', 'evicted'
  // ---------------------------------------------------------------------------

  const listeners = {};

  function on(eventName, handler) {
    (listeners[eventName] = listeners[eventName] || new Set()).add(handler);
    return function off() {
      listeners[eventName].delete(handler);
    };
  }

  function emit(eventName, payload) {
    const set = listeners[eventName];
    if (!set) return;
    set.forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        console.error('[media] listener error for "' + eventName + '"', err);
      }
    });
  }

  function requireString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new MediaError('BAD_INPUT', name + ' is required.');
    }
  }

  const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

  // ===========================================================================
  // 1. Synthetic audio
  // ===========================================================================

  function readNumber(query, key, min, max, integer) {
    const raw = query.get(key);
    if (raw === null || raw.trim() === '') {
      throw new MediaError('BAD_SOURCE', 'synth:// URL is missing "' + key + '".');
    }
    const value = Number(raw);
    if (!isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new MediaError('BAD_SOURCE', 'synth:// "' + key + '" must be ' + (integer ? 'an integer ' : 'a number ') + 'from ' + min + ' to ' + max + '.');
    }
    return value;
  }

  /**
   * @returns {{id: string, root: number, scale: string, bpm: number, bars: number, wave: string, seed: number}}
   * @throws MediaError('BAD_SOURCE')
   */
  function parseSynthUrl(url) {
    const match = /^synth:\/\/([A-Za-z0-9_.-]+)\?(.+)$/.exec(String(url));
    if (!match) throw new MediaError('BAD_SOURCE', 'Not a valid synth:// URL.');
    const query = new URLSearchParams(match[2]);
    const scale = query.get('scale');
    const wave = query.get('wave');
    if (!Object.prototype.hasOwnProperty.call(SCALES, scale)) {
      throw new MediaError('BAD_SOURCE', 'Unknown synth scale "' + scale + '".');
    }
    if (WAVES.indexOf(wave) === -1) {
      throw new MediaError('BAD_SOURCE', 'Unknown synth wave "' + wave + '".');
    }
    return {
      id: match[1],
      root: readNumber(query, 'root', 40, 1200, false),
      scale: scale,
      bpm: readNumber(query, 'bpm', 40, 220, false),
      bars: readNumber(query, 'bars', 1, 64, true),
      wave: wave,
      seed: readNumber(query, 'seed', 0, 4294967295, true)
    };
  }

  // Deterministic PRNG (mulberry32).
  function mulberry32(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function osc(wave, p) {
    switch (wave) {
      case 'sine':
        return Math.sin(2 * Math.PI * p);
      case 'triangle':
        return 4 * Math.abs(p - 0.5) - 1;
      case 'square':
        return p < 0.5 ? 1 : -1;
      default:
        return 2 * p - 1;
    }
  }

  function degreeFreq(root, scale, degree) {
    const n = scale.length;
    const octave = Math.floor(degree / n);
    const index = ((degree % n) + n) % n;
    return root * Math.pow(2, (scale[index] + 12 * octave) / 12);
  }

  const PAD_ENV = { a: 0.25, d: 0.3, s: 0.7, r: 0.4 };
  const BASS_ENV = { a: 0.01, d: 0.12, s: 0.7, r: 0.08 };
  const LEAD_ENV = { a: 0.01, d: 0.08, s: 0.6, r: 0.06 };
  const LEAD_LONG_ENV = { a: 0.02, d: 0.2, s: 0.7, r: 0.5 };

  /** Mixes one enveloped oscillator note into buf (clipped at the buffer end). */
  function addTone(buf, start, len, freq, amp, wave, env) {
    const end = Math.min(buf.length, start + len);
    if (len <= 0 || start >= end) return;
    const inc = freq / SAMPLE_RATE;
    const attack = Math.max(1, env.a * SAMPLE_RATE);
    const decay = Math.max(1, env.d * SAMPLE_RATE);
    const release = Math.max(1, Math.min(env.r * SAMPLE_RATE, len));
    const releaseStart = len - release;
    let phase = 0;
    for (let i = 0, n = end - start; i < n; i++) {
      let e;
      if (i < attack) e = i / attack;
      else if (i < attack + decay) e = 1 - (1 - env.s) * ((i - attack) / decay);
      else e = env.s;
      if (i > releaseStart) e *= Math.max(0, (len - i) / release);
      buf[start + i] += amp * e * osc(wave, phase);
      phase += inc;
      if (phase >= 1) phase -= 1;
    }
  }

  function addKick(buf, start, amp) {
    const len = Math.min(Math.round(0.2 * SAMPLE_RATE), buf.length - start);
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      phase += (45 + 90 * Math.exp(-t * 35)) / SAMPLE_RATE;
      buf[start + i] += amp * Math.sin(2 * Math.PI * phase) * Math.exp(-t * 22);
    }
  }

  function addSnare(buf, start, amp, noise) {
    const len = Math.min(Math.round(0.16 * SAMPLE_RATE), buf.length - start);
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      const body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 35) * 0.5;
      const hiss = (noise() * 2 - 1) * Math.exp(-t * 26);
      buf[start + i] += amp * (body + hiss);
    }
  }

  function addHat(buf, start, amp, noise) {
    const len = Math.min(Math.round(0.05 * SAMPLE_RATE), buf.length - start);
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      const cur = noise() * 2 - 1;
      buf[start + i] += amp * (cur - prev) * Math.exp(-t * 90);
      prev = cur;
    }
  }

  /** Renders the composition to mono Float32 samples. Yields to the UI between bars. */
  async function renderSynth(p, onProgress) {
    const beat = (SAMPLE_RATE * 60) / p.bpm;
    const eighth = beat / 2;
    const barLen = beat * 4;
    const total = Math.round(barLen * p.bars);
    const master = new Float32Array(total);
    const lead = new Float32Array(total);
    const scale = SCALES[p.scale];
    const n = scale.length;
    const rng = mulberry32(p.seed);
    const noise = mulberry32(p.seed ^ 0x9e3779b9);
    const progression = PROGRESSIONS[Math.floor(rng() * PROGRESSIONS.length)];
    const bassWave = p.wave === 'sine' ? 'sine' : 'triangle';
    let leadPos = n + Math.floor(rng() * 3);

    for (let bar = 0; bar < p.bars; bar++) {
      const barStart = Math.round(bar * barLen);
      const last = bar === p.bars - 1;
      const chord = progression[bar % progression.length];

      // Pad: a stacked triad (scale thirds), one chord per bar.
      [0, 2, 4].forEach((step) => {
        addTone(master, barStart, Math.round(barLen), degreeFreq(p.root, scale, chord + step), 0.06, 'sine', PAD_ENV);
      });

      // Bass: chord root one octave down. Random rolls are always consumed in the same order.
      const rollA = rng();
      const rollB = rng();
      const bassFreq = degreeFreq(p.root, scale, chord) / 2;
      if (last) {
        addTone(master, barStart, Math.round(barLen * 0.9), bassFreq, 0.26, bassWave, BASS_ENV);
      } else {
        addTone(master, barStart, Math.round(eighth * 3.2), bassFreq, 0.26, bassWave, BASS_ENV);
        addTone(master, Math.round(barStart + eighth * 4), Math.round(eighth * 3.2), bassFreq, 0.26, bassWave, BASS_ENV);
        if (rollA < 0.5) addTone(master, Math.round(barStart + eighth * 3), Math.round(eighth * 1.6), bassFreq, 0.26, bassWave, BASS_ENV);
        if (rollB < 0.5) addTone(master, Math.round(barStart + eighth * 6), Math.round(eighth * 1.6), bassFreq, 0.26, bassWave, BASS_ENV);
      }

      // Lead: random walk over the scale; final bar resolves to the root.
      for (let step = 0; step < 8; step++) {
        const restRoll = rng();
        const move = LEAD_STEPS[Math.floor(rng() * LEAD_STEPS.length)];
        const longRoll = rng();
        const noteStart = Math.round(barStart + step * eighth);
        if (last) {
          if (step === 0) {
            addTone(lead, noteStart, Math.round(barLen * 0.9), degreeFreq(p.root, scale, n), 0.18, p.wave, LEAD_LONG_ENV);
          }
          continue;
        }
        if (step !== 0 && restRoll < 0.22) continue;
        leadPos = Math.max(n - 1, Math.min(2 * n + 1, leadPos + move));
        addTone(
          lead,
          noteStart,
          Math.round(eighth * (longRoll < 0.35 ? 1.9 : 0.9)),
          degreeFreq(p.root, scale, leadPos),
          0.16,
          p.wave,
          LEAD_ENV
        );
      }

      // Drums: intro bar and final bar stay light.
      const drumsOn = p.bars <= 2 || (bar >= 1 && !last);
      for (let b = 0; b < 4; b++) {
        const beatStart = Math.round(barStart + b * beat);
        if (last) {
          if (b === 0) addKick(master, beatStart, 0.5);
          continue;
        }
        if (!drumsOn) continue;
        if (b === 0 || b === 2 || p.bpm >= 110) addKick(master, beatStart, 0.5);
        if (b === 1 || b === 3) addSnare(master, beatStart, 0.22, noise);
        addHat(master, beatStart, 0.05, noise);
        addHat(master, Math.round(beatStart + eighth), 0.03, noise);
      }

      if (onProgress) onProgress((bar + 1) / p.bars);
      if (bar % 2 === 1) await yieldToUI();
    }

    // Soften the lead (one-pole low-pass ~3.2 kHz) and mix it in.
    const alpha = 1 - Math.exp((-2 * Math.PI * 3200) / SAMPLE_RATE);
    let y = 0;
    for (let i = 0; i < total; i++) {
      y += alpha * (lead[i] - y);
      master[i] += y;
    }

    // Normalize, fade in/out.
    let peak = 0;
    for (let i = 0; i < total; i++) {
      const a = Math.abs(master[i]);
      if (a > peak) peak = a;
    }
    const gain = peak > 0 ? 0.85 / peak : 1;
    const fadeIn = Math.min(Math.round(0.03 * SAMPLE_RATE), total);
    const fadeOut = Math.min(SAMPLE_RATE, Math.floor(total / 4));
    for (let i = 0; i < total; i++) {
      let g = gain;
      if (i < fadeIn) g *= i / fadeIn;
      const fromEnd = total - 1 - i;
      if (fromEnd < fadeOut) g *= fromEnd / fadeOut;
      master[i] *= g;
    }
    return master;
  }

  function encodeWav(samples, sampleRate) {
    const n = samples.length;
    const bytes = new Uint8Array(44 + n * 2);
    const view = new DataView(bytes.buffer);
    const writeText = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
    }
    return bytes;
  }

  /**
   * Validates a 16-bit PCM WAV and measures it.
   * @returns {{ok: boolean, error?: string, sampleRate?: number, channels?: number, bitsPerSample?: number,
   *            dataBytes?: number, durationSec?: number, peak?: number, rms?: number}}
   */
  function inspectWav(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 44) return { ok: false, error: 'too short' };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') {
      return { ok: false, error: 'missing RIFF/WAVE/fmt/data markers' };
    }
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    const dataBytes = view.getUint32(40, true);
    if (view.getUint16(20, true) !== 1 || bitsPerSample !== 16 || dataBytes !== bytes.length - 44) {
      return { ok: false, error: 'not 16-bit PCM or size mismatch' };
    }
    const count = dataBytes / 2;
    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < count; i++) {
      const v = view.getInt16(44 + i * 2, true) / 32768;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSquares += v * v;
    }
    return {
      ok: true,
      sampleRate: sampleRate,
      channels: channels,
      bitsPerSample: bitsPerSample,
      dataBytes: dataBytes,
      durationSec: count / channels / sampleRate,
      peak: peak,
      rms: count ? Math.sqrt(sumSquares / count) : 0
    };
  }

  /**
   * Renders a synth:// URL to a WAV file (deterministic).
   * @param {string} url
   * @param {{onProgress?: function(number)}} [options]  progress 0..1
   * @returns {Promise<{bytes: Uint8Array, mimeType: string, sampleRate: number, durationSec: number, params: object}>}
   */
  async function synthesize(url, options) {
    const params = parseSynthUrl(url);
    const samples = await renderSynth(params, options && options.onProgress);
    return {
      bytes: encodeWav(samples, SAMPLE_RATE),
      mimeType: 'audio/wav',
      sampleRate: SAMPLE_RATE,
      durationSec: samples.length / SAMPLE_RATE,
      params: params
    };
  }

  // ===========================================================================
  // 2. Source acquisition
  // ===========================================================================

  function guessMimeFromUrl(url) {
    const ext = (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(url)) || [])[1];
    const map = {
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      opus: 'audio/ogg',
      wav: 'audio/wav',
      flac: 'audio/flac',
      webm: 'audio/webm'
    };
    return map[(ext || '').toLowerCase()] || 'audio/mpeg';
  }

  /**
   * Gets raw audio bytes for a product source: synth:// renders offline,
   * anything else is downloaded with fetch() (needs CORS or same-origin).
   * @returns {Promise<{bytes: Uint8Array, mimeType: string, durationSec: number|null, origin: 'synth'|'network'}>}
   */
  async function fetchSource(url, options) {
    if (/^synth:/i.test(String(url))) {
      const rendered = await synthesize(url, options);
      return { bytes: rendered.bytes, mimeType: rendered.mimeType, durationSec: rendered.durationSec, origin: 'synth' };
    }
    if (typeof fetch !== 'function') throw new MediaError('FETCH_FAILED', 'fetch() is not available.');
    let response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new MediaError('FETCH_FAILED', 'Could not download the audio (offline or blocked by CORS).', String(err && err.message));
    }
    if (!response.ok) throw new MediaError('FETCH_FAILED', 'Audio download failed with HTTP ' + response.status + '.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new MediaError('FETCH_FAILED', 'Downloaded audio is empty.');
    const headerMime = ((response.headers && response.headers.get('content-type')) || '').split(';')[0].trim();
    const mimeType = headerMime.indexOf('audio/') === 0 ? headerMime : guessMimeFromUrl(url);
    return { bytes: bytes, mimeType: mimeType, durationSec: null, origin: 'network' };
  }

  // ===========================================================================
  // 3. Vault pipeline
  // ===========================================================================

  async function deriveKeyFor(license) {
    return vcrypto.deriveContentKey({
      masterSecret: await db.getDeviceSecret(),
      productId: license.product_id,
      licenseKey: license.license_key
    });
  }

  async function isCached(productId) {
    requireString(productId, 'productId');
    const found = await db.transact(S.VAULT, 'readonly', (s) => req(s[S.VAULT].count(productId)));
    return found > 0;
  }

  function listCachedIds() {
    return db.transact(S.VAULT, 'readonly', (s) => req(s[S.VAULT].getAllKeys()));
  }

  /**
   * Where does this item stand in the pipeline?
   * state: 'not_owned' | 'owned_not_cached' | 'ready'
   */
  async function getAvailability(options) {
    const { userId, productId } = options || {};
    requireString(userId, 'userId');
    requireString(productId, 'productId');
    const verdict = await ownership.verifyLicense({ userId, productId });
    const cached = await isCached(productId);
    let state = 'not_owned';
    if (verdict.licensed) state = cached ? 'ready' : 'owned_not_cached';
    return { state: state, licensed: verdict.licensed, reason: verdict.reason, cached: cached };
  }

  const inflightCaches = new Map();

  /**
   * Downloads/renders, encrypts and stores a product in the vault.
   * Concurrent calls for the same item share one job.
   * @param {{userId: string, productId: string, force?: boolean,
   *          onProgress?: function(string, number)}} options   stage: 'checking'|'rendering'|'encrypting'|'saving'|'done'
   * @returns {Promise<{status: 'cached'|'already_cached', productId: string, sizeBytes?: number,
   *                    durationSec?: number|null, mimeType?: string}>}
   * @throws OwnershipError NOT_LICENSED, MediaError NO_SUCH_PRODUCT | BAD_SOURCE | FETCH_FAILED
   */
  function cacheProduct(options) {
    const { userId, productId } = options || {};
    requireString(userId, 'userId');
    requireString(productId, 'productId');
    const jobKey = userId + '|' + productId;
    if (inflightCaches.has(jobKey)) return inflightCaches.get(jobKey);
    const job = runCache(options).finally(() => {
      inflightCaches.delete(jobKey);
    });
    inflightCaches.set(jobKey, job);
    return job;
  }

  async function runCache(options) {
    const { userId, productId, force, onProgress } = options;
    const progress = (stage, fraction) => {
      if (onProgress) onProgress(stage, fraction);
    };

    progress('checking', 0);
    const { license } = await ownership.assertLicensed({ userId, productId });
    const product = await db.get(S.PRODUCTS, productId);
    if (!product) throw new MediaError('NO_SUCH_PRODUCT', 'This product is no longer in the catalog.');

    if (!force && (await isCached(productId))) {
      progress('done', 1);
      return { status: 'already_cached', productId: productId };
    }

    const source = await fetchSource(product.media_source_url, {
      onProgress: (fraction) => progress('rendering', fraction)
    });

    progress('encrypting', 0);
    const key = await deriveKeyFor(license);
    const record = await vcrypto.sealMedia(source.bytes, key, { productId: productId, mimeType: source.mimeType });
    record.license_id = license.id;
    record.size_bytes = source.bytes.length;
    record.duration_sec = source.durationSec;

    progress('saving', 0);
    await db.transact([S.LICENSES, S.VAULT], 'readwrite', async (s) => {
      // The license may have been revoked while we were rendering: check again, atomically with the write.
      const current = await req(s[S.LICENSES].get(license.id));
      if (!current || current.status !== ownership.LICENSE_STATUS.ACTIVE) {
        throw new ownership.OwnershipError('NOT_LICENSED', 'The license was revoked while caching.', { reason: 'revoked' });
      }
      await req(s[S.VAULT].put(record));
    });

    progress('done', 1);
    const summary = {
      status: 'cached',
      productId: productId,
      sizeBytes: record.size_bytes,
      durationSec: record.duration_sec,
      mimeType: record.mime_type
    };
    emit('cached', summary);
    return summary;
  }

  /** Removes the encrypted copy only. The license and purchase are untouched. */
  async function evict(productId) {
    requireString(productId, 'productId');
    await db.remove(S.VAULT, productId);
    emit('evicted', { productId: productId });
  }

  // ===========================================================================
  // 4. Playback provider
  // ===========================================================================

  const activeLeases = new Set();

  /**
   * Verifies the license, decrypts the cached audio in memory and returns a
   * temporary object URL. Always call lease.revoke() when finished.
   *
   * @param {{userId: string, productId: string, autoCache?: boolean}} options
   *   autoCache: if the vault copy is missing, stale or corrupt, (re)build it once and retry.
   * @returns {Promise<{url: string, mimeType: string, productId: string, product: object|null,
   *                    durationSec: number|null, revoke: function}>}
   * @throws OwnershipError NOT_LICENSED; MediaError NOT_CACHED | VAULT_CORRUPT
   */
  async function openForPlayback(options) {
    const { userId, productId, autoCache } = options || {};
    requireString(userId, 'userId');
    requireString(productId, 'productId');

    let repaired = false;
    for (;;) {
      // 1) Ownership registry decides. The vault is never consulted first.
      const { license } = await ownership.assertLicensed({ userId, productId });

      // 2) Vault copy must exist and belong to this license.
      const record = await db.get(S.VAULT, productId);
      const usable = record && (!record.license_id || record.license_id === license.id);
      if (!usable) {
        if (autoCache && !repaired) {
          repaired = true;
          await cacheProduct({ userId, productId, force: true });
          continue;
        }
        throw new MediaError('NOT_CACHED', 'This item is owned but not cached on this device yet.');
      }

      // 3) Decrypt in memory.
      let opened;
      try {
        opened = await vcrypto.openMediaAsObjectURL(record, await deriveKeyFor(license));
      } catch (err) {
        if (err && err.code === 'DECRYPT_FAILED') {
          if (autoCache && !repaired) {
            repaired = true;
            await cacheProduct({ userId, productId, force: true });
            continue;
          }
          throw new MediaError('VAULT_CORRUPT', 'The cached copy is damaged or does not match your license. Cache it again.');
        }
        throw err;
      }

      const product = await db.get(S.PRODUCTS, productId);
      const lease = {
        url: opened.url,
        mimeType: opened.mimeType,
        productId: productId,
        product: product,
        durationSec: record.duration_sec || (product && product.duration_sec) || null,
        revoke() {
          opened.revoke();
          activeLeases.delete(lease);
        }
      };
      activeLeases.add(lease);
      return lease;
    }
  }

  /** Revokes every open object URL (e.g. on sign-out or when the player is closed). */
  function releaseAll() {
    Array.from(activeLeases).forEach((lease) => lease.revoke());
  }

  function activeLeaseCount() {
    return activeLeases.size;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  Vault.media = Object.freeze({
    MediaError,
    SAMPLE_RATE,
    on,
    // synthetic audio
    parseSynthUrl,
    synthesize,
    inspectWav,
    fetchSource,
    // vault pipeline
    getAvailability,
    isCached,
    listCachedIds,
    cacheProduct,
    evict,
    // playback
    openForPlayback,
    releaseAll,
    activeLeaseCount
  });
})(typeof window !== 'undefined' ? window : globalThis);
