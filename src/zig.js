import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadFile, fetchJson, request } from './http.js';
import { parsePublicKey, parseSignature, verifyFile } from './minisign.js';
import { exec, info } from './runner.js';

export const ZIG_PUBLIC_KEY = 'RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U';

const INDEX_URL = 'https://ziglang.org/download/index.json';
const MACH_INDEX_URL = 'https://pkg.hexops.org/zig/index.json';
const MIRRORS_URL = 'https://ziglang.org/download/community-mirrors.txt';
const SOURCE = 'github-grant-wade-zig-setup';

// Used only when ziglang.org itself is unreachable.
const FALLBACK_MIRRORS = [
  'https://pkg.hexops.org/zig',
  'https://zigmirror.hryx.net/zig',
  'https://zig.linus.dev/zig',
  'https://zig.squirl.dev',
  'https://zig.mirror.mschae23.de/zig',
  'https://ziglang.freetls.fastly.net',
  'https://zig.tilok.dev',
  'https://zig-mirror.tsimnet.eu/zig',
  'https://zig.karearl.com/zig',
  'https://pkg.earth/zig',
  'https://fs.liujiacai.net/zigbuilds',
  'https://zigmirror.com',
  'https://zig.chainsafe.dev',
  'https://zig.savalione.com',
  'https://zig.bcr.ist',
  'https://zig.vortan.dev/zig',
  'https://pkg.alexrp.com/zig',
];

const ARCHES = {
  arm: 'arm',
  arm64: 'aarch64',
  ia32: 'x86',
  loong64: 'loongarch64',
  mips: 'mips',
  mipsel: 'mipsel',
  mips64: 'mips64',
  mips64el: 'mips64el',
  ppc64: 'powerpc64',
  riscv64: 'riscv64',
  s390x: 's390x',
  x64: 'x86_64',
};

const PLATFORMS = {
  android: 'android',
  darwin: 'macos',
  freebsd: 'freebsd',
  linux: 'linux',
  netbsd: 'netbsd',
  openbsd: 'openbsd',
  sunos: 'illumos',
  win32: 'windows',
};

export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+)\+[0-9a-f]+)?$/.exec(text);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return { major, minor, patch, dev: match[4] === undefined ? null : Number(match[4]) };
}

// Treats a release as newer than every dev build of the same version. Malformed versions never compare as older.
export function versionLessThan(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (const part of ['major', 'minor', 'patch']) {
    if (x[part] !== y[part]) return x[part] < y[part];
  }
  return (x.dev ?? Infinity) < (y.dev ?? Infinity);
}

export function latestRelease(index) {
  let latest = null;
  for (const version of Object.keys(index)) {
    if (parseVersion(version)?.dev !== null) continue;
    if (latest === null || versionLessThan(latest, version)) latest = version;
  }
  if (latest === null) throw new Error('no tagged Zig release found in the download index');
  return latest;
}

export async function versionFromZon(dir) {
  let zon;
  try {
    zon = await fs.promises.readFile(path.join(dir, 'build.zig.zon'), 'utf8');
  } catch {
    return null;
  }
  return (
    /\.\s*mach_zig_version\s*=\s*"(.*?)"/.exec(zon)?.[1] ??
    /\.\s*minimum_zig_version\s*=\s*"(.*?)"/.exec(zon)?.[1] ??
    null
  );
}

export async function resolveVersion(spec, dir) {
  if (spec === '') {
    spec = await versionFromZon(dir);
    if (spec === null) {
      info('No Zig version found in build.zig.zon; using the latest release');
      spec = 'latest';
    }
  }
  if (spec === 'master') return (await fetchJson(INDEX_URL)).master.version;
  if (spec === 'latest') return latestRelease(await fetchJson(INDEX_URL));
  if (spec.includes('mach')) {
    const version = (await fetchJson(MACH_INDEX_URL))[spec]?.version;
    if (!version) throw new Error(`Mach nominated Zig version '${spec}' not found`);
    return version;
  }
  return spec;
}

