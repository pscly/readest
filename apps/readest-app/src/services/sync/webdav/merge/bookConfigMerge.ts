import { BookConfig, BookNote } from '@/types/book';

type Side = 'local' | 'remote';

interface ParsedConfigResult {
  config: Partial<BookConfig> & Record<string, unknown>;
  parseError: string | null;
}

export interface BookConfigConflictCopy {
  relativePath: string;
  json: string;
}

export interface MergeBookConfigResult {
  mergedJson: string;
  conflictCopies: BookConfigConflictCopy[];
  warnings: string[];
}

export interface MergeBookConfigInput {
  bookHash: string;
  deviceId: string;
  localConfigJson: string | null;
  remoteConfigJson: string | null;
  nowMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) return false;
    }
    return true;
  }

  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!(key in right)) return false;
      if (!deepEqual(left[key], right[key])) return false;
    }
    return true;
  }

  return false;
};

const asTimestamp = (value: unknown): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const parseConfigJson = (
  configJson: string | null,
  side: Side,
  warnings: string[],
): ParsedConfigResult => {
  if (configJson === null) {
    return { config: { updatedAt: 0 }, parseError: null };
  }

  try {
    const parsed = JSON.parse(configJson) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('配置内容不是对象');
    }

    return {
      config: parsed as Partial<BookConfig> & Record<string, unknown>,
      parseError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${side} config.json 解析失败：${message}`);
    return {
      config: { updatedAt: 0 },
      parseError: message,
    };
  }
};

const chooseFieldByUpdatedAt = (
  localConfig: Partial<BookConfig>,
  remoteConfig: Partial<BookConfig>,
  key: 'progress' | 'location' | 'xpointer',
): unknown => {
  const localValue = localConfig[key];
  const remoteValue = remoteConfig[key];

  if (localValue === undefined && remoteValue === undefined) return undefined;
  if (localValue === undefined) return remoteValue;
  if (remoteValue === undefined) return localValue;

  const localUpdatedAt = asTimestamp(localConfig.updatedAt);
  const remoteUpdatedAt = asTimestamp(remoteConfig.updatedAt);
  return remoteUpdatedAt > localUpdatedAt ? remoteValue : localValue;
};

const normalizeNotes = (notes: unknown): BookNote[] => {
  if (!Array.isArray(notes)) return [];
  return notes.filter((note): note is BookNote => {
    if (!isRecord(note)) return false;
    const id = note['id'];
    return typeof id === 'string';
  });
};

const mergeBooknotes = (
  localConfig: Partial<BookConfig>,
  remoteConfig: Partial<BookConfig>,
): { notes: BookNote[] | undefined; hasConflict: boolean } => {
  const localNotes = normalizeNotes(localConfig.booknotes);
  const remoteNotes = normalizeNotes(remoteConfig.booknotes);

  const hasBooknotes =
    Array.isArray(localConfig.booknotes) || Array.isArray(remoteConfig.booknotes);
  if (!hasBooknotes) return { notes: undefined, hasConflict: false };

  const mergedById = new Map<string, BookNote>();
  let hasConflict = false;

  for (const note of localNotes) {
    mergedById.set(note.id, { ...note });
  }

  for (const incoming of remoteNotes) {
    const existing = mergedById.get(incoming.id);
    if (!existing) {
      mergedById.set(incoming.id, { ...incoming });
      continue;
    }

    const noteChanged = !deepEqual(existing, incoming);
    const hasDeletedAtChange = (existing.deletedAt ?? 0) !== (incoming.deletedAt ?? 0);
    if (noteChanged && !hasDeletedAtChange) {
      hasConflict = true;
      mergedById.set(incoming.id, { ...existing });
      continue;
    }

    const shouldTakeIncoming =
      existing.updatedAt < incoming.updatedAt ||
      (existing.deletedAt ?? 0) < (incoming.deletedAt ?? 0);

    const winner = shouldTakeIncoming ? { ...existing, ...incoming } : { ...incoming, ...existing };

    mergedById.set(incoming.id, winner);
  }

  return {
    notes: Array.from(mergedById.values()).sort((left, right) => left.id.localeCompare(right.id)),
    hasConflict,
  };
};

const mergeSectionWithConflict = (
  localSection: unknown,
  remoteSection: unknown,
): { merged: Record<string, unknown> | undefined; hasConflict: boolean } => {
  const localObj = isRecord(localSection) ? localSection : undefined;
  const remoteObj = isRecord(remoteSection) ? remoteSection : undefined;

  if (!localObj && !remoteObj) {
    return { merged: undefined, hasConflict: false };
  }
  if (!localObj && remoteObj) {
    return { merged: { ...remoteObj }, hasConflict: false };
  }
  if (localObj && !remoteObj) {
    return { merged: { ...localObj }, hasConflict: false };
  }

  const merged: Record<string, unknown> = {};
  let hasConflict = false;
  const keys = new Set([...Object.keys(localObj!), ...Object.keys(remoteObj!)]);

  for (const key of keys) {
    const localValue = localObj![key];
    const remoteValue = remoteObj![key];

    if (localValue === undefined && remoteValue === undefined) continue;
    if (localValue === undefined) {
      merged[key] = remoteValue;
      continue;
    }
    if (remoteValue === undefined) {
      merged[key] = localValue;
      continue;
    }

    if (deepEqual(localValue, remoteValue)) {
      merged[key] = localValue;
      continue;
    }

    hasConflict = true;
    merged[key] = localValue;
  }

  return { merged, hasConflict };
};

const buildConflictPath = (
  bookHash: string,
  deviceId: string,
  ts: number,
  index: number,
): string => {
  if (index === 0) {
    return `Books/${bookHash}/conflicts/config.${deviceId}.${ts}.json`;
  }
  return `Books/${bookHash}/conflicts/config.${deviceId}.${ts}.${index}.json`;
};

export const mergeBookConfigJson = ({
  bookHash,
  deviceId,
  localConfigJson,
  remoteConfigJson,
  nowMs,
}: MergeBookConfigInput): MergeBookConfigResult => {
  const warnings: string[] = [];
  const ts = nowMs ?? Date.now();

  const parsedLocal = parseConfigJson(localConfigJson, 'local', warnings);
  const parsedRemote = parseConfigJson(remoteConfigJson, 'remote', warnings);

  const localConfig = parsedLocal.config;
  const remoteConfig = parsedRemote.config;

  const mergedConfig: Partial<BookConfig> & Record<string, unknown> = {
    ...remoteConfig,
    ...localConfig,
  };

  mergedConfig.progress = chooseFieldByUpdatedAt(localConfig, remoteConfig, 'progress') as
    | [number, number]
    | undefined;
  mergedConfig.location = chooseFieldByUpdatedAt(localConfig, remoteConfig, 'location') as
    | string
    | undefined;
  mergedConfig.xpointer = chooseFieldByUpdatedAt(localConfig, remoteConfig, 'xpointer') as
    | string
    | undefined;

  const mergedNotesResult = mergeBooknotes(localConfig, remoteConfig);
  if (mergedNotesResult.notes !== undefined) {
    mergedConfig.booknotes = mergedNotesResult.notes;
  }

  const viewSettingsMerge = mergeSectionWithConflict(
    localConfig.viewSettings,
    remoteConfig.viewSettings,
  );
  if (viewSettingsMerge.merged !== undefined) {
    mergedConfig.viewSettings = viewSettingsMerge.merged;
  }

  const searchConfigMerge = mergeSectionWithConflict(
    localConfig.searchConfig,
    remoteConfig.searchConfig,
  );
  if (searchConfigMerge.merged !== undefined) {
    mergedConfig.searchConfig = searchConfigMerge.merged;
  }

  const localUpdatedAt = asTimestamp(localConfig.updatedAt);
  const remoteUpdatedAt = asTimestamp(remoteConfig.updatedAt);
  const providedNow = nowMs ?? 0;
  mergedConfig.updatedAt = Math.max(localUpdatedAt, remoteUpdatedAt, providedNow);

  const conflictCopies: BookConfigConflictCopy[] = [];
  let conflictIndex = 0;

  if (parsedLocal.parseError) {
    conflictCopies.push({
      relativePath: buildConflictPath(bookHash, deviceId, ts, conflictIndex),
      json: JSON.stringify(
        {
          type: 'invalid-json',
          side: 'local',
          error: parsedLocal.parseError,
          rawText: localConfigJson,
        },
        null,
        2,
      ),
    });
    conflictIndex += 1;
  }

  if (parsedRemote.parseError) {
    conflictCopies.push({
      relativePath: buildConflictPath(bookHash, deviceId, ts, conflictIndex),
      json: JSON.stringify(
        {
          type: 'invalid-json',
          side: 'remote',
          error: parsedRemote.parseError,
          rawText: remoteConfigJson,
        },
        null,
        2,
      ),
    });
    conflictIndex += 1;
  }

  if (
    !parsedRemote.parseError &&
    (viewSettingsMerge.hasConflict ||
      searchConfigMerge.hasConflict ||
      mergedNotesResult.hasConflict)
  ) {
    conflictCopies.push({
      relativePath: buildConflictPath(bookHash, deviceId, ts, conflictIndex),
      json: JSON.stringify(remoteConfig, null, 2),
    });
  }

  return {
    mergedJson: JSON.stringify(mergedConfig, null, 2),
    conflictCopies,
    warnings,
  };
};
