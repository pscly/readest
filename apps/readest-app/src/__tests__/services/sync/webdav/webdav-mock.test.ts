import { afterEach, describe, expect, it } from 'vitest';
import { startWebDavMockServer } from '@/__tests__/helpers/webdav-mock';

const basicAuthHeader = `Basic ${Buffer.from('user:pass').toString('base64')}`;

const closeHandlers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closeHandlers.length > 0) {
    const close = closeHandlers.pop();
    if (close) {
      await close();
    }
  }
});

describe('webdav mock server', () => {
  it('supports PUT -> PROPFIND -> GET roundtrip with basic auth', async () => {
    const server = await startWebDavMockServer();
    closeHandlers.push(server.close);

    const filePath = '/roundtrip/book.txt';
    const fileContent = 'hello-webdav';

    const mkcolResponse = await fetch(`${server.baseUrl}/roundtrip`, {
      method: 'MKCOL',
      headers: { Authorization: basicAuthHeader },
    });
    expect(mkcolResponse.status).toBe(201);

    const putResponse = await fetch(`${server.baseUrl}${filePath}`, {
      method: 'PUT',
      headers: { Authorization: basicAuthHeader },
      body: fileContent,
    });
    expect(putResponse.status).toBe(201);

    const propfindResponse = await fetch(`${server.baseUrl}/roundtrip`, {
      method: 'PROPFIND',
      headers: {
        Authorization: basicAuthHeader,
        Depth: '1',
      },
    });
    expect(propfindResponse.status).toBe(207);

    const propfindXml = await propfindResponse.text();
    expect(propfindXml).toContain('<D:multistatus xmlns:D="DAV:">');
    expect(propfindXml).toContain(`<D:href>${server.baseUrl}/roundtrip/book.txt</D:href>`);
    expect(propfindXml).toContain('<D:getetag>');
    expect(propfindXml).toContain('<D:getlastmodified>');
    expect(propfindXml).toContain('<D:getcontentlength>12</D:getcontentlength>');

    const getResponse = await fetch(`${server.baseUrl}${filePath}`, {
      method: 'GET',
      headers: { Authorization: basicAuthHeader },
    });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe(fileContent);
  });

  it('returns 401 when missing basic auth header', async () => {
    const server = await startWebDavMockServer();
    closeHandlers.push(server.close);

    const response = await fetch(`${server.baseUrl}/unauthorized.txt`, {
      method: 'GET',
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic');
  });

  it('supports fault injection for 500, read-only 403 and delayed response', async () => {
    const server = await startWebDavMockServer();
    closeHandlers.push(server.close);

    server.state.failWith500Paths.add('/fail.txt');
    server.state.readOnlyPaths.add('/readonly');
    server.state.delayByPath.set('/delay.txt', 80);

    const failResponse = await fetch(`${server.baseUrl}/fail.txt`, {
      method: 'GET',
      headers: { Authorization: basicAuthHeader },
    });
    expect(failResponse.status).toBe(500);

    const mkcolReadonly = await fetch(`${server.baseUrl}/readonly`, {
      method: 'MKCOL',
      headers: { Authorization: basicAuthHeader },
    });
    expect(mkcolReadonly.status).toBe(403);

    const startedAt = Date.now();
    const delayedResponse = await fetch(`${server.baseUrl}/delay.txt`, {
      method: 'GET',
      headers: { Authorization: basicAuthHeader },
    });
    const elapsed = Date.now() - startedAt;
    expect(delayedResponse.status).toBe(404);
    expect(elapsed).toBeGreaterThanOrEqual(70);
  });
});
