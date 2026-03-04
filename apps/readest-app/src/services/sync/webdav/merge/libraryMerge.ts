import { Book, ReadingStatus } from '@/types/book';

type Side = 'local' | 'remote';

type ParseStatus = 'missing' | 'ok' | 'failed';

interface ParsedLibraryResult {
  books: Book[];
  status: ParseStatus;
  raw: string | null;
}

export interface MergeLibraryInput {
  localLibraryJson: string | null;
  remoteLibraryJson: string | null;
  nowMs?: number;
  deviceId?: string;
}

export interface LibraryConflictCopy {
  relativePath: string;
  json: string;
}

export interface MergeLibraryResult {
  mergedJson: string;
  conflictCopies: LibraryConflictCopy[];
  warnings: string[];
  writeLocal: boolean;
  writeRemote: boolean;
}

const READING_STATUS_RANK: Record<ReadingStatus, number> = {
  unread: 0,
  reading: 1,
  finished: 2,
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const asTimestamp = (value: unknown): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const getBookUpdatedAt = (book: Partial<Book> | undefined, fallbackTs: number): number => {
  if (!book) return fallbackTs;
  const updatedAt = asTimestamp(book.updatedAt);
  if (updatedAt > 0) return updatedAt;

  const lastUpdated = asTimestamp(book.lastUpdated);
  if (lastUpdated > 0) return lastUpdated;

  return fallbackTs;
};

const parseLibraryJson = (
  libraryJson: string | null,
  side: Side,
  warnings: string[],
): ParsedLibraryResult => {
  if (libraryJson === null) {
    return { books: [], status: 'missing', raw: null };
  }

  try {
    const parsed = JSON.parse(libraryJson) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('library.json 内容不是数组');
    }

    const books: Book[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) {
        warnings.push(`${side} library.json 包含无效书籍条目（缺少 hash）`);
        continue;
      }

      const hash = item['hash'];
      if (typeof hash !== 'string') {
        warnings.push(`${side} library.json 包含无效书籍条目（缺少 hash）`);
        continue;
      }
      books.push(item as unknown as Book);
    }

    return { books, status: 'ok', raw: libraryJson };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${side} library.json 解析失败：${message}`);
    return { books: [], status: 'failed', raw: libraryJson };
  }
};

const normalizeBook = (book: Book, fallbackTs: number): Book => {
  return {
    ...book,
    updatedAt: getBookUpdatedAt(book, fallbackTs),
  };
};

const pickByUpdatedAt = <T>(
  localValue: T | undefined,
  remoteValue: T | undefined,
  localUpdatedAt: number,
  remoteUpdatedAt: number,
): T | undefined => {
  if (localValue === undefined && remoteValue === undefined) return undefined;
  if (localValue === undefined) return remoteValue;
  if (remoteValue === undefined) return localValue;
  return remoteUpdatedAt > localUpdatedAt ? remoteValue : localValue;
};

const getStatusRank = (status: ReadingStatus | undefined): number => {
  if (!status) return -1;
  return READING_STATUS_RANK[status] ?? -1;
};

const mergeReadingStatus = (
  localStatus: ReadingStatus | undefined,
  remoteStatus: ReadingStatus | undefined,
  localUpdatedAt: number,
  remoteUpdatedAt: number,
): ReadingStatus | undefined => {
  const localRank = getStatusRank(localStatus);
  const remoteRank = getStatusRank(remoteStatus);

  if (localRank < 0 && remoteRank < 0) return undefined;
  if (localRank > remoteRank) return localStatus;
  if (remoteRank > localRank) return remoteStatus;
  return remoteUpdatedAt > localUpdatedAt ? remoteStatus : localStatus;
};

const mergeBook = (localBook: Book, remoteBook: Book, fallbackTs: number): Book => {
  const normalizedLocal = normalizeBook(localBook, fallbackTs);
  const normalizedRemote = normalizeBook(remoteBook, fallbackTs);

  const localUpdatedAt = normalizedLocal.updatedAt;
  const remoteUpdatedAt = normalizedRemote.updatedAt;
  const mergedUpdatedAt = Math.max(localUpdatedAt, remoteUpdatedAt);
  const newerSideBook = remoteUpdatedAt > localUpdatedAt ? normalizedRemote : normalizedLocal;
  const olderSideBook = remoteUpdatedAt > localUpdatedAt ? normalizedLocal : normalizedRemote;

  const merged: Book = {
    ...olderSideBook,
    ...newerSideBook,
    hash: normalizedLocal.hash,
    updatedAt: mergedUpdatedAt,
  };

  const mergedDeletedAt = Math.max(
    asTimestamp(normalizedLocal.deletedAt),
    asTimestamp(normalizedRemote.deletedAt),
  );
  merged.deletedAt = mergedDeletedAt > 0 ? mergedDeletedAt : null;

  merged.readingStatus = mergeReadingStatus(
    normalizedLocal.readingStatus,
    normalizedRemote.readingStatus,
    localUpdatedAt,
    remoteUpdatedAt,
  );

  merged.progress = pickByUpdatedAt(
    normalizedLocal.progress,
    normalizedRemote.progress,
    localUpdatedAt,
    remoteUpdatedAt,
  );

  merged.metadata = pickByUpdatedAt(
    normalizedLocal.metadata,
    normalizedRemote.metadata,
    localUpdatedAt,
    remoteUpdatedAt,
  );

  return merged;
};

const mergeBooks = (localBooks: Book[], remoteBooks: Book[], fallbackTs: number): Book[] => {
  const localByHash = new Map<string, Book>(
    localBooks.map((book) => [book.hash, normalizeBook(book, fallbackTs)]),
  );
  const remoteByHash = new Map<string, Book>(
    remoteBooks.map((book) => [book.hash, normalizeBook(book, fallbackTs)]),
  );

  const mergedBooks: Book[] = [];
  const mergedHashes = new Set<string>();

  for (const localBook of localBooks) {
    const hash = localBook.hash;
    const normalizedLocal = localByHash.get(hash);
    if (!normalizedLocal) continue;

    const remoteMatch = remoteByHash.get(hash);
    mergedBooks.push(
      remoteMatch ? mergeBook(normalizedLocal, remoteMatch, fallbackTs) : normalizedLocal,
    );
    mergedHashes.add(hash);
  }

  const remoteOnlyBooks = remoteBooks
    .filter((book) => !mergedHashes.has(book.hash))
    .map((book) => remoteByHash.get(book.hash))
    .filter((book): book is Book => Boolean(book))
    .sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return left.updatedAt - right.updatedAt;
      }
      return left.hash.localeCompare(right.hash);
    });

  return [...mergedBooks, ...remoteOnlyBooks];
};

const buildConflictPath = (params: {
  side: Side;
  deviceId: string;
  ts: number;
  index: number;
}): string => {
  const safeDevice = params.deviceId || 'device';
  if (params.index === 0) {
    return `Books/conflicts/library.conflict.${params.side}.${safeDevice}.${params.ts}.json`;
  }
  return `Books/conflicts/library.conflict.${params.side}.${safeDevice}.${params.ts}.${params.index}.json`;
};

export const mergeLibraryJson = ({
  localLibraryJson,
  remoteLibraryJson,
  nowMs,
  deviceId,
}: MergeLibraryInput): MergeLibraryResult => {
  const warnings: string[] = [];
  const ts = nowMs ?? Date.now();
  const sourceDeviceId = deviceId ?? 'device';
  const conflictCopies: LibraryConflictCopy[] = [];
  const conflictIndexBySide: Record<Side, number> = { local: 0, remote: 0 };

  const parsedLocal = parseLibraryJson(localLibraryJson, 'local', warnings);
  const parsedRemote = parseLibraryJson(remoteLibraryJson, 'remote', warnings);

  const pushConflictCopy = (side: Side, raw: string | null) => {
    if (raw === null) {
      return;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    const index = conflictIndexBySide[side];
    conflictIndexBySide[side] += 1;
    conflictCopies.push({
      relativePath: buildConflictPath({
        side,
        deviceId: sourceDeviceId,
        ts,
        index,
      }),
      json: raw,
    });
  };

  if (parsedLocal.status === 'failed') {
    pushConflictCopy('local', parsedLocal.raw);
  }
  if (parsedRemote.status === 'failed') {
    pushConflictCopy('remote', parsedRemote.raw);
  }

  const normalizedLocalJson = JSON.stringify(
    parsedLocal.books.map((book) => normalizeBook(book, ts)),
    null,
    2,
  );
  const normalizedRemoteJson = JSON.stringify(
    parsedRemote.books.map((book) => normalizeBook(book, ts)),
    null,
    2,
  );

  if (parsedLocal.status === 'ok' && parsedRemote.status === 'ok') {
    const mergedBooks = mergeBooks(parsedLocal.books, parsedRemote.books, ts);
    return {
      mergedJson: JSON.stringify(mergedBooks, null, 2),
      conflictCopies,
      warnings,
      writeLocal: true,
      writeRemote: true,
    };
  }

  if (parsedRemote.status === 'ok' && parsedLocal.status !== 'ok') {
    return {
      mergedJson: normalizedRemoteJson,
      conflictCopies,
      warnings,
      writeLocal: true,
      writeRemote: false,
    };
  }

  if (parsedLocal.status === 'ok' && parsedRemote.status === 'missing') {
    return {
      mergedJson: normalizedLocalJson,
      conflictCopies,
      warnings,
      writeLocal: true,
      writeRemote: true,
    };
  }

  if (parsedLocal.status === 'ok' && parsedRemote.status === 'failed') {
    if (parsedLocal.books.length === 0) {
      warnings.push(
        '远端 library.json 解析失败，且本地书库为空：为避免覆盖远端数据，本次跳过合并写入',
      );
      return {
        mergedJson: normalizedLocalJson,
        conflictCopies,
        warnings,
        writeLocal: false,
        writeRemote: false,
      };
    }
    return {
      mergedJson: normalizedLocalJson,
      conflictCopies,
      warnings,
      writeLocal: true,
      writeRemote: true,
    };
  }

  warnings.push('本地与远端 library.json 都无法解析：为避免数据丢失，本次跳过覆盖写入');
  return {
    mergedJson: JSON.stringify([], null, 2),
    conflictCopies,
    warnings,
    writeLocal: false,
    writeRemote: false,
  };
};
