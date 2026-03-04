import type { WebDavSyncScope } from './syncScope';
import type { WebDavFsAdapter } from './fsAdapter';
import { decodeUtf8, encodeUtf8 } from './fsAdapter';
import type { WebDavClient } from './client';
import { WebDavHttpError } from './client';
import {
  createEmptyWebDavManifestSchema,
  createEmptyWebDavTombstonesSchema,
  type WebDavManifestEntry,
  type WebDavManifestSchema,
  type WebDavTombstoneEntry,
  type WebDavTombstonesSchema,
} from './types';
import { planWebDavSyncOperations, type WebDavPlannedOperation } from './planner';
import { mergeSettingsJson } from './merge/settingsMerge';
import { mergeLibraryJson } from './merge/libraryMerge';
import { mergeBookConfigJson } from './merge/bookConfigMerge';

export class WebDavSyncEngineError extends Error {
  override name = 'WebDavSyncEngineError';
}

export class WebDavSyncAlreadyRunningError extends Error {
  override name = 'WebDavSyncAlreadyRunningError';
}

export interface WebDavSyncMetadataOnceParams {
  client: WebDavClient;
  fs: WebDavFsAdapter;
  scope: WebDavSyncScope;
  deviceId: string;
  nowMs?: number;
  maxConcurrentTransfers?: number;
}

export interface WebDavSyncMetadataOnceResult {
  operations: WebDavPlannedOperation[];
  warnings: string[];
}

let inFlightSyncTask: Promise<WebDavSyncMetadataOnceResult> | null = null;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEBDAV_TRASH_RETENTION_DAYS = 90;
const WEBDAV_TRASH_RETENTION_MS = WEBDAV_TRASH_RETENTION_DAYS * DAY_MS;
const MERGE_JSON_MAX_RETRIES = 2;

const ensureTrailingSlashTrimmed = (value: string) => value.replace(/[\\/]+$/g, '');

const WEBDAV_DEFAULT_MAX_CONCURRENT_TRANSFERS = 4;
const WEBDAV_MAX_CONCURRENT_TRANSFERS_LIMIT = 8;
const WEBDAV_LOCAL_MANIFEST_CACHE_SCHEMA_VERSION = 1;
const WEBDAV_LOCAL_MANIFEST_CACHE_FILENAME = 'webdav.local.manifest.json';

const joinPath = (...parts: string[]) => {
  const filtered = parts.filter((p) => p.length > 0);
  if (filtered.length === 0) return '';
  const normalized = filtered.map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
  const first = filtered[0]!.replace(/\\/g, '/');
  const isUnixAbs = first.startsWith('/');
  const isWinAbs = /^[A-Za-z]:\//.test(first);
  const joined = normalized.filter(Boolean).join('/');
  if (isUnixAbs) {
    return joined.startsWith('/') ? joined : `/${joined}`;
  }
  if (isWinAbs) {
    return (
      first.replace(/^\/+|\/+$/g, '') +
      (normalized.length > 1 ? `/${normalized.slice(1).join('/')}` : '')
    );
  }
  return joined;
};

const dirname = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '';
  return normalized.slice(0, index);
};

const parentRemoteDir = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '';
  return normalized.slice(0, index);
};

const normalizeRelativePath = (relativePath: string) =>
  relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

const getTrashRelativePath = (deletedAtMs: number, originalPath: string) => {
  const normalizedOriginalPath = normalizeRelativePath(originalPath);
  return normalizeRelativePath(`.trash/${deletedAtMs}/${normalizedOriginalPath}`);
};

