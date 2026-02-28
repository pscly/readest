import { isTauriAppPlatform } from '@/services/environment';
import {
  secureStoreDelete,
  secureStoreGet,
  secureStoreSet,
  type SecureStoreGetResponse,
} from '@/utils/bridge';

const WEBDAV_PASSWORD_KEY = 'webdav.password';

export class WebDavCredentialsError extends Error {
  override name = 'WebDavCredentialsError';
}

const assertNativeSupported = () => {
  if (!isTauriAppPlatform()) {
    throw new WebDavCredentialsError('WebDAV 凭据仅支持在 Tauri 应用内使用');
  }
};

const assertOk = (result: { success: boolean; error?: string }) => {
  if (!result.success) {
    throw new WebDavCredentialsError(result.error || '安全存储操作失败');
  }
};

const assertGetOk = (result: SecureStoreGetResponse) => {
  if (result.error) {
    throw new WebDavCredentialsError(result.error);
  }
};

export async function setWebDavPassword(password: string): Promise<void> {
  assertNativeSupported();
  const result = await secureStoreSet({ key: WEBDAV_PASSWORD_KEY, value: password });
  assertOk(result);
}

export async function getWebDavPassword(): Promise<string | null> {
  assertNativeSupported();
  const result = await secureStoreGet({ key: WEBDAV_PASSWORD_KEY });
  assertGetOk(result);
  return result.value;
}

export async function clearWebDavPassword(): Promise<void> {
  assertNativeSupported();
  const result = await secureStoreDelete({ key: WEBDAV_PASSWORD_KEY });
  assertOk(result);
}
