type JsonObject = Record<string, unknown>;

export interface MergeSettingsJsonResult {
  mergedJson: string;
  remoteUploadJson: string;
  warnings: string[];
}

const safeParse = (input: string): { value: unknown; ok: boolean } => {
  try {
    return { value: JSON.parse(input), ok: true };
  } catch {
    return { value: {}, ok: false };
  }
};

const deepClone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const isObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isSyncBackend = (value: unknown): value is 'off' | 'cloud' | 'webdav' =>
  value === 'off' || value === 'cloud' || value === 'webdav';

const deepMergeRemoteWins = (local: unknown, remote: unknown): unknown => {
  if (Array.isArray(local) && Array.isArray(remote)) {
    return remote;
  }
  if (isObject(local) && isObject(remote)) {
    const out: JsonObject = { ...local };
    for (const [key, remoteValue] of Object.entries(remote)) {
      if (key in out) {
        out[key] = deepMergeRemoteWins(out[key], remoteValue);
      } else {
        out[key] = remoteValue;
      }
    }
    return out;
  }
  return remote ?? local;
};

const redactSettingsSecrets = (settings: unknown): unknown => {
  const clone = deepClone(settings);
  if (!isObject(clone)) {
    return {};
  }

  delete clone['syncBackend'];

  const readwise = clone['readwise'];
  if (isObject(readwise)) {
    delete readwise['accessToken'];
  }

  const kosync = clone['kosync'];
  if (isObject(kosync)) {
    delete kosync['userkey'];
  }

  const catalogs = clone['opdsCatalogs'];
  if (Array.isArray(catalogs)) {
    for (const item of catalogs) {
      if (isObject(item)) {
        delete item['password'];
      }
    }
  }

  return clone;
};

const restoreLocalSecrets = (merged: unknown, local: unknown) => {
  if (!isObject(merged) || !isObject(local)) {
    return;
  }

  const localSyncBackend = local['syncBackend'];
  if (isSyncBackend(localSyncBackend)) {
    merged['syncBackend'] = localSyncBackend;
  }

  const localReadwise = local['readwise'];
  if (isObject(localReadwise)) {
    const accessToken = localReadwise['accessToken'];
    if (typeof accessToken === 'string') {
      const mergedReadwise = merged['readwise'];
      if (isObject(mergedReadwise)) {
        mergedReadwise['accessToken'] = accessToken;
      }
    }
  }

  const localKosync = local['kosync'];
  if (isObject(localKosync)) {
    const userkey = localKosync['userkey'];
    if (typeof userkey === 'string') {
      const mergedKosync = merged['kosync'];
      if (isObject(mergedKosync)) {
        mergedKosync['userkey'] = userkey;
      }
    }
  }

  const localCatalogs = local['opdsCatalogs'];
  const mergedCatalogs = merged['opdsCatalogs'];
  if (Array.isArray(localCatalogs) && Array.isArray(mergedCatalogs)) {
    const passwordById = new Map<string, string>();
    for (const item of localCatalogs) {
      if (
        isObject(item) &&
        typeof item['id'] === 'string' &&
        typeof item['password'] === 'string'
      ) {
        passwordById.set(item['id'], item['password']);
      }
    }
    for (const item of mergedCatalogs) {
      if (isObject(item) && typeof item['id'] === 'string') {
        const password = passwordById.get(item['id']);
        if (password) {
          item['password'] = password;
        }
      }
    }
  }
};

export function mergeSettingsJson(params: {
  localSettingsJson: string;
  remoteSettingsJson: string;
}): MergeSettingsJsonResult {
  const warnings: string[] = [];
  const localParsed = safeParse(params.localSettingsJson);
  const remoteParsed = safeParse(params.remoteSettingsJson);
  if (!localParsed.ok) {
    warnings.push('本地 settings.json 解析失败，按空对象处理');
  }
  if (!remoteParsed.ok) {
    warnings.push('远端 settings.json 解析失败，按空对象处理');
  }

  const remoteRedacted = redactSettingsSecrets(remoteParsed.value);
  const merged = deepMergeRemoteWins(localParsed.value, remoteRedacted);
  restoreLocalSecrets(merged, localParsed.value);

  const remoteUpload = redactSettingsSecrets(merged);
  return {
    mergedJson: JSON.stringify(merged, null, 2),
    remoteUploadJson: JSON.stringify(remoteUpload, null, 2),
    warnings,
  };
}
