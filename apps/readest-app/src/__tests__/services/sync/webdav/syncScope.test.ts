import { describe, expect, it } from 'vitest';
import { buildWebDavSyncScope } from '@/services/sync/webdav/syncScope';

describe('buildWebDavSyncScope', () => {
  it('default: non-portable without customRootDir', () => {
    const scope = buildWebDavSyncScope({
      appConfigDir: '/cfg/readest',
      appDataDir: '/data/readest',
      isPortable: false,
    });

    expect(scope.mappings).toEqual([
      {
        key: 'Settings',
        relativePath: 'Settings/settings.json',
        absolutePath: '/cfg/readest/settings.json',
        kind: 'file',
        recursive: false,
      },
      {
        key: 'Settings',
        relativePath: 'Settings/settings.json.bak',
        absolutePath: '/cfg/readest/settings.json.bak',
        kind: 'file',
        recursive: false,
      },
      {
        key: 'Books',
        relativePath: 'Books',
        absolutePath: '/data/readest/Readest/Books',
        kind: 'directory',
        recursive: true,
      },
      {
        key: 'Fonts',
        relativePath: 'Fonts',
        absolutePath: '/data/readest/Readest/Fonts',
        kind: 'directory',
        recursive: true,
      },
      {
        key: 'Images',
        relativePath: 'Images',
        absolutePath: '/data/readest/Readest/Images',
        kind: 'directory',
        recursive: true,
      },
    ]);
    expect(scope.excludes).toContain('Settings/webdav.local.json');
    expect(scope.excludes).toContain('Settings/webdav.device.json');
  });

  it('customRootDir only affects Books/Fonts/Images, not Settings', () => {
    const scope = buildWebDavSyncScope({
      appConfigDir: '/cfg/readest',
      appDataDir: '/data/readest',
      customRootDir: '/mnt/custom-root',
      isPortable: false,
    });

    const settingsMapping = scope.mappings.filter((m) => m.key === 'Settings');
    const booksMapping = scope.mappings.find((m) => m.key === 'Books');
    const fontsMapping = scope.mappings.find((m) => m.key === 'Fonts');
    const imagesMapping = scope.mappings.find((m) => m.key === 'Images');

    expect(settingsMapping.map((m) => m.absolutePath)).toEqual([
      '/cfg/readest/settings.json',
      '/cfg/readest/settings.json.bak',
    ]);
    expect(booksMapping?.absolutePath).toBe('/mnt/custom-root/Readest/Books');
    expect(fontsMapping?.absolutePath).toBe('/mnt/custom-root/Readest/Fonts');
    expect(imagesMapping?.absolutePath).toBe('/mnt/custom-root/Readest/Images');
  });

  it('portable mode moves Settings to execDir', () => {
    const scope = buildWebDavSyncScope({
      appConfigDir: '/cfg/readest',
      appDataDir: '/data/readest',
      execDir: '/apps/readest-portable',
      isPortable: true,
    });

    const settingsMapping = scope.mappings.filter((m) => m.key === 'Settings');
    const booksMapping = scope.mappings.find((m) => m.key === 'Books');

    expect(settingsMapping.map((m) => m.absolutePath)).toEqual([
      '/apps/readest-portable/settings.json',
      '/apps/readest-portable/settings.json.bak',
    ]);
    expect(booksMapping?.absolutePath).toBe('/apps/readest-portable/Readest/Books');
  });
});
