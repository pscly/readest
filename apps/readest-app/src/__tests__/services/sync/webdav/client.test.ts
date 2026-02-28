import { describe, expect, it } from 'vitest';
import { startWebDavMockServer } from '@/__tests__/helpers/webdav-mock';
import { WebDavClient, WebDavHttpError } from '@/services/sync/webdav/client';

describe('WebDavClient', () => {
  it('PUT -> PROPFIND -> GET (happy path)', async () => {
    const server = await startWebDavMockServer();
    try {
      const client = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 2000,
        maxRetries: 0,
      });

      await client.mkcol('');
      await client.mkcol('Books');
      await client.putText('Books/hello.txt', 'hi', 'text/plain');

      const entries = await client.propfind('Books', '1');
      expect(entries.some((entry) => entry.href.endsWith('/readest1/Books/hello.txt'))).toBe(true);

      const text = await client.getText('Books/hello.txt');
      expect(text).toBe('hi');
    } finally {
      await server.close();
    }
  });

  it('returns 401 on invalid credentials', async () => {
    const server = await startWebDavMockServer();
    try {
      const client = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'wrong',
        timeoutMs: 2000,
        maxRetries: 0,
      });

      await expect(client.propfind('', '0')).rejects.toEqual(expect.any(WebDavHttpError));
      await expect(client.propfind('', '0')).rejects.toMatchObject({ status: 401 });
    } finally {
      await server.close();
    }
  });

  it('returns 412 when If-Match does not match', async () => {
    const server = await startWebDavMockServer();
    try {
      const client = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 2000,
        maxRetries: 0,
      });

      await client.mkcol('');
      await client.mkcol('Books');
      await client.putText('Books/etag.txt', 'v1', 'text/plain');

      await expect(
        client.putText('Books/etag.txt', 'v2', 'text/plain', { ifMatch: '"wrong-etag"' }),
      ).rejects.toMatchObject({ status: 412 });
    } finally {
      await server.close();
    }
  });

  it('allows PUT with correct If-Match', async () => {
    const server = await startWebDavMockServer();
    try {
      const client = new WebDavClient({
        baseUrl: server.baseUrl,
        rootDir: 'readest1',
        username: 'user',
        password: 'pass',
        timeoutMs: 2000,
        maxRetries: 0,
      });

      await client.mkcol('');
      await client.mkcol('Books');
      await client.putText('Books/etag-ok.txt', 'v1', 'text/plain');
      const etag = await client.getEtag('Books/etag-ok.txt');
      expect(etag).toBeTruthy();

      await client.putText('Books/etag-ok.txt', 'v2', 'text/plain', { ifMatch: etag ?? undefined });
      await expect(client.getText('Books/etag-ok.txt')).resolves.toBe('v2');
    } finally {
      await server.close();
    }
  });
});
