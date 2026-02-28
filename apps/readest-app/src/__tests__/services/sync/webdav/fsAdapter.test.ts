import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { NodeFsAdapter } from '@/__tests__/helpers/nodeFsAdapter';
import { decodeUtf8, encodeUtf8, writeJsonAtomic } from '@/services/sync/webdav/fsAdapter';

describe('NodeFsAdapter.writeFileAtomic', () => {
  it('does not corrupt existing JSON when rename fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-fs-'));
    const filePath = path.join(dir, 'settings.json');
    await fs.writeFile(filePath, encodeUtf8(JSON.stringify({ ok: true }, null, 2)));

    const adapter = new NodeFsAdapter({
      beforeRename: async () => {
        throw new Error('Injected failure before rename');
      },
    });

    await expect(writeJsonAtomic(adapter, filePath, { ok: false })).rejects.toThrow(
      'Injected failure',
    );

    const content = await fs.readFile(filePath);
    expect(JSON.parse(decodeUtf8(new Uint8Array(content)))).toEqual({ ok: true });
  });

  it('writes new JSON atomically on success', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-fs-'));
    const filePath = path.join(dir, 'settings.json');

    const adapter = new NodeFsAdapter();
    await writeJsonAtomic(adapter, filePath, { ok: true });

    const content = await fs.readFile(filePath);
    expect(JSON.parse(decodeUtf8(new Uint8Array(content)))).toEqual({ ok: true });
  });
});
