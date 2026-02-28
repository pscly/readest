import { describe, expect, it, beforeEach } from 'vitest';
import { SystemSettings } from '@/types/settings';
import { migrateLocalStorageToSettings } from '@/services/migrations/migrateLocalStorageToSettings';

const SENSITIVE_KEYS = ['token', 'refresh_token', 'user'];

const createSettings = (): SystemSettings =>
  ({
    telemetryEnabled: true,
    globalReadSettings: {
      customThemes: [],
    },
    globalViewSettings: {
      uiLanguage: '',
    },
  }) as SystemSettings;

const collectSensitiveKeys = (input: unknown, found: string[] = []): string[] => {
  if (Array.isArray(input)) {
    input.forEach((item) => {
      collectSensitiveKeys(item, found);
    });
    return found;
  }

  if (input && typeof input === 'object') {
    Object.entries(input as Record<string, unknown>).forEach(([key, value]) => {
      if (SENSITIVE_KEYS.includes(key)) {
        found.push(key);
      }
      collectSensitiveKeys(value, found);
    });
  }

  return found;
};

describe('migrateLocalStorageToSettings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('happy path: 迁移多 key 并清理 localStorage', () => {
    const settings = createSettings();

    localStorage.setItem('themeMode', 'dark');
    localStorage.setItem('themeColor', 'contrast');
    localStorage.setItem(
      'ttsPreferredVoices',
      JSON.stringify({ preferredClient: 'edge', 'edge-en': 'A' }),
    );
    localStorage.setItem('customShortcuts', JSON.stringify({ onToggleSideBar: ['s'] }));
    localStorage.setItem('customThemes', JSON.stringify([{ name: 'my-theme', label: 'My Theme' }]));
    localStorage.setItem('i18nextLng', 'zh-CN');
    localStorage.setItem('readest-telemetry-opt-out', 'true');

    const changed = migrateLocalStorageToSettings(settings);

    expect(changed).toBe(true);
    expect(settings.themeMode).toBe('dark');
    expect(settings.themeColor).toBe('contrast');
    expect(settings.ttsPreferredVoices).toEqual({ preferredClient: 'edge', 'edge-en': 'A' });
    expect(settings.customShortcuts).toEqual({ onToggleSideBar: ['s'] });
    expect(settings.globalReadSettings.customThemes).toEqual([
      { name: 'my-theme', label: 'My Theme' },
    ]);
    expect(settings.globalViewSettings.uiLanguage).toBe('zh-CN');
    expect(settings.telemetryEnabled).toBe(false);

    expect(localStorage.getItem('themeMode')).toBeNull();
    expect(localStorage.getItem('themeColor')).toBeNull();
    expect(localStorage.getItem('ttsPreferredVoices')).toBeNull();
    expect(localStorage.getItem('customShortcuts')).toBeNull();
    expect(localStorage.getItem('customThemes')).toBeNull();
    expect(localStorage.getItem('i18nextLng')).toBeNull();
    expect(localStorage.getItem('readest-telemetry-opt-out')).toBeNull();
  });

  it('idempotent: 重复执行结果不变', () => {
    const settings = createSettings();
    localStorage.setItem('themeMode', 'auto');

    const firstChanged = migrateLocalStorageToSettings(settings);
    const snapshot = JSON.stringify(settings);
    const secondChanged = migrateLocalStorageToSettings(settings);

    expect(firstChanged).toBe(true);
    expect(secondChanged).toBe(false);
    expect(JSON.stringify(settings)).toBe(snapshot);
    expect(localStorage.getItem('themeMode')).toBeNull();
  });

  it('sensitive blacklist: 不迁移 token/refresh_token/user 且不污染 settings', () => {
    const settings = createSettings();
    localStorage.setItem('token', 'secret-token');
    localStorage.setItem('refresh_token', 'secret-refresh-token');
    localStorage.setItem('user', '{"id":"u1"}');
    localStorage.setItem('ttsPreferredVoices', '{invalid json}');

    const changed = migrateLocalStorageToSettings(settings);

    expect(changed).toBe(false);
    expect(collectSensitiveKeys(settings)).toEqual([]);
    expect(localStorage.getItem('token')).toBe('secret-token');
    expect(localStorage.getItem('refresh_token')).toBe('secret-refresh-token');
    expect(localStorage.getItem('user')).toBe('{"id":"u1"}');
    expect(localStorage.getItem('ttsPreferredVoices')).toBe('{invalid json}');
  });
});
