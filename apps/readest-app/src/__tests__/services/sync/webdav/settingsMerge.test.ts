import { describe, expect, it } from 'vitest';
import { mergeSettingsJson } from '@/services/sync/webdav/merge/settingsMerge';

describe('mergeSettingsJson', () => {
  type SettingsLike = {
    themeMode?: string;
    syncBackend?: string;
    readwise?: { accessToken?: string };
    kosync?: { userkey?: string };
    opdsCatalogs?: Array<{ password?: string }>;
  };

  it('redacts secrets from remoteUploadJson and restores local secrets in mergedJson', () => {
    const localSettings = {
      themeMode: 'light',
      syncBackend: 'webdav',
      readwise: {
        enabled: true,
        accessToken: 'local-token',
        lastSyncedAt: 123,
      },
      kosync: {
        enabled: true,
        userkey: 'local-userkey',
      },
      opdsCatalogs: [
        {
          id: 'catalog-1',
          title: 'Demo',
          url: 'https://example.com/opds',
          username: 'user',
          password: 'local-pass',
        },
      ],
    };

    const remoteSettings = {
      themeMode: 'dark',
      syncBackend: 'cloud',
      readwise: {
        enabled: false,
        accessToken: 'remote-token',
        lastSyncedAt: 999,
      },
      kosync: {
        enabled: false,
        userkey: 'remote-userkey',
      },
      opdsCatalogs: [
        {
          id: 'catalog-1',
          title: 'Demo',
          url: 'https://example.com/opds',
          username: 'user',
          password: 'remote-pass',
        },
      ],
    };

    const result = mergeSettingsJson({
      localSettingsJson: JSON.stringify(localSettings),
      remoteSettingsJson: JSON.stringify(remoteSettings),
    });

    const merged = JSON.parse(result.mergedJson) as SettingsLike;
    expect(merged.themeMode).toBe('dark');
    expect(merged.syncBackend).toBe('webdav');
    expect(merged.readwise?.accessToken).toBe('local-token');
    expect(merged.kosync?.userkey).toBe('local-userkey');
    expect(merged.opdsCatalogs?.[0]?.password).toBe('local-pass');

    const remoteUpload = JSON.parse(result.remoteUploadJson) as SettingsLike;
    expect(remoteUpload.syncBackend).toBeUndefined();
    expect(remoteUpload.readwise?.accessToken).toBeUndefined();
    expect(remoteUpload.kosync?.userkey).toBeUndefined();
    expect(remoteUpload.opdsCatalogs?.[0]?.password).toBeUndefined();
  });

  it('adds warnings when JSON is invalid', () => {
    const result = mergeSettingsJson({
      localSettingsJson: '{"ok":true}',
      remoteSettingsJson: '{ invalid json',
    });

    expect(result.warnings.join('\n')).toContain('远端 settings.json 解析失败');
    expect(JSON.parse(result.mergedJson)).toEqual({ ok: true });
  });

  it('keeps syncBackend local-only and excludes it from remote upload', () => {
    const localSettings = {
      syncBackend: 'webdav',
    };
    const remoteSettings = {
      syncBackend: 'cloud',
    };

    const result = mergeSettingsJson({
      localSettingsJson: JSON.stringify(localSettings),
      remoteSettingsJson: JSON.stringify(remoteSettings),
    });

    const merged = JSON.parse(result.mergedJson) as SettingsLike;
    expect(merged.syncBackend).toBe('webdav');

    const remoteUpload = JSON.parse(result.remoteUploadJson) as SettingsLike;
    expect(remoteUpload.syncBackend).toBeUndefined();
  });
});