export function artifactName(
  version,
  platform = process.platform,
  arch = process.arch,
  endianness = os.endianness(),
) {
  const osName = PLATFORMS[platform];
  let cpu = ARCHES[arch];
  if (!osName || !cpu) throw new Error(`unsupported platform ${platform}-${arch}`);
  if (cpu === 'powerpc64' && endianness === 'LE') cpu = 'powerpc64le';
  if (cpu === 'arm' && versionLessThan(version, '0.15.1')) cpu = 'armv7a';

  const parsed = parseVersion(version);
  const oldLayout =
    versionLessThan(version, '0.14.1') ||
    (parsed?.major === 0 && parsed.minor === 15 && parsed.patch === 0 && parsed.dev !== null && parsed.dev < 631);
  return oldLayout ? `zig-${osName}-${cpu}-${version}` : `zig-${cpu}-${osName}-${version}`;
}

export function artifactExtension(platform = process.platform) {
  return platform === 'win32' ? '.zip' : '.tar.xz';
}

async function fetchMirrors() {
  try {
    const text = await (await request(MIRRORS_URL, { timeoutMs: 10_000 })).text();
    const mirrors = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (mirrors.length > 0) return mirrors;
  } catch (err) {
    info(`Could not fetch the community mirror list (${err.message}); using the built-in list`);
  }
  return FALLBACK_MIRRORS;
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export async function verifyArchive(file, fileName, signatureData, publicKey = ZIG_PUBLIC_KEY) {
  const signature = parseSignature(signatureData);
  if (!(await verifyFile(parsePublicKey(publicKey), signature, file))) {
    throw new Error('signature verification failed');
  }
  const signedName = /(?:^|\s)file:(\S+)/.exec(signature.trustedComment)?.[1];
  if (signedName !== fileName) {
    throw new Error(`signature is for '${signedName}', not '${fileName}'`);
  }
}

async function downloadVerified(base, fileName, dest) {
  try {
    await downloadFile(`${base}/${fileName}?source=${SOURCE}`, dest);
    const res = await request(`${base}/${fileName}.minisig?source=${SOURCE}`, { timeoutMs: 30_000 });
    const signature = Buffer.from(await res.arrayBuffer());
    await verifyArchive(dest, fileName, signature);
    await fs.promises.writeFile(`${dest}.minisig`, signature);
  } catch (err) {
    await fs.promises.rm(dest, { force: true });
    await fs.promises.rm(`${dest}.minisig`, { force: true });
    throw err;
  }
}

export async function downloadZig(version, fileName, dest, mirror = '') {
  if (mirror) {
    if (/^(https?:\/\/)?ziglang\.org(\/|$)/.test(mirror)) {
      throw new Error("ziglang.org cannot be used as the mirror override; leave 'mirror' empty and it is used as the last resort");
    }
    info(`Downloading from ${mirror}`);
    await downloadVerified(mirror.replace(/\/+$/, ''), fileName, dest);
    return mirror;
  }

  for (const candidate of shuffle(await fetchMirrors())) {
    info(`Trying mirror ${candidate}`);
    try {
      await downloadVerified(candidate, fileName, dest);
      return candidate;
    } catch (err) {
      info(`  ${err.message}`);
    }
  }

  const official = version.includes('-dev') ? 'https://ziglang.org/builds' : `https://ziglang.org/download/${version}`;
  info(`All mirrors failed; trying ${official}`);
  await downloadVerified(official, fileName, dest);
  return official;
}

export async function extractArchive(archive, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  await exec(tarPath(), ['-xf', archive, '-C', dest]);
}

// Windows' bundled bsdtar reads zip files; Git's GNU tar, which can shadow it on PATH, does not.
export function tarPath() {
  if (process.platform !== 'win32') return 'tar';
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}
