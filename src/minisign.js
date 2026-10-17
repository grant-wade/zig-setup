import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

export function parsePublicKey(text) {
  const raw = Buffer.from(text, 'base64');
  if (raw.length !== 42 || raw.toString('latin1', 0, 2) !== 'Ed') {
    throw new Error('invalid minisign public key');
  }
  return {
    id: raw.subarray(2, 10),
    key: crypto.createPublicKey({
      format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10).toString('base64url') },
    }),
  };
}

export function parseSignature(data) {
  const lines = data.toString('utf8').split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines.at(-1) === '') lines.pop();
  if (
    lines.length !== 4 ||
    !lines[0].startsWith('untrusted comment: ') ||
    !lines[2].startsWith('trusted comment: ')
  ) {
    throw new Error('invalid minisign signature');
  }
  const info = Buffer.from(lines[1], 'base64');
  const globalSignature = Buffer.from(lines[3], 'base64');
  if (info.length !== 74 || globalSignature.length !== 64) {
    throw new Error('invalid minisign signature');
  }
  return {
    algorithm: info.toString('latin1', 0, 2),
    keyId: info.subarray(2, 10),
    signature: info.subarray(10),
    trustedComment: lines[2].slice('trusted comment: '.length),
    globalSignature,
  };
}

async function hashFile(algorithm, file) {
  const hash = crypto.createHash(algorithm);
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest();
}

export async function verifyFile(publicKey, signature, file) {
  if (!signature.keyId.equals(publicKey.id)) return false;
  let message;
  if (signature.algorithm === 'ED') message = await hashFile('blake2b512', file);
  else if (signature.algorithm === 'Ed') message = await fs.promises.readFile(file);
  else return false;
  if (!crypto.verify(null, message, publicKey.key, signature.signature)) return false;
  const trusted = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment)]);
  return crypto.verify(null, trusted, publicKey.key, signature.globalSignature);
}
