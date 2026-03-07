import { describe, expect, it } from 'vitest';
import { DEFAULT_MOBILE_SYSTEM_SETTINGS } from '@/services/constants';

describe('DEFAULT_MOBILE_SYSTEM_SETTINGS', () => {
  it('移动端默认使用 WebDAV 作为同步后端', () => {
    expect(DEFAULT_MOBILE_SYSTEM_SETTINGS.syncBackend).toBe('webdav');
  });
});
