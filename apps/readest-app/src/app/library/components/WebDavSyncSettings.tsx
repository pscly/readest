import clsx from 'clsx';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import Dialog from '@/components/Dialog';
import { isTauriAppPlatform } from '@/services/environment';
import {
  sanitizeWebDavLocalSettings,
  serializeWebDavLocalSettings,
  type WebDavLocalSettings,
  WEBDAV_LOCAL_SETTINGS_FILENAME,
} from '@/services/sync/webdav/localSettings';
import {
  clearWebDavPassword,
  getWebDavPassword,
  setWebDavPassword,
  WebDavCredentialsError,
} from '@/services/sync/webdav/credentials';
import { WebDavClient, WebDavHttpError } from '@/services/sync/webdav/client';
import { runWebDavSyncOnce, WebDavSyncNotConfiguredError } from '@/services/sync/webdav/runOnce';

export const setWebDavSyncSettingsWindowVisible = (visible: boolean) => {
  const dialog = document.getElementById('webdav_sync_settings_window');
  if (dialog) {
    const event = new CustomEvent('setWebDavSyncSettingsVisibility', {
      detail: { visible },
    });
    dialog.dispatchEvent(event);
  }
};

const normalizeBaseUrl = (value: string) => value.trim();
const normalizeRootDir = (value: string) => value.trim();
const normalizeUsername = (value: string) => value.trim();

const isHttpUrl = (value: string) => /^http:\/\//i.test(value.trim());
const isHttpsUrl = (value: string) => /^https:\/\//i.test(value.trim());

const redactSensitive = (text: string) => {
  return text
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***')
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, '://***:***@');
};

const tryExtractErrorMessage = (error: unknown): string | null => {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return null;
  const obj = error as Record<string, unknown>;
  if (typeof obj['message'] === 'string') return obj['message'];
  if (typeof obj['error'] === 'string') return obj['error'];
  return null;
};

const normalizeErrorMessage = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const redacted = redactSensitive(trimmed);
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
};

const classifyWebDavError = (error: unknown): { message: string; type: 'error' | 'info' } => {
  if (error instanceof WebDavHttpError) {
    if (error.status === 401) {
      return { message: '认证失败：请检查用户名/密码', type: 'error' };
    }
    if (error.status === 403) {
      return { message: '权限不足：服务器拒绝访问/写入', type: 'error' };
    }
    if (error.status === 404) {
      return { message: '路径不存在：请检查 URL 与远端根目录', type: 'error' };
    }
    return { message: `请求失败（HTTP ${error.status}）`, type: 'error' };
  }

  if (error instanceof WebDavCredentialsError) {
    return { message: error.message, type: 'error' };
  }

  if (error instanceof WebDavSyncNotConfiguredError) {
    return { message: error.message, type: 'info' };
  }

  if (error instanceof Error) {
    return { message: error.message, type: 'error' };
  }

  const extractedMessage = tryExtractErrorMessage(error);
  if (extractedMessage) {
    const normalized = normalizeErrorMessage(extractedMessage);
    if (normalized) {
      return { message: normalized, type: 'error' };
    }
  }
  return { message: '未知错误', type: 'error' };
};

