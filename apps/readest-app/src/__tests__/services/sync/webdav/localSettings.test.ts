import { describe, expect, it } from 'vitest';
import { serializeWebDavLocalSettings } from '@/services/sync/webdav/localSettings';

describe('serializeWebDavLocalSettings', () => {
  it('does not include password field', () => {
    const json = serializeWebDavLocalSettings({
      baseUrl: 'http://example.com/webdav',
      username: 'user',
      rootDir: 'readest1',
      autoSync: true,
      allowInsecureTls: true,
      httpWarningAcknowledged: true,
      maxConcurrentTransfers: 6,
      password: 'should-not-be-serialized',
    });

    expect(json).not.toContain('password');
    expect(JSON.parse(json)).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        baseUrl: 'http://example.com/webdav',
        username: 'user',
        rootDir: 'readest1',
        autoSync: true,
        allowInsecureTls: true,
        httpWarningAcknowledged: true,
        maxConcurrentTransfers: 6,
      }),
    );
  });
});
