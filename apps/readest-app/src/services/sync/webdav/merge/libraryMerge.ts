import { Book, ReadingStatus } from '@/types/book';

type Side = 'local' | 'remote';

interface ParsedLibraryResult {
  books: Book[];
  parseFailed: boolean;
}

export interface MergeLibraryInput {
  localLibraryJson: string | null;
  remoteLibraryJson: string | null;
  nowMs?: number;
}

export interface MergeLibraryResult {
  mergedJson: string;
  warnings: string[];
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
    return { books: [], parseFailed: false };
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

    return { books, parseFailed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${side} library.json 解析失败：${message}`);
    return { books: [], parseFailed: true };
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

export const mergeLibraryJson = ({
  localLibraryJson,
  remoteLibraryJson,
  nowMs,
}: MergeLibraryInput): MergeLibraryResult => {
  const warnings: string[] = [];
  const ts = nowMs ?? Date.now();

  const parsedLocal = parseLibraryJson(localLibraryJson, 'local', warnings);
  const parsedRemote = parseLibraryJson(remoteLibraryJson, 'remote', warnings);

  if (parsedLocal.parseFailed && !parsedRemote.parseFailed) {
    return {
      mergedJson: JSON.stringify(
        parsedRemote.books.map((book) => normalizeBook(book, ts)),
        null,
        2,
      ),
      warnings,
    };
  }

  if (parsedRemote.parseFailed && !parsedLocal.parseFailed) {
    return {
      mergedJson: JSON.stringify(
        parsedLocal.books.map((book) => normalizeBook(book, ts)),
        null,
        2,
      ),
      warnings,
    };
  }

  if (parsedLocal.parseFailed && parsedRemote.parseFailed) {
    return {
      mergedJson: JSON.stringify([], null, 2),
      warnings,
    };
  }

  const mergedBooks = mergeBooks(parsedLocal.books, parsedRemote.books, ts);
  return {
    mergedJson: JSON.stringify(mergedBooks, null, 2),
    warnings,
  };
};
