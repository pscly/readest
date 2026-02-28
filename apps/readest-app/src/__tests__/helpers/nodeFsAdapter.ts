import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { FileStat, WebDavFsAdapter } from '@/services/sync/webdav/fsAdapter';

export class NodeFsAdapter implements WebDavFsAdapter {
  private hooks?: {
    beforeRename?: () => Promise<void>;
  };

  constructor(hooks?: { beforeRename?: () => Promise<void> }) {
    this.hooks = hooks;
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    const buffer = await fs.readFile(filePath);
    return new Uint8Array(buffer);
  }

  async mkdirp(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async readDir(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async stat(filePath: string): Promise<FileStat | null> {
    try {
      const info = await fs.stat(filePath);
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        sizeBytes: info.size,
        modifiedAtMs: info.mtimeMs,
      };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async writeFileAtomic(filePath: string, data: Uint8Array): Promise<void> {
    const dirPath = path.dirname(filePath);
    await this.mkdirp(dirPath);

    const tempPath = `${filePath}.tmp.${randomUUID()}`;
    try {
      await fs.writeFile(tempPath, data);
      await this.hooks?.beforeRename?.();
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    await this.mkdirp(path.dirname(toPath));
    await fs.rename(fromPath, toPath);
  }

  async remove(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch((error) => {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT') {
        return;
      }
      throw error;
    });
  }
}
