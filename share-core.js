'use strict';
// Shared by the app (publishing a board) and view.html (reading it).
//
// A shared board is published as ONE file that anyone with the link can download —
// but its content is AES-GCM encrypted with a passphrase, so without the passphrase
// the file is just noise. The key is derived in the browser (PBKDF2); the passphrase
// never leaves the owner's and the viewers' devices.
(function (global) {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 31 symbols: no I, L, O, 0, 1
  const GROUPS = 4, GROUP_LEN = 4;                       // XXXX-XXXX-XXXX-XXXX ≈ 79 bits
  const ITERATIONS = 250000;
  const MAX_ITERATIONS = 1000000;                        // a hostile file can't make us hash forever
  const CARD_STATUSES = ['archive', 'todo', 'inprogress', 'done'];
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const fromB64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

  function randomIndex(n) {   // unbiased
    const limit = 256 - (256 % n);
    const b = new Uint8Array(1);
    for (;;) { crypto.getRandomValues(b); if (b[0] < limit) return b[0] % n; }
  }

  function generatePassphrase() {
    const groups = [];
    for (let g = 0; g < GROUPS; g++) {
      let part = '';
      for (let i = 0; i < GROUP_LEN; i++) part += ALPHABET[randomIndex(ALPHABET.length)];
      groups.push(part);
    }
    return groups.join('-');
  }

  // Forgive case, spaces and dashes when someone types it in
  function normalizePassphrase(input) {
    const clean = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length !== GROUPS * GROUP_LEN) return clean;
    return clean.match(new RegExp(`.{${GROUP_LEN}}`, 'g')).join('-');
  }

  function newSalt() { return toB64(crypto.getRandomValues(new Uint8Array(16))); }

  async function deriveKey(passphrase, saltB64, iterations = ITERATIONS) {
    const material = await crypto.subtle.importKey('raw', enc.encode(normalizePassphrase(passphrase)), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function encrypt(payload, key, saltB64) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload))));
    return { app: 'taskboards-share', v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS, salt: saltB64, iv: toB64(iv), ct: toB64(ct) };
  }

  function checkEnvelope(env) {
    const ok = env && env.app === 'taskboards-share' && env.v === 1 && env.kdf === 'PBKDF2-SHA256' &&
      Number.isInteger(env.iter) && env.iter >= 10000 && env.iter <= MAX_ITERATIONS &&
      typeof env.salt === 'string' && typeof env.iv === 'string' && typeof env.ct === 'string';
    if (!ok) throw new Error('bad-file');
  }

  // Throws 'bad-file' (not one of ours) or 'bad-passphrase' (wrong key / tampered)
  async function decryptWithKey(env, key) {
    checkEnvelope(env);
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, key, fromB64(env.ct));
      return JSON.parse(dec.decode(plain));
    } catch { throw new Error('bad-passphrase'); }
  }

  async function decrypt(env, passphrase) {
    checkEnvelope(env);
    const key = await deriveKey(passphrase, env.salt, env.iter);
    return { payload: await decryptWithKey(env, key), key };
  }

  // Keep only fields we know — a foreign, hand-edited or hostile file can't inject odd data.
  function cleanCards(raw, makeId) {
    const ids = new Set();
    return (Array.isArray(raw) ? raw : [])
      .filter(c => c && typeof c === 'object' && typeof c.title === 'string' && CARD_STATUSES.includes(c.status))
      .map(c => {
        const id = typeof c.id === 'string' && c.id && !ids.has(c.id) ? c.id : makeId();
        ids.add(id);
        const card = {
          id,
          title: c.title.slice(0, 200),
          owner: typeof c.owner === 'string' ? c.owner.slice(0, 80) : '',
          dueDate: /^\d{4}-\d{2}-\d{2}$/.test(c.dueDate) ? c.dueDate : '',
          status: c.status,
          createdAt: Number(c.createdAt) || Date.now()
        };
        if (Number.isFinite(c.sortOrder)) card.sortOrder = c.sortOrder;
        if (typeof c.note === 'string' && c.note.trim()) card.note = c.note.trim().slice(0, 500);   // same limit as the note field
        return card;
      });
  }

  global.TBShare = {
    generatePassphrase, normalizePassphrase, newSalt, deriveKey,
    encrypt, decrypt, decryptWithKey, cleanCards, CARD_STATUSES
  };
})(window);