const getBookHashFromBooksPath = (relativePath: string): string | null => {
  const match = normalizeRelativePath(relativePath).match(/^Books\/([^/]+)\//);
  return match?.[1] ?? null;
};

const sha256Hex = async (data: Uint8Array): Promise<string> => {
  if (globalThis.crypto?.subtle) {
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
};

const clampInteger = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const isNodeRuntime = () => {
  if (typeof process === 'undefined') return false;

  const proc = process as unknown as { versions?: unknown };
  if (!proc.versions || typeof proc.versions !== 'object') return false;
  const versions = proc.versions as Record<string, unknown>;
  const nodeVersion = versions['node'];
  return typeof nodeVersion === 'string' && nodeVersion.length > 0;
};

const computePartialMd5FromPath = async (
  absolutePath: string,
  sizeBytes: number,
): Promise<string | undefined> => {
  if (sizeBytes <= 0) {
    return 'pmd5:d41d8cd98f00b204e9800998ecf8427e';
  }

  if (isNodeRuntime()) {
    const nodeFs = await import('node:fs/promises');
    const { md5 } = await import('js-md5');
    const hasher = md5.create();
    const step = 1024;
    const size = 1024;
    const handle = await nodeFs.open(absolutePath, 'r');
    try {
      for (let i = -1; i <= 10; i += 1) {
        const start = Math.min(sizeBytes, step << (2 * i));
        const end = Math.min(start + size, sizeBytes);
        if (start >= sizeBytes) break;

        const length = Math.max(0, end - start);
        const buffer = new Uint8Array(length);
        if (length > 0) {
          await handle.read({ buffer, position: start });
          hasher.update(buffer);
        }
      }
      return `pmd5:${hasher.hex()}`;
    } finally {
      await handle.close();
    }
  }

  try {
    const [{ NativeFile }, { partialMD5 }] = await Promise.all([
      import('@/utils/file'),
      import('@/utils/md5'),
    ]);
    const file = await new NativeFile(absolutePath).open();
    try {
      const hex = await partialMD5(file);
      return `pmd5:${hex}`;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
};

const parseJson = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const isMetaPath = (path: string) => path.startsWith('.meta/');

const isJsonLikePath = (path: string) =>
  path.endsWith('.json') || path.endsWith('.json.bak') || path.endsWith('.bak');

const isSettingsPath = (path: string) =>
  path === 'Settings/settings.json' || path === 'Settings/settings.json.bak';

const globToRegExp = (pattern: string) => {
  const normalized = pattern.replace(/\\/g, '/');
  let regex = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    const next = normalized[i + 1];
    if (ch === '*' && next === '*') {
      regex += '.*';
      i += 1;
      continue;
    }
    if (ch === '*') {
      regex += '[^/]*';
      continue;
    }
    if (ch === '?') {
      regex += '[^/]';
      continue;
    }
    regex += ch.replace(/[$^+.()|{}\\]/g, '\\$&');
  }
  regex += '$';
  return new RegExp(regex);
};

const buildExcludeMatchers = (patterns: string[]) => patterns.map((p) => globToRegExp(p));

const isExcludedRelativePath = (relativePath: string, excludeMatchers: RegExp[]) => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return excludeMatchers.some((re) => re.test(normalized));
};

const resolveLocalPath = (scope: WebDavSyncScope, relativePath: string): string | null => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

  for (const mapping of scope.mappings) {
    if (mapping.kind === 'file' && mapping.relativePath === normalized) {
      return mapping.absolutePath;
    }
  }

  for (const mapping of scope.mappings) {
    if (mapping.kind !== 'directory') continue;
    const prefix = mapping.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (normalized === prefix) {
      return mapping.absolutePath;
    }
    if (normalized.startsWith(`${prefix}/`)) {
      const rest = normalized.slice(prefix.length + 1);
      return joinPath(mapping.absolutePath, rest);
    }
  }

  return null;
};

const getBooksRoot = (scope: WebDavSyncScope): string => {
  const mapping = scope.mappings.find((m) => m.key === 'Books' && m.kind === 'directory');
  if (!mapping) {
    throw new WebDavSyncEngineError('未找到 Books 同步目录映射');
  }
  return mapping.absolutePath;
};

const getLocalTrashRoot = (scope: WebDavSyncScope): string => {
  const booksRoot = getBooksRoot(scope);
  return joinPath(dirname(booksRoot), '.trash');
};

const getLocalTrashAbsolutePath = (
  scope: WebDavSyncScope,
  deletedAtMs: number,
  originalPath: string,
): string => {
  return joinPath(getLocalTrashRoot(scope), `${deletedAtMs}`, normalizeRelativePath(originalPath));
};

const getSettingsDir = (scope: WebDavSyncScope): string => {
  const mapping = scope.mappings.find(
    (m) => m.key === 'Settings' && m.relativePath === 'Settings/settings.json',
  );
  if (!mapping) {
    throw new WebDavSyncEngineError('未找到 Settings/settings.json 同步映射');
  }
  return dirname(mapping.absolutePath);
};

const readLocalText = async (fs: WebDavFsAdapter, absolutePath: string): Promise<string | null> => {
  const bytes = await fs.readFile(absolutePath).catch(() => null);
  if (!bytes) return null;
  return decodeUtf8(bytes);
};

const writeLocalJsonWithBak = async (params: {
  fs: WebDavFsAdapter;
  mainAbsolutePath: string;
  jsonText: string;
}): Promise<void> => {
  const main = params.mainAbsolutePath;
  const bak = `${main}.bak`;
  const data = encodeUtf8(params.jsonText);
  await params.fs.writeFileAtomic(bak, data);
  await params.fs.writeFileAtomic(main, data);
};

interface WebDavLocalManifestCacheEntry {
  fileSizeBytes: number;
  fileModifiedAtMs: number;
  manifestSizeBytes: number;
  checksum?: string;
}

interface WebDavLocalManifestCacheFile {
  schemaVersion: typeof WEBDAV_LOCAL_MANIFEST_CACHE_SCHEMA_VERSION;
  updatedAtMs: number;
  entries: Record<string, WebDavLocalManifestCacheEntry>;
}

const readLocalManifestCache = async (
  fs: WebDavFsAdapter,
  absolutePath: string,
): Promise<Map<string, WebDavLocalManifestCacheEntry> | null> => {
  const bytes = await fs.readFile(absolutePath).catch(() => null);
  if (!bytes) {
    return null;
  }
  const parsed = parseJson<unknown>(decodeUtf8(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (obj['schemaVersion'] !== WEBDAV_LOCAL_MANIFEST_CACHE_SCHEMA_VERSION) {
    return null;
  }

  const rawEntries = obj['entries'];
  if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
    return null;
  }

  const map = new Map<string, WebDavLocalManifestCacheEntry>();
  for (const [relativePath, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    const fileSizeBytes = record['fileSizeBytes'];
    const fileModifiedAtMs = record['fileModifiedAtMs'];
    const manifestSizeBytes = record['manifestSizeBytes'];
    const checksum = record['checksum'];
    if (
      typeof fileSizeBytes !== 'number' ||
      !Number.isFinite(fileSizeBytes) ||
      typeof fileModifiedAtMs !== 'number' ||
      !Number.isFinite(fileModifiedAtMs) ||
      typeof manifestSizeBytes !== 'number' ||
      !Number.isFinite(manifestSizeBytes)
    ) {
      continue;
    }
    if (checksum !== undefined && typeof checksum !== 'string') {
      continue;
    }
    map.set(relativePath, {
      fileSizeBytes,
      fileModifiedAtMs,
      manifestSizeBytes,
      checksum,
    });
  }
  return map;
};

const writeLocalManifestCache = async (params: {
  fs: WebDavFsAdapter;
  absolutePath: string;
  updatedAtMs: number;
  entries: Map<string, WebDavLocalManifestCacheEntry>;
}): Promise<void> => {
  const record: Record<string, WebDavLocalManifestCacheEntry> = {};
  const sortedKeys = Array.from(params.entries.keys()).sort((a, b) => a.localeCompare(b));
  for (const key of sortedKeys) {
    const value = params.entries.get(key);
    if (!value) continue;
    record[key] = value;
  }

  const cacheFile: WebDavLocalManifestCacheFile = {
    schemaVersion: WEBDAV_LOCAL_MANIFEST_CACHE_SCHEMA_VERSION,
    updatedAtMs: params.updatedAtMs,
    entries: record,
  };
  const text = JSON.stringify(cacheFile, null, 2);
  await params.fs.writeFileAtomic(params.absolutePath, encodeUtf8(text)).catch(() => undefined);
};

const localManifestCachePath = (scope: WebDavSyncScope): string | null => {
  try {
    const settingsDir = getSettingsDir(scope);
    return `${ensureTrailingSlashTrimmed(settingsDir)}/${WEBDAV_LOCAL_MANIFEST_CACHE_FILENAME}`;
  } catch {
    return null;
  }
};

type AsyncTask<T> = () => Promise<T>;

const runConcurrently = async <T>(tasks: AsyncTask<T>[], maxConcurrency: number): Promise<T[]> => {
  const concurrency = clampInteger(maxConcurrency, 1, 1, WEBDAV_MAX_CONCURRENT_TRANSFERS_LIMIT);
  if (tasks.length === 0) {
    return [];
  }
  if (concurrency <= 1 || tasks.length === 1) {
    const results: T[] = [];
    for (const task of tasks) {
      results.push(await task());
    }
    return results;
  }

  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  let aborted: unknown = null;

  const worker = async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) {
        return;
      }
      try {
        results[index] = await tasks[index]!();
      } catch (error) {
        aborted = error;
        return;
      }
    }
  };

  const workerCount = Math.min(concurrency, tasks.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  if (aborted) {
    throw aborted;
  }
  return results;
};

const remoteDirEnsureStateByClient = new WeakMap<
  WebDavClient,
  {
    created: Set<string>;
    inFlight: Map<string, Promise<void>>;
  }
>();

const ensureRemoteDirs = async (client: WebDavClient, relativeDirPath: string): Promise<void> => {
  const normalized = relativeDirPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return;
  const state =
    remoteDirEnsureStateByClient.get(client) ??
    (() => {
      const created = new Set<string>();
      const inFlight = new Map<string, Promise<void>>();
      const next = { created, inFlight };
      remoteDirEnsureStateByClient.set(client, next);
      return next;
    })();
  const parts = normalized.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (state.created.has(current)) {
      continue;
    }
    const pending = state.inFlight.get(current);
    if (pending) {
      await pending;
      continue;
    }
    const task = client
      .mkcol(current)
      .then(() => {
        state.created.add(current);
      })
      .finally(() => {
        state.inFlight.delete(current);
      });
    state.inFlight.set(current, task);
    await task;
  }
};

