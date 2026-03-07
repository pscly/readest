import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import SettingsMenu from '@/app/library/components/SettingsMenu';

const {
  runWebDavSyncOnceMock,
  setIsSyncingMock,
  onPullLibraryMock,
  eventDispatchMock,
  navigateToLoginMock,
  themeSetModeMock,
  settingsState,
  appService,
  mobileSyncState,
} = vi.hoisted(() => ({
  runWebDavSyncOnceMock: vi.fn(),
  setIsSyncingMock: vi.fn(),
  onPullLibraryMock: vi.fn(),
  eventDispatchMock: vi.fn(),
  navigateToLoginMock: vi.fn(),
  themeSetModeMock: vi.fn(),
  settingsState: {
    autoUpload: true,
    autoCheckUpdates: true,
    alwaysOnTop: false,
    alwaysShowStatusBar: false,
    screenWakeLock: false,
    openLastBooks: false,
    autoImportBooksOnOpen: false,
    telemetryEnabled: true,
    alwaysInForeground: false,
    savedBookCoverForLockScreen: '',
    savedBookCoverForLockScreenPath: '',
    openBookInNewWindow: true,
    lastSyncedAtBooks: 0,
    syncBackend: 'cloud' as 'cloud' | 'webdav' | 'off',
  },
  mobileSyncState: {
    needsAuthForCloud: false,
    pendingChanges: false,
    lastSuccessfulSyncAt: 0,
    lastAttemptedSyncAt: 0,
    lastSyncError: null as string | null,
    isOnline: true,
    lastOnlineAt: 0,
  },
  appService: {
    isMobile: false,
    hasUpdater: false,
    hasWindow: false,
    isMobileApp: false,
    isAndroidApp: false,
    canCustomizeRootDir: false,
    distChannel: 'readest',
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/utils/nav', () => ({
  navigateToLogin: navigateToLoginMock,
  navigateToProfile: vi.fn(),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, options?: Record<string, number | string>) => {
    if (!options) {
      return key;
    }
    return Object.entries(options).reduce(
      (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
      key,
    );
  },
}));

vi.mock('@/services/environment', async () => {
  const actual = await vi.importActual('@/services/environment');
  return {
    ...actual,
    isTauriAppPlatform: () => true,
    isWebAppPlatform: () => false,
  };
});

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: { getAppService: vi.fn() },
    appService,
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      user_metadata: { full_name: 'Sync User' },
    },
  }),
}));

vi.mock('@/hooks/useQuotaStats', () => ({
  useQuotaStats: () => ({
    userProfilePlan: 'plus',
    quotas: [],
  }),
}));

vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({
    themeMode: 'auto',
    setThemeMode: themeSetModeMock,
  }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: settingsState,
    setSettingsDialogOpen: vi.fn(),
  }),
}));

vi.mock('@/store/mobileSyncStore', () => ({
  useMobileSyncStore: ((
    selector?: (state: typeof mobileSyncState & Record<string, unknown>) => unknown,
  ) => {
    const state = {
      ...mobileSyncState,
      markSyncAttempted: vi.fn(),
      markSyncSucceeded: vi.fn(),
      markSyncFailed: vi.fn(),
      resetSyncError: vi.fn(),
    };
    return selector ? selector(state) : state;
  }) as unknown as typeof import('@/store/mobileSyncStore').useMobileSyncStore,
}));

vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: () => ({
    isSyncing: false,
    setIsSyncing: setIsSyncingMock,
  }),
}));

vi.mock('@/hooks/useResponsiveSize', () => ({
  useResponsiveSize: () => 16,
}));

vi.mock('@/hooks/useTransferQueue', () => ({
  useTransferQueue: () => ({
    stats: { active: 0, pending: 0, failed: 0 },
    hasActiveTransfers: false,
    setIsTransferQueueOpen: vi.fn(),
  }),
}));

vi.mock('@/services/sync/webdav/runOnce', () => ({
  WebDavSyncNotConfiguredError: class WebDavSyncNotConfiguredError extends Error {
    override name = 'WebDavSyncNotConfiguredError';
  },
  runWebDavSyncOnce: runWebDavSyncOnceMock,
}));

vi.mock('@/services/sync/webdav/engine', () => ({
  WebDavSyncAlreadyRunningError: class WebDavSyncAlreadyRunningError extends Error {
    override name = 'WebDavSyncAlreadyRunningError';
  },
}));

vi.mock('@/services/sync/webdav/client', () => ({
  WebDavHttpError: class WebDavHttpError extends Error {
    status: number;

    constructor(status: number) {
      super('WebDavHttpError');
      this.status = status;
    }
  },
}));

vi.mock('@/services/sync/webdav/credentials', () => ({
  WebDavCredentialsError: class WebDavCredentialsError extends Error {
    override name = 'WebDavCredentialsError';
  },
}));

vi.mock('@/utils/event', () => ({
  eventDispatcher: {
    dispatch: eventDispatchMock,
  },
}));

describe('SettingsMenu sync backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsState.syncBackend = 'cloud';
    mobileSyncState.needsAuthForCloud = false;
    runWebDavSyncOnceMock.mockResolvedValue({ operations: [], warnings: [] });
    eventDispatchMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('backend=cloud 点击同步入口会调用 onPullLibrary(true, true)', async () => {
    settingsState.syncBackend = 'cloud';

    render(<SettingsMenu onPullLibrary={onPullLibraryMock} />);

    fireEvent.click(screen.getByRole('menuitem', { name: /Never synced/i }));

    await waitFor(() => {
      expect(onPullLibraryMock).toHaveBeenCalledWith(true, true);
    });
    expect(runWebDavSyncOnceMock).not.toHaveBeenCalled();
  });

  it('cloud 会话失效时，手动点击同步才会跳登录，不会继续触发 pull', async () => {
    settingsState.syncBackend = 'cloud';
    mobileSyncState.needsAuthForCloud = true;

    render(<SettingsMenu onPullLibrary={onPullLibraryMock} />);

    fireEvent.click(screen.getByRole('menuitem', { name: /Never synced/i }));

    await waitFor(() => {
      expect(navigateToLoginMock).toHaveBeenCalled();
    });
    expect(onPullLibraryMock).not.toHaveBeenCalled();
    expect(runWebDavSyncOnceMock).not.toHaveBeenCalled();
  });

  it('backend=webdav 点击同步入口会调用 runWebDavSyncOnce(appService)', async () => {
    settingsState.syncBackend = 'webdav';

    render(<SettingsMenu onPullLibrary={onPullLibraryMock} />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Never synced' }));

    await waitFor(() => {
      expect(runWebDavSyncOnceMock).toHaveBeenCalledWith(appService);
    });
    expect(onPullLibraryMock).not.toHaveBeenCalled();
  });
});
