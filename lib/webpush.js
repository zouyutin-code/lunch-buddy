// Web Push for Cloudflare Workers / Pages Functions, using only Web Crypto.
// Payload encryption: RFC 8291 (aes128gcm, RFC 8188). Sender auth: VAPID (RFC 8292).
//
// env.VAPID_PUBLIC_KEY  - uncompressed P-256 public key, base64url (65 bytes)
// env.VAPID_PRIVATE_JWK - the matching private key as a JWK JSON string (secret)
// env.VAPID_SUBJECT     - contact URL or mailto: for push services

const te = new TextEncoder();

export const b64u = {
  enc(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// Encrypt one payload for one subscription (single aes128gcm record).
export async function encryptPayload(sub, plaintext) {
  const uaPub = b64u.dec(sub.p256dh);
  const authSecret = b64u.dec(sub.auth);
  if (uaPub.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys');
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPub.length;
  header.set(asPub, 21);
  return concat(header, ct);
}

let signingKey = null;
async function vapidKey(env) {
  if (!signingKey) {
    signingKey = crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  }
  return signingKey;
}

export async function vapidHeader(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const unsigned = head + '.' + claims;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidKey(env), te.encode(unsigned));
  return `vapid t=${unsigned}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// Push services we deliver to. Keeps the server from POSTing to arbitrary URLs.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
export function isPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) {
    return false;
  }
}

// Send one notification. Resolves the push service's Response (404/410 = subscription gone).
export async function sendPush(env, sub, payload, { ttl = 86400, urgency = 'normal' } = {}) {
  if (!isPushEndpoint(sub.endpoint)) throw new Error('not a push endpoint');
  const body = await encryptPayload(sub, te.encode(JSON.stringify(payload)));
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: await vapidHeader(env, sub.endpoint)
    },
    body
  });
}
