export interface WebDavLocalSettings {
  schemaVersion: 1;
  baseUrl: string;
  username: string;
  rootDir: string;
  autoSync: boolean;
  allowInsecureTls: boolean;
  httpWarningAcknowledged: boolean;
  maxConcurrentTransfers: number;
  updatedAt: number;
}

export const WEBDAV_LOCAL_SETTINGS_FILENAME = 'webdav.local.json';

const DEFAULT_ROOT_DIR = 'readest1';
const DEFAULT_MAX_CONCURRENT_TRANSFERS = 4;
const MAX_CONCURRENT_TRANSFERS_LIMIT = 8;

const asBoolean = (value: unknown, defaultValue: boolean) =>
  typeof value === 'boolean' ? value : defaultValue;

const asString = (value: unknown, defaultValue: string) =>
  typeof value === 'string' && value.trim().length > 0 ? value : defaultValue;

const asNumber = (value: unknown, defaultValue: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;

const clampInteger = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.floor(value)));

export function sanitizeWebDavLocalSettings(raw: unknown, nowMs = Date.now()): WebDavLocalSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const maxConcurrentTransfers = clampInteger(
    asNumber(obj['maxConcurrentTransfers'], DEFAULT_MAX_CONCURRENT_TRANSFERS),
    1,
    MAX_CONCURRENT_TRANSFERS_LIMIT,
  );
  return {
    schemaVersion: 1,
    baseUrl: asString(obj['baseUrl'], ''),
    username: asString(obj['username'], ''),
    rootDir: asString(obj['rootDir'], DEFAULT_ROOT_DIR),
    autoSync: asBoolean(obj['autoSync'], false),
    allowInsecureTls: asBoolean(obj['allowInsecureTls'], false),
    httpWarningAcknowledged: asBoolean(obj['httpWarningAcknowledged'], false),
    maxConcurrentTransfers,
    updatedAt: asNumber(obj['updatedAt'], nowMs),
  };
}

export function serializeWebDavLocalSettings(raw: unknown, nowMs = Date.now()): string {
  const sanitized = sanitizeWebDavLocalSettings(raw, nowMs);
  return JSON.stringify(sanitized, null, 2);
}
