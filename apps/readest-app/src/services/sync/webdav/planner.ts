import type {
  WebDavManifestEntry,
  WebDavManifestSchema,
  WebDavTombstoneEntry,
  WebDavTombstonesSchema,
} from './types';

export type WebDavMergeStrategy = 'settings' | 'library' | 'bookConfig';

export type WebDavPlannedOperation =
  | {
      type: 'merge_json';
      path: string;
      strategy: WebDavMergeStrategy;
      local?: WebDavManifestEntry;
      remote?: WebDavManifestEntry;
    }
  | {
      type: 'upload';
      path: string;
      local: WebDavManifestEntry;
      remote?: WebDavManifestEntry;
    }
  | {
      type: 'download';
      path: string;
      remote: WebDavManifestEntry;
      local?: WebDavManifestEntry;
    }
  | {
      type: 'trash_local';
      originalPath: string;
      deletedAtMs: number;
    }
  | {
      type: 'trash_remote';
      originalPath: string;
      deletedAtMs: number;
    };

export interface WebDavPlannerInput {
  localManifest: WebDavManifestSchema;
  remoteManifest: WebDavManifestSchema;
  localTombstones?: WebDavTombstonesSchema;
  remoteTombstones?: WebDavTombstonesSchema;
}

export interface WebDavPlannerOutput {
  operations: WebDavPlannedOperation[];
  mergedTombstones: WebDavTombstonesSchema;
  warnings: string[];
}

const keyByPath = (entries: WebDavManifestEntry[]) => {
  const map = new Map<string, WebDavManifestEntry>();
  for (const entry of entries) {
    if (!entry.path) {
      continue;
    }
    map.set(entry.path, entry);
  }
  return map;
};

const normalizeTombstones = (tombstones?: WebDavTombstonesSchema) => tombstones?.tombstones ?? [];

const mergeTombstones = (
  local: WebDavTombstoneEntry[],
  remote: WebDavTombstoneEntry[],
): WebDavTombstoneEntry[] => {
  const byPath = new Map<string, WebDavTombstoneEntry>();
  for (const entry of [...local, ...remote]) {
    const existing = byPath.get(entry.originalPath);
    if (!existing || entry.deletedAtMs > existing.deletedAtMs) {
      byPath.set(entry.originalPath, entry);
    }
  }
  return Array.from(byPath.values()).sort((a, b) => a.originalPath.localeCompare(b.originalPath));
};

const detectMergeStrategy = (path: string): WebDavMergeStrategy | null => {
  if (path === 'Settings/settings.json') {
    return 'settings';
  }
  if (path === 'Books/library.json') {
    return 'library';
  }
  if (/^Books\/[^/]+\/config\.json$/.test(path)) {
    return 'bookConfig';
  }
  return null;
};

const areEntriesEquivalent = (left: WebDavManifestEntry, right: WebDavManifestEntry) => {
  if (left.checksum && right.checksum) {
    return left.checksum === right.checksum;
  }
  if (left.etag && right.etag) {
    return left.etag === right.etag;
  }
  return left.sizeBytes === right.sizeBytes && left.modifiedAtMs === right.modifiedAtMs;
};

export function planWebDavSyncOperations(
  input: WebDavPlannerInput,
  nowMs = Date.now(),
): WebDavPlannerOutput {
  const warnings: string[] = [];
  const localEntries = keyByPath(input.localManifest.entries);
  const remoteEntries = keyByPath(input.remoteManifest.entries);

  const mergedTombstonesList = mergeTombstones(
    normalizeTombstones(input.localTombstones),
    normalizeTombstones(input.remoteTombstones),
  );
  const tombstoneByPath = new Map<string, WebDavTombstoneEntry>(
    mergedTombstonesList.map((entry) => [entry.originalPath, entry]),
  );

  const allPaths = new Set<string>([...localEntries.keys(), ...remoteEntries.keys()]);
  const operations: WebDavPlannedOperation[] = [];

  for (const path of Array.from(allPaths).sort((a, b) => a.localeCompare(b))) {
    const tombstone = tombstoneByPath.get(path);
    if (tombstone) {
      operations.push({
        type: 'trash_local',
        originalPath: path,
        deletedAtMs: tombstone.deletedAtMs,
      });
      operations.push({
        type: 'trash_remote',
        originalPath: path,
        deletedAtMs: tombstone.deletedAtMs,
      });
      continue;
    }

    const local = localEntries.get(path);
    const remote = remoteEntries.get(path);

    if (!local && remote) {
      operations.push({ type: 'download', path, remote });
      continue;
    }
    if (local && !remote) {
      operations.push({ type: 'upload', path, local });
      continue;
    }
    if (!local || !remote) {
      continue;
    }
    if (areEntriesEquivalent(local, remote)) {
      continue;
    }

    const strategy = detectMergeStrategy(path);
    if (strategy) {
      operations.push({ type: 'merge_json', path, strategy, local, remote });
      continue;
    }

    if (local.modifiedAtMs === remote.modifiedAtMs) {
      warnings.push(`Binary conflict on ${path}: equal modifiedAtMs`);
    }
    if (local.modifiedAtMs >= remote.modifiedAtMs) {
      operations.push({ type: 'upload', path, local, remote });
    } else {
      operations.push({ type: 'download', path, remote, local });
    }
  }

  return {
    operations,
    mergedTombstones: {
      schemaVersion: 1,
      generatedAtMs: nowMs,
      updatedAtMs: nowMs,
      tombstones: mergedTombstonesList,
    },
    warnings,
  };
}
