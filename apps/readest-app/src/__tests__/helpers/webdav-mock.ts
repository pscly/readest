import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

type WebDavEntry = {
  isCollection: boolean;
  content: Buffer;
  etag: string;
  lastModifiedMs: number;
};

export type WebDavMockState = {
  entries: Map<string, WebDavEntry>;
  failWith500Paths: Set<string>;
  readOnlyPaths: Set<string>;
  abortGetPaths: Set<string>;
  delayMs: number;
  delayByPath: Map<string, number>;
};

type StartWebDavMockServerOptions = {
  username?: string;
  password?: string;
  delayMs?: number;
};

const normalizePath = (inputPath: string) => {
  const sanitized = inputPath.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (sanitized === '' || sanitized === '/') {
    return '/';
  }

  const withLeadingSlash = sanitized.startsWith('/') ? sanitized : `/${sanitized}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/g, '') : withLeadingSlash;
};

const getParentPath = (path: string) => {
  if (path === '/') {
    return '/';
  }

  const index = path.lastIndexOf('/');
  if (index <= 0) {
    return '/';
  }

  return path.slice(0, index) || '/';
};

const formatHttpDate = (ms: number) => new Date(ms).toUTCString();

const computeEtag = (content: Buffer, isCollection: boolean) => {
  const digest = createHash('sha1')
    .update(isCollection ? 'collection:' : 'file:')
    .update(content)
    .digest('hex');
  return `"${digest}"`;
};

const updateEntry = (
  entries: Map<string, WebDavEntry>,
  path: string,
  isCollection: boolean,
  content: Buffer,
) => {
  const normalizedPath = normalizePath(path);
  const now = Date.now();
  entries.set(normalizedPath, {
    isCollection,
    content,
    etag: computeEtag(content, isCollection),
    lastModifiedMs: now,
  });
};

const collectBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

const getHeader = (request: IncomingMessage, headerName: string): string | undefined => {
  const headerValue = request.headers[headerName];
  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }

  return headerValue;
};

const parseEntityTagList = (headerValue: string) =>
  headerValue
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const failOnPrecondition = (params: {
  request: IncomingMessage;
  currentEntry: WebDavEntry | undefined;
}): boolean => {
  const ifMatch = getHeader(params.request, 'if-match');
  if (ifMatch) {
    if (!params.currentEntry) {
      return true;
    }
    const tags = parseEntityTagList(ifMatch);
    if (tags.length > 0 && !tags.includes(params.currentEntry.etag) && !tags.includes('*')) {
      return true;
    }
  }

  const ifNoneMatch = getHeader(params.request, 'if-none-match');
  if (ifNoneMatch) {
    const tags = parseEntityTagList(ifNoneMatch);
    if (tags.includes('*') && params.currentEntry) {
      return true;
    }
    if (params.currentEntry && tags.includes(params.currentEntry.etag)) {
      return true;
    }
  }

  return false;
};

const ensureAuthorized = (request: IncomingMessage, expectedAuthHeader: string) => {
  return request.headers.authorization === expectedAuthHeader;
};

const isPathOrParentMatch = (candidatePath: string, targetPath: string) => {
  if (candidatePath === '/') {
    return true;
  }

  return targetPath === candidatePath || targetPath.startsWith(`${candidatePath}/`);
};

const isReadOnly = (readOnlyPaths: Set<string>, path: string) => {
  for (const readOnlyPath of readOnlyPaths) {
    if (isPathOrParentMatch(readOnlyPath, path)) {
      return true;
    }
  }
  return false;
};

const buildPropfindXml = (
  baseUrl: string,
  entries: Array<{ path: string; entry: WebDavEntry }>,
) => {
  const responses = entries
    .map(({ path, entry }) => {
      const href = `${baseUrl}${path}`;
      const contentLength = entry.isCollection ? 0 : entry.content.byteLength;
      const lastModified = formatHttpDate(entry.lastModifiedMs);

      return `  <D:response>\n    <D:href>${href}</D:href>\n    <D:propstat>\n      <D:prop>\n        <D:getetag>${entry.etag}</D:getetag>\n        <D:getlastmodified>${lastModified}</D:getlastmodified>\n        <D:getcontentlength>${contentLength}</D:getcontentlength>\n      </D:prop>\n      <D:status>HTTP/1.1 200 OK</D:status>\n    </D:propstat>\n  </D:response>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:\">\n${responses}\n</D:multistatus>`;
};

const send = (
  response: ServerResponse,
  statusCode: number,
  body = '',
  headers?: Record<string, string>,
) => {
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      response.setHeader(key, value);
    }
  }
  response.statusCode = statusCode;
  response.end(body);
};

