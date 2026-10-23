// Read an exact shipped text entry for offline compatibility tests. Never writes ASAR.
import { open } from 'node:fs/promises';
export async function readAsarText(archive, entry) {
  const file = await open(archive, 'r');
  try {
    const prefix = Buffer.alloc(16);
    await file.read(prefix, 0, 16, 0);
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
    if (headerSize > 32_000_000 || jsonSize > headerSize - 8) throw new Error('Invalid ASAR header');
    const bytes = Buffer.alloc(jsonSize);
    await file.read(bytes, 0, jsonSize, 16);
    const tree = JSON.parse(bytes.toString('utf8'));
    let wanted = entry;
    for (let hop = 0; hop < 8; hop++) {
      let node = tree;
      const parts = wanted.split('/');
      for (let i = 0; i < parts.length; i++) {
        node = node.files?.[parts[i]];
        if (!node) throw new Error('ASAR reference not found: ' + wanted);
        if (node.link) { wanted = node.link + (i + 1 < parts.length ? '/' + parts.slice(i + 1).join('/') : ''); break; }
      }
      if (node.link) continue;
      if (node.unpacked || !Number.isSafeInteger(node.size)) throw new Error('Not a packed text file');
      const body = Buffer.alloc(node.size);
      await file.read(body, 0, body.length, 8 + headerSize + Number(node.offset));
      return body.toString('utf8');
    }
    throw new Error('ASAR link cycle');
  } finally { await file.close(); }
}
