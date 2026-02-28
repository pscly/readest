import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { startWebDavMockServer } from '@/__tests__/helpers/webdav-mock';
import { NodeFsAdapter } from '@/__tests__/helpers/nodeFsAdapter';
import { buildWebDavSyncScope } from '@/services/sync/webdav/syncScope';
import { WebDavClient, WebDavClientError, WebDavHttpError } from '@/services/sync/webdav/client';
import {
  restoreBookFromTrash,
  syncWebDavMetadataOnce,
  WebDavSyncAlreadyRunningError,
} from '@/services/sync/webdav/engine';

const writeJson = async (filePath: string, value: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
};

const writeBytes = async (filePath: string, value: Uint8Array) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value);
};

const readBytes = async (filePath: string) => new Uint8Array(await fs.readFile(filePath));

const readServerJson = (entries: Map<string, { content: Buffer }>, targetPath: string) => {
  const entry = entries.get(targetPath);
  if (!entry) {
    throw new Error(`Missing server entry: ${targetPath}`);
  }
  return JSON.parse(entry.content.toString('utf-8')) as unknown;
};

const expectSyncStateNotAdvanced = async (params: {
  serverEntries: Map<string, unknown>;
  cfgDir: string;
  deviceId: string;
}) => {
  expect(params.serverEntries.has('/readest1/.meta/manifest.json')).toBe(false);
  expect(params.serverEntries.has('/readest1/.meta/tombstones.json')).toBe(false);
  expect(params.serverEntries.has(`/readest1/.meta/devices/${params.deviceId}.json`)).toBe(false);

  await expect(fs.stat(path.join(params.cfgDir, 'webdav.device.json'))).rejects.toBeTruthy();
  await expect(fs.stat(path.join(params.cfgDir, 'settings.json.bak'))).rejects.toBeTruthy();
};

