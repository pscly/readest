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

    expect(merged).toHaveLength(1);
    expect(merged[0]?.hash).toBe('book-deleted');
    expect(merged[0]?.deletedAt).toBe(200);
  });
});
