import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { startWebDavMockServer } from '@/__tests__/helpers/webdav-mock';
import { NodeFsAdapter } from '@/__tests__/helpers/nodeFsAdapter';
import { buildWebDavSyncScope } from '@/services/sync/webdav/syncScope';
import { WebDavClient } from '@/services/sync/webdav/client';
import { restoreBookFromTrash, syncWebDavMetadataOnce } from '@/services/sync/webdav/engine';

const FIXED_NOW_MS = 1_700_000_000_000;

const writeJson = async (filePath: string, value: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
};

const writeBytes = async (filePath: string, value: Uint8Array) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value);
};

const createClient = (baseUrl: string, password = 'pass') => {
  return new WebDavClient({
    baseUrl,
    rootDir: 'readest1',
    username: 'user',
    password,
    timeoutMs: 5_000,
    maxRetries: 0,
  });
};

const createWorkspace = async (prefix: string) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `readest-webdav-int-${prefix}-`));
  const cfgDir = path.join(root, 'cfg');
  const dataDir = path.join(root, 'data');
  const scope = buildWebDavSyncScope({
    appConfigDir: cfgDir,
    appDataDir: dataDir,
    isPortable: false,
  });
  const booksRoot = scope.mappings.find((mapping) => mapping.key === 'Books')!.absolutePath;
  return { root, cfgDir, dataDir, scope, booksRoot };
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
};

