export interface CloudLoginStartupDecisionInput {
  keepLogin: boolean;
  hasSession: boolean;
}

export interface CloudLoginDecision {
  nextKeepLogin: boolean;
  shouldPersist: boolean;
  shouldNavigateToAuth: boolean;
}

/**
 * 云端登录策略（启动阶段）
 *
 * 设计目标（移动端优先）：
 * - 不再因为 keepLogin=true 但会话缺失就强制跳转登录页
 * - 会话存在时可将 keepLogin 纠正为 true，以便后续保持登录体验
 */
export const computeCloudLoginStartupDecision = (
  input: CloudLoginStartupDecisionInput,
): CloudLoginDecision => {
  if (input.hasSession) {
    if (input.keepLogin) {
      return { nextKeepLogin: true, shouldPersist: false, shouldNavigateToAuth: false };
    }
    return { nextKeepLogin: true, shouldPersist: true, shouldNavigateToAuth: false };
  }

  if (input.keepLogin) {
    return { nextKeepLogin: false, shouldPersist: true, shouldNavigateToAuth: false };
  }

  return {
    nextKeepLogin: input.keepLogin,
    shouldPersist: false,
    shouldNavigateToAuth: false,
  };
};

/**
 * 云端同步/请求遇到 Not authenticated 时的策略。
 *
 * 设计目标：
 * - 不自动跳转登录页（避免打断用户使用 WebDAV/本地功能）
 * - 清理 keepLogin，避免下次启动再触发“强制登录循环”
 */
export const computeCloudNotAuthenticatedDecision = (keepLogin: boolean): CloudLoginDecision => {
  if (keepLogin) {
    return { nextKeepLogin: false, shouldPersist: true, shouldNavigateToAuth: false };
  }
  return { nextKeepLogin: keepLogin, shouldPersist: false, shouldNavigateToAuth: false };
};
