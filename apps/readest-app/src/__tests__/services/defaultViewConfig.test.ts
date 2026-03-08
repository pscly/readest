import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTE_EXPORT_CONFIG, DEFAULT_VIEW_CONFIG } from '@/services/constants';

describe('DEFAULT_VIEW_CONFIG', () => {
  it('应包含进度栏时间和电量显示所需的默认字段', () => {
    expect(DEFAULT_VIEW_CONFIG.showCurrentTime).toBe(false);
    expect(DEFAULT_VIEW_CONFIG.use24HourClock).toBe(false);
    expect(DEFAULT_VIEW_CONFIG.showCurrentBatteryStatus).toBe(false);
    expect(DEFAULT_VIEW_CONFIG.showBatteryPercentage).toBe(true);
  });
});

describe('DEFAULT_NOTE_EXPORT_CONFIG', () => {
  it('应默认导出批注所在页码', () => {
    expect(DEFAULT_NOTE_EXPORT_CONFIG.includePageNumber).toBe(true);
  });
});