export const startWebDavMockServer = async (
  options: StartWebDavMockServerOptions = {},
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  state: WebDavMockState;
}> => {
  const username = options.username ?? 'user';
  const password = options.password ?? 'pass';
  const expectedAuthHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  const state: WebDavMockState = {
    entries: new Map<string, WebDavEntry>(),
    failWith500Paths: new Set<string>(),
    readOnlyPaths: new Set<string>(),
    abortGetPaths: new Set<string>(),
    delayMs: options.delayMs ?? 0,
    delayByPath: new Map<string, number>(),
  };

  updateEntry(state.entries, '/', true, Buffer.alloc(0));

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const requestPath = normalizePath(decodeURIComponent(url.pathname));
    const method = (request.method || 'GET').toUpperCase();

    if (!ensureAuthorized(request, expectedAuthHeader)) {
      send(response, 401, 'Unauthorized', {
        'WWW-Authenticate': 'Basic realm="webdav-mock"',
      });
      return;
    }

    const delayMs = state.delayByPath.get(requestPath) ?? state.delayMs;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    if (state.failWith500Paths.has(requestPath)) {
      send(response, 500, 'Injected Internal Server Error');
      return;
    }

    const denyWrite = () => {
      if (!['MKCOL', 'PUT', 'MOVE', 'DELETE'].includes(method)) {
        return false;
      }
      return isReadOnly(state.readOnlyPaths, requestPath);
    };

    if (denyWrite()) {
      send(response, 403, 'Forbidden');
      return;
    }

    if (method === 'MKCOL') {
      if (state.entries.has(requestPath)) {
        send(response, 405, 'Method Not Allowed');
        return;
      }

      const parentPath = getParentPath(requestPath);
      const parent = state.entries.get(parentPath);
      if (!parent || !parent.isCollection) {
        send(response, 409, 'Conflict');
        return;
      }

      updateEntry(state.entries, requestPath, true, Buffer.alloc(0));
      send(response, 201);
      return;
    }

    if (method === 'PUT') {
      const parentPath = getParentPath(requestPath);
      const parent = state.entries.get(parentPath);
      if (!parent || !parent.isCollection) {
        send(response, 409, 'Conflict');
        return;
      }

      const existingEntry = state.entries.get(requestPath);
      if (failOnPrecondition({ request, currentEntry: existingEntry })) {
        send(response, 412, 'Precondition Failed');
        return;
      }

      const content = await collectBody(request);
      const existed = Boolean(existingEntry);
      updateEntry(state.entries, requestPath, false, content);
      send(response, existed ? 204 : 201);
      return;
    }

    if (method === 'GET') {
      const entry = state.entries.get(requestPath);
      if (!entry || entry.isCollection) {
        send(response, 404, 'Not Found');
        return;
      }

      if (state.abortGetPaths.has(requestPath)) {
        response.statusCode = 200;
        response.setHeader('ETag', entry.etag);
        response.setHeader('Last-Modified', formatHttpDate(entry.lastModifiedMs));
        response.setHeader('Content-Length', `${entry.content.byteLength}`);
        const partialLength = Math.max(0, entry.content.byteLength - 1);
        response.write(entry.content.subarray(0, partialLength));
        response.destroy();
        return;
      }

      send(response, 200, entry.content.toString('utf-8'), {
        ETag: entry.etag,
        'Last-Modified': formatHttpDate(entry.lastModifiedMs),
        'Content-Length': `${entry.content.byteLength}`,
      });
      return;
    }

    if (method === 'MOVE') {
      const destinationRaw = getHeader(request, 'destination');
      if (!destinationRaw) {
        send(response, 400, 'Missing Destination');
        return;
      }

      const source = state.entries.get(requestPath);
      if (!source) {
        send(response, 404, 'Not Found');
        return;
      }

      if (failOnPrecondition({ request, currentEntry: source })) {
        send(response, 412, 'Precondition Failed');
        return;
      }

      const destinationUrl = new URL(destinationRaw, 'http://127.0.0.1');
      const destinationPath = normalizePath(decodeURIComponent(destinationUrl.pathname));
      const destinationParentPath = getParentPath(destinationPath);
      const destinationParent = state.entries.get(destinationParentPath);
      if (!destinationParent || !destinationParent.isCollection) {
        send(response, 409, 'Conflict');
        return;
      }

      if (isReadOnly(state.readOnlyPaths, destinationPath)) {
        send(response, 403, 'Forbidden');
        return;
      }

      const movedEntries = Array.from(state.entries.entries()).filter(([path]) =>
        isPathOrParentMatch(requestPath, path),
      );

      for (const [path] of movedEntries) {
        state.entries.delete(path);
      }

      for (const [path, entry] of movedEntries) {
        const suffix = path === requestPath ? '' : path.slice(requestPath.length);
        const targetPath = normalizePath(`${destinationPath}${suffix}`);
        state.entries.set(targetPath, {
          ...entry,
          lastModifiedMs: Date.now(),
        });
      }

      send(response, 201);
      return;
    }

    if (method === 'DELETE') {
      const target = state.entries.get(requestPath);
      if (!target) {
        send(response, 404, 'Not Found');
        return;
      }

      const toDelete = Array.from(state.entries.keys()).filter((path) =>
        isPathOrParentMatch(requestPath, path),
      );
      for (const path of toDelete) {
        state.entries.delete(path);
      }

      if (!state.entries.has('/')) {
        updateEntry(state.entries, '/', true, Buffer.alloc(0));
      }

      send(response, 204);
      return;
    }

    if (method === 'PROPFIND') {
      const target = state.entries.get(requestPath);
      if (!target) {
        send(response, 404, 'Not Found');
        return;
      }

      const depth = getHeader(request, 'depth') === '0' ? '0' : '1';
      const entriesForResponse: Array<{ path: string; entry: WebDavEntry }> = [
        {
          path: requestPath,
          entry: target,
        },
      ];

      if (target.isCollection && depth !== '0') {
        const children = Array.from(state.entries.entries())
          .filter(([path]) => {
            if (path === requestPath) {
              return false;
            }

            const parentPath = getParentPath(path);
            return parentPath === requestPath;
          })
          .sort(([left], [right]) => left.localeCompare(right));

        for (const [path, entry] of children) {
          entriesForResponse.push({ path, entry });
        }
      }

      const originFromRequest = `http://${getHeader(request, 'host') || '127.0.0.1'}`;
      const xml = buildPropfindXml(originFromRequest, entriesForResponse);
      send(response, 207, xml, {
        'Content-Type': 'application/xml; charset=utf-8',
      });
      return;
    }

    send(response, 405, 'Method Not Allowed');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start webdav mock server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    state,
  };
};

export const webDavMockUtils = {
  normalizePath,
};
