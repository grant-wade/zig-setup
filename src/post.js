import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cache from './cache.js';
import { getState, getInput, info, run, warning } from './runner.js';

await run(async () => {
  const cacheDir = getState('cache-dir');
  const prefix = getState('cache-prefix');
  if (!cacheDir || !prefix || !fs.existsSync(cacheDir)) return;

  const limit = Number(getInput('cache-size-limit') || '0') * 1024 * 1024;
  const { size, fingerprint } = await cache.directoryStats(cacheDir);
  if (limit > 0 && size > limit) {
    info(`Zig cache is ${size} bytes, over the ${limit} byte limit; saving an empty cache instead`);
    for (const entry of await fs.promises.readdir(cacheDir)) {
      await fs.promises.rm(path.join(cacheDir, entry), { recursive: true, force: true });
    }
  } else if (size === 0) {
    info('Zig cache is empty; nothing to save');
    return;
  } else if (fingerprint === getState('cache-fingerprint')) {
    info('Zig cache is unchanged since it was restored; not saving');
    return;
  }

  const key = `${prefix}${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  const archive = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `zig-setup-cache-${process.pid}.tar.zst`);
  try {
    await cache.packDirectory(cacheDir, archive);
    const { size: archiveSize } = await fs.promises.stat(archive);
    if (await cache.saveFile(key, cache.ZIG_CACHE_VERSION, archive)) {
      info(`Saved Zig cache as ${key} (${(archiveSize / 1024 / 1024).toFixed(1)} MiB)`);
    } else {
      info(`Zig cache ${key} already exists`);
    }
  } catch (err) {
    warning(`Could not save the Zig cache: ${err.message}`);
  } finally {
    await fs.promises.rm(archive, { force: true });
  }
});
