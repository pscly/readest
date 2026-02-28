export const WEBDAV_REMOTE_SCHEMA_VERSION = 1;

export type MsTimestamp = number;

export interface WebDavManifestEntry {
  path: string;
  sizeBytes: number;
  modifiedAtMs: MsTimestamp;
  etag?: string;
  checksum?: string;
}

export interface WebDavManifestSchema {
  schemaVersion: number;
  generatedAtMs: MsTimestamp;
  updatedAtMs: MsTimestamp;
  sourceDeviceId: string;
  entries: WebDavManifestEntry[];
}

export interface WebDavTombstoneEntry {
  originalPath: string;
  deletedAtMs: MsTimestamp;
  deletedByDeviceId: string;
}

export interface WebDavTombstonesSchema {
  schemaVersion: number;
  generatedAtMs: MsTimestamp;
  updatedAtMs: MsTimestamp;
  tombstones: WebDavTombstoneEntry[];
}

export interface WebDavDeviceMetadataSchema {
  schemaVersion: number;
  deviceId: string;
  deviceName: string;
  createdAtMs: MsTimestamp;
  updatedAtMs: MsTimestamp;
  lastSeenAtMs: MsTimestamp;
  appVersion?: string;
}

export const createEmptyWebDavManifestSchema = ({
  sourceDeviceId,
  nowMs = Date.now(),
}: {
  sourceDeviceId: string;
  nowMs?: number;
}): WebDavManifestSchema => ({
  schemaVersion: WEBDAV_REMOTE_SCHEMA_VERSION,
  generatedAtMs: nowMs,
  updatedAtMs: nowMs,
  sourceDeviceId,
  entries: [],
});

export const createEmptyWebDavTombstonesSchema = ({
  nowMs = Date.now(),
}: {
  nowMs?: number;
} = {}): WebDavTombstonesSchema => ({
  schemaVersion: WEBDAV_REMOTE_SCHEMA_VERSION,
  generatedAtMs: nowMs,
  updatedAtMs: nowMs,
  tombstones: [],
});

export const createWebDavDeviceMetadataSchema = ({
  deviceId,
  deviceName,
  appVersion,
  nowMs = Date.now(),
}: {
  deviceId: string;
  deviceName: string;
  appVersion?: string;
  nowMs?: number;
}): WebDavDeviceMetadataSchema => ({
  schemaVersion: WEBDAV_REMOTE_SCHEMA_VERSION,
  deviceId,
  deviceName,
  createdAtMs: nowMs,
  updatedAtMs: nowMs,
  lastSeenAtMs: nowMs,
  appVersion,
});
