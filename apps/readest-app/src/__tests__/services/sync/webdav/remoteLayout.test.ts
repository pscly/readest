import { describe, expect, it } from 'vitest';
import manifestFixture from '@/__tests__/fixtures/webdav/manifest.sample.json';
import tombstonesFixture from '@/__tests__/fixtures/webdav/tombstones.sample.json';
import {
  getDeviceInfoPath,
  getManifestPath,
  getTombstonesPath,
  getTrashPath,
  normalizeRootDir,
} from '@/services/sync/webdav/remoteLayout';

const collectForbiddenKeyPaths = (value: unknown, currentPath = '$'): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectForbiddenKeyPaths(item, `${currentPath}[${index}]`),
    );
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const keyPath = `${currentPath}.${key}`;
      const forbidden = ['password', 'token', 'authorization'].includes(key.toLowerCase())
        ? [keyPath]
        : [];
      return [...forbidden, ...collectForbiddenKeyPaths(child, keyPath)];
    });
  }

  return [];
};

describe('remoteLayout', () => {
  it('normalizes rootDir and encodes each path segment', () => {
    expect(normalizeRootDir('readest1/')).toBe('readest1');
    expect(normalizeRootDir('/readest1//')).toBe('readest1');

    expect(getManifestPath('readest1/')).toBe('/readest1/.meta/manifest.json');
    expect(getTombstonesPath('/readest1//')).toBe('/readest1/.meta/tombstones.json');
    expect(getDeviceInfoPath('readest1', '设备 A #1%?')).toBe(
      '/readest1/.meta/devices/%E8%AE%BE%E5%A4%87%20A%20%231%25%3F.json',
    );

    expect(getTrashPath('readest1/', 1730000900000, 'Books/中文 空格#%?/book?.epub')).toBe(
      '/readest1/.trash/1730000900000/Books/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC%23%25%3F/book%3F.epub',
    );
  });

  it('schema objects do not contain forbidden credential keys', () => {
    const manifest = manifestFixture;
    const tombstones = tombstonesFixture;
    const device = {
      schemaVersion: 1,
      deviceId: 'desktop-001',
      name: 'Readest Desktop',
      platform: 'linux',
      appVersion: '0.0.1',
      updatedAt: 1730001200000,
    };

    expect(collectForbiddenKeyPaths(manifest)).toEqual([]);
    expect(collectForbiddenKeyPaths(tombstones)).toEqual([]);
    expect(collectForbiddenKeyPaths(device)).toEqual([]);
  });
});
