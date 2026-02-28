import { describe, expect, it } from 'vitest';
import { mergeBookConfigJson } from '@/services/sync/webdav/merge/bookConfigMerge';

const BOOK_HASH = 'book-hash-1';
const DEVICE_ID = 'device-a';
const NOW_MS = 1700000000000;

const conflictPath = `Books/${BOOK_HASH}/conflicts/config.${DEVICE_ID}.${NOW_MS}.json`;

describe('mergeBookConfigJson', () => {
  it('notes additive: merges different note ids without conflict copy', () => {
    const localConfigJson = JSON.stringify({
      updatedAt: 100,
      booknotes: [
        {
          id: 'note-a',
          type: 'annotation',
          cfi: 'epubcfi(/6/2)',
          note: 'local-note-a',
          createdAt: 1,
          updatedAt: 100,
        },
      ],
    });

    const remoteConfigJson = JSON.stringify({
      updatedAt: 200,
      booknotes: [
        {
          id: 'note-b',
          type: 'annotation',
          cfi: 'epubcfi(/6/4)',
          note: 'remote-note-b',
          createdAt: 2,
          updatedAt: 200,
        },
      ],
    });

    const result = mergeBookConfigJson({
      bookHash: BOOK_HASH,
      deviceId: DEVICE_ID,
      localConfigJson,
      remoteConfigJson,
      nowMs: NOW_MS,
    });

    const merged = JSON.parse(result.mergedJson) as {
      booknotes: Array<{ id: string; note: string }>;
      updatedAt: number;
    };

    expect(result.conflictCopies).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(merged.booknotes.map((note) => note.id)).toEqual(['note-a', 'note-b']);
    expect(merged.updatedAt).toBe(NOW_MS);
  });

  it('notes conflict: keeps local note and creates conflict copy with remote note', () => {
    const localConfigJson = JSON.stringify({
      updatedAt: 300,
      booknotes: [
        {
          id: 'note-1',
          type: 'annotation',
          cfi: 'epubcfi(/6/8)',
          note: 'local-content',
          createdAt: 10,
          updatedAt: 300,
        },
      ],
    });

    const remoteConfigJson = JSON.stringify({
      updatedAt: 400,
      booknotes: [
        {
          id: 'note-1',
          type: 'annotation',
          cfi: 'epubcfi(/6/8)',
          note: 'remote-content',
          createdAt: 10,
          updatedAt: 400,
        },
      ],
    });

    const result = mergeBookConfigJson({
      bookHash: BOOK_HASH,
      deviceId: DEVICE_ID,
      localConfigJson,
      remoteConfigJson,
      nowMs: NOW_MS,
    });

    const merged = JSON.parse(result.mergedJson) as {
      booknotes: Array<{ id: string; note: string }>;
    };
    const conflictJson = JSON.parse(result.conflictCopies[0]!.json) as {
      booknotes?: Array<{ id: string; note: string }>;
    };

    expect(result.conflictCopies.length).toBeGreaterThanOrEqual(1);
    expect(result.conflictCopies[0]!.relativePath).toBe(conflictPath);
    expect(merged.booknotes.find((note) => note.id === 'note-1')?.note).toBe('local-content');
    expect(conflictJson.booknotes?.find((note) => note.id === 'note-1')?.note).toBe(
      'remote-content',
    );
  });

  it('tombstone: keeps note with later deletedAt value', () => {
    const localConfigJson = JSON.stringify({
      updatedAt: 150,
      booknotes: [
        {
          id: 'note-tombstone',
          type: 'annotation',
          cfi: 'epubcfi(/6/10)',
          note: 'active-local',
          createdAt: 3,
          updatedAt: 150,
        },
      ],
    });

    const remoteConfigJson = JSON.stringify({
      updatedAt: 140,
      booknotes: [
        {
          id: 'note-tombstone',
          type: 'annotation',
          cfi: 'epubcfi(/6/10)',
          note: 'deleted-remote',
          createdAt: 3,
          updatedAt: 120,
          deletedAt: 500,
        },
      ],
    });

    const result = mergeBookConfigJson({
      bookHash: BOOK_HASH,
      deviceId: DEVICE_ID,
      localConfigJson,
      remoteConfigJson,
      nowMs: NOW_MS,
    });

    const merged = JSON.parse(result.mergedJson) as {
      booknotes: Array<{ id: string; deletedAt?: number }>;
    };

    expect(result.conflictCopies).toEqual([]);
    expect(merged.booknotes.find((note) => note.id === 'note-tombstone')?.deletedAt).toBe(500);
  });

  it('bad json: degrades gracefully and stores invalid remote raw text in conflict copy', () => {
    const localConfigJson = JSON.stringify({
      updatedAt: 60,
      location: 'epubcfi(/6/12)',
      progress: [10, 100],
    });
    const remoteConfigJson = '{';

    const result = mergeBookConfigJson({
      bookHash: BOOK_HASH,
      deviceId: DEVICE_ID,
      localConfigJson,
      remoteConfigJson,
      nowMs: NOW_MS,
    });

    const merged = JSON.parse(result.mergedJson) as {
      location?: string;
      progress?: [number, number];
      updatedAt: number;
    };
    const conflictJson = JSON.parse(result.conflictCopies[0]!.json) as {
      side?: string;
      rawText?: string;
    };

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.conflictCopies.length).toBe(1);
    expect(result.conflictCopies[0]!.relativePath).toBe(conflictPath);
    expect(conflictJson.side).toBe('remote');
    expect(conflictJson.rawText).toBe(remoteConfigJson);
    expect(merged.location).toBe('epubcfi(/6/12)');
    expect(merged.progress).toEqual([10, 100]);
    expect(merged.updatedAt).toBe(NOW_MS);
  });
});
