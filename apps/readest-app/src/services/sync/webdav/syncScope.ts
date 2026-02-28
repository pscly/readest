import {
  LOCAL_BOOKS_SUBDIR,
  LOCAL_FONTS_SUBDIR,
  LOCAL_IMAGES_SUBDIR,
  SETTINGS_FILENAME,
} from '@/services/constants';
import type { AppService } from '@/types/system';

export type SyncScopeRootKey = 'Settings' | 'Books' | 'Fonts' | 'Images';

export interface SyncScopeMapping {
  key: SyncScopeRootKey;
  relativePath: string;
  absolutePath: string;
  kind: 'file' | 'directory';
  recursive: boolean;
}

export interface WebDavSyncScope {
  mappings: SyncScopeMapping[];
  excludes: string[];
}

export interface BuildWebDavSyncScopeOptions {
  appConfigDir: string;
  appDataDir: string;
  execDir?: string;
  isPortable?: boolean;
  customRootDir?: string;
}

const LOCAL_ONLY_WEBDAV_SETTINGS_FILENAME = 'webdav.local.json';
const LOCAL_ONLY_WEBDAV_DEVICE_FILENAME = 'webdav.device.json';

const joinPath = (...parts: string[]) => {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) {
    return '';
  }

  const first = filtered[0]!.replace(/\\/g, '/');
  const isUnixAbsolute = first.startsWith('/');
  const isWindowsAbsolute = /^[A-Za-z]:\//.test(first);
  const isAbsolute = isUnixAbsolute || isWindowsAbsolute;

  const normalized = filtered.map((part, index) => {
    const normalizedPart = part.replace(/\\/g, '/');
    if (index === 0) {
      if (isUnixAbsolute) {
        return normalizedPart.replace(/\/+$/g, '');
      }
      return normalizedPart.replace(/^\/+|\/+$/g, '');
    }
    return normalizedPart.replace(/^\/+|\/+$/g, '');
  });

  const joined = normalized.filter((part) => part.length > 0).join('/');
  if (isUnixAbsolute && !joined.startsWith('/')) {
    return `/${joined}`;
  }
  if (isAbsolute) {
    return joined;
  }
  return joined;
};

const trimTrailingSlash = (path: string) => path.replace(/\/+$/g, '');

const getDataRoot = ({
  appDataDir,
  execDir,
  isPortable,
  customRootDir,
}: Pick<
  BuildWebDavSyncScopeOptions,
  'appDataDir' | 'execDir' | 'isPortable' | 'customRootDir'
>) => {
  if (customRootDir) {
    return trimTrailingSlash(customRootDir);
  }
  if (isPortable && execDir) {
    return trimTrailingSlash(execDir);
  }
  return trimTrailingSlash(appDataDir);
};

const getSettingsRoot = ({
  appConfigDir,
  execDir,
  isPortable,
}: Pick<BuildWebDavSyncScopeOptions, 'appConfigDir' | 'execDir' | 'isPortable'>) => {
  if (isPortable && execDir) {
    return trimTrailingSlash(execDir);
  }
  return trimTrailingSlash(appConfigDir);
};

export const buildWebDavSyncScope = (options: BuildWebDavSyncScopeOptions): WebDavSyncScope => {
  const dataRoot = getDataRoot(options);
  const settingsRoot = getSettingsRoot(options);

  const settingsRelativePath = `Settings/${SETTINGS_FILENAME}`;
  const settingsBackupRelativePath = `${settingsRelativePath}.bak`;

  return {
    mappings: [
      {
        key: 'Settings',
        relativePath: settingsRelativePath,
        absolutePath: joinPath(settingsRoot, SETTINGS_FILENAME),
        kind: 'file',
        recursive: false,
      },
      {
        key: 'Settings',
        relativePath: settingsBackupRelativePath,
        absolutePath: joinPath(settingsRoot, `${SETTINGS_FILENAME}.bak`),
        kind: 'file',
        recursive: false,
      },
      {
        key: 'Books',
        relativePath: 'Books',
        absolutePath: joinPath(dataRoot, LOCAL_BOOKS_SUBDIR),
        kind: 'directory',
        recursive: true,
      },
      {
        key: 'Fonts',
        relativePath: 'Fonts',
        absolutePath: joinPath(dataRoot, LOCAL_FONTS_SUBDIR),
        kind: 'directory',
        recursive: true,
      },
      {
        key: 'Images',
        relativePath: 'Images',
        absolutePath: joinPath(dataRoot, LOCAL_IMAGES_SUBDIR),
        kind: 'directory',
        recursive: true,
      },
    ],
    excludes: [
      `Settings/${LOCAL_ONLY_WEBDAV_SETTINGS_FILENAME}`,
      `Settings/${LOCAL_ONLY_WEBDAV_DEVICE_FILENAME}`,
      'Cache/**',
      'Temp/**',
      '**/vendor/**',
      '**/build/**',
      '**/dist/**',
      '**/*.tmp',
    ],
  };
};

export const buildWebDavSyncScopeFromAppService = async (
  appService: AppService,
): Promise<WebDavSyncScope> => {
  const settingsRoot = trimTrailingSlash(await appService.resolveFilePath('', 'Settings'));
  const booksRoot = trimTrailingSlash(await appService.resolveFilePath('', 'Books'));
  const fontsRoot = trimTrailingSlash(await appService.resolveFilePath('', 'Fonts'));
  const imagesRoot = trimTrailingSlash(await appService.resolveFilePath('', 'Images'));

  const settingsRelativePath = `Settings/${SETTINGS_FILENAME}`;
  const settingsBackupRelativePath = `${settingsRelativePath}.bak`;

  return {
    mappings: [
      {
        key: 'Settings',
        relativePath: settingsRelativePath,
        absolutePath: joinPath(settingsRoot, SETTINGS_FILENAME),
        kind: 'file',
        recursive: false,
      },
      {
        key: 'Settings',
        relativePath: settingsBackupRelativePath,
        absolutePath: joinPath(settingsRoot, `${SETTINGS_FILENAME}.bak`),
        kind: 'file',
        recursive: false,
      },
      {
        key: 'Books',
        relativePath: 'Books',
        absolutePath: booksRoot,
        kind: 'directory',
        recursive: true,
      },
      {
        key: 'Fonts',
        relativePath: 'Fonts',
        absolutePath: fontsRoot,
        kind: 'directory',
        recursive: true,
      },
      {
        key: 'Images',
        relativePath: 'Images',
        absolutePath: imagesRoot,
        kind: 'directory',
        recursive: true,
      },
    ],
    excludes: [
      `Settings/${LOCAL_ONLY_WEBDAV_SETTINGS_FILENAME}`,
      `Settings/${LOCAL_ONLY_WEBDAV_DEVICE_FILENAME}`,
      'Cache/**',
      'Temp/**',
      '**/vendor/**',
      '**/build/**',
      '**/dist/**',
      '**/*.tmp',
    ],
  };
};
