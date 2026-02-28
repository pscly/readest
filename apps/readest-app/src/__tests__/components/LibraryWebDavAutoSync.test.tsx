import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  useWebDavAutoSync,
  WEBDAV_AUTO_SYNC_THROTTLE_MS,
} from '@/app/library/hooks/useWebDavAutoSync';

const {
  runWebDavSyncOnceMock,
  readFileMock,
  setIsSyncingMock,
  toastDispatchMock,
  settingsState,
  appService,
  librarySyncState,
} = vi.hoisted(() => {
  const runWebDavSyncOnceMock = vi.fn();
  const readFileMock = vi.fn();
  const toastDispatchMock = vi.fn();
  const librarySyncState = { isSyncing: false };
  const setIsSyncingMock = vi.fn((value: boolean) => {
    librarySyncState.isSyncing = value;
  });

  return {
    runWebDavSyncOnceMock,
    readFileMock,
    setIsSyncingMock,
    toastDispatchMock,
    settingsState: {
      syncBackend: 'webdav' as 'webdav' | 'cloud' | 'off',
    },
    appService: {
      readFile: readFileMock,
    },
    librarySyncState,
  };
});

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    appService,
  }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: settingsState,
  }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/utils/event', () => ({
  eventDispatcher: {
    dispatch: toastDispatchMock,
  },
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

vi.mock('@/store/libraryStore', () => {
  const useLibraryStore = (() => ({
    isSyncing: librarySyncState.isSyncing,
    setIsSyncing: setIsSyncingMock,
  })) as unknown as typeof import('@/store/libraryStore').useLibraryStore;

  Object.assign(useLibraryStore, {
    getState: () => ({
      isSyncing: librarySyncState.isSyncing,
      setIsSyncing: setIsSyncingMock,
    }),
  });

  return { useLibraryStore };
});

const HookHarness = () => {
  useWebDavAutoSync();
  return null;
};

const flushAsync = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

const setVisibilityState = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
};

describe('useWebDavAutoSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.clearAllMocks();
    librarySyncState.isSyncing = false;
    settingsState.syncBackend = 'webdav';
    readFileMock.mockResolvedValue(
      JSON.stringify({
        schemaVersion: 1,
        baseUrl: 'https://dav.example.com',
        username: 'reader',
        rootDir: 'readest1',
        autoSync: true,
      }),
    );
    runWebDavSyncOnceMock.mockResolvedValue({ operations: [], warnings: [] });
    setVisibilityState('visible');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('进入 Library 页面时会触发一次 WebDAV 自动同步', async () => {
    render(<HookHarness />);

    await flushAsync();
    expect(runWebDavSyncOnceMock).toHaveBeenCalledTimes(1);
    expect(setIsSyncingMock).toHaveBeenCalledWith(true);
    expect(setIsSyncingMock).toHaveBeenLastCalledWith(false);
  });

  it('WebDavSyncAlreadyRunningError 时仍会释放 library isSyncing 且不发 toast', async () => {
    const { WebDavSyncAlreadyRunningError } = await import('@/services/sync/webdav/engine');
    runWebDavSyncOnceMock.mockRejectedValueOnce(new WebDavSyncAlreadyRunningError('running'));

    render(<HookHarness />);
    await flushAsync();

    expect(runWebDavSyncOnceMock).toHaveBeenCalledTimes(1);
    expect(setIsSyncingMock).toHaveBeenCalledWith(true);
    expect(setIsSyncingMock).toHaveBeenLastCalledWith(false);
    expect(toastDispatchMock).not.toHaveBeenCalled();
  });

  it('backend=cloud 时不会触发 WebDAV 自动同步', async () => {
    settingsState.syncBackend = 'cloud';
    render(<HookHarness />);

    await flushAsync();
    expect(runWebDavSyncOnceMock).not.toHaveBeenCalled();
  });

  it('应用回到前台时触发并遵循 30s 节流窗口', async () => {
    render(<HookHarness />);
    await flushAsync();
    expect(runWebDavSyncOnceMock).toHaveBeenCalledTimes(1);

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAsync();
    expect(runWebDavSyncOnceMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WEBDAV_AUTO_SYNC_THROTTLE_MS + 1);
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAsync();
    expect(runWebDavSyncOnceMock).toHaveBeenCalledTimes(2);

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAsync();
    expect(runWebDavSyncOnceMock).toHaveBeenCalledTimes(2);
  });

  it('卸载时会移除 visibilitychange 监听', async () => {
    const { unmount } = render(<HookHarness />);
    await flushAsync();
    expect(runWebDavSyncOnceMock).toHaveBeenCalledTimes(1);

    unmount();
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(WEBDAV_AUTO_SYNC_THROTTLE_MS + 1);

    expect(runWebDavSyncOnceMock).toHaveBeenCalledTimes(1);
  });
});
