import { useCallback, useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { runWebDavSyncOnce, WebDavSyncNotConfiguredError } from '@/services/sync/webdav/runOnce';
import { WebDavSyncAlreadyRunningError } from '@/services/sync/webdav/engine';
import {
  sanitizeWebDavLocalSettings,
  WEBDAV_LOCAL_SETTINGS_FILENAME,
} from '@/services/sync/webdav/localSettings';

export const WEBDAV_AUTO_SYNC_THROTTLE_MS = 30_000;

const loadWebDavLocalSettings = async (
  appService: NonNullable<ReturnType<typeof useEnv>['appService']>,
) => {
  try {
    const text = await appService.readFile(WEBDAV_LOCAL_SETTINGS_FILENAME, 'Settings', 'text');
    const raw = typeof text === 'string' ? JSON.parse(text) : {};
    return sanitizeWebDavLocalSettings(raw);
  } catch {
    return sanitizeWebDavLocalSettings({});
  }
};

export const useWebDavAutoSync = () => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const syncInFlightRef = useRef(false);
  const lastAutoSyncAtRef = useRef(0);

  const tryAutoSync = useCallback(
    async (respectThrottle: boolean) => {
      if (!appService) {
        return;
      }

      if (settings.syncBackend !== 'webdav') {
        return;
      }

      const localSettings = await loadWebDavLocalSettings(appService);
      if (!localSettings.autoSync || !localSettings.baseUrl || !localSettings.username) {
        return;
      }

      const now = Date.now();
      if (respectThrottle && now - lastAutoSyncAtRef.current < WEBDAV_AUTO_SYNC_THROTTLE_MS) {
        return;
      }

      const { isSyncing, setIsSyncing } = useLibraryStore.getState();
      if (isSyncing || syncInFlightRef.current) {
        return;
      }

      syncInFlightRef.current = true;
      lastAutoSyncAtRef.current = now;
      setIsSyncing(true);
      try {
        await runWebDavSyncOnce(appService);
      } catch (error) {
        if (error instanceof WebDavSyncAlreadyRunningError) {
          return;
        }
        if (error instanceof WebDavSyncNotConfiguredError) {
          return;
        }
        eventDispatcher.dispatch('toast', {
          message: _('WebDAV auto-sync failed'),
          type: 'error',
        });
      } finally {
        syncInFlightRef.current = false;
        useLibraryStore.getState().setIsSyncing(false);
      }
    },
    [_, appService, settings.syncBackend],
  );

  useEffect(() => {
    void tryAutoSync(false);
  }, [tryAutoSync]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void tryAutoSync(true);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [tryAutoSync]);
};
