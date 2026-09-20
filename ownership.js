/**
 * src/services/ownership.js  -  Purchase, license and activation service (Phase 2)
 *
 * Classic script. Load order:
 *   src/crypto.js -> src/db.js -> src/services/ownership.js -> src/services/media.js
 * Exposes: window.Vault.ownership
 *
 * Domain rules enforced here
 *  - A PURCHASE is a payment record. It does not make media available.
 *  - A LICENSE is the permission record. Every grant writes purchase + license
 *    in ONE transaction (all-or-nothing): no payment without license, and no
 *    license without a payment/activation record.
 *  - One license record per user+product (unique index). Revoking flips its
 *    status; buying/redeeming again re-activates the same record.
 *  - Each license carries a `binding` hash of (user, product, license id,
 *    license key). verifyLicense() recomputes it, so casual edits of the
 *    license record (e.g. swapping the key or product in devtools) are detected.
 *    This is an integrity check, not tamper-proof security: local data can
 *    always be rewritten by someone with full device access.
 *  - Activation codes are single-use and checked by hash only. A code is NOT
 *    consumed when the redemption fails (e.g. the user already owns the item).
 *
 * Every function takes a single options object and an explicit userId, so the
 * account layer stays decoupled from this service.
 */
(function (global) {
  'use strict';

  const Vault = (global.Vault = global.Vault || {});
  if (!Vault.crypto || !Vault.db) {
    throw new Error('Load src/crypto.js and src/db.js before src/services/ownership.js.');
  }

  const vcrypto = Vault.crypto;
  const db = Vault.db;
  const req = db.req;
  const S = db.STORES;
  const STATUS = db.LICENSE_STATUS;
  const BINDING_PREFIX = 'odp.license.binding.v1|';

  class OwnershipError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'OwnershipError';
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  // ---------------------------------------------------------------------------
  // Events (for UI refresh in Phase 3)
  //   'purchase', 'code-redeemed', 'license-granted', 'license-revoked'
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
        console.error('[ownership] listener error for "' + eventName + '"', err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function requireString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new OwnershipError('BAD_INPUT', name + ' is required.');
    }
  }

  function computeBinding(userId, productId, licenseId, licenseKey) {
    return vcrypto.sha256Hex(BINDING_PREFIX + [userId, productId, licenseId, licenseKey].join('|'));
  }

  /**
   * Everything that needs async crypto is prepared BEFORE the transaction opens
   * (awaiting crypto.subtle inside an IndexedDB transaction would auto-commit it).
   */
  async function prepareGrant(userId, productId) {
    const licenseId = vcrypto.newId('license');
    const licenseKey = vcrypto.generateLicenseKey();
    return {
      purchaseId: vcrypto.newId('purchase'),
      licenseId: licenseId,
      licenseKey: licenseKey,
      binding: await computeBinding(userId, productId, licenseId, licenseKey)
    };
  }

  function userProductIndex(store) {
    return store.index('user_product');
  }

  /** Writes purchase + license inside an open transaction. Only awaits IDB requests. */
  async function writeGrant(s, grant) {
    const now = Date.now();
    const purchase = {
      id: grant.material.purchaseId,
      user_id: grant.userId,
      product_id: grant.product.id,
      timestamp: now,
      transaction_ref: grant.transactionRef,
      method: grant.method,
      amount: grant.amount,
      currency: grant.product.currency || 'USD',
      code_hash: grant.codeHash || null
    };

    let license;
    if (grant.existing) {
      // Re-activation keeps the license id/key/binding (so a previously cached
      // vault copy stays valid) and only refreshes purchase link + status.
      license = Object.assign({}, grant.existing, {
        purchase_id: purchase.id,
        granted_at: now,
        status: STATUS.ACTIVE,
        revoked_at: null,
        revoke_reason: null
      });
    } else {
      license = {
        id: grant.material.licenseId,
        user_id: grant.userId,
        product_id: grant.product.id,
        purchase_id: purchase.id,
        license_key: grant.material.licenseKey,
        granted_at: now,
        status: STATUS.ACTIVE,
        binding: grant.material.binding
      };
    }

    await req(s[S.PURCHASES].add(purchase));
    await req(s[S.LICENSES].put(license));
    return { purchase: purchase, license: license, product: grant.product };
  }

  // ---------------------------------------------------------------------------
  // Catalog reads
  // ---------------------------------------------------------------------------

  async function getCatalog() {
    const products = await db.getAll(S.PRODUCTS);
    return products.sort((a, b) => a.title.localeCompare(b.title));
  }

  function getProduct(productId) {
    requireString(productId, 'productId');
    return db.get(S.PRODUCTS, productId);
  }

  // ---------------------------------------------------------------------------
  // Purchase (simulated payment)
  // ---------------------------------------------------------------------------

  /**
   * Simulated purchase: charges nothing, records a financial transaction and
   * grants a permanent license atomically.
   * @param {{userId: string, productId: string, simulateDelayMs?: number}} options
   * @returns {Promise<{purchase, license, product}>}
   * @throws OwnershipError NO_SUCH_USER | NO_SUCH_PRODUCT | ALREADY_OWNED
   */
  async function purchase(options) {
    const { userId, productId, simulateDelayMs } = options || {};
    requireString(userId, 'userId');
    requireString(productId, 'productId');
    if (simulateDelayMs > 0) await sleep(simulateDelayMs);

    const material = await prepareGrant(userId, productId);
    const transactionRef = vcrypto.generateTransactionRef();

    const result = await db.transact(
      [S.USERS, S.PRODUCTS, S.PURCHASES, S.LICENSES],
      'readwrite',
      async (s) => {
        const user = await req(s[S.USERS].get(userId));
        if (!user) throw new OwnershipError('NO_SUCH_USER', 'Unknown user.');
        const product = await req(s[S.PRODUCTS].get(productId));
        if (!product) throw new OwnershipError('NO_SUCH_PRODUCT', 'This product is not in the catalog.');
        const existing = await req(userProductIndex(s[S.LICENSES]).get([userId, productId]));
        if (existing && existing.status === STATUS.ACTIVE) {
          throw new OwnershipError('ALREADY_OWNED', 'You already own "' + product.title + '".');
        }
        return writeGrant(s, {
          userId: userId,
          product: product,
          method: 'simulated_payment',
          transactionRef: transactionRef,
          amount: product.price,
          existing: existing || null,
          material: material
        });
      }
    );

    emit('purchase', result);
    emit('license-granted', result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Activation codes
  // ---------------------------------------------------------------------------

  /**
   * Extracts a code from scanner output. Accepts a bare code ("NHZN-4K7Q-M9XD")
   * or a URL-ish payload containing code=... (e.g. "odp://redeem?code=NHZN-4K7Q-M9XD").
   * @returns {string|null} candidate code, or null if nothing usable was found
   */
  function parseScannedPayload(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/[?&#]code=([^&#\s]+)/i);
    let candidate = trimmed;
    if (match) {
      try {
        candidate = decodeURIComponent(match[1]);
      } catch (_) {
        candidate = match[1];
      }
    }
    try {
      vcrypto.normalizeActivationCode(candidate);
      return candidate;
    } catch (_) {
      return null;
    }
  }

  /**
   * Redeems a single-use activation code offline (hash lookup only).
   * Failure messages are deliberately generic: they never reveal whether a
   * code exists for a different product.
   * @throws OwnershipError INVALID_CODE | CODE_ALREADY_REDEEMED | ALREADY_OWNED | NO_SUCH_USER | NO_SUCH_PRODUCT
   */
  async function redeemCode(options) {
    const { userId, code } = options || {};
    requireString(userId, 'userId');

    let codeHash;
    try {
      codeHash = await vcrypto.hashActivationCode(code);
    } catch (_) {
      throw new OwnershipError('INVALID_CODE', 'That code is not valid.');
    }

    // Product id is unknown until the code is read, so material is prepared per
    // product inside the transaction from pre-generated random parts.
    const licenseId = vcrypto.newId('license');
    const licenseKey = vcrypto.generateLicenseKey();
    const purchaseId = vcrypto.newId('purchase');
    const transactionRef = 'ACT-' + vcrypto.generateTransactionRef().slice(4);

    // Peek at the code (separate read) so the binding can be computed with the product id.
    const peek = await db.get(S.CODES, codeHash);
    if (!peek) throw new OwnershipError('INVALID_CODE', 'That code is not valid.');
    const binding = await computeBinding(userId, peek.product_id, licenseId, licenseKey);
    const material = { purchaseId, licenseId, licenseKey, binding };

    const result = await db.transact(
      [S.USERS, S.CODES, S.PRODUCTS, S.PURCHASES, S.LICENSES],
      'readwrite',
      async (s) => {
        const user = await req(s[S.USERS].get(userId));
        if (!user) throw new OwnershipError('NO_SUCH_USER', 'Unknown user.');

        const record = await req(s[S.CODES].get(codeHash));
        if (!record) throw new OwnershipError('INVALID_CODE', 'That code is not valid.');
        if (record.product_id !== peek.product_id) {
          throw new OwnershipError('INVALID_CODE', 'That code is not valid.');
        }
        if (record.is_redeemed) {
          throw new OwnershipError('CODE_ALREADY_REDEEMED', 'That code has already been used.');
        }

        const product = await req(s[S.PRODUCTS].get(record.product_id));
        if (!product) throw new OwnershipError('NO_SUCH_PRODUCT', 'This code refers to a product that is not available.');

        const existing = await req(userProductIndex(s[S.LICENSES]).get([userId, product.id]));
        if (existing && existing.status === STATUS.ACTIVE) {
          // Nothing is written: the code stays unused.
          throw new OwnershipError('ALREADY_OWNED', 'You already own "' + product.title + '". The code was not used.');
        }

        const granted = await writeGrant(s, {
          userId: userId,
          product: product,
          method: 'activation_code',
          transactionRef: transactionRef,
          amount: 0,
          codeHash: codeHash,
          existing: existing || null,
          material: material
        });

        await req(
          s[S.CODES].put(
            Object.assign({}, record, {
              is_redeemed: true,
              redeemed_by: userId,
              redeemed_at: granted.purchase.timestamp
            })
          )
        );
        return granted;
      }
    );

    emit('code-redeemed', result);
    emit('license-granted', result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // License verification
  // ---------------------------------------------------------------------------

  /**
   * Checks the ownership registry (never the media vault).
   * @returns {Promise<{licensed: boolean, reason: string, license: object|null, purchase: object|null}>}
   *   reason: 'ok' | 'no_license' | 'revoked' | 'inactive' | 'purchase_missing'
   *           | 'purchase_mismatch' | 'binding_mismatch'
   */
  async function verifyLicense(options) {
    const { userId, productId } = options || {};
    requireString(userId, 'userId');
    requireString(productId, 'productId');

    const found = await db.transact([S.LICENSES, S.PURCHASES], 'readonly', async (s) => {
      const license = await req(userProductIndex(s[S.LICENSES]).get([userId, productId]));
      if (!license) return { license: null, purchase: null };
      const purchase = license.purchase_id ? await req(s[S.PURCHASES].get(license.purchase_id)) : undefined;
      return { license: license, purchase: purchase || null };
    });

    const { license, purchase } = found;
    const fail = (reason) => ({ licensed: false, reason: reason, license: license, purchase: purchase });

    if (!license) return fail('no_license');
    if (license.status === STATUS.REVOKED) return fail('revoked');
    if (license.status !== STATUS.ACTIVE) return fail('inactive');
    if (license.user_id !== userId || license.product_id !== productId) return fail('binding_mismatch');
    if (!purchase) return fail('purchase_missing');
    if (purchase.user_id !== userId || purchase.product_id !== productId) return fail('purchase_mismatch');

    const expected = await computeBinding(license.user_id, license.product_id, license.id, license.license_key);
    if (!vcrypto.constantTimeEqual(expected, String(license.binding || ''))) return fail('binding_mismatch');

    return { licensed: true, reason: 'ok', license: license, purchase: purchase };
  }

  /** Like verifyLicense but throws OwnershipError('NOT_LICENSED') when access is not permitted. */
  async function assertLicensed(options) {
    const verdict = await verifyLicense(options);
    if (!verdict.licensed) {
      throw new OwnershipError('NOT_LICENSED', 'You do not have an active license for this item.', {
        reason: verdict.reason
      });
    }
    return verdict;
  }

  async function getLicense(options) {
    const { userId, productId } = options || {};
    requireString(userId, 'userId');
    requireString(productId, 'productId');
    return db.getFromIndex(S.LICENSES, 'user_product', [userId, productId]);
  }

  /**
   * Suspends access without deleting anything. The purchase record and any
   * cached vault copy remain, but every access check fails until re-activation.
   */
  async function revokeLicense(options) {
    const { userId, productId, reason } = options || {};
    requireString(userId, 'userId');
    requireString(productId, 'productId');
    const revoked = await db.transact(S.LICENSES, 'readwrite', async (s) => {
      const license = await req(userProductIndex(s[S.LICENSES]).get([userId, productId]));
      if (!license) throw new OwnershipError('NOT_LICENSED', 'No license to revoke.');
      const next = Object.assign({}, license, {
        status: STATUS.REVOKED,
        revoked_at: Date.now(),
        revoke_reason: reason || null
      });
      await req(s[S.LICENSES].put(next));
      return next;
    });
    emit('license-revoked', { license: revoked });
    return revoked;
  }

  // ---------------------------------------------------------------------------
  // Library + history
  // ---------------------------------------------------------------------------

  /**
   * The user's owned items, newest first: [{license, product, purchase}].
   * `product` is null if the catalog entry was removed (ownership still stands).
   */
  async function getLibrary(options) {
    const { userId, includeRevoked } = options || {};
    requireString(userId, 'userId');
    return db.transact([S.LICENSES, S.PRODUCTS, S.PURCHASES], 'readonly', async (s) => {
      const licenses = await req(s[S.LICENSES].index('user_id').getAll(userId));
      const items = [];
      for (const license of licenses) {
        if (!includeRevoked && license.status !== STATUS.ACTIVE) continue;
        const product = (await req(s[S.PRODUCTS].get(license.product_id))) || null;
        const purchase = license.purchase_id
          ? (await req(s[S.PURCHASES].get(license.purchase_id))) || null
          : null;
        items.push({ license: license, product: product, purchase: purchase });
      }
      items.sort((a, b) => b.license.granted_at - a.license.granted_at);
      return items;
    });
  }

  /** Product ids with an ACTIVE license (cheap lookup for "Owned" badges in the shop). */
  async function getOwnedProductIds(options) {
    const items = await getLibrary(options);
    return items.map((item) => item.license.product_id);
  }

  async function getPurchaseHistory(options) {
    const { userId } = options || {};
    requireString(userId, 'userId');
    const purchases = await db.getAllFromIndex(S.PURCHASES, 'user_id', userId);
    return purchases.sort((a, b) => b.timestamp - a.timestamp);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  Vault.ownership = Object.freeze({
    OwnershipError,
    LICENSE_STATUS: STATUS,
    on,
    getCatalog,
    getProduct,
    purchase,
    redeemCode,
    parseScannedPayload,
    verifyLicense,
    assertLicensed,
    getLicense,
    revokeLicense,
    getLibrary,
    getOwnedProductIds,
    getPurchaseHistory
  });
})(typeof window !== 'undefined' ? window : globalThis);
