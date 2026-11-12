/**
 * R3.17 encrypted cross-run state envelope for a PUBLIC repository.
 * Never print plaintext state, internal IDs, or the encryption key.
 * The key is a 32-byte random hex Actions secret R316_STATE_KEY, never committed.
 */
import crypto from 'node:crypto';

const AAD = Buffer.from('lijianjun004-star/tcl-live-monitor:r315-runtime-control:r316-state:v1');
export function parseStateKey(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw Error('R316_STATE_KEY_REQUIRED_64_HEX');
  return Buffer.from(value, 'hex');
}
export function sealState(state, key) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !Buffer.isBuffer(key) || key.length !== 32)
    throw Error('STATE_SEAL_INPUT_INVALID');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(state), 'utf8')), cipher.final()]);
  return { version: 1, alg: 'AES-256-GCM', iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: body.toString('base64') };
}
export function openState(envelope, key) {
  if (!envelope || envelope.version !== 1 || envelope.alg !== 'AES-256-GCM' ||
      !Buffer.isBuffer(key) || key.length !== 32) throw Error('STATE_ENVELOPE_INVALID');
  try {
    const iv=Buffer.from(envelope.iv,'base64'), tag=Buffer.from(envelope.tag,'base64'),
      body=Buffer.from(envelope.ciphertext,'base64');
    if (iv.length!==12 || tag.length!==16 || body.length>5_000_000) throw Error('STATE_ENVELOPE_INVALID');
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);
    decipher.setAAD(AAD); decipher.setAuthTag(tag);
    const value=JSON.parse(Buffer.concat([decipher.update(body),decipher.final()]).toString('utf8'));
    if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('STATE_OBJECT_INVALID');
    return value;
  } catch { throw Error('STATE_AUTHENTICATION_OR_FORMAT_FAILED'); }
}