describe('WebDAV sync integration (two-device)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('合并：deviceA 改 settings + deviceB 加笔记，最终一致', async () => {
    const server = await startWebDavMockServer();
    try {
      const workspaceA = await createWorkspace('merge-A');
      const workspaceB = await createWorkspace('merge-B');

      const bookHash = 'book-merge-1';
      await writeJson(path.join(workspaceA.cfgDir, 'settings.json'), {
        themeMode: 'light',
        themeColor: '#112233',
      });
      await writeJson(path.join(workspaceB.cfgDir, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(workspaceA.booksRoot, 'library.json'), [
        { hash: bookHash, updatedAt: 1000 },
      ]);
      await writeJson(path.join(workspaceB.booksRoot, 'library.json'), [
        { hash: bookHash, updatedAt: 2000 },
      ]);
      await writeJson(path.join(workspaceA.booksRoot, bookHash, 'config.json'), {
        updatedAt: 1000,
        booknotes: [],
      });
      await writeJson(path.join(workspaceB.booksRoot, bookHash, 'config.json'), {
        updatedAt: 2000,
        booknotes: [
          {
            id: 'note-device-b',
            type: 'annotation',
            cfi: 'epubcfi(/6/2)',
            note: 'from-device-b',
            createdAt: 2,
            updatedAt: 2000,
          },
        ],
      });

      await syncWebDavMetadataOnce({
        client: createClient(server.baseUrl),
        fs: new NodeFsAdapter(),
        scope: workspaceA.scope,
        deviceId: 'deviceA',
        nowMs: 10_000,
      });
      await syncWebDavMetadataOnce({
        client: createClient(server.baseUrl),
        fs: new NodeFsAdapter(),
        scope: workspaceB.scope,
        deviceId: 'deviceB',
        nowMs: 20_000,
      });
      await syncWebDavMetadataOnce({
        client: createClient(server.baseUrl),
        fs: new NodeFsAdapter(),
        scope: workspaceA.scope,
        deviceId: 'deviceA',
        nowMs: 30_000,
      });

      const settingsA = JSON.parse(
        await fs.readFile(path.join(workspaceA.cfgDir, 'settings.json'), 'utf-8'),
      );
      const settingsB = JSON.parse(
        await fs.readFile(path.join(workspaceB.cfgDir, 'settings.json'), 'utf-8'),
      );
      expect(settingsA.themeColor).toBe('#112233');
      expect(settingsB.themeColor).toBe('#112233');

      const configA = JSON.parse(
        await fs.readFile(path.join(workspaceA.booksRoot, bookHash, 'config.json'), 'utf-8'),
      ) as { booknotes?: Array<{ id: string; note: string }> };
      const configB = JSON.parse(
        await fs.readFile(path.join(workspaceB.booksRoot, bookHash, 'config.json'), 'utf-8'),
      ) as { booknotes?: Array<{ id: string; note: string }> };
      expect(configA.booknotes?.some((note) => note.id === 'note-device-b')).toBe(true);
      expect(configB.booknotes?.some((note) => note.id === 'note-device-b')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('冲突：同一 noteId 不同内容会生成冲突副本且不覆盖原件', async () => {
    const server = await startWebDavMockServer();
    try {
      const workspaceA = await createWorkspace('note-conflict-A');
      const workspaceB = await createWorkspace('note-conflict-B');

      const bookHash = 'book-note-conflict-1';
      await writeJson(path.join(workspaceA.cfgDir, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(workspaceB.cfgDir, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(workspaceA.booksRoot, 'library.json'), [
        { hash: bookHash, updatedAt: 1000 },
      ]);
      await writeJson(path.join(workspaceB.booksRoot, 'library.json'), [
        { hash: bookHash, updatedAt: 2000 },
      ]);

      await writeJson(path.join(workspaceA.booksRoot, bookHash, 'config.json'), {
        updatedAt: 1000,
        booknotes: [
          {
            id: 'note-1',
            type: 'annotation',
            cfi: 'epubcfi(/6/8)',
            note: 'from-device-a',
            createdAt: 1,
            updatedAt: 1000,
          },
        ],
      });
      await writeJson(path.join(workspaceB.booksRoot, bookHash, 'config.json'), {
        updatedAt: 2000,
        booknotes: [
          {
            id: 'note-1',
            type: 'annotation',
            cfi: 'epubcfi(/6/8)',
            note: 'from-device-b',
            createdAt: 1,
            updatedAt: 2000,
          },
        ],
      });

      await syncWebDavMetadataOnce({
        client: createClient(server.baseUrl),
        fs: new NodeFsAdapter(),
        scope: workspaceA.scope,
        deviceId: 'deviceA',
        nowMs: 40_000,
      });
      await syncWebDavMetadataOnce({
        client: createClient(server.baseUrl),
        fs: new NodeFsAdapter(),
        scope: workspaceB.scope,
        deviceId: 'deviceB',
        nowMs: 50_000,
      });

      const mergedB = JSON.parse(
        await fs.readFile(path.join(workspaceB.booksRoot, bookHash, 'config.json'), 'utf-8'),
      ) as { booknotes?: Array<{ id: string; note: string }> };
      expect(mergedB.booknotes?.find((note) => note.id === 'note-1')?.note).toBe('from-device-b');

      const conflictsDir = path.join(workspaceB.booksRoot, bookHash, 'conflicts');
      const conflictFiles = await fs.readdir(conflictsDir);
      const conflictFile = conflictFiles.find((fileName) =>
        /^config\.deviceB\.50000(?:\.\d+)?\.json$/.test(fileName),
      );
      expect(conflictFile).toBeTruthy();

      const conflictJson = JSON.parse(
        await fs.readFile(path.join(conflictsDir, conflictFile!), 'utf-8'),
      ) as { booknotes?: Array<{ id: string; note: string }> };
      expect(conflictJson.booknotes?.find((note) => note.id === 'note-1')?.note).toBe(
        'from-device-a',
      );
    } finally {
      await server.close();
    }
  });

  it('删除：deviceA 删除书后，deviceB 同步进入回收站并可恢复', async () => {
    const server = await startWebDavMockServer();
    try {
      const workspaceA = await createWorkspace('trash-A');
      const workspaceB = await createWorkspace('trash-B');

      const bookHash = 'book-trash-integration-1';
      const deletedAtMs = 60_000;
      await writeJson(path.join(workspaceA.cfgDir, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(workspaceB.cfgDir, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(workspaceA.booksRoot, 'library.json'), [
        { hash: bookHash, title: 'Trash Book', updatedAt: 1000, deletedAt: null },
      ]);
      await writeJson(path.join(workspaceA.booksRoot, bookHash, 'config.json'), {
        updatedAt: 1000,
        booknotes: [{ id: 'n1', type: 'note', cfi: 'cfi', note: 'note', updatedAt: 1000 }],
      });
      await writeBytes(
        path.join(workspaceA.booksRoot, bookHash, 'Book.epub'),
        new Uint8Array([1, 2, 3]),
      );

      await syncWebDavMetadataOnce({
        client: createClient(server.baseUrl),
        fs: new NodeFsAdapter(),
        scope: workspaceA.scope,
        deviceId: 'deviceA',
        nowMs: 10_000,
      });
      await syncWebDavMetadataOnce({
        client: createClient(server.baseUrl),
        fs: new NodeFsAdapter(),
        scope: workspaceB.scope,
        deviceId: 'deviceB',
        nowMs: 20_000,
      });

      await fs.rm(path.join(workspaceA.booksRoot, bookHash), { recursive: true, force: true });
      await writeJson(path.join(workspaceA.booksRoot, 'library.json'), [
        { hash: bookHash, title: 'Trash Book', updatedAt: deletedAtMs, deletedAt: deletedAtMs },
      ]);

      await syncWebDavMetadataOnce({
        client: createClient(server.baseUrl),
        fs: new NodeFsAdapter(),
        scope: workspaceA.scope,
        deviceId: 'deviceA',
        nowMs: 70_000,
      });
      await syncWebDavMetadataOnce({
        client: createClient(server.baseUrl),
        fs: new NodeFsAdapter(),
        scope: workspaceB.scope,
        deviceId: 'deviceB',
        nowMs: 80_000,
      });

      const trashBookPath = path.join(
        path.dirname(workspaceB.booksRoot),
        '.trash',
        `${deletedAtMs}`,
        'Books',
        bookHash,
        'Book.epub',
      );
      await expect(
        fs.stat(path.join(workspaceB.booksRoot, bookHash, 'Book.epub')),
      ).rejects.toBeTruthy();
      await expect(fs.stat(trashBookPath)).resolves.toBeTruthy();

      const restoreResult = await restoreBookFromTrash({
        fs: new NodeFsAdapter(),
        scope: workspaceB.scope,
        bookHash,
      });
      expect(restoreResult).toMatchObject({ restored: true, deletedAtMs });
      await expect(
        fs.stat(path.join(workspaceB.booksRoot, bookHash, 'Book.epub')),
      ).resolves.toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('认证失败：错误密码不推进 manifest/tombstones/device 状态', async () => {
    const server = await startWebDavMockServer();
    try {
      const workspaceA = await createWorkspace('auth-fail-A');
      await writeJson(path.join(workspaceA.cfgDir, 'settings.json'), { themeMode: 'light' });

      await expect(
        syncWebDavMetadataOnce({
          client: createClient(server.baseUrl, 'wrong-pass'),
          fs: new NodeFsAdapter(),
          scope: workspaceA.scope,
          deviceId: 'deviceA',
          nowMs: 90_000,
        }),
      ).rejects.toMatchObject({ status: 401 });

      await expectSyncStateNotAdvanced({
        serverEntries: server.state.entries,
        cfgDir: workspaceA.cfgDir,
        deviceId: 'deviceA',
      });
    } finally {
      await server.close();
    }
  });

  it('超时：请求超时时不推进状态且不产生坏 JSON/坏二进制', async () => {
    vi.useRealTimers();
    const server = await startWebDavMockServer({ delayMs: 80 });
    try {
      const workspaceA = await createWorkspace('timeout-A');
      const bookHash = 'book-timeout-integration-1';
      const binaryPath = path.join(workspaceA.booksRoot, bookHash, 'Book.epub');
      const originalBytes = new Uint8Array([4, 2, 6, 8]);

      await writeJson(path.join(workspaceA.cfgDir, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(workspaceA.booksRoot, 'library.json'), [
        { hash: bookHash, updatedAt: 1000 },
      ]);
      await writeBytes(binaryPath, originalBytes);

      await expect(
        syncWebDavMetadataOnce({
          client: new WebDavClient({
            baseUrl: server.baseUrl,
            rootDir: 'readest1',
            username: 'user',
            password: 'pass',
            timeoutMs: 20,
            maxRetries: 0,
          }),
          fs: new NodeFsAdapter(),
          scope: workspaceA.scope,
          deviceId: 'deviceA',
          nowMs: 95_000,
        }),
      ).rejects.toThrow(/超时/);

      await expectSyncStateNotAdvanced({
        serverEntries: server.state.entries,
        cfgDir: workspaceA.cfgDir,
        deviceId: 'deviceA',
      });

      const settingsText = await fs.readFile(
        path.join(workspaceA.cfgDir, 'settings.json'),
        'utf-8',
      );
      const libraryText = await fs.readFile(
        path.join(workspaceA.booksRoot, 'library.json'),
        'utf-8',
      );
      expect(() => JSON.parse(settingsText)).not.toThrow();
      expect(() => JSON.parse(libraryText)).not.toThrow();

      const currentBytes = await fs.readFile(binaryPath);
      expect(Array.from(currentBytes)).toEqual(Array.from(originalBytes));

      const binaryDirEntries = await fs.readdir(path.dirname(binaryPath));
      expect(binaryDirEntries.some((entry) => entry.startsWith('Book.epub.tmp.'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('断网：下载中断时不产生坏目标文件与 tmp 残留，现有 JSON 仍可解析', async () => {
    const server = await startWebDavMockServer();
    try {
      const workspaceA = await createWorkspace('abort-A');
      const workspaceB = await createWorkspace('abort-B');

      const bookHash = 'book-abort-integration-1';
      const fileName = 'BrokenDownload.epub';
      const fileRel = path.join(bookHash, fileName);
      const fileAbsA = path.join(workspaceA.booksRoot, fileRel);
      const fileAbsB = path.join(workspaceB.booksRoot, fileRel);

      await writeJson(path.join(workspaceA.cfgDir, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(workspaceB.cfgDir, 'settings.json'), { themeMode: 'light' });
      await writeJson(path.join(workspaceA.booksRoot, 'library.json'), [
        { hash: bookHash, updatedAt: 1000 },
      ]);
      await writeJson(path.join(workspaceB.booksRoot, 'library.json'), [
        { hash: bookHash, updatedAt: 1000 },
      ]);
      await writeBytes(fileAbsA, new Uint8Array([9, 8, 7, 6, 5, 4]));

      await syncWebDavMetadataOnce({
        client: createClient(server.baseUrl),
        fs: new NodeFsAdapter(),
        scope: workspaceA.scope,
        deviceId: 'deviceA',
        nowMs: 100_000,
      });

      server.state.abortGetPaths.add(`/readest1/Books/${bookHash}/${fileName}`);

      await expect(
        syncWebDavMetadataOnce({
          client: createClient(server.baseUrl),
          fs: new NodeFsAdapter(),
          scope: workspaceB.scope,
          deviceId: 'deviceB',
          nowMs: 110_000,
        }),
      ).rejects.toBeTruthy();

      await expect(fs.stat(fileAbsB)).rejects.toBeTruthy();

      const entries = await fs
        .readdir(path.join(workspaceB.booksRoot, bookHash))
        .catch(() => [] as string[]);
      expect(entries.some((entry) => entry.startsWith(`${fileName}.tmp.`))).toBe(false);

      const localLibraryText = await fs.readFile(
        path.join(workspaceB.booksRoot, 'library.json'),
        'utf-8',
      );
      expect(() => JSON.parse(localLibraryText)).not.toThrow();
    } finally {
      await server.close();
    }
  });
});
