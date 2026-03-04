import { readFile, writeFile, mkdir, stat, readDir, rename, remove } from '@tauri-apps/plugin-fs';
import type { DirEntry } from '@tauri-apps/plugin-fs';
import type { FileStat, WebDavFsAdapter } from './fsAdapter';

const dirname = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '';
  return normalized.slice(0, index);
};

const extractErrorMessage = (error: unknown): string | null => {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return null;
  const obj = error as Record<string, unknown>;
  if (typeof obj['message'] === 'string') return obj['message'];
  if (typeof obj['error'] === 'string') return obj['error'];
  return null;
};

const isNotFoundError = (error: unknown) => {
  const message = extractErrorMessage(error);
  if (!message) return false;

  const lower = message.toLowerCase();
  return (
    lower.includes('not found') ||
    lower.includes('no such file') ||
    lower.includes('cannot find') ||
    lower.includes('enoent') ||
    lower.includes('os error 2') ||
    lower.includes('os error 3') ||
    message.includes('找不到') ||
    message.includes('不存在')
  );
};

const listNames = (entries: DirEntry[]) => entries.map((entry) => entry.name);

export class TauriFsAdapter implements WebDavFsAdapter {
  async readFile(filePath: string): Promise<Uint8Array> {
    const content = await readFile(filePath);
    return content instanceof Uint8Array ? content : new Uint8Array(content);
  }

  async mkdirp(dirPath: string): Promise<void> {
    if (!dirPath) return;
    await mkdir(dirPath, { recursive: true }).catch(() => undefined);
  }

  async readDir(dirPath: string): Promise<string[]> {
    try {
      const entries = await readDir(dirPath);
      return listNames(entries);
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  async stat(filePath: string): Promise<FileStat | null> {
    try {
      const info = await stat(filePath);
      return {
        isFile: info.isFile,
        isDirectory: info.isDirectory,
        sizeBytes: info.size,
        modifiedAtMs: info.mtime ? info.mtime.getTime() : Date.now(),
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeFileAtomic(filePath: string, data: Uint8Array): Promise<void> {
    const dirPath = dirname(filePath);
    await this.mkdirp(dirPath);

    const tempPath = `${filePath}.tmp.${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    try {
      await writeFile(tempPath, data);
      await rename(tempPath, filePath);
    } catch (error) {
      await remove(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    await this.mkdirp(dirname(toPath));
    await rename(fromPath, toPath);
  }

  async remove(filePath: string): Promise<void> {
    await remove(filePath).catch((error) => {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    });
  }
}
