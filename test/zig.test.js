import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  artifactExtension,
  artifactName,
  latestRelease,
  parseVersion,
  resolveVersion,
  verifyArchive,
  versionLessThan,
} from '../src/zig.js';
import { makeKey, sign, tempFile } from './helpers.js';

test('parses release and dev versions', () => {
  assert.deepEqual(parseVersion('0.16.0'), { major: 0, minor: 16, patch: 0, dev: null });
  assert.deepEqual(parseVersion('0.18.0-dev.253+16d31ceed'), { major: 0, minor: 18, patch: 0, dev: 253 });
  assert.equal(parseVersion('master'), null);
  assert.equal(parseVersion('0.16'), null);
});

test('orders versions with releases after their dev builds', () => {
  assert.equal(versionLessThan('0.15.2', '0.16.0'), true);
  assert.equal(versionLessThan('0.16.0', '0.15.2'), false);
  assert.equal(versionLessThan('0.16.0-dev.9+abc', '0.16.0'), true);
  assert.equal(versionLessThan('0.16.0', '0.16.0-dev.9+abc'), false);
  assert.equal(versionLessThan('0.16.0-dev.9+abc', '0.16.0-dev.10+abc'), true);
  assert.equal(versionLessThan('0.16.0', '0.16.0'), false);
  assert.equal(versionLessThan('garbage', '0.16.0'), false);
});

test('picks the newest tagged release from the index', () => {
  const index = { master: {}, '0.9.1': {}, '0.17.0': {}, '0.16.0': {}, '0.15.2': {} };
  assert.equal(latestRelease(index), '0.17.0');
});

test('names artifacts for current and old layouts', () => {
  assert.equal(artifactName('0.16.0', 'linux', 'x64'), 'zig-x86_64-linux-0.16.0');
  assert.equal(artifactName('0.17.0', 'darwin', 'arm64'), 'zig-aarch64-macos-0.17.0');
  assert.equal(artifactName('0.17.0', 'win32', 'x64'), 'zig-x86_64-windows-0.17.0');
  assert.equal(artifactName('0.14.1', 'linux', 'x64'), 'zig-x86_64-linux-0.14.1');
  assert.equal(artifactName('0.14.0', 'linux', 'x64'), 'zig-linux-x86_64-0.14.0');
  assert.equal(artifactName('0.15.0-dev.600+abc', 'linux', 'x64'), 'zig-linux-x86_64-0.15.0-dev.600+abc');
  assert.equal(artifactName('0.15.0-dev.631+abc', 'linux', 'x64'), 'zig-x86_64-linux-0.15.0-dev.631+abc');
  assert.equal(artifactName('0.15.0', 'linux', 'arm'), 'zig-armv7a-linux-0.15.0');
  assert.equal(artifactName('0.15.1', 'linux', 'arm'), 'zig-arm-linux-0.15.1');
  assert.equal(artifactName('0.16.0', 'linux', 'ppc64', 'LE'), 'zig-powerpc64le-linux-0.16.0');
  assert.throws(() => artifactName('0.16.0', 'aix', 'ppc64'));
});

test('uses zip only on Windows', () => {
  assert.equal(artifactExtension('win32'), '.zip');
  assert.equal(artifactExtension('linux'), '.tar.xz');
});

test('reads the version from build.zig.zon', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zig-setup-test-'));
  fs.writeFileSync(path.join(dir, 'build.zig.zon'), '.{\n    .name = .demo,\n    .minimum_zig_version = "0.16.0",\n}\n');
  assert.equal(await resolveVersion('', dir), '0.16.0');
  assert.equal(await resolveVersion('0.17.0', dir), '0.17.0');
});

test('verifies an archive against its signature and signed file name', async () => {
  const key = makeKey();
  const name = 'zig-x86_64-linux-0.16.0.tar.xz';
  const file = tempFile('archive');
  const signature = Buffer.from(sign(key, Buffer.from('archive'), { trustedComment: `timestamp:1 file:${name} hashed` }));
  await verifyArchive(file, name, signature, key.text);
  await assert.rejects(verifyArchive(file, 'zig-x86_64-linux-0.17.0.tar.xz', signature, key.text), /signature is for/);
  await assert.rejects(verifyArchive(tempFile('tampered'), name, signature, key.text), /verification failed/);
  await assert.rejects(verifyArchive(file, name, signature), /verification failed/);
});
