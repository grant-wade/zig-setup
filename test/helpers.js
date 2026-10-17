import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const id = crypto.randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { id, privateKey, text: Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64') };
}

export function sign(key, content, { algorithm = 'ED', trustedComment = 'timestamp:1 file:x hashed' } = {}) {
  const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(content).digest() : content;
  const signature = crypto.sign(null, message, key.privateKey);
  const globalSignature = crypto.sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), key.privateKey);
  return [
    'untrusted comment: signature from minisign secret key',
    Buffer.concat([Buffer.from(algorithm), key.id, signature]).toString('base64'),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');
}

export function tempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zig-setup-test-'));
  const file = path.join(dir, 'file');
  fs.writeFileSync(file, content);
  return file;
}

// Mimics the Twirp cache service and the Azure blob endpoints its signed URLs point at.
export function startFakeService() {
  const entries = new Map();
  const blobs = new Map();
  const blocks = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://localhost');
    const base = `http://localhost:${server.address().port}`;
    const json = (value) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));

    if (url.pathname.startsWith('/twirp/')) {
      assert.equal(req.headers.authorization, 'Bearer test-token');
      const request = JSON.parse(body);
      const method = url.pathname.split('/').at(-1);
      if (method === 'CreateCacheEntry') {
        if (entries.has(request.key)) return json({ ok: false, message: 'already exists' });
        entries.set(request.key, { version: request.version, final: false, time: entries.size });
        return json({ ok: true, signed_upload_url: `${base}/blob/${encodeURIComponent(request.key)}?sig=1` });
      }
      if (method === 'FinalizeCacheEntryUpload') {
        const entry = entries.get(request.key);
        assert.equal(Number(request.size_bytes), blobs.get(request.key).length);
        entry.final = true;
        return json({ ok: true, entry_id: '1' });
      }
      if (method === 'GetCacheEntryDownloadURL') {
        const usable = [...entries].filter(([, e]) => e.final && e.version === request.version);
        let match = usable.find(([key]) => key === request.key);
        for (const prefix of request.restore_keys ?? []) {
          match ??= usable.filter(([key]) => key.startsWith(prefix)).sort((a, b) => b[1].time - a[1].time)[0];
        }
        if (!match) return json({ ok: false });
        return json({ ok: true, signedDownloadUrl: `${base}/blob/${encodeURIComponent(match[0])}?sig=1`, matchedKey: match[0] });
      }
    }

    if (url.pathname.startsWith('/blob/')) {
      const key = decodeURIComponent(url.pathname.slice('/blob/'.length));
      if (req.method === 'GET') return res.writeHead(200).end(blobs.get(key));
      const comp = url.searchParams.get('comp');
      if (comp === 'block') {
        blocks.set(`${key}/${url.searchParams.get('blockid')}`, body);
      } else if (comp === 'blocklist') {
        const ids = [...body.toString().matchAll(/<Latest>(.*?)<\/Latest>/g)].map((m) => m[1]);
        blobs.set(key, Buffer.concat(ids.map((id) => blocks.get(`${key}/${id}`))));
      } else {
        assert.equal(req.headers['x-ms-blob-type'], 'BlockBlob');
        blobs.set(key, body);
      }
      return res.writeHead(201).end();
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, blobs })));
}
