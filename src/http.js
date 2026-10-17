import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const USER_AGENT = 'zig-setup';

export async function request(url, { timeoutMs = 60_000, headers, ...init } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res;
}

export async function fetchJson(url) {
  return (await request(url)).json();
}

// Aborts only when the connection stalls, so large downloads on slow links still finish.
export async function downloadFile(url, dest, { idleTimeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error(`no data received for ${idleTimeoutMs / 1000}s`)),
      idleTimeoutMs,
    );
  };
  arm();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          arm();
          yield chunk;
        }
      },
      fs.createWriteStream(dest),
    );
  } finally {
    clearTimeout(timer);
  }
}
