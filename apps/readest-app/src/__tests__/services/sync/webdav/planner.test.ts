import { describe, expect, it } from 'vitest';
import {
  createEmptyWebDavManifestSchema,
  createEmptyWebDavTombstonesSchema,
  type WebDavManifestEntry,
} from '@/services/sync/webdav/types';
import { planWebDavSyncOperations } from '@/services/sync/webdav/planner';

const entry = (overrides: Partial<WebDavManifestEntry> & Pick<WebDavManifestEntry, 'path'>) => ({
  path: overrides.path,
  sizeBytes: overrides.sizeBytes ?? 1,
  modifiedAtMs: overrides.modifiedAtMs ?? 1,
  etag: overrides.etag,
  checksum: overrides.checksum,
});

describe('planWebDavSyncOperations', () => {
  it('plans merge_json for Settings/settings.json when different', () => {
    const localManifest = createEmptyWebDavManifestSchema({ sourceDeviceId: 'A', nowMs: 1 });
    const remoteManifest = createEmptyWebDavManifestSchema({ sourceDeviceId: 'B', nowMs: 1 });
    localManifest.entries.push(
      entry({ path: 'Settings/settings.json', checksum: 'a', modifiedAtMs: 10 }),
    );
    remoteManifest.entries.push(
      entry({ path: 'Settings/settings.json', checksum: 'b', modifiedAtMs: 20 }),
    );

    const result = planWebDavSyncOperations({ localManifest, remoteManifest }, 123);
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        type: 'merge_json',
        path: 'Settings/settings.json',
        strategy: 'settings',
      }),
    );
  });

  it('plans upload when file exists only locally', () => {
    const localManifest = createEmptyWebDavManifestSchema({ sourceDeviceId: 'A', nowMs: 1 });
    const remoteManifest = createEmptyWebDavManifestSchema({ sourceDeviceId: 'B', nowMs: 1 });
    localManifest.entries.push(
      entry({ path: 'Books/abc/book.epub', checksum: 'c1', modifiedAtMs: 10 }),
    );

    const result = planWebDavSyncOperations({ localManifest, remoteManifest }, 123);
    expect(result.operations).toContainEqual(
      expect.objectContaining({ type: 'upload', path: 'Books/abc/book.epub' }),
    );
  });

  it('plans download when file exists only remotely', () => {
    const localManifest = createEmptyWebDavManifestSchema({ sourceDeviceId: 'A', nowMs: 1 });
    const remoteManifest = createEmptyWebDavManifestSchema({ sourceDeviceId: 'B', nowMs: 1 });
    remoteManifest.entries.push(
      entry({ path: 'Books/abc/book.epub', checksum: 'c1', modifiedAtMs: 10 }),
    );

    const result = planWebDavSyncOperations({ localManifest, remoteManifest }, 123);
    expect(result.operations).toContainEqual(
      expect.objectContaining({ type: 'download', path: 'Books/abc/book.epub' }),
    );
  });

  it('plans trash operations when tombstoned', () => {
    const localManifest = createEmptyWebDavManifestSchema({ sourceDeviceId: 'A', nowMs: 1 });
    const remoteManifest = createEmptyWebDavManifestSchema({ sourceDeviceId: 'B', nowMs: 1 });
    const tombstones = createEmptyWebDavTombstonesSchema({ nowMs: 1 });
    tombstones.tombstones.push({
      originalPath: 'Books/library.json',
      deletedAtMs: 5000,
      deletedByDeviceId: 'B',
    });
    localManifest.entries.push(
      entry({ path: 'Books/library.json', checksum: 'x', modifiedAtMs: 10 }),
    );
    remoteManifest.entries.push(
      entry({ path: 'Books/library.json', checksum: 'y', modifiedAtMs: 20 }),
    );

    const result = planWebDavSyncOperations({
      localManifest,
      remoteManifest,
      remoteTombstones: tombstones,
    });
    expect(result.operations).toContainEqual({
      type: 'trash_local',
      originalPath: 'Books/library.json',
      deletedAtMs: 5000,
    });
    expect(result.operations).toContainEqual({
      type: 'trash_remote',
      originalPath: 'Books/library.json',
      deletedAtMs: 5000,
    });
  });
});
