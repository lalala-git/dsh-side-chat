// Deterministic npm-style .tgz for identical input bytes and Node/zlib toolchain.
// Node built-ins only: no package manager, downloads, prepare scripts,
// profile access, shell tools or deletion.
import { readFile, writeFile, lstat, open } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderClient } from './build.mjs';
const mode = process.argv[2];
if (process.argv.length > 3 || (mode && !['--replace-existing', '--check'].includes(mode))) throw new Error('Only --replace-existing or --check is supported');
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.name !== 'dsh-plugin-side-chat-native' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Unexpected package destination');
if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('An explicit runtime file allowlist is required');
const names = ['package.json', ...manifest.files];
if (new Set(names).size !== names.length || names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || path.posix.normalize(name) !== name || name.split('/').includes('..') || Buffer.byteLength('package/' + name) > 100)) throw new Error('Package files must be unique, literal relative file paths');
for (const entry of [manifest.main, ...Object.values(manifest.exports ?? {}), manifest.dsh?.bundle?.patch]) {
  if (typeof entry !== 'string' || !entry.startsWith('./') || !names.includes(entry.slice(2))) throw new Error('Package entry is missing from the runtime allowlist');
}
if (await readFile(path.join(root, 'lib/client.js'), 'utf8') !== await renderClient()) throw new Error('Client bundle is stale; run node scripts/build.mjs before packaging.');
const parts = [];
for (const name of names) {
  const source = path.join(root, name), info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not an ordinary package file: ' + name);
  const data = await readFile(source), header = Buffer.alloc(512);
  header.write('package/' + name, 0, 100, 'utf8');
  const octal = (offset, length, value) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, data.length); octal(136, 12, 0);
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
}
const tar = Buffer.concat([...parts, Buffer.alloc(1024)]), compressed = gzipSync(tar, { level: 9 });
if (!gunzipSync(compressed).equals(tar)) throw new Error('Archive round-trip validation failed');
const output = path.join(root, `${manifest.name}-${manifest.version}.tgz`);
if (mode === '--check') {
  const info = await lstat(output);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not an existing ordinary package: ' + output);
  if (!(await readFile(output)).equals(compressed)) throw new Error('Existing package does not match current release inputs; rebuild the intended version before release.');
} else if (mode === '--replace-existing') {
  // Explicit in-place mode: no unlink/rename, new path or staging file. Read
  // and validate the existing package before overwriting that exact file.
  const info = await lstat(output);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not an existing ordinary package: ' + output);
  const file = await open(output, 'r+');
  try {
    const previous = gunzipSync(await file.readFile());
    if (previous.subarray(0, 100).toString('utf8').split('\0')[0] !== 'package/package.json') throw new Error('Existing file is not this package format');
    const manifestSize = parseInt(previous.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim(), 8);
    const existing = JSON.parse(previous.subarray(512, 512 + manifestSize).toString('utf8'));
    if (existing.name !== manifest.name || existing.version !== manifest.version) throw new Error('Existing package identity does not match');
    let offset = 0;
    while (offset < compressed.length) {
      const { bytesWritten } = await file.write(compressed, offset, compressed.length - offset, offset);
      if (!bytesWritten) throw new Error('Package overwrite made no progress');
      offset += bytesWritten;
    }
    await file.truncate(compressed.length);
    const written = Buffer.alloc(compressed.length);
    let read = 0;
    while (read < written.length) {
      const { bytesRead } = await file.read(written, read, written.length - read, read);
      if (!bytesRead) throw new Error('Truncated package after overwrite');
      read += bytesRead;
    }
    if (!written.equals(compressed) || !gunzipSync(written).equals(tar)) throw new Error('Written package failed verification');
  } finally { await file.close(); }
} else {
  // New releases are immutable: an existing version is never overwritten here.
  await writeFile(output, compressed, { flag: 'wx' });
}
console.log(`Verified ${names.length} files: ${output}`);
console.log(`SHA256 ${createHash('sha256').update(compressed).digest('hex')}`);