const toManifestEntryFromText = async (params: {
  path: string;
  text: string;
  modifiedAtMs: number;
}): Promise<WebDavManifestEntry> => {
  const bytes = encodeUtf8(params.text);
  return {
    path: params.path,
    sizeBytes: bytes.byteLength,
    modifiedAtMs: params.modifiedAtMs,
    checksum: await sha256Hex(bytes),
  };
};

const scanLocalScopeManifest = async (params: {
  fs: WebDavFsAdapter;
  scope: WebDavSyncScope;
  sourceDeviceId: string;
  nowMs: number;
}): Promise<WebDavManifestSchema> => {
  const entries: WebDavManifestEntry[] = [];
  const excludeMatchers = buildExcludeMatchers(params.scope.excludes);
  const cacheAbsolutePath = localManifestCachePath(params.scope);
  const previousCache = cacheAbsolutePath
    ? await readLocalManifestCache(params.fs, cacheAbsolutePath)
    : null;
  const nextCache = new Map<string, WebDavLocalManifestCacheEntry>();

  const includeFile = async (relativePath: string, absolutePath: string) => {
    if (isExcludedRelativePath(relativePath, excludeMatchers)) {
      return;
    }
    const info = await params.fs.stat(absolutePath);
    if (!info || !info.isFile) {
      return;
    }

    const cached = previousCache?.get(relativePath);
    if (
      cached &&
      cached.fileSizeBytes === info.sizeBytes &&
      cached.fileModifiedAtMs === info.modifiedAtMs
    ) {
      entries.push({
        path: relativePath,
        sizeBytes: cached.manifestSizeBytes,
        modifiedAtMs: info.modifiedAtMs,
        checksum: cached.checksum,
      });
      nextCache.set(relativePath, cached);
      return;
    }

    if (isSettingsPath(relativePath)) {
      const localText = await readLocalText(params.fs, absolutePath);
      if (localText === null) {
        return;
      }
      const sanitized = mergeSettingsJson({
        localSettingsJson: localText,
        remoteSettingsJson: '{}',
      }).remoteUploadJson;
      const bytes = encodeUtf8(sanitized);
      const checksum = await sha256Hex(bytes);
      entries.push({
        path: relativePath,
        sizeBytes: bytes.byteLength,
        modifiedAtMs: info.modifiedAtMs,
        checksum,
      });
      nextCache.set(relativePath, {
        fileSizeBytes: info.sizeBytes,
        fileModifiedAtMs: info.modifiedAtMs,
        manifestSizeBytes: bytes.byteLength,
        checksum,
      });
      return;
    }

    if (isJsonLikePath(relativePath)) {
      const bytes = await params.fs.readFile(absolutePath);
      const checksum = await sha256Hex(bytes);
      entries.push({
        path: relativePath,
        sizeBytes: info.sizeBytes,
        modifiedAtMs: info.modifiedAtMs,
        checksum,
      });
      nextCache.set(relativePath, {
        fileSizeBytes: info.sizeBytes,
        fileModifiedAtMs: info.modifiedAtMs,
        manifestSizeBytes: info.sizeBytes,
        checksum,
      });
      return;
    }

    const checksum = await computePartialMd5FromPath(absolutePath, info.sizeBytes);
    entries.push({
      path: relativePath,
      sizeBytes: info.sizeBytes,
      modifiedAtMs: info.modifiedAtMs,
      checksum,
    });
    nextCache.set(relativePath, {
      fileSizeBytes: info.sizeBytes,
      fileModifiedAtMs: info.modifiedAtMs,
      manifestSizeBytes: info.sizeBytes,
      checksum,
    });
  };

  const walkDir = async (relativeDir: string, absoluteDir: string): Promise<void> => {
    if (isExcludedRelativePath(relativeDir, excludeMatchers)) {
      return;
    }
    const children = await params.fs.readDir(absoluteDir);
    for (const name of children) {
      if (!name) continue;
      const childAbs = joinPath(absoluteDir, name);
      const childRel = relativeDir ? `${relativeDir}/${name}` : name;
      if (isExcludedRelativePath(childRel, excludeMatchers)) {
        continue;
      }
      const stat = await params.fs.stat(childAbs);
      if (!stat) continue;
      if (stat.isDirectory) {
        await walkDir(childRel, childAbs);
        continue;
      }
      if (stat.isFile) {
        await includeFile(childRel, childAbs);
      }
    }
  };

  for (const mapping of params.scope.mappings) {
    if (mapping.kind === 'file') {
      await includeFile(mapping.relativePath, mapping.absolutePath);
      continue;
    }
    if (mapping.kind === 'directory' && mapping.recursive) {
      await walkDir(mapping.relativePath, mapping.absolutePath);
    }
  }

  if (cacheAbsolutePath) {
    await writeLocalManifestCache({
      fs: params.fs,
      absolutePath: cacheAbsolutePath,
      updatedAtMs: params.nowMs,
      entries: nextCache,
    });
  }

  return {
    schemaVersion: 1,
    generatedAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    sourceDeviceId: params.sourceDeviceId,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
  };
};