describe('syncWebDavMetadataOnce', () => {
  it('merges settings/library/config across two devices', async () => {
    const server = await startWebDavMockServer();
    try {
      const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-A-'));
      const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-B-'));

      const cfgA = path.join(rootA, 'cfg');
      const dataA = path.join(rootA, 'data');
      const cfgB = path.join(rootB, 'cfg');
      const dataB = path.join(rootB, 'data');

      const scopeA = buildWebDavSyncScope({
        appConfigDir: cfgA,
        appDataDir: dataA,
        isPortable: false,
      });
      const scopeB = buildWebDavSyncScope({
        appConfigDir: cfgB,
        appDataDir: dataB,
        isPortable: false,
      });

      const booksRootA = scopeA.mappings.find((m) => m.key === 'Books')!.absolutePath;
      const booksRootB = scopeB.mappings.find((m) => m.key === 'Books')!.absolutePath;

      await writeJson(path.join(cfgA, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(cfgB, 'settings.json'), { themeColor: '#ff0' });

      const bookHash = 'book-1';
      await writeJson(path.join(booksRootA, 'library.json'), [
        { hash: bookHash, updatedAt: 1000, progress: [1, 10], readingStatus: 'reading' },
      ]);
      await writeJson(path.join(booksRootB, 'library.json'), [
        { hash: bookHash, updatedAt: 2000, progress: [2, 10], readingStatus: 'reading' },
      ]);

      await writeJson(path.join(booksRootA, bookHash, 'config.json'), {
        updatedAt: 1000,
        booknotes: [{ id: 'n1', type: 'note', cfi: 'cfi-1', updatedAt: 1000 }],
      });
      await writeJson(path.join(booksRootB, bookHash, 'config.json'), {
        updatedAt: 2000,
        booknotes: [{ id: 'n2', type: 'note', cfi: 'cfi-2', updatedAt: 2000 }],
      });

      const bookFileRel = path.join(bookHash, 'MyBook.epub');
      const coverFileRel = path.join(bookHash, 'cover.png');
      await writeBytes(path.join(booksRootA, bookFileRel), new Uint8Array([1, 2, 3, 4]));
      await writeBytes(path.join(booksRootA, coverFileRel), new Uint8Array([9, 9, 9]));

      const clientA = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });
      const clientB = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });

      const fsA = new NodeFsAdapter();
      const fsB = new NodeFsAdapter();

      await syncWebDavMetadataOnce({
        client: clientA,
        fs: fsA,
        scope: scopeA,
        deviceId: 'deviceA',
        nowMs: 10_000,
      });
      await syncWebDavMetadataOnce({
        client: clientB,
        fs: fsB,
        scope: scopeB,
        deviceId: 'deviceB',
        nowMs: 20_000,
      });
      await syncWebDavMetadataOnce({
        client: clientA,
        fs: fsA,
        scope: scopeA,
        deviceId: 'deviceA',
        nowMs: 30_000,
      });

      const settingsA = JSON.parse(await fs.readFile(path.join(cfgA, 'settings.json'), 'utf-8'));
      const settingsB = JSON.parse(await fs.readFile(path.join(cfgB, 'settings.json'), 'utf-8'));
      expect(settingsA).toMatchObject({ themeMode: 'light', themeColor: '#ff0' });
      expect(settingsB).toMatchObject({ themeMode: 'light', themeColor: '#ff0' });

      const configA = JSON.parse(
        await fs.readFile(path.join(booksRootA, bookHash, 'config.json'), 'utf-8'),
      );
      const configB = JSON.parse(
        await fs.readFile(path.join(booksRootB, bookHash, 'config.json'), 'utf-8'),
      );
      const notesA = (configA as { booknotes?: Array<{ id: string }> }).booknotes ?? [];
      const notesB = (configB as { booknotes?: Array<{ id: string }> }).booknotes ?? [];
      const idsA = new Set(notesA.map((n) => n.id));
      const idsB = new Set(notesB.map((n) => n.id));
      expect(idsA).toEqual(new Set(['n1', 'n2']));
      expect(idsB).toEqual(new Set(['n1', 'n2']));

      const libraryA = JSON.parse(
        await fs.readFile(path.join(booksRootA, 'library.json'), 'utf-8'),
      );
      const libraryB = JSON.parse(
        await fs.readFile(path.join(booksRootB, 'library.json'), 'utf-8'),
      );
      expect(libraryA[0].progress).toEqual([2, 10]);
      expect(libraryB[0].progress).toEqual([2, 10]);

      await expect(fs.stat(path.join(cfgA, 'settings.json.bak'))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(booksRootA, 'library.json.bak'))).resolves.toBeTruthy();

      await expect(fs.stat(path.join(booksRootB, bookFileRel))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(booksRootB, coverFileRel))).resolves.toBeTruthy();
      expect(await readBytes(path.join(booksRootB, bookFileRel))).toEqual(
        await readBytes(path.join(booksRootA, bookFileRel)),
      );
      expect(await readBytes(path.join(booksRootB, coverFileRel))).toEqual(
        await readBytes(path.join(booksRootA, coverFileRel)),
      );
    } finally {
      await server.close();
    }
  });

  it('preserves binary conflicts as conflict copies', async () => {
    const server = await startWebDavMockServer();
    try {
      const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-conflict-A-'));
      const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-conflict-B-'));

      const cfgA = path.join(rootA, 'cfg');
      const dataA = path.join(rootA, 'data');
      const cfgB = path.join(rootB, 'cfg');
      const dataB = path.join(rootB, 'data');

      const scopeA = buildWebDavSyncScope({
        appConfigDir: cfgA,
        appDataDir: dataA,
        isPortable: false,
      });
      const scopeB = buildWebDavSyncScope({
        appConfigDir: cfgB,
        appDataDir: dataB,
        isPortable: false,
      });

      const booksRootA = scopeA.mappings.find((m) => m.key === 'Books')!.absolutePath;
      const booksRootB = scopeB.mappings.find((m) => m.key === 'Books')!.absolutePath;

      const bookHash = 'book-conflict-1';
      const fileRel = path.join(bookHash, 'MyBook.epub');
      const fileAbsA = path.join(booksRootA, fileRel);
      const fileAbsB = path.join(booksRootB, fileRel);

      await writeBytes(fileAbsA, new Uint8Array([0, 0, 0, 1]));
      await writeBytes(fileAbsB, new Uint8Array([0, 0, 0, 2]));

      await fs.utimes(fileAbsA, new Date(1000), new Date(1000));
      await fs.utimes(fileAbsB, new Date(2000), new Date(2000));

      const clientA = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });
      const clientB = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });
      const fsA = new NodeFsAdapter();
      const fsB = new NodeFsAdapter();

      await syncWebDavMetadataOnce({
        client: clientB,
        fs: fsB,
        scope: scopeB,
        deviceId: 'deviceB',
        nowMs: 10_000,
      });
      await syncWebDavMetadataOnce({
        client: clientA,
        fs: fsA,
        scope: scopeA,
        deviceId: 'deviceA',
        nowMs: 20_000,
      });
      await syncWebDavMetadataOnce({
        client: clientB,
        fs: fsB,
        scope: scopeB,
        deviceId: 'deviceB',
        nowMs: 30_000,
      });

      const bytesA = await readBytes(fileAbsA);
      const bytesB = await readBytes(fileAbsB);
      expect(bytesA).toEqual(new Uint8Array([0, 0, 0, 2]));
      expect(bytesB).toEqual(new Uint8Array([0, 0, 0, 2]));

      const conflictsA = await fs.readdir(path.join(booksRootA, bookHash, 'conflicts'));
      expect(
        conflictsA.some((name) => name.includes('.conflict.local.') && name.endsWith('.epub')),
      ).toBe(true);
      const conflictNameA = conflictsA.find(
        (name) => name.includes('.conflict.local.') && name.endsWith('.epub'),
      )!;
      expect(await readBytes(path.join(booksRootA, bookHash, 'conflicts', conflictNameA))).toEqual(
        new Uint8Array([0, 0, 0, 1]),
      );

      const conflictsB = await fs.readdir(path.join(booksRootB, bookHash, 'conflicts'));
      expect(
        conflictsB.some((name) => name.includes('.conflict.local.') && name.endsWith('.epub')),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('retries merge_json after 412 precondition failure and finally succeeds', async () => {
    const server = await startWebDavMockServer();
    try {
      const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-412-A-'));
      const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-412-B-'));

      const cfgA = path.join(rootA, 'cfg');
      const dataA = path.join(rootA, 'data');
      const cfgB = path.join(rootB, 'cfg');
      const dataB = path.join(rootB, 'data');

      const scopeA = buildWebDavSyncScope({
        appConfigDir: cfgA,
        appDataDir: dataA,
        isPortable: false,
      });
      const scopeB = buildWebDavSyncScope({
        appConfigDir: cfgB,
        appDataDir: dataB,
        isPortable: false,
      });

      await writeJson(path.join(cfgA, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(cfgB, 'settings.json'), { themeColor: '#00ff00' });

      const clientA = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });
      const clientB = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });

      const fsA = new NodeFsAdapter();
      const fsB = new NodeFsAdapter();

      await syncWebDavMetadataOnce({
        client: clientA,
        fs: fsA,
        scope: scopeA,
        deviceId: 'deviceA',
        nowMs: 10_000,
      });

      let settingsWriteCount = 0;
      let tampered = false;
      const originalPutText = clientB.putText.bind(clientB);
      clientB.putText = async (...args: Parameters<typeof originalPutText>) => {
        if (args[0] === 'Settings/settings.json') {
          settingsWriteCount += 1;
          if (!tampered) {
            tampered = true;
            const target = server.state.entries.get('/readest1/Settings/settings.json');
            if (target) {
              target.content = Buffer.from(JSON.stringify({ remoteOnlyFlag: true }, null, 2));
              target.etag = '"forced-new-etag"';
              target.lastModifiedMs = Date.now();
            }
          }
        }
        return originalPutText(...args);
      };

      await syncWebDavMetadataOnce({
        client: clientB,
        fs: fsB,
        scope: scopeB,
        deviceId: 'deviceB',
        nowMs: 20_000,
      });

      expect(tampered).toBe(true);
      expect(settingsWriteCount).toBe(2);

      const remoteSettings = readServerJson(
        server.state.entries as unknown as Map<string, { content: Buffer }>,
        '/readest1/Settings/settings.json',
      ) as { themeMode?: string; themeColor?: string; remoteOnlyFlag?: boolean };
      expect(remoteSettings.themeColor).toBe('#00ff00');
      expect(remoteSettings.remoteOnlyFlag).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('does not leave target or tmp files when binary download is interrupted', async () => {
    const server = await startWebDavMockServer();
    try {
      const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-abort-A-'));
      const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-abort-B-'));

      const cfgA = path.join(rootA, 'cfg');
      const dataA = path.join(rootA, 'data');
      const cfgB = path.join(rootB, 'cfg');
      const dataB = path.join(rootB, 'data');

      const scopeA = buildWebDavSyncScope({
        appConfigDir: cfgA,
        appDataDir: dataA,
        isPortable: false,
      });
      const scopeB = buildWebDavSyncScope({
        appConfigDir: cfgB,
        appDataDir: dataB,
        isPortable: false,
      });

      const booksRootA = scopeA.mappings.find((m) => m.key === 'Books')!.absolutePath;
      const booksRootB = scopeB.mappings.find((m) => m.key === 'Books')!.absolutePath;

      const bookHash = 'book-abort-1';
      const fileName = 'BrokenDownload.epub';
      const fileRel = path.join(bookHash, fileName);
      const fileAbsA = path.join(booksRootA, fileRel);
      const fileAbsB = path.join(booksRootB, fileRel);

      await writeBytes(fileAbsA, new Uint8Array([1, 2, 3, 4, 5, 6]));

      const clientA = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });
      const clientB = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });

      const fsA = new NodeFsAdapter();
      const fsB = new NodeFsAdapter();

      await syncWebDavMetadataOnce({
        client: clientA,
        fs: fsA,
        scope: scopeA,
        deviceId: 'deviceA',
        nowMs: 10_000,
      });

      server.state.abortGetPaths.add(`/readest1/Books/${bookHash}/${fileName}`);

      await expect(
        syncWebDavMetadataOnce({
          client: clientB,
          fs: fsB,
          scope: scopeB,
          deviceId: 'deviceB',
          nowMs: 20_000,
        }),
      ).rejects.toBeTruthy();

      await expect(fs.stat(fileAbsB)).rejects.toBeTruthy();

      const entries = await fs.readdir(path.join(booksRootB, bookHash)).catch(() => [] as string[]);
      expect(entries.some((entry) => entry.startsWith(`${fileName}.tmp.`))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('Task14: 删除传播到回收站并可恢复整本书目录', async () => {
    const server = await startWebDavMockServer();
    try {
      const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-trash-A-'));
      const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-trash-B-'));

      const cfgA = path.join(rootA, 'cfg');
      const dataA = path.join(rootA, 'data');
      const cfgB = path.join(rootB, 'cfg');
      const dataB = path.join(rootB, 'data');

      const scopeA = buildWebDavSyncScope({
        appConfigDir: cfgA,
        appDataDir: dataA,
        isPortable: false,
      });
      const scopeB = buildWebDavSyncScope({
        appConfigDir: cfgB,
        appDataDir: dataB,
        isPortable: false,
      });

      const booksRootA = scopeA.mappings.find((m) => m.key === 'Books')!.absolutePath;
      const booksRootB = scopeB.mappings.find((m) => m.key === 'Books')!.absolutePath;

      const bookHash = 'book-trash-1';
      const deletedAtMs = 50_000;
      await writeJson(path.join(cfgA, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(cfgB, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(booksRootA, 'library.json'), [
        { hash: bookHash, title: 'Book Trash', updatedAt: 1_000, deletedAt: null },
      ]);
      await writeJson(path.join(booksRootA, bookHash, 'config.json'), {
        updatedAt: 1_000,
        booknotes: [{ id: 'n1', type: 'note', cfi: 'cfi', note: 'n', updatedAt: 1_000 }],
      });
      await writeBytes(path.join(booksRootA, bookHash, 'Book.epub'), new Uint8Array([1, 2, 3]));
      await writeBytes(path.join(booksRootA, bookHash, 'cover.png'), new Uint8Array([9, 8, 7]));

      const clientA = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });
      const clientB = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });

      const fsA = new NodeFsAdapter();
      const fsB = new NodeFsAdapter();

      await syncWebDavMetadataOnce({
        client: clientA,
        fs: fsA,
        scope: scopeA,
        deviceId: 'deviceA',
        nowMs: 10_000,
      });
      await syncWebDavMetadataOnce({
        client: clientB,
        fs: fsB,
        scope: scopeB,
        deviceId: 'deviceB',
        nowMs: 20_000,
      });

      await fs.rm(path.join(booksRootA, bookHash), { recursive: true, force: true });
      await writeJson(path.join(booksRootA, 'library.json'), [
        {
          hash: bookHash,
          title: 'Book Trash',
          updatedAt: deletedAtMs,
          deletedAt: deletedAtMs,
        },
      ]);

      await syncWebDavMetadataOnce({
        client: clientA,
        fs: fsA,
        scope: scopeA,
        deviceId: 'deviceA',
        nowMs: 60_000,
      });

      expect(
        server.state.entries.has(`/readest1/.trash/${deletedAtMs}/Books/${bookHash}/Book.epub`),
      ).toBe(true);

      const tombstones = readServerJson(
        server.state.entries as unknown as Map<string, { content: Buffer }>,
        '/readest1/.meta/tombstones.json',
      ) as { tombstones: Array<{ originalPath: string; deletedAtMs: number }> };
      expect(
        tombstones.tombstones.some(
          (entry) =>
            entry.originalPath === `Books/${bookHash}/Book.epub` &&
            entry.deletedAtMs === deletedAtMs,
        ),
      ).toBe(true);

      await syncWebDavMetadataOnce({
        client: clientB,
        fs: fsB,
        scope: scopeB,
        deviceId: 'deviceB',
        nowMs: 70_000,
      });

      const localTrashBookPath = path.join(
        path.dirname(booksRootB),
        '.trash',
        `${deletedAtMs}`,
        'Books',
        bookHash,
        'Book.epub',
      );
      await expect(fs.stat(path.join(booksRootB, bookHash, 'Book.epub'))).rejects.toBeTruthy();
      await expect(fs.stat(localTrashBookPath)).resolves.toBeTruthy();

      const restoreResult = await restoreBookFromTrash({
        fs: fsB,
        scope: scopeB,
        bookHash,
      });
      expect(restoreResult).toMatchObject({ restored: true, deletedAtMs });
      await expect(fs.stat(path.join(booksRootB, bookHash, 'Book.epub'))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(booksRootB, bookHash, 'config.json'))).resolves.toBeTruthy();
      expect(await readBytes(path.join(booksRootB, bookHash, 'Book.epub'))).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    } finally {
      await server.close();
    }
  });

  it('Task14: 仅清理超过 90 天的 tombstone 与远端 trash 项', async () => {
    const server = await startWebDavMockServer();
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-retention-'));
      const cfg = path.join(root, 'cfg');
      const data = path.join(root, 'data');
      const nowMs = 100 * 24 * 60 * 60 * 1000;
      const oldDeletedAtMs = nowMs - 91 * 24 * 60 * 60 * 1000;
      const freshDeletedAtMs = nowMs - 1 * 24 * 60 * 60 * 1000;

      const scope = buildWebDavSyncScope({
        appConfigDir: cfg,
        appDataDir: data,
        isPortable: false,
      });
      await writeJson(path.join(cfg, 'settings.json'), { themeMode: 'light' });

      const client = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });

      await client.mkcol('');
      await client.mkcol('.meta');
      await client.mkcol('.trash');
      await client.mkcol(`.trash/${oldDeletedAtMs}`);
      await client.mkcol(`.trash/${oldDeletedAtMs}/Books`);
      await client.mkcol(`.trash/${oldDeletedAtMs}/Books/book-old`);
      await client.putBytes(
        `.trash/${oldDeletedAtMs}/Books/book-old/old.epub`,
        new Uint8Array([1, 1, 1]),
      );

      await client.mkcol(`.trash/${freshDeletedAtMs}`);
      await client.mkcol(`.trash/${freshDeletedAtMs}/Books`);
      await client.mkcol(`.trash/${freshDeletedAtMs}/Books/book-new`);
      await client.putBytes(
        `.trash/${freshDeletedAtMs}/Books/book-new/new.epub`,
        new Uint8Array([2, 2, 2]),
      );

      await client.putText(
        '.meta/tombstones.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAtMs: nowMs,
            updatedAtMs: nowMs,
            tombstones: [
              {
                originalPath: 'Books/book-old/old.epub',
                deletedAtMs: oldDeletedAtMs,
                deletedByDeviceId: 'deviceA',
              },
              {
                originalPath: 'Books/book-new/new.epub',
                deletedAtMs: freshDeletedAtMs,
                deletedByDeviceId: 'deviceA',
              },
            ],
          },
          null,
          2,
        ),
        'application/json',
      );

      await client.putText(
        '.meta/manifest.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAtMs: nowMs,
            updatedAtMs: nowMs,
            sourceDeviceId: 'deviceA',
            entries: [],
          },
          null,
          2,
        ),
        'application/json',
      );

      await syncWebDavMetadataOnce({
        client,
        fs: new NodeFsAdapter(),
        scope,
        deviceId: 'deviceB',
        nowMs,
      });

      expect(
        server.state.entries.has(`/readest1/.trash/${oldDeletedAtMs}/Books/book-old/old.epub`),
      ).toBe(false);
      expect(
        server.state.entries.has(`/readest1/.trash/${freshDeletedAtMs}/Books/book-new/new.epub`),
      ).toBe(true);

      const tombstones = readServerJson(
        server.state.entries as unknown as Map<string, { content: Buffer }>,
        '/readest1/.meta/tombstones.json',
      ) as {
        tombstones: Array<{ originalPath: string; deletedAtMs: number }>;
      };
      expect(tombstones.tombstones).toHaveLength(1);
      expect(tombstones.tombstones[0]).toMatchObject({
        originalPath: 'Books/book-new/new.epub',
        deletedAtMs: freshDeletedAtMs,
      });
    } finally {
      await server.close();
    }
  });

  it('rejects concurrent sync runs with a clear error', async () => {
    const server = await startWebDavMockServer({ delayMs: 250 });
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-lock-'));
      const cfg = path.join(root, 'cfg');
      const data = path.join(root, 'data');

      const scope = buildWebDavSyncScope({
        appConfigDir: cfg,
        appDataDir: data,
        isPortable: false,
      });
      await writeJson(path.join(cfg, 'settings.json'), { themeMode: 'light' });

      const client = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });
      const adapter = new NodeFsAdapter();

      const first = syncWebDavMetadataOnce({
        client,
        fs: adapter,
        scope,
        deviceId: 'deviceA',
        nowMs: 10_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(
        syncWebDavMetadataOnce({
          client,
          fs: adapter,
          scope,
          deviceId: 'deviceA',
          nowMs: 10_001,
        }),
      ).rejects.toBeInstanceOf(WebDavSyncAlreadyRunningError);

      await first;
    } finally {
      await server.close();
    }
  });

  it('does not write manifest/device state when auth fails', async () => {
    const server = await startWebDavMockServer();
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-authfail-'));
      const cfg = path.join(root, 'cfg');
      const data = path.join(root, 'data');

      const scope = buildWebDavSyncScope({
        appConfigDir: cfg,
        appDataDir: data,
        isPortable: false,
      });
      await writeJson(path.join(cfg, 'settings.json'), { themeMode: 'light' });

      const client = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'wrong-pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });

      const adapter = new NodeFsAdapter();
      await expect(
        syncWebDavMetadataOnce({
          client,
          fs: adapter,
          scope,
          deviceId: 'deviceA',
          nowMs: 10_000,
        }),
      ).rejects.toMatchObject({ status: 401 });

      await expectSyncStateNotAdvanced({
        serverEntries: server.state.entries,
        cfgDir: cfg,
        deviceId: 'deviceA',
      });
    } catch (error) {
      if (error instanceof WebDavHttpError) {
        throw error;
      }
      throw error;
    } finally {
      await server.close();
    }
  });

  it('does not write manifest/device state when remote directory is read-only (403)', async () => {
    const server = await startWebDavMockServer();
    server.state.readOnlyPaths.add('/readest1');
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-readonly-'));
      const cfg = path.join(root, 'cfg');
      const data = path.join(root, 'data');

      const scope = buildWebDavSyncScope({
        appConfigDir: cfg,
        appDataDir: data,
        isPortable: false,
      });
      await writeJson(path.join(cfg, 'settings.json'), { themeMode: 'light' });

      const client = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 5_000,
        maxRetries: 0,
      });

      const adapter = new NodeFsAdapter();
      await expect(
        syncWebDavMetadataOnce({
          client,
          fs: adapter,
          scope,
          deviceId: 'deviceA',
          nowMs: 10_000,
        }),
      ).rejects.toMatchObject({ status: 403 });

      await expectSyncStateNotAdvanced({
        serverEntries: server.state.entries,
        cfgDir: cfg,
        deviceId: 'deviceA',
      });
    } catch (error) {
      if (error instanceof WebDavHttpError) {
        throw error;
      }
      throw error;
    } finally {
      await server.close();
    }
  });

  it('does not write manifest/device state when request times out', async () => {
    const server = await startWebDavMockServer({ delayMs: 200 });
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readest-webdav-timeout-'));
      const cfg = path.join(root, 'cfg');
      const data = path.join(root, 'data');

      const scope = buildWebDavSyncScope({
        appConfigDir: cfg,
        appDataDir: data,
        isPortable: false,
      });
      await writeJson(path.join(cfg, 'settings.json'), { themeMode: 'light' });

      const client = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 1,
        maxRetries: 0,
      });

      const adapter = new NodeFsAdapter();
      await expect(
        syncWebDavMetadataOnce({
          client,
          fs: adapter,
          scope,
          deviceId: 'deviceA',
          nowMs: 10_000,
        }),
      ).rejects.toBeInstanceOf(WebDavClientError);

      await expectSyncStateNotAdvanced({
        serverEntries: server.state.entries,
        cfgDir: cfg,
        deviceId: 'deviceA',
      });
    } catch (error) {
      if (error instanceof WebDavHttpError) {
        throw error;
      }
      throw error;
    } finally {
      await server.close();
    }
  });
});
