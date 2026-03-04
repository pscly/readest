import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import {
  WebDavSyncSettingsWindow,
  setWebDavSyncSettingsWindowVisible,
} from '@/app/library/components/WebDavSyncSettings';
import { eventDispatcher } from '@/utils/event';
import { WebDavHttpError } from '@/services/sync/webdav/client';

const { fakeAppService, getWebDavPasswordMock, setWebDavPasswordMock, clearWebDavPasswordMock } =
  vi.hoisted(() => ({
    fakeAppService: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      resolveFilePath: vi.fn(),
    },
    getWebDavPasswordMock: vi.fn(),
    setWebDavPasswordMock: vi.fn(),
    clearWebDavPasswordMock: vi.fn(),
  }));

const { mkcolMock, propfindMock } = vi.hoisted(() => ({
  mkcolMock: vi.fn(),
  propfindMock: vi.fn(),
}));

const { runWebDavSyncOnceMock } = vi.hoisted(() => ({
  runWebDavSyncOnceMock: vi.fn(),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/services/environment', async () => {
  const actual = await vi.importActual('@/services/environment');
  return {
    ...actual,
    isTauriAppPlatform: () => true,
  };
});

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: fakeAppService }),
}));

vi.mock('@/services/sync/webdav/credentials', () => ({
  getWebDavPassword: getWebDavPasswordMock,
  setWebDavPassword: setWebDavPasswordMock,
  clearWebDavPassword: clearWebDavPasswordMock,
  WebDavCredentialsError: class WebDavCredentialsError extends Error {
    override name = 'WebDavCredentialsError';
  },
}));

vi.mock('@/services/sync/webdav/client', () => {
  class MockWebDavHttpError extends Error {
    status: number;
    statusText: string;
    bodyText?: string;

    constructor(status: number, statusText: string, bodyText?: string) {
      super(`WebDAV HTTP ${status} ${statusText}`);
      this.status = status;
      this.statusText = statusText;
      this.bodyText = bodyText;
    }
  }

  class MockWebDavClient {
    mkcol = mkcolMock;
    propfind = propfindMock;

    constructor(_options: unknown) {}
  }

  return {
    WebDavClient: MockWebDavClient,
    WebDavHttpError: MockWebDavHttpError,
  };
});

vi.mock('@/services/sync/webdav/runOnce', () => ({
  runWebDavSyncOnce: runWebDavSyncOnceMock,
  WebDavSyncNotConfiguredError: class WebDavSyncNotConfiguredError extends Error {
    override name = 'WebDavSyncNotConfiguredError';
  },
}));

describe('WebDavSyncSettingsWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeAppService.readFile.mockRejectedValue(new Error('not found'));
    fakeAppService.writeFile.mockResolvedValue(undefined);
    fakeAppService.resolveFilePath.mockResolvedValue('/tmp/readest-test-path');
    getWebDavPasswordMock.mockResolvedValue(null);
    setWebDavPasswordMock.mockResolvedValue(undefined);
    clearWebDavPasswordMock.mockResolvedValue(undefined);
    mkcolMock.mockResolvedValue(undefined);
    propfindMock.mockResolvedValue([]);
    runWebDavSyncOnceMock.mockResolvedValue({ operations: [], warnings: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('在 http URL 下展示风险提示并在确认前禁用保存', async () => {
    render(<WebDavSyncSettingsWindow />);
    await Promise.resolve();
    setWebDavSyncSettingsWindowVisible(true);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();

    const baseUrlInput = screen.getByLabelText('Server URL') as HTMLInputElement;
    fireEvent.change(baseUrlInput, { target: { value: 'http://example.com/webdav' } });

    expect(
      screen.getByText('Using HTTP Basic over http:// will transmit your password in plaintext.'),
    ).toBeTruthy();

    const saveButton = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('I understand the risks'));
    expect(saveButton.disabled).toBe(false);
  });

  it('测试连接遇到 401 时派发包含认证失败的 toast', async () => {
    mkcolMock.mockRejectedValueOnce(new WebDavHttpError(401, 'Unauthorized'));
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch').mockResolvedValue(undefined);

    render(<WebDavSyncSettingsWindow />);
    await Promise.resolve();
    setWebDavSyncSettingsWindowVisible(true);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://example.com/webdav' },
    });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'demo-user' } });
    const passwordInput = document.getElementById('webdav_password') as HTMLInputElement | null;
    expect(passwordInput).toBeTruthy();
    fireEvent.change(passwordInput!, { target: { value: '******' } });

    const testButton = screen.getByRole('button', { name: 'Test Connection' });
    expect((testButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(testButton);

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({
          message: expect.stringContaining('认证失败'),
        }),
      );
    });
  });

  it('同步遇到非 Error 异常时也应派发可读 toast（不应回落为未知错误）', async () => {
    runWebDavSyncOnceMock.mockRejectedValueOnce({ message: 'Injected non-Error failure' });
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch').mockResolvedValue(undefined);

    render(<WebDavSyncSettingsWindow />);
    await Promise.resolve();
    setWebDavSyncSettingsWindowVisible(true);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://example.com/webdav' },
    });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'demo-user' } });
    const passwordInput = document.getElementById('webdav_password') as HTMLInputElement | null;
    expect(passwordInput).toBeTruthy();
    fireEvent.change(passwordInput!, { target: { value: '******' } });

    const syncButton = screen.getByRole('button', { name: 'Sync Now' });
    expect((syncButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({
          message: expect.stringContaining('Injected non-Error failure'),
        }),
      );
    });
  });
});
