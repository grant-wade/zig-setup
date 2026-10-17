import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cache from './cache.js';
import {
  addPath,
  endGroup,
  exec,
  exportVariable,
  getBooleanInput,
  getInput,
  info,
  run,
  saveState,
  setOutput,
  startGroup,
  warning,
} from './runner.js';
import {
  artifactExtension,
  artifactName,
  downloadZig,
  extractArchive,
  resolveVersion,
  verifyArchive,
} from './zig.js';

function useToolCache() {
  const value = getInput('use-tool-cache');
  if (value === '') return process.env.RUNNER_ENVIRONMENT !== 'github-hosted' && Boolean(process.env.RUNNER_TOOL_CACHE);
  return getBooleanInput('use-tool-cache');
}

function canSaveCache() {
  const setting = getInput('save-cache') || 'auto';
  const branch = cache.defaultBranch();
  if (!cache.shouldSave(setting, process.env.GITHUB_REF, branch)) {
    info(
      setting === 'auto'
        ? `Not saving to the Actions cache from ${process.env.GITHUB_REF}; only ${branch} saves when save-cache is auto`
        : 'Not saving to the Actions cache because save-cache is false',
    );
    return false;
  }
  return cache.isWritable();
}

async function restoreArchive(key, fileName, archive) {
  const signature = `${archive}.minisig`;
  try {
    if (
      (await cache.restoreFile(`${key}.minisig`, [], cache.ARCHIVE_VERSION, signature)) &&
      (await cache.restoreFile(key, [], cache.ARCHIVE_VERSION, archive))
    ) {
      await verifyArchive(archive, fileName, await fs.promises.readFile(signature));
      info(`Restored and verified ${fileName} from the Actions cache`);
      return true;
    }
  } catch (err) {
    warning(`Could not use ${fileName} from the Actions cache: ${err.message}`);
  }
  await fs.promises.rm(archive, { force: true });
  await fs.promises.rm(signature, { force: true });
  return false;
}

async function fetchArchive(version, fileName, dir, saveCache) {
  const archive = path.join(dir, fileName);
  const key = `zig-setup-archive-v1-${fileName}`;
  if (cache.isReadable() && (await restoreArchive(key, fileName, archive))) return archive;

  const source = await downloadZig(version, fileName, archive, getInput('mirror'));
  info(`Downloaded and verified ${fileName} from ${source}`);

  if (saveCache) {
    try {
      const saved =
        (await cache.saveFile(key, cache.ARCHIVE_VERSION, archive)) &&
        (await cache.saveFile(`${key}.minisig`, cache.ARCHIVE_VERSION, `${archive}.minisig`));
      if (!saved) info(`${fileName} is already being cached by another job`);
    } catch (err) {
      warning(`Could not save ${fileName} to the Actions cache: ${err.message}`);
    }
  }
  return archive;
}

async function install(version, saveCache) {
  const name = artifactName(version);
  const fileName = `${name}${artifactExtension()}`;
  const temp = process.env.RUNNER_TEMP ?? os.tmpdir();

  const toolDir = useToolCache() ? path.join(process.env.RUNNER_TOOL_CACHE, 'zig', version, process.arch) : null;
  if (toolDir && fs.existsSync(`${toolDir}.complete`)) {
    info(`Using Zig from the tool cache at ${toolDir}`);
    return { name, dir: path.join(toolDir, name) };
  }

  const workDir = await fs.promises.mkdtemp(path.join(temp, 'zig-setup-'));
  const archive = await fetchArchive(version, fileName, workDir, saveCache);
  const dest = toolDir ?? workDir;
  if (toolDir) await fs.promises.rm(toolDir, { recursive: true, force: true });
  await extractArchive(archive, dest);
  await fs.promises.rm(archive, { force: true });
  await fs.promises.rm(`${archive}.minisig`, { force: true });
  if (toolDir) await fs.promises.writeFile(`${toolDir}.complete`, '');
  return { name, dir: path.join(dest, name) };
}

async function restoreZigCache(prefix, cacheDir) {
  if (!cache.isReadable()) return false;
  const archive = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `zig-setup-cache-${process.pid}.tar.zst`);
  try {
    const hit = await cache.restoreFile(prefix, [prefix], cache.ZIG_CACHE_VERSION, archive);
    if (!hit) {
      info(`No Zig cache found for ${prefix}`);
      return false;
    }
    await cache.unpackDirectory(archive, cacheDir);
    info(`Restored Zig cache from ${hit}`);
    return true;
  } catch (err) {
    warning(`Could not restore the Zig cache: ${err.message}`);
    return false;
  } finally {
    await fs.promises.rm(archive, { force: true });
  }
}

await run(async () => {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const version = await resolveVersion(getInput('version'), workspace);
  const useCache = getBooleanInput('use-cache') && cache.isAvailable();
  const saveCache = cache.isAvailable() && canSaveCache();

  startGroup(`Installing Zig ${version}`);
  let installed;
  try {
    installed = await install(version, saveCache);
  } finally {
    endGroup();
  }

  addPath(installed.dir);
  const zig = path.join(installed.dir, process.platform === 'win32' ? 'zig.exe' : 'zig');
  const zigVersion = (await exec(zig, ['version'])).trim();
  info(`Installed Zig ${zigVersion} at ${installed.dir}`);
  setOutput('zig-version', zigVersion);
  setOutput('zig-path', installed.dir);

  const cacheDir = path.join(workspace, '.zig-cache');
  await fs.promises.mkdir(cacheDir, { recursive: true });
  exportVariable('ZIG_GLOBAL_CACHE_DIR', cacheDir);
  exportVariable('ZIG_LOCAL_CACHE_DIR', cacheDir);

  let hit = false;
  if (useCache) {
    const job = (process.env.GITHUB_JOB ?? '').replaceAll(/[^\w]/g, '_');
    const prefix = `zig-setup-cache-v1-${job}-${installed.name}-${getInput('cache-key')}-`;
    hit = await restoreZigCache(prefix, cacheDir);
    if (saveCache) {
      saveState('cache-dir', cacheDir);
      saveState('cache-prefix', prefix);
      saveState('cache-fingerprint', (await cache.directoryStats(cacheDir)).fingerprint);
    }
  } else if (getBooleanInput('use-cache')) {
    info('The Actions cache service is unavailable; the Zig cache will not be restored or saved');
  }
  setOutput('cache-hit', String(hit));
});
