import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicKey, parseSignature, verifyFile } from '../src/minisign.js';
import { makeKey, sign, tempFile } from './helpers.js';

test('verifies prehashed and legacy signatures', async () => {
  const key = makeKey();
  const file = tempFile('zig');
  for (const algorithm of ['ED', 'Ed']) {
    const signature = parseSignature(Buffer.from(sign(key, Buffer.from('zig'), { algorithm })));
    assert.equal(await verifyFile(parsePublicKey(key.text), signature, file), true);
  }
});

test('rejects modified content', async () => {
  const key = makeKey();
  const signature = parseSignature(Buffer.from(sign(key, Buffer.from('zig'))));
  assert.equal(await verifyFile(parsePublicKey(key.text), signature, tempFile('zag')), false);
});

test('rejects a tampered trusted comment', async () => {
  const key = makeKey();
  const text = sign(key, Buffer.from('zig')).replace('file:x', 'file:y');
  assert.equal(await verifyFile(parsePublicKey(key.text), parseSignature(Buffer.from(text)), tempFile('zig')), false);
});

test('rejects a signature from another key', async () => {
  const signer = makeKey();
  const other = makeKey();
  const signature = parseSignature(Buffer.from(sign(signer, Buffer.from('zig'))));
  assert.equal(await verifyFile(parsePublicKey(other.text), signature, tempFile('zig')), false);
});

test('rejects malformed signature files', () => {
  assert.throws(() => parseSignature(Buffer.from('not a signature\n')));
  assert.throws(() => parseSignature(Buffer.from('untrusted comment: x\nAAAA\ntrusted comment: y\nAAAA\n')));
});

test('parses the Zig Software Foundation key', async () => {
  const { ZIG_PUBLIC_KEY } = await import('../src/zig.js');
  assert.equal(parsePublicKey(ZIG_PUBLIC_KEY).id.length, 8);
});
