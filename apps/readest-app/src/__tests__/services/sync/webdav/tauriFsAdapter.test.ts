import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriFsAdapter } from '@/services/sync/webdav/tauriFsAdapter';

const { readDirMock, statMock, removeMock } = vi.hoisted(() => ({
  readDirMock: vi.fn(),
  statMock: vi.fn(),
  removeMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  stat: statMock,
  readDir: readDirMock,
  rename: vi.fn(),
  remove: removeMock,
}));

describe('TauriFsAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('readDir 在 Windows 路径不存在时返回空数组（os error 3）', async () => {
    readDirMock.mockRejectedValueOnce({
      message: 'The system cannot find the path specified. (os error 3)',
    });

    const adapter = new TauriFsAdapter();
    await expect(adapter.readDir('C:/missing')).resolves.toEqual([]);
  });

  it('stat 在路径不存在时返回 null（os error 2）', async () => {
    statMock.mockRejectedValueOnce({ message: 'No such file or directory (os error 2)' });

    const adapter = new TauriFsAdapter();
    await expect(adapter.stat('C:/missing/file.txt')).resolves.toBeNull();
  });

  it('remove 在路径不存在时不抛错（string error）', async () => {
    removeMock.mockRejectedValueOnce('File not found');

    const adapter = new TauriFsAdapter();
    await expect(adapter.remove('C:/missing/file.txt')).resolves.toBeUndefined();
  });

  it('遇到非 not-found 错误时应继续抛出', async () => {
    readDirMock.mockRejectedValueOnce({ message: 'permission denied' });

    const adapter = new TauriFsAdapter();
    await expect(adapter.readDir('C:/denied')).rejects.toBeTruthy();
  });
});