export const WebDavSyncSettingsWindow: React.FC = () => {
  const _ = useTranslation();
  const { appService } = useEnv();

  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState<WebDavLocalSettings>(
    sanitizeWebDavLocalSettings({}, Date.now()),
  );
  const [passwordInput, setPasswordInput] = useState('');
  const [isPasswordSaved, setIsPasswordSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const httpWarningRequired = useMemo(
    () => isHttpUrl(settings.baseUrl) && !settings.httpWarningAcknowledged,
    [settings.baseUrl, settings.httpWarningAcknowledged],
  );

  const canUseWebDav = isTauriAppPlatform() && Boolean(appService);
  const canSave = canUseWebDav && !httpWarningRequired;
  const canRunActions =
    canUseWebDav &&
    !httpWarningRequired &&
    settings.baseUrl.trim().length > 0 &&
    settings.username.trim().length > 0 &&
    (passwordInput.trim().length > 0 || isPasswordSaved);

  const loadLocalSettings = useCallback(async () => {
    if (!appService) return;
    const nowMs = Date.now();
    const raw = await appService
      .readFile(WEBDAV_LOCAL_SETTINGS_FILENAME, 'Settings', 'text')
      .then((text) => JSON.parse(text as string))
      .catch(() => ({}));
    setSettings(sanitizeWebDavLocalSettings(raw, nowMs));

    try {
      const saved = await getWebDavPassword();
      setIsPasswordSaved(Boolean(saved));
    } catch {
      setIsPasswordSaved(false);
    }
    setPasswordInput('');
  }, [appService]);

  useEffect(() => {
    const handleCustomEvent = (event: CustomEvent) => {
      setIsOpen(event.detail.visible);
      if (event.detail.visible) {
        loadLocalSettings();
      }
    };
    const el = document.getElementById('webdav_sync_settings_window');
    el?.addEventListener('setWebDavSyncSettingsVisibility', handleCustomEvent as EventListener);
    return () => {
      el?.removeEventListener(
        'setWebDavSyncSettingsVisibility',
        handleCustomEvent as EventListener,
      );
    };
  }, [loadLocalSettings]);

  const saveLocalSettings = async () => {
    if (!appService) return;
    if (!canSave) return;

    setIsSaving(true);
    try {
      const next: WebDavLocalSettings = {
        ...settings,
        baseUrl: normalizeBaseUrl(settings.baseUrl),
        username: normalizeUsername(settings.username),
        rootDir: normalizeRootDir(settings.rootDir),
        updatedAt: Date.now(),
      };

      await appService.writeFile(
        WEBDAV_LOCAL_SETTINGS_FILENAME,
        'Settings',
        serializeWebDavLocalSettings(next),
      );

      if (passwordInput.trim().length > 0) {
        await setWebDavPassword(passwordInput.trim());
        setIsPasswordSaved(true);
        setPasswordInput('');
      }

      setSettings(next);
      eventDispatcher.dispatch('toast', { message: _('Saved'), type: 'info' });
    } catch (error) {
      const classified = classifyWebDavError(error);
      eventDispatcher.dispatch('toast', { message: _(classified.message), type: classified.type });
    } finally {
      setIsSaving(false);
    }
  };

  const resolvePassword = async () => {
    const trimmed = passwordInput.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    const saved = await getWebDavPassword();
    return saved ?? '';
  };

  const testConnection = async () => {
    if (!canRunActions) return;
    setIsTesting(true);
    try {
      const password = await resolvePassword();
      const client = new WebDavClient({
        baseUrl: settings.baseUrl,
        rootDir: settings.rootDir,
        username: settings.username,
        password,
        allowInsecureTls: settings.allowInsecureTls,
        timeoutMs: 10_000,
        maxRetries: 0,
      });

      await client.mkcol('');
      await client.propfind('', '0');

      eventDispatcher.dispatch('toast', { message: _('Connection successful'), type: 'info' });
    } catch (error) {
      const classified = classifyWebDavError(error);
      eventDispatcher.dispatch('toast', { message: _(classified.message), type: classified.type });
    } finally {
      setIsTesting(false);
    }
  };

  const syncNow = async () => {
    if (!appService) return;
    if (!canRunActions) return;
    setIsSyncing(true);
    try {
      await saveLocalSettings();
      const result = await runWebDavSyncOnce(appService);
      const opCount = result.operations.length;
      const warningCount = result.warnings.length;
      const message =
        opCount === 0
          ? '同步完成：无变更'
          : warningCount > 0
            ? `同步完成：${opCount} 项（${warningCount} 条警告）`
            : `同步完成：${opCount} 项`;
      eventDispatcher.dispatch('toast', { message: _(message), type: 'info' });
      eventDispatcher.dispatch('webdav-sync-finished', {
        finishedAtMs: Date.now(),
        operationsCount: opCount,
        warningsCount: warningCount,
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
      const classified = classifyWebDavError(error);
      eventDispatcher.dispatch('toast', { message: _(classified.message), type: classified.type });
    } finally {
      setIsSyncing(false);
    }
  };

  const clearPassword = async () => {
    setIsSaving(true);
    try {
      await clearWebDavPassword();
      setIsPasswordSaved(false);
      setPasswordInput('');
      eventDispatcher.dispatch('toast', { message: _('Password cleared'), type: 'info' });
    } catch (error) {
      const classified = classifyWebDavError(error);
      eventDispatcher.dispatch('toast', { message: _(classified.message), type: classified.type });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog
      id='webdav_sync_settings_window'
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      title={_('WebDAV Sync Settings')}
      boxClassName='sm:!min-w-[520px] sm:h-auto'
    >
      {isOpen && (
        <div className='mb-4 mt-0 flex flex-col gap-4 p-2 sm:p-4'>
          {!canUseWebDav && (
            <div className='border-warning/40 bg-warning/10 rounded-lg border p-3 text-sm'>
              {_('WebDAV sync is only available in the Tauri app.')}
            </div>
          )}

          <div className='form-control w-full'>
            <label className='label py-1' htmlFor='webdav_base_url'>
              <span className='label-text font-medium'>{_('Server URL')}</span>
            </label>
            <input
              id='webdav_base_url'
              type='text'
              className='input input-bordered h-12 w-full focus:outline-none focus:ring-0'
              spellCheck='false'
              value={settings.baseUrl}
              onChange={(e) => setSettings((prev) => ({ ...prev, baseUrl: e.target.value }))}
              placeholder={_('Example: http(s)://your-server/dav/webdav')}
              disabled={!canUseWebDav}
            />
          </div>

          <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
            <div className='form-control w-full'>
              <label className='label py-1' htmlFor='webdav_username'>
                <span className='label-text font-medium'>{_('Username')}</span>
              </label>
              <input
                id='webdav_username'
                type='text'
                className='input input-bordered h-12 w-full focus:outline-none focus:ring-0'
                spellCheck='false'
                value={settings.username}
                onChange={(e) => setSettings((prev) => ({ ...prev, username: e.target.value }))}
                disabled={!canUseWebDav}
              />
            </div>
            <div className='form-control w-full'>
              <label className='label py-1' htmlFor='webdav_root_dir'>
                <span className='label-text font-medium'>{_('Remote Root Dir')}</span>
              </label>
              <input
                id='webdav_root_dir'
                type='text'
                className='input input-bordered h-12 w-full focus:outline-none focus:ring-0'
                spellCheck='false'
                value={settings.rootDir}
                onChange={(e) => setSettings((prev) => ({ ...prev, rootDir: e.target.value }))}
                disabled={!canUseWebDav}
              />
            </div>
          </div>

          <div className='form-control w-full'>
            <label className='label py-1' htmlFor='webdav_max_concurrent_transfers'>
              <span className='label-text font-medium'>{_('Max Concurrent Transfers')}</span>
            </label>
            <input
              id='webdav_max_concurrent_transfers'
              type='number'
              min={1}
              max={8}
              className='input input-bordered h-12 w-full focus:outline-none focus:ring-0'
              value={settings.maxConcurrentTransfers}
              onChange={(e) => {
                const nextValue = e.target.valueAsNumber;
                if (!Number.isFinite(nextValue)) {
                  return;
                }
                const clamped = Math.min(8, Math.max(1, Math.floor(nextValue)));
                setSettings((prev) => ({ ...prev, maxConcurrentTransfers: clamped }));
              }}
              disabled={!canUseWebDav}
            />
            <div className='text-base-content/60 mt-1 text-xs'>
              {_('Recommended: 4. Lower it if your WebDAV server is slow or unstable.')}
            </div>
          </div>

          <div className='form-control w-full'>
            <label className='label py-1' htmlFor='webdav_password'>
              <span className='label-text font-medium'>{_('Password')}</span>
              <span
                className={clsx(
                  'text-xs',
                  isPasswordSaved ? 'text-success' : 'text-base-content/60',
                )}
              >
                {isPasswordSaved ? _('Saved locally') : _('Not saved')}
              </span>
            </label>
            <input
              id='webdav_password'
              type='password'
              className='input input-bordered h-12 w-full focus:outline-none focus:ring-0'
              spellCheck='false'
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder={isPasswordSaved ? _('Leave blank to keep saved password') : ''}
              disabled={!canUseWebDav}
            />
            <div className='mt-2 flex items-center justify-between'>
              <div className='flex items-center gap-2 text-sm'>
                <input
                  id='webdav_auto_sync_toggle'
                  type='checkbox'
                  className='toggle toggle-sm'
                  checked={settings.autoSync}
                  onChange={() => setSettings((prev) => ({ ...prev, autoSync: !prev.autoSync }))}
                  disabled={!canUseWebDav}
                />
                <label className='text-base-content/80' htmlFor='webdav_auto_sync_toggle'>
                  {_('Auto Sync')}
                </label>
              </div>
              {isHttpsUrl(settings.baseUrl) && (
                <div className='flex items-center gap-2 text-sm'>
                  <input
                    id='webdav_allow_insecure_tls_toggle'
                    type='checkbox'
                    className='toggle toggle-sm'
                    checked={settings.allowInsecureTls}
                    onChange={() =>
                      setSettings((prev) => ({ ...prev, allowInsecureTls: !prev.allowInsecureTls }))
                    }
                    disabled={!canUseWebDav}
                  />
                  <label
                    className='text-base-content/80'
                    htmlFor='webdav_allow_insecure_tls_toggle'
                  >
                    {_('Allow insecure TLS (local only)')}
                  </label>
                </div>
              )}
              <button
                type='button'
                className='btn btn-ghost btn-sm'
                onClick={clearPassword}
                disabled={!canUseWebDav || isSaving}
              >
                {_('Clear Password')}
              </button>
            </div>
          </div>

          {isHttpUrl(settings.baseUrl) && (
            <div className='border-error/40 bg-error/10 rounded-lg border p-3 text-sm'>
              <div className='font-medium'>{_('Security warning')}</div>
              <div className='text-base-content/80 mt-1'>
                {_('Using HTTP Basic over http:// will transmit your password in plaintext.')}
              </div>
              <div className='mt-3 flex items-center gap-2'>
                <input
                  id='webdav_http_warning_ack'
                  type='checkbox'
                  className='checkbox checkbox-sm'
                  checked={settings.httpWarningAcknowledged}
                  onChange={() =>
                    setSettings((prev) => ({
                      ...prev,
                      httpWarningAcknowledged: !prev.httpWarningAcknowledged,
                    }))
                  }
                  disabled={!canUseWebDav}
                />
                <label className='text-base-content/80 text-sm' htmlFor='webdav_http_warning_ack'>
                  {_('I understand the risks')}
                </label>
              </div>
            </div>
          )}

          <div className='grid grid-cols-1 gap-2 sm:grid-cols-3'>
            <button
              type='button'
              className='btn btn-outline h-12 min-h-12'
              onClick={saveLocalSettings}
              disabled={!canSave || isSaving}
            >
              {isSaving ? <span className='loading loading-spinner'></span> : _('Save')}
            </button>
            <button
              type='button'
              className='btn btn-outline h-12 min-h-12'
              onClick={testConnection}
              disabled={!canRunActions || isTesting}
            >
              {isTesting ? <span className='loading loading-spinner'></span> : _('Test Connection')}
            </button>
            <button
              type='button'
              className='btn btn-primary h-12 min-h-12'
              onClick={syncNow}
              disabled={!canRunActions || isSyncing}
            >
              {isSyncing ? <span className='loading loading-spinner'></span> : _('Sync Now')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
};
