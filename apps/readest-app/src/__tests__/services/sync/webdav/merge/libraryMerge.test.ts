import { describe, expect, it } from 'vitest';
import { Book } from '@/types/book';
import { mergeLibraryJson } from '@/services/sync/webdav/merge/libraryMerge';

const NOW_MS = 1700000000000;

const createBook = (partial: Partial<Book> & Pick<Book, 'hash'>): Book => {
  return {
    hash: partial.hash,
    format: partial.format ?? 'EPUB',
    title: partial.title ?? `title-${partial.hash}`,
    author: partial.author ?? 'author',
    createdAt: partial.createdAt ?? 1,
    updatedAt: partial.updatedAt ?? 1,
    deletedAt: partial.deletedAt,
    readingStatus: partial.readingStatus,
    progress: partial.progress,
    metadata: partial.metadata,
  };
};

describe('mergeLibraryJson', () => {
  it('additive: merges local and remote books without dropping entries', () => {
    const localLibraryJson = JSON.stringify([createBook({ hash: 'book-a', updatedAt: 100 })]);
    const remoteLibraryJson = JSON.stringify([createBook({ hash: 'book-b', updatedAt: 200 })]);

    const result = mergeLibraryJson({
      localLibraryJson,
      remoteLibraryJson,
      nowMs: NOW_MS,
    });
    const merged = JSON.parse(result.mergedJson) as Book[];

    expect(result.warnings).toEqual([]);
    expect(result.conflictCopies).toEqual([]);
    expect(result.writeLocal).toBe(true);
    expect(result.writeRemote).toBe(true);
    expect(merged.map((book) => book.hash)).toEqual(['book-a', 'book-b']);
  });

  it('progress does not roll back when local side is newer', () => {
    const localLibraryJson = JSON.stringify([
      createBook({
        hash: 'book-progress',
        updatedAt: 300,
        progress: [50, 100],
        readingStatus: 'reading',
      }),
    ]);
    const remoteLibraryJson = JSON.stringify([
      createBook({
        hash: 'book-progress',
        updatedAt: 100,
        progress: [10, 100],
        readingStatus: 'reading',
      }),
    ]);

    const result = mergeLibraryJson({
      localLibraryJson,
      remoteLibraryJson,
      nowMs: NOW_MS,
    });
    const merged = JSON.parse(result.mergedJson) as Book[];

    expect(result.conflictCopies).toEqual([]);
    expect(result.writeLocal).toBe(true);
    expect(result.writeRemote).toBe(true);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.progress).toEqual([50, 100]);
    expect(merged[0]?.updatedAt).toBe(300);
  });

  it('deletedAt keeps the later tombstone and entry remains in output', () => {
    const localLibraryJson = JSON.stringify([
      createBook({ hash: 'book-deleted', updatedAt: 150, deletedAt: 100 }),
    ]);
    const remoteLibraryJson = JSON.stringify([
      createBook({ hash: 'book-deleted', updatedAt: 160, deletedAt: 200 }),
    ]);

    const result = mergeLibraryJson({
      localLibraryJson,
      remoteLibraryJson,
      nowMs: NOW_MS,
    });
    const merged = JSON.parse(result.mergedJson) as Book[];

    expect(result.conflictCopies).toEqual([]);
    expect(result.writeLocal).toBe(true);
    expect(result.writeRemote).toBe(true);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.hash).toBe('book-deleted');
    expect(merged[0]?.deletedAt).toBe(200);
  });

  it('keeps remote intact when local is corrupted (writes local only)', () => {
    const localLibraryJson = '{invalid-json';
    const remoteLibraryJson = JSON.stringify([createBook({ hash: 'book-remote', updatedAt: 123 })]);

    const result = mergeLibraryJson({
      localLibraryJson,
      remoteLibraryJson,
      nowMs: NOW_MS,
      deviceId: 'device-a',
    });

    const merged = JSON.parse(result.mergedJson) as Book[];
    expect(merged.map((book) => book.hash)).toEqual(['book-remote']);
    expect(result.writeLocal).toBe(true);
    expect(result.writeRemote).toBe(false);
    expect(result.conflictCopies).toHaveLength(1);
    expect(result.conflictCopies[0]?.relativePath).toContain(
      'Books/conflicts/library.conflict.local.device-a',
    );
    expect(result.conflictCopies[0]?.json).toBe(localLibraryJson);
  });

  it('skips overwrite when remote is corrupted and local is empty', () => {
    const localLibraryJson = JSON.stringify([]);
    const remoteLibraryJson = '{corrupted';

    const result = mergeLibraryJson({
      localLibraryJson,
      remoteLibraryJson,
      nowMs: NOW_MS,
      deviceId: 'device-a',
    });

    expect(result.writeLocal).toBe(false);
    expect(result.writeRemote).toBe(false);
    expect(result.conflictCopies).toHaveLength(1);
    expect(result.conflictCopies[0]?.relativePath).toContain(
      'Books/conflicts/library.conflict.remote.device-a',
    );
    expect(result.conflictCopies[0]?.json).toBe(remoteLibraryJson);
    expect(result.warnings.join('\n')).toContain('本地书库为空');
  });

  it('repairs remote when remote is corrupted but local has data', () => {
    const localLibraryJson = JSON.stringify([createBook({ hash: 'book-local', updatedAt: 100 })]);
    const remoteLibraryJson = '{corrupted';

    const result = mergeLibraryJson({
      localLibraryJson,
      remoteLibraryJson,
      nowMs: NOW_MS,
      deviceId: 'device-a',
    });

    const merged = JSON.parse(result.mergedJson) as Book[];
    expect(merged.map((book) => book.hash)).toEqual(['book-local']);
    expect(result.writeLocal).toBe(true);
    expect(result.writeRemote).toBe(true);
    expect(result.conflictCopies).toHaveLength(1);
    expect(result.conflictCopies[0]?.relativePath).toContain(
      'Books/conflicts/library.conflict.remote.device-a',
    );
  });

  it('skips overwrite when both sides are corrupted', () => {
    const localLibraryJson = '{bad-local';
    const remoteLibraryJson = '{bad-remote';

    const result = mergeLibraryJson({
      localLibraryJson,
      remoteLibraryJson,
      nowMs: NOW_MS,
      deviceId: 'device-a',
    });

    expect(result.writeLocal).toBe(false);
    expect(result.writeRemote).toBe(false);
    expect(result.conflictCopies).toHaveLength(2);
    expect(result.warnings.join('\n')).toContain('都无法解析');
  });
});
