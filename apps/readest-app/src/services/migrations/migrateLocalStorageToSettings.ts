import { SystemSettings, ThemeType } from '@/types/settings';

type StorageLike = Pick<Storage, 'getItem' | 'removeItem'>;

const THEME_MODES: ThemeType[] = ['auto', 'light', 'dark'];

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isObjectRecord(value) && Object.values(value).every((item) => typeof item === 'string');

const isShortcutRecord = (value: unknown): value is Record<string, string[]> =>
  isObjectRecord(value) &&
  Object.values(value).every(
    (item) => Array.isArray(item) && item.every((shortcut) => typeof shortcut === 'string'),
  );

const parseJSON = <T>(value: string | null): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const isEmptyString = (value?: string): boolean => !value || value.trim().length === 0;

const isEmptyObject = (value?: Record<string, unknown>): boolean =>
  !value || Object.keys(value).length === 0;

const isTelemetryOptOut = (value: string | null): boolean =>
  typeof value === 'string' && value.toLowerCase() === 'true';

export const migrateLocalStorageToSettings = (
  settings: SystemSettings,
  storage: StorageLike | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined,
): boolean => {
  if (!storage) return false;

  let changed = false;

  const themeModeValue = storage.getItem('themeMode');
  if (!settings.themeMode && themeModeValue && THEME_MODES.includes(themeModeValue as ThemeType)) {
    settings.themeMode = themeModeValue as ThemeType;
    storage.removeItem('themeMode');
    changed = true;
  }

  const themeColorValue = storage.getItem('themeColor');
  if (isEmptyString(settings.themeColor) && themeColorValue && themeColorValue.trim().length > 0) {
    settings.themeColor = themeColorValue;
    storage.removeItem('themeColor');
    changed = true;
  }

  const ttsPreferredVoices = parseJSON<Record<string, string>>(
    storage.getItem('ttsPreferredVoices'),
  );
  if (
    isEmptyObject(settings.ttsPreferredVoices) &&
    ttsPreferredVoices &&
    isStringRecord(ttsPreferredVoices)
  ) {
    settings.ttsPreferredVoices = ttsPreferredVoices;
    storage.removeItem('ttsPreferredVoices');
    changed = true;
  }

  const customShortcuts = parseJSON<Record<string, string[]>>(storage.getItem('customShortcuts'));
  if (
    isEmptyObject(settings.customShortcuts) &&
    customShortcuts &&
    isShortcutRecord(customShortcuts)
  ) {
    settings.customShortcuts = customShortcuts;
    storage.removeItem('customShortcuts');
    changed = true;
  }

  if (Array.isArray(settings.globalReadSettings?.customThemes)) {
    const customThemes = parseJSON<unknown[]>(storage.getItem('customThemes'));
    if (settings.globalReadSettings.customThemes.length === 0 && Array.isArray(customThemes)) {
      settings.globalReadSettings.customThemes =
        customThemes as typeof settings.globalReadSettings.customThemes;
      storage.removeItem('customThemes');
      changed = true;
    }
  }

  const uiLanguage = storage.getItem('i18nextLng');
  if (
    isEmptyString(settings.globalViewSettings?.uiLanguage) &&
    uiLanguage &&
    uiLanguage.trim().length > 0
  ) {
    settings.globalViewSettings.uiLanguage = uiLanguage;
    storage.removeItem('i18nextLng');
    changed = true;
  }

  const telemetryOptOut = storage.getItem('readest-telemetry-opt-out');
  if (settings.telemetryEnabled && isTelemetryOptOut(telemetryOptOut)) {
    settings.telemetryEnabled = false;
    storage.removeItem('readest-telemetry-opt-out');
    changed = true;
  }

  return changed;
};
