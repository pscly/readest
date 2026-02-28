import type { AppService } from '@/types/system';
import { WebDavClient } from './client';
import { getWebDavPassword } from './credentials';
import { sanitizeWebDavLocalSettings, WEBDAV_LOCAL_SETTINGS_FILENAME } from './localSettings';
import { buildWebDavSyncScopeFromAppService } from './syncScope';
import { getOrCreateWebDavDeviceInfo } from './device';
import { TauriFsAdapter } from './tauriFsAdapter';
import { syncWebDavMetadataOnce } from './engine';

export class WebDavSyncNotConfiguredError extends Error {
  override name = 'WebDavSyncNotConfiguredError';
}

export async function runWebDavSyncOnce(appService: AppService) {
  const scope = await buildWebDavSyncScopeFromAppService(appService);
  const fs = new TauriFsAdapter();

  const settingsDir = await appService.resolveFilePath('', 'Settings');
  const localSettingsPath = `${settingsDir.replace(/[\\/]+$/g, '')}/${WEBDAV_LOCAL_SETTINGS_FILENAME}`;
  const localSettingsText = await fs
    .readFile(localSettingsPath)
    .then((b) => new TextDecoder().decode(b))
    .catch(() => '{}');
  let localSettingsRaw: unknown = {};
  try {
    localSettingsRaw = JSON.parse(localSettingsText);
  } catch {
    localSettingsRaw = {};
  }
  const localSettings = sanitizeWebDavLocalSettings(localSettingsRaw);

  if (!localSettings.baseUrl || !localSettings.username) {
    throw new WebDavSyncNotConfiguredError('WebDAV 未配置（缺少 baseUrl/username）');
  }

  const password = await getWebDavPassword();
  if (!password) {
    throw new WebDavSyncNotConfiguredError('WebDAV 未配置（缺少密码）');
  }

  const deviceInfo = await getOrCreateWebDavDeviceInfo({
    fs,
    settingsDirPath: settingsDir,
  });

  const client = new WebDavClient({
    baseUrl: localSettings.baseUrl,
    rootDir: localSettings.rootDir,
    username: localSettings.username,
    password,
    allowInsecureTls: localSettings.allowInsecureTls,
  });

  return await syncWebDavMetadataOnce({
    client,
    fs,
    scope,
    deviceId: deviceInfo.deviceId,
  });
}
