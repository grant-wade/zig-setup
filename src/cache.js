import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { downloadFile, request } from './http.js';
import { tarPath } from './zig.js';

const SERVICE = 'github.actions.results.api.v1.CacheService';
const BLOCK_SIZE = 64 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;
const RETRYABLE = new Set([500, 502, 503, 504]);
const IGNORED_ENTRIES = new Set(['tmp']);

function cacheVersion(kind) {
  return crypto.createHash('sha256').update(`zig-setup|${kind}`).digest('hex');
}

export const ARCHIVE_VERSION = cacheVersion('archive-v1');
export const ZIG_CACHE_VERSION = cacheVersion('zig-cache-v1-tar-zstd');

function mode() {
  return (process.env.ACTIONS_CACHE_MODE ?? '').trim().toLowerCase();
}

export function isAvailable() {
  const host = new URL(process.env.GITHUB_SERVER_URL || 'https://github.com').hostname.toLowerCase();
  const ghes = host !== 'github.com' && !host.endsWith('.ghe.com') && !host.endsWith('.localhost');
  return (
    !ghes &&
    Boolean(process.env.ACTIONS_CACHE_SERVICE_V2) &&
    Boolean(process.env.ACTIONS_RESULTS_URL) &&
    Boolean(process.env.ACTIONS_RUNTIME_TOKEN)
  );
}

export function isReadable() {
  return isAvailable() && !['none', 'write-only'].includes(mode());
}

export function isWritable() {
  return isAvailable() && !['none', 'read'].includes(mode());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetries(fn, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || err.retryable === false) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

function field(object, name) {
  return object[name] ?? object[name.replace(/_(.)/g, (_, c) => c.toUpperCase())];
}

async function rpc(method, body) {
  const url = new URL(`/twirp/${SERVICE}/${method}`, process.env.ACTIONS_RESULTS_URL);
  return withRetries(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
        'User-Agent': 'zig-setup',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = JSON.parse(text).msg ?? text;
      } catch {}
      const err = new Error(`${method} failed: ${res.status} ${message}`);
      err.retryable = RETRYABLE.has(res.status);
      throw err;
    }
    return JSON.parse(text);
  });
}

export async function uploadBlob(url, file, blockSize = BLOCK_SIZE) {
  const { size } = await fs.promises.stat(file);
  const headers = { 'x-ms-version': '2023-11-03' };
  const handle = await fs.promises.open(file, 'r');
  try {
    if (size <= blockSize) {
      const body = await handle.readFile();
      await withRetries(() =>
        request(url, { method: 'PUT', headers: { ...headers, 'x-ms-blob-type': 'BlockBlob' }, body, timeoutMs: 10 * 60_000 }),
      );
      return;
    }

    const count = Math.ceil(size / blockSize);
    const ids = Array.from({ length: count }, (_, i) => Buffer.from(String(i).padStart(8, '0')).toString('base64'));
    let next = 0;
    const worker = async () => {
      while (next < count) {
        const i = next++;
        const length = Math.min(blockSize, size - i * blockSize);
        const body = Buffer.alloc(length);
        await handle.read(body, 0, length, i * blockSize);
        await withRetries(() =>
          request(`${url}&comp=block&blockid=${encodeURIComponent(ids[i])}`, {
            method: 'PUT',
            headers,
            body,
            timeoutMs: 10 * 60_000,
          }),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, count) }, worker));

    const blockList = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`;
    await withRetries(() =>
      request(`${url}&comp=blocklist`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/xml' },
        body: blockList,
      }),
    );
  } finally {
    await handle.close();
  }
}

function checkKey(key) {
  if (key.length > 512) throw new Error(`cache key is longer than 512 characters: ${key}`);
  if (key.includes(',')) throw new Error(`cache key cannot contain commas: ${key}`);
}

// Restores the newest entry matching `key` exactly or any of `restoreKeys` as a prefix. Returns the matched key.
export async function restoreFile(key, restoreKeys, version, dest) {
  [key, ...restoreKeys].forEach(checkKey);
  const res = await rpc('GetCacheEntryDownloadURL', { key, restore_keys: restoreKeys, version });
  if (!field(res, 'ok')) return null;
  await withRetries(() => downloadFile(field(res, 'signed_download_url'), dest, { idleTimeoutMs: 60_000 }));
  return field(res, 'matched_key');
}

// Returns false when the entry could not be reserved, which usually means another job already saved it.
export async function saveFile(key, version, file) {
  checkKey(key);
  const created = await rpc('CreateCacheEntry', { key, version });
  if (!field(created, 'ok')) return false;
  await uploadBlob(field(created, 'signed_upload_url'), file);
  const { size } = await fs.promises.stat(file);
  const finalized = await rpc('FinalizeCacheEntryUpload', { key, version, size_bytes: String(size) });
  if (!field(finalized, 'ok')) throw new Error(field(finalized, 'message') || `could not finalize cache entry ${key}`);
  return true;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`))));
  });
}

export async function packDirectory(dir, archive) {
  const entries = (await fs.promises.readdir(dir)).filter((name) => !IGNORED_ENTRIES.has(name));
  const paths = entries.length > 0 ? entries.map((name) => `./${name}`) : ['.'];
  const child = spawn(tarPath(), ['-cf', '-', '-C', dir, ...paths], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Streaming zstd with ZSTD_c_nbWorkers silently drops output in Node 24, so this stays single-threaded.
  await Promise.all([
    waitForExit(child),
    pipeline(child.stdout, zlib.createZstdCompress(), fs.createWriteStream(archive)),
  ]);
}

export async function unpackDirectory(archive, dir) {
  await fs.promises.mkdir(dir, { recursive: true });
  const child = spawn(tarPath(), ['-xf', '-', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
  await Promise.all([
    waitForExit(child),
    pipeline(fs.createReadStream(archive), zlib.createZstdDecompress(), child.stdin),
  ]);
}

// Fingerprints only paths and sizes: Zig rewrites manifests whenever source mtimes differ, as they do after every checkout.
export async function directoryStats(dir) {
  let size = 0;
  const files = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(dir, file).split(path.sep).join('/');
    if (IGNORED_ENTRIES.has(relative.split('/')[0])) continue;
    try {
      const { size: fileSize } = await fs.promises.stat(file);
      size += fileSize;
      files.push(`${relative}\0${fileSize}`);
    } catch {}
  }
  files.sort();
  return { size, fingerprint: crypto.createHash('sha256').update(files.join('\n')).digest('hex') };
}

export function shouldSave(setting, ref, defaultBranch) {
  if (setting === 'true') return true;
  if (setting === 'false') return false;
  if (setting !== 'auto') throw new TypeError("Input 'save-cache' must be 'auto', 'true' or 'false'");
  return !defaultBranch || ref === `refs/heads/${defaultBranch}`;
}

export function defaultBranch() {
  try {
    return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).repository?.default_branch ?? null;
  } catch {
    return null;
  }
}
