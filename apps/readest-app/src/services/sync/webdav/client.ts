import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { buildRemotePath, normalizeRootDir } from './remoteLayout';

export type WebDavDepth = '0' | '1' | 'infinity';

export interface WebDavClientOptions {
  baseUrl: string;
  rootDir: string;
  username: string;
  password: string;
  allowInsecureTls?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface WebDavRequestPrecondition {
  ifMatch?: string;
  ifNoneMatch?: string;
}

export interface WebDavPropfindEntry {
  href: string;
  etag?: string;
  lastModified?: string;
  contentLength?: number;
  isCollection: boolean;
}

export class WebDavClientError extends Error {
  override name = 'WebDavClientError';
}

export class WebDavHttpError extends WebDavClientError {
  status: number;
  statusText: string;
  bodyText?: string;

  constructor(status: number, statusText: string, bodyText?: string) {
    super(`WebDAV HTTP ${status} ${statusText}`);
    this.status = status;
    this.statusText = statusText;
    this.bodyText = bodyText;
  }
}

const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/g, '');

const joinUrl = (baseUrl: string, path: string) => {
  const base = normalizeBaseUrl(baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
};

const encodeBasicAuth = (username: string, password: string) => {
  const raw = `${username}:${password}`;
  const encoded =
    typeof btoa === 'function' ? btoa(raw) : Buffer.from(raw, 'utf-8').toString('base64');
  return `Basic ${encoded}`;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const jitterMs = (attempt: number) => {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  const rand = Math.floor(Math.random() * 250);
  return base + rand;
};

const extractFirstText = (root: Element, tagLocalName: string) => {
  const elements = root.getElementsByTagName('*');
  for (const node of Array.from(elements)) {
    if (node.localName === tagLocalName) {
      const text = node.textContent?.trim();
      return text && text.length > 0 ? text : undefined;
    }
  }
  return undefined;
};

const hasCollectionTag = (root: Element) => {
  const elements = root.getElementsByTagName('*');
  for (const node of Array.from(elements)) {
    if (node.localName === 'collection') {
      return true;
    }
  }
  return false;
};

export class WebDavClient {
  private baseUrl: string;
  private rootDir: string;
  private username: string;
  private password: string;
  private allowInsecureTls: boolean;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(options: WebDavClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.rootDir = normalizeRootDir(options.rootDir);
    this.username = options.username;
    this.password = options.password;
    this.allowInsecureTls = options.allowInsecureTls ?? false;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  private shouldAllowInsecureTls() {
    return this.allowInsecureTls && this.baseUrl.toLowerCase().startsWith('https://');
  }

  private withPreconditionHeaders(
    headers: Record<string, string>,
    precondition?: WebDavRequestPrecondition,
  ) {
    if (!precondition) {
      return headers;
    }
    if (precondition.ifMatch) {
      headers['If-Match'] = precondition.ifMatch;
    }
    if (precondition.ifNoneMatch) {
      headers['If-None-Match'] = precondition.ifNoneMatch;
    }
    return headers;
  }

  private toRemotePath(relativePath: string) {
    return buildRemotePath(this.rootDir, relativePath);
  }

  private toUrl(relativePath: string) {
    const remotePath = this.toRemotePath(relativePath);
    return joinUrl(this.baseUrl, remotePath);
  }

  private authHeaderValue() {
    return encodeBasicAuth(this.username, this.password);
  }

  private async request(
    method: string,
    remotePath: string,
    options: {
      headers?: Record<string, string>;
      body?: BodyInit | null;
      expectedStatuses?: number[];
    } = {},
  ): Promise<Response> {
    const url = joinUrl(this.baseUrl, remotePath);
    const expectedStatuses = options.expectedStatuses ?? [200, 201, 204, 207];
    const headers: Record<string, string> = {
      ...options.headers,
      Authorization: this.authHeaderValue(),
    };

    const doFetch = async (): Promise<Response> => {
      const fetcher = isTauriAppPlatform() ? tauriFetch : window.fetch;
      if (isTauriAppPlatform()) {
        const allowInsecureTls = this.shouldAllowInsecureTls();
        return fetcher(url, {
          method,
          headers,
          body: options.body,
          danger: {
            acceptInvalidCerts: allowInsecureTls,
            acceptInvalidHostnames: allowInsecureTls,
          },
        });
      }
      return fetcher(url, {
        method,
        headers,
        body: options.body,
      });
    };

    const withTimeout = async () => {
      const timeoutPromise = new Promise<Response>((_, reject) => {
        const id = setTimeout(() => {
          clearTimeout(id);
          reject(new WebDavClientError('WebDAV 请求超时'));
        }, this.timeoutMs);
      });
      return Promise.race([doFetch(), timeoutPromise]);
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await withTimeout();
        if (expectedStatuses.includes(response.status)) {
          return response;
        }
        if (response.status >= 500 && attempt < this.maxRetries) {
          lastError = new WebDavHttpError(response.status, response.statusText);
          await sleep(jitterMs(attempt));
          continue;
        }
        const bodyText = await response.text().catch(() => undefined);
        throw new WebDavHttpError(response.status, response.statusText, bodyText);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          await sleep(jitterMs(attempt));
          continue;
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new WebDavClientError('WebDAV 请求失败');
  }

  async mkcol(relativeDirPath: string): Promise<void> {
    const remotePath = this.toRemotePath(relativeDirPath);
    await this.request('MKCOL', remotePath, { expectedStatuses: [201, 405] });
  }

  async putText(
    relativeFilePath: string,
    text: string,
    contentType = 'application/octet-stream',
    precondition?: WebDavRequestPrecondition,
  ): Promise<void> {
    const remotePath = this.toRemotePath(relativeFilePath);
    await this.request('PUT', remotePath, {
      expectedStatuses: [200, 201, 204],
      headers: this.withPreconditionHeaders(
        {
          'Content-Type': contentType,
        },
        precondition,
      ),
      body: text,
    });
  }

  async putBytes(
    relativeFilePath: string,
    bytes: Uint8Array,
    contentType = 'application/octet-stream',
    precondition?: WebDavRequestPrecondition,
  ): Promise<void> {
    const remotePath = this.toRemotePath(relativeFilePath);
    const backingBuffer = bytes.buffer;
    const body: ArrayBuffer =
      backingBuffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === backingBuffer.byteLength
        ? backingBuffer
        : (() => {
            const copied = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(copied).set(bytes);
            return copied;
          })();
    await this.request('PUT', remotePath, {
      expectedStatuses: [200, 201, 204],
      headers: this.withPreconditionHeaders(
        {
          'Content-Type': contentType,
        },
        precondition,
      ),
      body,
    });
  }

  async getText(relativeFilePath: string): Promise<string> {
    const remotePath = this.toRemotePath(relativeFilePath);
    const response = await this.request('GET', remotePath, { expectedStatuses: [200] });
    return response.text();
  }

  async getBytes(relativeFilePath: string): Promise<Uint8Array> {
    const remotePath = this.toRemotePath(relativeFilePath);
    const response = await this.request('GET', remotePath, { expectedStatuses: [200] });
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }

  async uploadFileFromPath(
    relativeFilePath: string,
    absoluteFilePath: string,
    contentType = 'application/octet-stream',
    precondition?: WebDavRequestPrecondition,
  ): Promise<void> {
    if (isTauriAppPlatform()) {
      const { tauriUpload } = await import('@/utils/transfer');
      const headers = new Map<string, string>();
      headers.set('Authorization', this.authHeaderValue());
      headers.set('Content-Type', contentType);
      if (precondition?.ifMatch) {
        headers.set('If-Match', precondition.ifMatch);
      }
      if (precondition?.ifNoneMatch) {
        headers.set('If-None-Match', precondition.ifNoneMatch);
      }
      await tauriUpload(this.toUrl(relativeFilePath), absoluteFilePath, 'PUT', undefined, headers, {
        skipSslVerification: this.shouldAllowInsecureTls(),
      });
      return;
    }

    const nodeFs = await import('node:fs/promises');
    const buffer = await nodeFs.readFile(absoluteFilePath);
    await this.putBytes(relativeFilePath, new Uint8Array(buffer), contentType, precondition);
  }

  async downloadFileToPath(relativeFilePath: string, absoluteFilePath: string): Promise<void> {
    if (isTauriAppPlatform()) {
      const { tauriDownload } = await import('@/utils/transfer');
      await tauriDownload(
        this.toUrl(relativeFilePath),
        absoluteFilePath,
        undefined,
        {
          Authorization: this.authHeaderValue(),
        },
        undefined,
        true,
        true,
      );
      return;
    }

    const bytes = await this.getBytes(relativeFilePath);
    const nodeFs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    await nodeFs.mkdir(nodePath.dirname(absoluteFilePath), { recursive: true });
    await nodeFs.writeFile(absoluteFilePath, bytes);
  }

  async delete(relativePath: string): Promise<void> {
    const remotePath = this.toRemotePath(relativePath);
    await this.request('DELETE', remotePath, { expectedStatuses: [204] });
  }

  async move(
    fromRelativePath: string,
    toRelativePath: string,
    options: { overwrite?: boolean; ifMatch?: string; ifNoneMatch?: string } = {},
  ): Promise<void> {
    const fromRemotePath = this.toRemotePath(fromRelativePath);
    const toRemotePath = this.toRemotePath(toRelativePath);
    const destination = joinUrl(this.baseUrl, toRemotePath);
    await this.request('MOVE', fromRemotePath, {
      expectedStatuses: [201, 204],
      headers: {
        Destination: destination,
        Overwrite: options.overwrite === false ? 'F' : 'T',
        ...(options.ifMatch ? { 'If-Match': options.ifMatch } : {}),
        ...(options.ifNoneMatch ? { 'If-None-Match': options.ifNoneMatch } : {}),
      },
    });
  }

  async getEtag(relativePath: string): Promise<string | null> {
    try {
      const entries = await this.propfind(relativePath, '0');
      return entries[0]?.etag ?? null;
    } catch (error) {
      if (error instanceof WebDavHttpError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async propfind(relativePath: string, depth: WebDavDepth = '1'): Promise<WebDavPropfindEntry[]> {
    const remotePath = this.toRemotePath(relativePath);
    const response = await this.request('PROPFIND', remotePath, {
      expectedStatuses: [207],
      headers: {
        Depth: depth,
      },
    });
    const xmlText = await response.text();
    return this.parsePropfindXml(xmlText);
  }

  private parsePropfindXml(xmlText: string): WebDavPropfindEntry[] {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const parseError = doc.getElementsByTagName('parsererror');
    if (parseError.length > 0) {
      throw new WebDavClientError('PROPFIND XML 解析失败');
    }

    const responses = Array.from(doc.getElementsByTagName('*')).filter(
      (node) => node instanceof Element && node.localName === 'response',
    ) as Element[];

    const entries: WebDavPropfindEntry[] = [];
    for (const response of responses) {
      const href = extractFirstText(response, 'href');
      if (!href) {
        continue;
      }
      const etag = extractFirstText(response, 'getetag');
      const lastModified = extractFirstText(response, 'getlastmodified');
      const contentLengthText = extractFirstText(response, 'getcontentlength');
      const contentLength = contentLengthText ? Number(contentLengthText) : undefined;
      const isCollection = hasCollectionTag(response);

      entries.push({
        href,
        etag,
        lastModified,
        contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
        isCollection,
      });
    }

    return entries;
  }
}
