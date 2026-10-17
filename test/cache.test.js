import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as cache from '../src/cache.js';
import { startFakeService } from './helpers.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zig-setup-test-'));
}

test('cache service round trip', async (t) => {
  const { server, blobs } = await startFakeService();
  t.after(() => server.close());
  Object.assign(process.env, {
    GITHUB_SERVER_URL: 'https://github.com',
    ACTIONS_CACHE_SERVICE_V2: 'True',
    ACTIONS_RESULTS_URL: `http://127.0.0.1:${server.address().port}/`,
    ACTIONS_RUNTIME_TOKEN: 'test-token',
  });
  assert.equal(cache.isReadable(), true);
  assert.equal(cache.isWritable(), true);

  await t.test('saves and restores a file by exact key', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'in'), 'archive contents');
    assert.equal(await cache.saveFile('archive', cache.ARCHIVE_VERSION, path.join(dir, 'in')), true);
    assert.equal(await cache.saveFile('archive', cache.ARCHIVE_VERSION, path.join(dir, 'in')), false);
    assert.equal(await cache.restoreFile('archive', [], cache.ARCHIVE_VERSION, path.join(dir, 'out')), 'archive');
    assert.equal(fs.readFileSync(path.join(dir, 'out'), 'utf8'), 'archive contents');
    assert.equal(await cache.restoreFile('archive', [], cache.ZIG_CACHE_VERSION, path.join(dir, 'x')), null);
  });

  await t.test('uploads large files in blocks', async () => {
    const dir = tempDir();
    const data = Buffer.alloc(10_000).map((_, i) => i % 251);
    fs.writeFileSync(path.join(dir, 'big'), data);
    const url = `http://127.0.0.1:${server.address().port}/blob/blocks?sig=1`;
    await cache.uploadBlob(url, path.join(dir, 'big'), 1024);
    assert.deepEqual(blobs.get('blocks'), data);
  });

  await t.test('restores the newest directory by prefix', async () => {
    const source = tempDir();
    fs.mkdirSync(path.join(source, 'o', 'abc'), { recursive: true });
    fs.writeFileSync(path.join(source, 'o', 'abc', 'artifact'), 'built');
    fs.mkdirSync(path.join(source, 'tmp'));
    fs.writeFileSync(path.join(source, 'tmp', 'scratch'), 'junk');
    for (const run of ['1', '2']) {
      fs.writeFileSync(path.join(source, 'run'), run);
      const archive = path.join(tempDir(), 'cache.tar.zst');
      await cache.packDirectory(source, archive);
      assert.equal(await cache.saveFile(`prefix-${run}`, cache.ZIG_CACHE_VERSION, archive), true);
    }

    const restored = tempDir();
    const archive = path.join(tempDir(), 'cache.tar.zst');
    assert.equal(await cache.restoreFile('prefix-', ['prefix-'], cache.ZIG_CACHE_VERSION, archive), 'prefix-2');
    await cache.unpackDirectory(archive, restored);
    assert.equal(fs.readFileSync(path.join(restored, 'run'), 'utf8'), '2');
    assert.equal(fs.readFileSync(path.join(restored, 'o', 'abc', 'artifact'), 'utf8'), 'built');
    assert.deepEqual(fs.readdirSync(path.join(restored, 'tmp')), []);
    assert.equal((await cache.directoryStats(restored)).size, 6);
  });

  await t.test('honours the runner cache mode', () => {
    process.env.ACTIONS_CACHE_MODE = 'read';
    assert.equal(cache.isReadable(), true);
    assert.equal(cache.isWritable(), false);
    process.env.ACTIONS_CACHE_MODE = 'none';
    assert.equal(cache.isReadable(), false);
    delete process.env.ACTIONS_CACHE_MODE;
  });

  await t.test('is unavailable on GitHub Enterprise Server', () => {
    process.env.GITHUB_SERVER_URL = 'https://git.example.com';
    assert.equal(cache.isAvailable(), false);
    process.env.GITHUB_SERVER_URL = 'https://github.com';
  });
});

test('fingerprints paths and sizes but not mtimes or tmp', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'h'));
  fs.writeFileSync(path.join(dir, 'h', 'manifest'), 'abc');
  const before = await cache.directoryStats(dir);

  fs.utimesSync(path.join(dir, 'h', 'manifest'), new Date(0), new Date(0));
  fs.mkdirSync(path.join(dir, 'tmp'));
  fs.writeFileSync(path.join(dir, 'tmp', 'scratch'), 'junk');
  assert.deepEqual(await cache.directoryStats(dir), before);

  fs.mkdirSync(path.join(dir, 'o', 'new'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'o', 'new', 'artifact'), 'x');
  const after = await cache.directoryStats(dir);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(after.size, 4);
});

test('saves from the default branch only in auto mode', () => {
  assert.equal(cache.shouldSave('auto', 'refs/heads/main', 'main'), true);
  assert.equal(cache.shouldSave('auto', 'refs/heads/feature', 'main'), false);
  assert.equal(cache.shouldSave('auto', 'refs/pull/8/merge', 'main'), false);
  assert.equal(cache.shouldSave('auto', 'refs/heads/feature', null), true);
  assert.equal(cache.shouldSave('true', 'refs/heads/feature', 'main'), true);
  assert.equal(cache.shouldSave('false', 'refs/heads/main', 'main'), false);
  assert.throws(() => cache.shouldSave('sometimes', 'refs/heads/main', 'main'));
});

test('reads the default branch from the event payload', () => {
  const event = path.join(tempDir(), 'event.json');
  fs.writeFileSync(event, JSON.stringify({ repository: { default_branch: 'trunk' } }));
  process.env.GITHUB_EVENT_PATH = event;
  assert.equal(cache.defaultBranch(), 'trunk');
  process.env.GITHUB_EVENT_PATH = path.join(tempDir(), 'missing.json');
  assert.equal(cache.defaultBranch(), null);
  delete process.env.GITHUB_EVENT_PATH;
});

test('round trips a directory larger than one zstd window', async () => {
  const source = tempDir();
  const data = crypto.randomBytes(80 * 1024 * 1024);
  fs.writeFileSync(path.join(source, 'blob'), data);
  const archive = path.join(tempDir(), 'cache.tar.zst');
  await cache.packDirectory(source, archive);
  const restored = tempDir();
  await cache.unpackDirectory(archive, restored);
  assert.ok(fs.readFileSync(path.join(restored, 'blob')).equals(data));
});
