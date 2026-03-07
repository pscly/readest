import { useCallback, useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useMobileSyncStore } from '@/store/mobileSyncStore';
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
  const scheduledSyncTimeoutRef = useRef<number | null>(null);

  const clearScheduledSync = useCallback(() => {
    if (scheduledSyncTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(scheduledSyncTimeoutRef.current);
    scheduledSyncTimeoutRef.current = null;
  }, []);

  const tryAutoSync = useCallback(
    async (
      reason: 'startup' | 'resume' | 'network-restored' | 'local-change',
      respectThrottle: boolean,
    ) => {
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

      const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
      const syncState = useMobileSyncStore.getState();
      syncState.setOnline(isOnline);

      if (!isOnline) {
        if (reason === 'local-change') {
          syncState.markLocalChangePending();
        }
        return;
      }

      const now = Date.now();
      if (respectThrottle && now - lastAutoSyncAtRef.current < WEBDAV_AUTO_SYNC_THROTTLE_MS) {
        if (reason === 'local-change') {
          syncState.markLocalChangePending();
          const remaining = WEBDAV_AUTO_SYNC_THROTTLE_MS - (now - lastAutoSyncAtRef.current) + 1;
          clearScheduledSync();
          scheduledSyncTimeoutRef.current = window.setTimeout(() => {
            scheduledSyncTimeoutRef.current = null;
            void tryAutoSync('local-change', false);
          }, remaining);
        }
        return;
      }

      const { isSyncing, setIsSyncing } = useLibraryStore.getState();
      if (isSyncing || syncInFlightRef.current) {
        if (reason === 'local-change') {
          syncState.markLocalChangePending();
          clearScheduledSync();
          scheduledSyncTimeoutRef.current = window.setTimeout(() => {
            scheduledSyncTimeoutRef.current = null;
            void tryAutoSync('local-change', false);
          }, WEBDAV_AUTO_SYNC_THROTTLE_MS);
        }
        return;
      }

      syncInFlightRef.current = true;
      lastAutoSyncAtRef.current = now;
      clearScheduledSync();
      setIsSyncing(true);
      syncState.markSyncAttempted(reason);
      try {
        const result = await runWebDavSyncOnce(appService);
        syncState.markSyncSucceeded(reason);
        eventDispatcher.dispatch('webdav-sync-finished', {
          finishedAtMs: Date.now(),
          operationsCount: result.operations.length,
          warningsCount: result.warnings.length,
          touchedPaths: result.operations
            .map((operation) => {
              if (operation.type === 'trash_local' || operation.type === 'trash_remote') {
                return operation.originalPath;
              }
              return operation.path;
            })
            .filter((path): path is string => typeof path === 'string' && path.length > 0),
        });
      } catch (error) {
        if (error instanceof WebDavSyncAlreadyRunningError) {
          return;
        }
        if (error instanceof WebDavSyncNotConfiguredError) {
          return;
        }
        const message = error instanceof Error ? error.message : 'WebDAV auto-sync failed';
        syncState.markSyncFailed(message, reason);
        eventDispatcher.dispatch('toast', {
          message: _('WebDAV auto-sync failed'),
          type: 'error',
        });
      } finally {
        syncInFlightRef.current = false;
        useLibraryStore.getState().setIsSyncing(false);
      }
    },
    [_, appService, clearScheduledSync, settings.syncBackend],
  );

  useEffect(() => {
    void tryAutoSync('startup', false);
  }, [tryAutoSync]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void tryAutoSync('resume', true);
    };

    const onLocalChange = () => {
      void tryAutoSync('local-change', true);
    };

    const onOnline = () => {
      useMobileSyncStore.getState().setOnline(true);
      void tryAutoSync('network-restored', true);
    };

    const onOffline = () => {
      useMobileSyncStore.getState().setOnline(false);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    eventDispatcher.on('mobile-sync-local-change', onLocalChange);

    return () => {
      clearScheduledSync();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      eventDispatcher.off('mobile-sync-local-change', onLocalChange);
    };
  }, [clearScheduledSync, tryAutoSync]);
};
