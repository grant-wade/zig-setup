import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function getInput(name) {
  return (process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '').trim();
}

export function getBooleanInput(name) {
  const value = getInput(name).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(`Input '${name}' must be 'true' or 'false'`);
}

function escapeData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function command(name, message) {
  process.stdout.write(`::${name}::${escapeData(message)}${os.EOL}`);
}

export function info(message) {
  process.stdout.write(`${message}${os.EOL}`);
}

export function warning(message) {
  command('warning', message);
}

export function startGroup(name) {
  command('group', name);
}

export function endGroup() {
  process.stdout.write(`::endgroup::${os.EOL}`);
}

function appendFileCommand(envName, key, value) {
  const file = process.env[envName];
  if (!file) throw new Error(`${envName} is not set`);
  const delimiter = `ghadelimiter_${randomUUID()}`;
  fs.appendFileSync(file, `${key}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}${os.EOL}`);
}

export function exportVariable(name, value) {
  process.env[name] = value;
  appendFileCommand('GITHUB_ENV', name, value);
}

export function setOutput(name, value) {
  appendFileCommand('GITHUB_OUTPUT', name, value);
}

export function saveState(name, value) {
  appendFileCommand('GITHUB_STATE', name, value);
}

export function getState(name) {
  return process.env[`STATE_${name}`] ?? '';
}

export function addPath(dir) {
  const file = process.env.GITHUB_PATH;
  if (!file) throw new Error('GITHUB_PATH is not set');
  fs.appendFileSync(file, `${dir}${os.EOL}`);
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
}

export function exec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(file)} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export async function run(fn) {
  try {
    await fn();
  } catch (err) {
    command('error', err?.message ?? String(err));
    process.exitCode = 1;
  }
}
