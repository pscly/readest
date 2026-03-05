import { describe, expect, it } from 'vitest';
import {
  computeCloudLoginStartupDecision,
  computeCloudNotAuthenticatedDecision,
} from '@/helpers/cloudLoginPolicy';

describe('cloudLoginPolicy', () => {
  describe('computeCloudLoginStartupDecision', () => {
    it('会话存在时：keepLogin=false 应纠正为 true 并持久化', () => {
      const decision = computeCloudLoginStartupDecision({ keepLogin: false, hasSession: true });
      expect(decision).toEqual({
        nextKeepLogin: true,
        shouldPersist: true,
        shouldNavigateToAuth: false,
      });
    });

    it('会话存在时：keepLogin=true 不需要重复持久化', () => {
      const decision = computeCloudLoginStartupDecision({ keepLogin: true, hasSession: true });
      expect(decision).toEqual({
        nextKeepLogin: true,
        shouldPersist: false,
        shouldNavigateToAuth: false,
      });
    });

    it('会话缺失时：keepLogin=true 应清理为 false 并持久化（不跳转登录）', () => {
      const decision = computeCloudLoginStartupDecision({ keepLogin: true, hasSession: false });
      expect(decision).toEqual({
        nextKeepLogin: false,
        shouldPersist: true,
        shouldNavigateToAuth: false,
      });
    });

    it('会话缺失时：keepLogin=false 不做任何变更', () => {
      const decision = computeCloudLoginStartupDecision({ keepLogin: false, hasSession: false });
      expect(decision).toEqual({
        nextKeepLogin: false,
        shouldPersist: false,
        shouldNavigateToAuth: false,
      });
    });
  });

  describe('computeCloudNotAuthenticatedDecision', () => {
    it('Not authenticated 且 keepLogin=true：清理 keepLogin（不跳转登录）', () => {
      const decision = computeCloudNotAuthenticatedDecision(true);
      expect(decision).toEqual({
        nextKeepLogin: false,
        shouldPersist: true,
        shouldNavigateToAuth: false,
      });
    });

    it('Not authenticated 且 keepLogin=false：不做任何变更', () => {
      const decision = computeCloudNotAuthenticatedDecision(false);
      expect(decision).toEqual({
        nextKeepLogin: false,
        shouldPersist: false,
        shouldNavigateToAuth: false,
      });
    });
  });
});
