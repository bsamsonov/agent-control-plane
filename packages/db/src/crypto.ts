/**
 * Envelope encryption for tenant_credentials.
 *
 * AES-256-GCM with a random 12-byte IV. The key is derived from MACP_MASTER_KEY
 * via SHA-256. The output blob is base64(iv || tag || ciphertext).
 *
 * sealCredential  → base64 string
 * openCredential  → throws on tamper / wrong key
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
// Public demo value: base64 of "demo-only-master-key-32bytes-!!". Never use it outside a demo.
const DEFAULT_MASTER_KEY = 'ZGVtby1vbmx5LW1hc3Rlci1rZXktMzJieXRlcy0hIQ=='; // gitleaks:allow

function deriveKey(): Buffer {
  const raw = process.env.MACP_MASTER_KEY ?? DEFAULT_MASTER_KEY;
  return createHash('sha256').update(raw).digest();
}

export function sealCredential(plain: Record<string, unknown>): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const json = JSON.stringify(plain);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, encrypted]);
  return blob.toString('base64');
}

export function openCredential(blob: string): Record<string, unknown> {
  const key = deriveKey();
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('credential blob too short');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ct = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}