const guessContentType = (relativePath: string) => {
  const normalized = relativePath.toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.json') || normalized.endsWith('.bak')) return 'application/json';
  return 'application/octet-stream';
};

const randomSuffix = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;

const makeConflictCopyRelativePath = (params: {
  originalPath: string;
  side: 'local' | 'remote';
  deviceId: string;
  nowMs: number;
}) => {
  const normalized = params.originalPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const dir = parentRemoteDir(normalized);
  const name = normalized.split('/').pop() ?? 'file';
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const conflictName = `${base}.conflict.${params.side}.${params.deviceId}.${params.nowMs}${ext}`;
  return dir ? `${dir}/conflicts/${conflictName}` : `conflicts/${conflictName}`;
};

const readRemoteJsonOrNull = async (
  client: WebDavClient,
  relativePath: string,
): Promise<string | null> => {
  try {
    return await client.getText(relativePath);
  } catch (error) {
    if (error instanceof WebDavHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
};

type WebDavWritePrecondition = {
  ifMatch?: string;
  ifNoneMatch?: string;
};

const buildWritePrecondition = async (
  client: WebDavClient,
  relativePath: string,
): Promise<WebDavWritePrecondition> => {
  const etag = await client.getEtag(relativePath);
  if (etag) {
    return { ifMatch: etag };
  }
  return { ifNoneMatch: '*' };
};

const isPreconditionFailedError = (error: unknown) =>
  error instanceof WebDavHttpError && error.status === 412;

const putTextWithEtagPrecondition = async (
  client: WebDavClient,
  relativePath: string,
  text: string,
  contentType: string,
) => {
  const precondition = await buildWritePrecondition(client, relativePath);
  await client.putText(relativePath, text, contentType, precondition);
};

const readRemoteManifest = async (client: WebDavClient, deviceId: string, nowMs: number) => {
  const text = await readRemoteJsonOrNull(client, '.meta/manifest.json');
  if (!text) {
    return createEmptyWebDavManifestSchema({ sourceDeviceId: deviceId, nowMs });
  }
  const parsed = parseJson<WebDavManifestSchema>(text);
  if (!parsed || !Array.isArray(parsed.entries)) {
    return createEmptyWebDavManifestSchema({ sourceDeviceId: deviceId, nowMs });
  }
  return parsed;
};

const readRemoteTombstones = async (client: WebDavClient, nowMs: number) => {
  const text = await readRemoteJsonOrNull(client, '.meta/tombstones.json');
  if (!text) {
    return createEmptyWebDavTombstonesSchema({ nowMs });
  }
  const parsed = parseJson<WebDavTombstonesSchema>(text);
  if (!parsed || !Array.isArray(parsed.tombstones)) {
    return createEmptyWebDavTombstonesSchema({ nowMs });
  }
  return parsed;
};

const removeManifestEntry = (manifest: WebDavManifestSchema, path: string) => {
  manifest.entries = manifest.entries.filter((entry) => entry.path !== path);
};

const removeManifestEntriesByPrefix = (manifest: WebDavManifestSchema, pathPrefix: string) => {
  const normalizedPrefix = normalizeRelativePath(pathPrefix);
  const prefixWithSlash = normalizedPrefix.endsWith('/')
    ? normalizedPrefix
    : `${normalizedPrefix}/`;
  manifest.entries = manifest.entries.filter((entry) => !entry.path.startsWith(prefixWithSlash));
};

const readLocalDeletedBookHashes = async (params: {
  fs: WebDavFsAdapter;
  scope: WebDavSyncScope;
}): Promise<Map<string, number>> => {
  const libraryPath = resolveLocalPath(params.scope, 'Books/library.json');
  if (!libraryPath) {
    return new Map();
  }

  const localText = await readLocalText(params.fs, libraryPath);
  if (!localText) {
    return new Map();
  }

  const parsed = parseJson<unknown>(localText);
  if (!Array.isArray(parsed)) {
    return new Map();
  }

  const deletedBooks = new Map<string, number>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const hash = record['hash'];
    const deletedAt = record['deletedAt'];
    if (typeof hash !== 'string') {
      continue;
    }
    if (typeof deletedAt !== 'number' || !Number.isFinite(deletedAt) || deletedAt <= 0) {
      continue;
    }

    const existingDeletedAt = deletedBooks.get(hash) ?? 0;
    if (deletedAt > existingDeletedAt) {
      deletedBooks.set(hash, deletedAt);
    }
  }

  return deletedBooks;
};

const buildLocalTombstonesFromDeletedBooks = async (params: {
  fs: WebDavFsAdapter;
  scope: WebDavSyncScope;
  remoteManifest: WebDavManifestSchema;
  deviceId: string;
  nowMs: number;
  cutoffMs: number;
}): Promise<WebDavTombstonesSchema> => {
  const deletedBooks = await readLocalDeletedBookHashes({
    fs: params.fs,
    scope: params.scope,
  });

  const remotePathsByHash = new Map<string, string[]>();
  for (const entry of params.remoteManifest.entries) {
    const match = entry.path.match(/^Books\/([^/]+)\//);
    if (!match) {
      continue;
    }
    const hash = match[1]!;
    const paths = remotePathsByHash.get(hash) ?? [];
    paths.push(entry.path);
    remotePathsByHash.set(hash, paths);
  }

  const tombstonesByPath = new Map<string, WebDavTombstoneEntry>();
  for (const [hash, deletedAtMs] of deletedBooks.entries()) {
    if (deletedAtMs <= params.cutoffMs) {
      continue;
    }

    const remotePaths = remotePathsByHash.get(hash) ?? [];
    for (const originalPath of remotePaths) {
      const existing = tombstonesByPath.get(originalPath);
      if (!existing || deletedAtMs > existing.deletedAtMs) {
        tombstonesByPath.set(originalPath, {
          originalPath,
          deletedAtMs,
          deletedByDeviceId: params.deviceId,
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    generatedAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    tombstones: Array.from(tombstonesByPath.values()).sort((a, b) =>
      a.originalPath.localeCompare(b.originalPath),
    ),
  };
};

const retainUnexpiredTombstones = async (params: {
  client: WebDavClient;
  tombstones: WebDavTombstonesSchema;
  cutoffMs: number;
  nowMs: number;
  remoteManifest: WebDavManifestSchema;
}): Promise<WebDavTombstonesSchema> => {
  const retained: WebDavTombstoneEntry[] = [];

  for (const tombstone of params.tombstones.tombstones) {
    if (tombstone.deletedAtMs > params.cutoffMs) {
      retained.push(tombstone);
      continue;
    }

    const trashPath = getTrashRelativePath(tombstone.deletedAtMs, tombstone.originalPath);
    try {
      await params.client.delete(trashPath);
    } catch (error) {
      if (!(error instanceof WebDavHttpError && error.status === 404)) {
        throw error;
      }
    }
    removeManifestEntry(params.remoteManifest, tombstone.originalPath);
  }

  return {
    ...params.tombstones,
    updatedAtMs: params.nowMs,
    tombstones: retained.sort((a, b) => a.originalPath.localeCompare(b.originalPath)),
  };
};

const moveLocalPathToTrash = async (params: {
  fs: WebDavFsAdapter;
  scope: WebDavSyncScope;
  originalPath: string;
  deletedAtMs: number;
  movedBookDirs: Set<string>;
}) => {
  const bookHash = getBookHashFromBooksPath(params.originalPath);
  if (bookHash) {
    const moveKey = `${params.deletedAtMs}:${bookHash}`;
    if (params.movedBookDirs.has(moveKey)) {
      return;
    }
    params.movedBookDirs.add(moveKey);

    const sourceBookPath = resolveLocalPath(params.scope, `Books/${bookHash}`);
    if (!sourceBookPath) {
      return;
    }
    const sourceBookStat = await params.fs.stat(sourceBookPath);
    if (!sourceBookStat?.isDirectory) {
      return;
    }

    const trashBookPath = getLocalTrashAbsolutePath(
      params.scope,
      params.deletedAtMs,
      `Books/${bookHash}`,
    );
    const existingTrashBookStat = await params.fs.stat(trashBookPath);
    if (existingTrashBookStat) {
      return;
    }

    await params.fs.mkdirp(dirname(trashBookPath));
    await params.fs.rename(sourceBookPath, trashBookPath);
    return;
  }

  const sourcePath = resolveLocalPath(params.scope, params.originalPath);
  if (!sourcePath) {
    return;
  }
  const sourceStat = await params.fs.stat(sourcePath);
  if (!sourceStat) {
    return;
  }

  const trashPath = getLocalTrashAbsolutePath(
    params.scope,
    params.deletedAtMs,
    params.originalPath,
  );
  const existingTrashStat = await params.fs.stat(trashPath);
  if (existingTrashStat) {
    return;
  }

  await params.fs.mkdirp(dirname(trashPath));
  await params.fs.rename(sourcePath, trashPath);
};

const moveRemotePathToTrash = async (params: {
  client: WebDavClient;
  remoteManifest: WebDavManifestSchema;
  originalPath: string;
  deletedAtMs: number;
  movedBookDirs: Set<string>;
}) => {
  const bookHash = getBookHashFromBooksPath(params.originalPath);
  if (bookHash) {
    const moveKey = `${params.deletedAtMs}:${bookHash}`;
    if (params.movedBookDirs.has(moveKey)) {
      return;
    }
    params.movedBookDirs.add(moveKey);

    const sourceBookPath = `Books/${bookHash}`;
    const trashBookPath = getTrashRelativePath(params.deletedAtMs, sourceBookPath);
    try {
      await params.client.propfind(trashBookPath, '0');
      return;
    } catch (error) {
      if (!(error instanceof WebDavHttpError && error.status === 404)) {
        throw error;
      }
    }

    await ensureRemoteDirs(params.client, parentRemoteDir(trashBookPath));
    try {
      await params.client.move(sourceBookPath, trashBookPath, { overwrite: false });
    } catch (error) {
      if (!(error instanceof WebDavHttpError && error.status === 404)) {
        throw error;
      }
    }
    removeManifestEntriesByPrefix(params.remoteManifest, sourceBookPath);
    return;
  }

  const trashPath = getTrashRelativePath(params.deletedAtMs, params.originalPath);
  await ensureRemoteDirs(params.client, parentRemoteDir(trashPath));
  try {
    await params.client.move(params.originalPath, trashPath, { overwrite: false });
  } catch (error) {
    if (!(error instanceof WebDavHttpError && error.status === 404)) {
      throw error;
    }
  }
  removeManifestEntry(params.remoteManifest, params.originalPath);
};

const updateManifestEntry = (manifest: WebDavManifestSchema, entry: WebDavManifestEntry) => {
  const byPath = new Map(manifest.entries.map((e) => [e.path, e]));
  byPath.set(entry.path, entry);
  manifest.entries = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
};

const updateManifestEntries = (manifest: WebDavManifestSchema, entries: WebDavManifestEntry[]) => {
  if (entries.length === 0) {
    return;
  }
  const byPath = new Map(manifest.entries.map((e) => [e.path, e]));
  for (const entry of entries) {
    byPath.set(entry.path, entry);
  }
  manifest.entries = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
};

export interface RestoreBookFromTrashParams {
  fs: WebDavFsAdapter;
  scope: WebDavSyncScope;
  bookHash: string;
}

export interface RestoreBookFromTrashResult {
  restored: boolean;
  deletedAtMs?: number;
}

export async function restoreBookFromTrash(
  params: RestoreBookFromTrashParams,
): Promise<RestoreBookFromTrashResult> {
  const booksRoot = getBooksRoot(params.scope);
  const trashRoot = getLocalTrashRoot(params.scope);
  const deletedAtDirs = (await params.fs.readDir(trashRoot))
    .map((name) => Number(name))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a);

  for (const deletedAtMs of deletedAtDirs) {
    const trashBookDir = joinPath(trashRoot, `${deletedAtMs}`, 'Books', params.bookHash);
    const trashBookStat = await params.fs.stat(trashBookDir);
    if (!trashBookStat?.isDirectory) {
      continue;
    }

    const targetBookDir = joinPath(booksRoot, params.bookHash);
    const targetStat = await params.fs.stat(targetBookDir);
    if (targetStat) {
      return {
        restored: false,
      };
    }

    await params.fs.mkdirp(dirname(targetBookDir));
    await params.fs.rename(trashBookDir, targetBookDir);
    return {
      restored: true,
      deletedAtMs,
    };
  }

  return {
    restored: false,
  };
}

export async function syncWebDavMetadataOnce(
  params: WebDavSyncMetadataOnceParams,
): Promise<WebDavSyncMetadataOnceResult> {
  if (inFlightSyncTask) {
    throw new WebDavSyncAlreadyRunningError('WebDAV 同步正在进行中，请稍后重试');
  }

  const task = (async () => {
    const nowMs = params.nowMs ?? Date.now();
    const tombstoneCutoffMs = nowMs - WEBDAV_TRASH_RETENTION_MS;
    const warnings: string[] = [];
    const maxConcurrentTransfers = clampInteger(
      params.maxConcurrentTransfers,
      WEBDAV_DEFAULT_MAX_CONCURRENT_TRANSFERS,
      1,
      WEBDAV_MAX_CONCURRENT_TRANSFERS_LIMIT,
    );

    await params.client.mkcol('');
    await ensureRemoteDirs(params.client, '.meta');
    await ensureRemoteDirs(params.client, '.meta/devices');
    await ensureRemoteDirs(params.client, '.trash');

    const remoteManifest = await readRemoteManifest(params.client, params.deviceId, nowMs);
    const rawRemoteTombstones = await readRemoteTombstones(params.client, nowMs);
    const remoteTombstones = await retainUnexpiredTombstones({
      client: params.client,
      tombstones: rawRemoteTombstones,
      cutoffMs: tombstoneCutoffMs,
      nowMs,
      remoteManifest,
    });
    const localManifest = await scanLocalScopeManifest({
      fs: params.fs,
      scope: params.scope,
      sourceDeviceId: params.deviceId,
      nowMs,
    });
    const localTombstones = await buildLocalTombstonesFromDeletedBooks({
      fs: params.fs,
      scope: params.scope,
      remoteManifest,
      deviceId: params.deviceId,
      nowMs,
      cutoffMs: tombstoneCutoffMs,
    });

    const planned = planWebDavSyncOperations({
      localManifest,
      remoteManifest,
      localTombstones,
      remoteTombstones,
    });
    warnings.push(...planned.warnings);

    const operations = planned.operations;
    const settingsDir = getSettingsDir(params.scope);
    const movedLocalBookDirs = new Set<string>();
    const movedRemoteBookDirs = new Set<string>();

    const transferTasks: AsyncTask<WebDavManifestEntry[]>[] = [];

    for (const operation of operations) {
      if (operation.type === 'upload') {
        transferTasks.push(async () => {
          const updates: WebDavManifestEntry[] = [];
          const localAbs = resolveLocalPath(params.scope, operation.path);
          if (!localAbs) return updates;

          if (isJsonLikePath(operation.path)) {
            const localText = await readLocalText(params.fs, localAbs);
            if (localText === null) return updates;

            let uploadText = localText;
            if (isSettingsPath(operation.path)) {
              uploadText = mergeSettingsJson({
                localSettingsJson: localText,
                remoteSettingsJson: '{}',
              }).remoteUploadJson;
            }

            await ensureRemoteDirs(params.client, parentRemoteDir(operation.path));
            await params.client.putText(operation.path, uploadText, 'application/json');
            updates.push({ ...operation.local, path: operation.path, modifiedAtMs: nowMs });
            return updates;
          }

          if (operation.remote) {
            const conflictRelBase = makeConflictCopyRelativePath({
              originalPath: operation.path,
              side: 'remote',
              deviceId: params.deviceId,
              nowMs,
            });
            let moved = false;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const conflictRel =
                attempt === 0 ? conflictRelBase : `${conflictRelBase}.${attempt}.${randomSuffix()}`;
              try {
                await ensureRemoteDirs(params.client, parentRemoteDir(conflictRel));
                await params.client.move(operation.path, conflictRel, { overwrite: false });
                updates.push({ ...operation.remote, path: conflictRel });
                moved = true;
                break;
              } catch {
                continue;
              }
            }
            if (!moved) {
              warnings.push(`无法为二进制冲突创建远端冲突副本: ${operation.path}`);
            }
          }

          await ensureRemoteDirs(params.client, parentRemoteDir(operation.path));
          await params.client.uploadFileFromPath(
            operation.path,
            localAbs,
            guessContentType(operation.path),
          );
          updates.push({ ...operation.local, path: operation.path });
          return updates;
        });
        continue;
      }

      if (operation.type === 'download') {
        transferTasks.push(async () => {
          const updates: WebDavManifestEntry[] = [];
          const localAbs = resolveLocalPath(params.scope, operation.path);
          if (!localAbs) {
            return updates;
          }

          if (isJsonLikePath(operation.path)) {
            const remoteText = await readRemoteJsonOrNull(params.client, operation.path);
            if (remoteText === null) {
              return updates;
            }

            const needsBackup =
              operation.path === 'Settings/settings.json' ||
              operation.path === 'Books/library.json';
            if (needsBackup) {
              await writeLocalJsonWithBak({
                fs: params.fs,
                mainAbsolutePath: localAbs,
                jsonText: remoteText,
              });
            } else {
              await params.fs.writeFileAtomic(localAbs, encodeUtf8(remoteText));
            }
            return updates;
          }

          if (operation.local) {
            const conflictRel = makeConflictCopyRelativePath({
              originalPath: operation.path,
              side: 'local',
              deviceId: params.deviceId,
              nowMs,
            });
            const conflictAbs = resolveLocalPath(params.scope, conflictRel);
            if (conflictAbs) {
              await params.fs.mkdirp(dirname(conflictAbs));
              await params.fs.rename(localAbs, conflictAbs);

              await ensureRemoteDirs(params.client, parentRemoteDir(conflictRel));
              await params.client.uploadFileFromPath(
                conflictRel,
                conflictAbs,
                guessContentType(conflictRel),
              );
              updates.push({ ...operation.local, path: conflictRel });
            }
          }

          const tempPath = `${localAbs}.tmp.${randomSuffix()}`;
          try {
            await params.client.downloadFileToPath(operation.path, tempPath);
            await params.fs.rename(tempPath, localAbs);
          } catch (error) {
            await params.fs.remove(tempPath);
            throw error;
          }
          return updates;
        });
        continue;
      }

      if (operation.type === 'trash_local') {
        await moveLocalPathToTrash({
          fs: params.fs,
          scope: params.scope,
          originalPath: operation.originalPath,
          deletedAtMs: operation.deletedAtMs,
          movedBookDirs: movedLocalBookDirs,
        });
        continue;
      }

      if (operation.type === 'trash_remote') {
        await moveRemotePathToTrash({
          client: params.client,
          remoteManifest,
          originalPath: operation.originalPath,
          deletedAtMs: operation.deletedAtMs,
          movedBookDirs: movedRemoteBookDirs,
        });
        continue;
      }

      if (operation.type === 'merge_json') {
        const localAbs = resolveLocalPath(params.scope, operation.path);
        if (!localAbs) continue;
        let preconditionFailureCount = 0;
        for (let attempt = 0; attempt <= MERGE_JSON_MAX_RETRIES; attempt += 1) {
          const localText = await readLocalText(params.fs, localAbs);
          const remoteText = await readRemoteJsonOrNull(params.client, operation.path);
          const precondition = await buildWritePrecondition(params.client, operation.path);

          if (operation.strategy === 'settings') {
            const result = mergeSettingsJson({
              localSettingsJson: localText ?? '{}',
              remoteSettingsJson: remoteText ?? '{}',
            });

            try {
              await ensureRemoteDirs(params.client, parentRemoteDir(operation.path));
              await params.client.putText(
                operation.path,
                result.remoteUploadJson,
                'application/json',
                precondition,
              );
              await writeLocalJsonWithBak({
                fs: params.fs,
                mainAbsolutePath: localAbs,
                jsonText: result.mergedJson,
              });
              warnings.push(...result.warnings);
              updateManifestEntry(
                remoteManifest,
                await toManifestEntryFromText({
                  path: operation.path,
                  text: result.remoteUploadJson,
                  modifiedAtMs: nowMs,
                }),
              );
              break;
            } catch (error) {
              if (isPreconditionFailedError(error) && attempt < MERGE_JSON_MAX_RETRIES) {
                preconditionFailureCount += 1;
                continue;
              }
              if (isPreconditionFailedError(error)) {
                throw new WebDavSyncEngineError(
                  `WebDAV 条件写失败（settings，重试 ${preconditionFailureCount + 1} 次）: ${operation.path}`,
                );
              }
              throw error;
            }
          }

          if (operation.strategy === 'library') {
            const result = mergeLibraryJson({
              localLibraryJson: localText,
              remoteLibraryJson: remoteText,
              nowMs,
              deviceId: params.deviceId,
            });

            try {
              warnings.push(...result.warnings);

              if (result.writeRemote) {
                await ensureRemoteDirs(params.client, parentRemoteDir(operation.path));
                await params.client.putText(
                  operation.path,
                  result.mergedJson,
                  'application/json',
                  precondition,
                );
                updateManifestEntry(
                  remoteManifest,
                  await toManifestEntryFromText({
                    path: operation.path,
                    text: result.mergedJson,
                    modifiedAtMs: nowMs,
                  }),
                );
              }

              if (result.writeLocal) {
                await writeLocalJsonWithBak({
                  fs: params.fs,
                  mainAbsolutePath: localAbs,
                  jsonText: result.mergedJson,
                });
              }

              for (const copy of result.conflictCopies) {
                if (isMetaPath(copy.relativePath)) {
                  continue;
                }
                const abs = resolveLocalPath(params.scope, copy.relativePath);
                if (!abs) {
                  continue;
                }
                await ensureRemoteDirs(params.client, parentRemoteDir(copy.relativePath));
                await params.fs.mkdirp(dirname(abs));
                await params.fs.writeFileAtomic(abs, encodeUtf8(copy.json));
                await params.client.putText(copy.relativePath, copy.json, 'application/json');
                updateManifestEntry(
                  remoteManifest,
                  await toManifestEntryFromText({
                    path: copy.relativePath,
                    text: copy.json,
                    modifiedAtMs: nowMs,
                  }),
                );
              }

              break;
            } catch (error) {
              if (isPreconditionFailedError(error) && attempt < MERGE_JSON_MAX_RETRIES) {
                preconditionFailureCount += 1;
                continue;
              }
              if (isPreconditionFailedError(error)) {
                throw new WebDavSyncEngineError(
                  `WebDAV 条件写失败（library，重试 ${preconditionFailureCount + 1} 次）: ${operation.path}`,
                );
              }
              throw error;
            }
          }

          if (operation.strategy === 'bookConfig') {
            const match = operation.path.match(/^Books\/([^/]+)\/config\.json$/);
            if (!match) {
              warnings.push(`无法解析 config.json bookHash: ${operation.path}`);
              break;
            }
            const bookHash = match[1]!;
            const result = mergeBookConfigJson({
              bookHash,
              deviceId: params.deviceId,
              localConfigJson: localText,
              remoteConfigJson: remoteText,
              nowMs,
            });

            try {
              await ensureRemoteDirs(params.client, parentRemoteDir(operation.path));
              await params.client.putText(
                operation.path,
                result.mergedJson,
                'application/json',
                precondition,
              );
              await params.fs.writeFileAtomic(localAbs, encodeUtf8(result.mergedJson));
              warnings.push(...result.warnings);
              updateManifestEntry(
                remoteManifest,
                await toManifestEntryFromText({
                  path: operation.path,
                  text: result.mergedJson,
                  modifiedAtMs: nowMs,
                }),
              );

              for (const copy of result.conflictCopies) {
                if (isMetaPath(copy.relativePath)) {
                  continue;
                }
                const abs = resolveLocalPath(params.scope, copy.relativePath);
                if (!abs) {
                  continue;
                }
                await ensureRemoteDirs(params.client, parentRemoteDir(copy.relativePath));
                await params.fs.writeFileAtomic(abs, encodeUtf8(copy.json));
                await params.client.putText(copy.relativePath, copy.json, 'application/json');
                updateManifestEntry(
                  remoteManifest,
                  await toManifestEntryFromText({
                    path: copy.relativePath,
                    text: copy.json,
                    modifiedAtMs: nowMs,
                  }),
                );
              }
              break;
            } catch (error) {
              if (isPreconditionFailedError(error) && attempt < MERGE_JSON_MAX_RETRIES) {
                preconditionFailureCount += 1;
                continue;
              }
              if (isPreconditionFailedError(error)) {
                throw new WebDavSyncEngineError(
                  `WebDAV 条件写失败（bookConfig，重试 ${preconditionFailureCount + 1} 次）: ${operation.path}`,
                );
              }
              throw error;
            }
          }
        }
        continue;
      }
    }

    const transferResults = await runConcurrently(transferTasks, maxConcurrentTransfers);
    const transferUpdates = transferResults.flat();
    updateManifestEntries(remoteManifest, transferUpdates);

    const nextManifest: WebDavManifestSchema = {
      ...remoteManifest,
      schemaVersion: 1,
      updatedAtMs: nowMs,
      sourceDeviceId: params.deviceId,
      entries: remoteManifest.entries.sort((a, b) => a.path.localeCompare(b.path)),
    };
    if (!nextManifest.generatedAtMs) {
      nextManifest.generatedAtMs = nowMs;
    }

    const deviceInfo = {
      schemaVersion: 1,
      deviceId: params.deviceId,
      deviceName: params.deviceId,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      lastSeenAtMs: nowMs,
    };

    await putTextWithEtagPrecondition(
      params.client,
      '.meta/manifest.json',
      JSON.stringify(nextManifest, null, 2),
      'application/json',
    );
    const retainedMergedTombstones = await retainUnexpiredTombstones({
      client: params.client,
      tombstones: planned.mergedTombstones,
      cutoffMs: tombstoneCutoffMs,
      nowMs,
      remoteManifest,
    });

    await putTextWithEtagPrecondition(
      params.client,
      '.meta/tombstones.json',
      JSON.stringify(retainedMergedTombstones, null, 2),
      'application/json',
    );
    await putTextWithEtagPrecondition(
      params.client,
      `.meta/devices/${params.deviceId}.json`,
      JSON.stringify(deviceInfo, null, 2),
      'application/json',
    );

    const localDeviceInfoPath = `${ensureTrailingSlashTrimmed(settingsDir)}/webdav.device.json`;
    await params.fs.writeFileAtomic(
      localDeviceInfoPath,
      encodeUtf8(JSON.stringify(deviceInfo, null, 2)),
    );

    return { operations, warnings };
  })();

  inFlightSyncTask = task;
  try {
    return await task;
  } finally {
    if (inFlightSyncTask === task) {
      inFlightSyncTask = null;
    }
  }
}
