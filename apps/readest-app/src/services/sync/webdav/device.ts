import { v4 as uuidv4 } from 'uuid';
import { decodeUtf8, encodeUtf8, type WebDavFsAdapter, writeJsonAtomic } from './fsAdapter';

export const WEBDAV_DEVICE_FILENAME = 'webdav.device.json';

export interface WebDavDeviceInfo {
  schemaVersion: 1;
  deviceId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

const safeParseDeviceInfo = (text: string): WebDavDeviceInfo | null => {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    if (obj['schemaVersion'] !== 1) return null;
    const deviceId = obj['deviceId'];
    if (typeof deviceId !== 'string' || deviceId.length < 8) return null;

    const createdAtMs = obj['createdAtMs'];
    if (typeof createdAtMs !== 'number') return null;

    const updatedAtMs = obj['updatedAtMs'];
    if (typeof updatedAtMs !== 'number') return null;

    const parsed: WebDavDeviceInfo = {
      schemaVersion: 1,
      deviceId,
      createdAtMs,
      updatedAtMs,
    };
    return parsed;
  } catch {
    return null;
  }
};

export async function getOrCreateWebDavDeviceInfo(params: {
  fs: WebDavFsAdapter;
  settingsDirPath: string;
  nowMs?: number;
}): Promise<WebDavDeviceInfo> {
  const nowMs = params.nowMs ?? Date.now();
  const filePath = `${params.settingsDirPath.replace(/\/+$/g, '')}/${WEBDAV_DEVICE_FILENAME}`;

  const existingBytes = await params.fs.readFile(filePath).catch(() => null);
  if (existingBytes) {
    const parsed = safeParseDeviceInfo(decodeUtf8(existingBytes));
    if (parsed) {
      if (parsed.updatedAtMs !== nowMs) {
        const next: WebDavDeviceInfo = { ...parsed, updatedAtMs: nowMs };
        await writeJsonAtomic(params.fs, filePath, next);
        return next;
      }
      return parsed;
    }
  }

  const created: WebDavDeviceInfo = {
    schemaVersion: 1,
    deviceId: uuidv4(),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };

  await params.fs.writeFileAtomic(filePath, encodeUtf8(JSON.stringify(created, null, 2)));
  return created;
}
