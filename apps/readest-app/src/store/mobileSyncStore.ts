import { create } from 'zustand';

export type MobileSyncReason =
  | 'startup'
  | 'resume'
  | 'network-restored'
  | 'local-change'
  | 'manual'
  | 'cloud-auth';

interface MobileSyncState {
  pendingChanges: boolean;
  lastSuccessfulSyncAt: number;
  lastAttemptedSyncAt: number;
  lastSyncError: string | null;
  needsAuthForCloud: boolean;
  isOnline: boolean;
  lastOnlineAt: number;
  lastSyncReason: MobileSyncReason | null;
  markLocalChangePending: () => void;
  markSyncAttempted: (reason: MobileSyncReason) => void;
  markSyncSucceeded: (reason: MobileSyncReason) => void;
  markSyncFailed: (message: string, reason: MobileSyncReason) => void;
  setNeedsAuthForCloud: (needsAuth: boolean) => void;
  setOnline: (online: boolean) => void;
  resetSyncError: () => void;
}

const getInitialOnlineState = () => {
  if (typeof navigator === 'undefined') {
    return true;
  }
  return navigator.onLine;
};

const initialOnline = getInitialOnlineState();

export const useMobileSyncStore = create<MobileSyncState>((set) => ({
  pendingChanges: false,
  lastSuccessfulSyncAt: 0,
  lastAttemptedSyncAt: 0,
  lastSyncError: null,
  needsAuthForCloud: false,
  isOnline: initialOnline,
  lastOnlineAt: initialOnline ? Date.now() : 0,
  lastSyncReason: null,
  markLocalChangePending: () => set({ pendingChanges: true }),
  markSyncAttempted: (reason) =>
    set({
      lastAttemptedSyncAt: Date.now(),
      lastSyncReason: reason,
    }),
  markSyncSucceeded: (reason) =>
    set({
      pendingChanges: false,
      lastSuccessfulSyncAt: Date.now(),
      lastSyncError: null,
      lastSyncReason: reason,
    }),
  markSyncFailed: (message, reason) =>
    set({
      pendingChanges: true,
      lastSyncError: message,
      lastSyncReason: reason,
    }),
  setNeedsAuthForCloud: (needsAuthForCloud) => set({ needsAuthForCloud }),
  setOnline: (online) =>
    set((state) => ({
      isOnline: online,
      lastOnlineAt: online ? Date.now() : state.lastOnlineAt,
    })),
  resetSyncError: () => set({ lastSyncError: null }),
}));
