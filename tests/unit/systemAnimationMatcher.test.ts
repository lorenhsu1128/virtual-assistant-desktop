import { describe, it, expect } from 'vitest';
import {
  createStateMatcher,
  matchStateFromFilename,
  filterFilesByState,
  extractBasename,
} from '../../src/animation/systemAnimationMatcher';

describe('extractBasename', () => {
  it('handles forward slash path', () => {
    expect(extractBasename('C:/app/assets/SYS_IDLE_01.vrma')).toBe('SYS_IDLE_01.vrma');
  });

  it('handles backslash path', () => {
    expect(extractBasename('C:\\app\\assets\\SYS_IDLE_01.vrma')).toBe('SYS_IDLE_01.vrma');
  });

  it('handles mixed separators', () => {
    expect(extractBasename('C:\\app/assets\\vrma/SYS_WALK_02.vrma')).toBe('SYS_WALK_02.vrma');
  });

  it('returns input unchanged when no separator', () => {
    expect(extractBasename('SYS_SIT_03.vrma')).toBe('SYS_SIT_03.vrma');
  });
});

describe('createStateMatcher', () => {
  it('matches SYS_IDLE_NN', () => {
    const re = createStateMatcher('idle');
    expect(re.test('SYS_IDLE_01.vrma')).toBe(true);
    expect(re.test('SYS_IDLE_20.vrma')).toBe(true);
    expect(re.test('SYS_IDLE_999.vrma')).toBe(true);
  });

  it('is case-insensitive', () => {
    const re = createStateMatcher('idle');
    expect(re.test('sys_idle_01.vrma')).toBe(true);
    expect(re.test('SYS_IDLE_01.VRMA')).toBe(true);
    expect(re.test('Sys_Idle_01.Vrma')).toBe(true);
  });

  it('rejects filenames without numeric suffix', () => {
    const re = createStateMatcher('idle');
    expect(re.test('SYS_IDLE.vrma')).toBe(false);
    expect(re.test('SYS_IDLE_.vrma')).toBe(false);
    expect(re.test('SYS_IDLE_abc.vrma')).toBe(false);
  });

  it('rejects wrong extension', () => {
    const re = createStateMatcher('idle');
    expect(re.test('SYS_IDLE_01.vrm')).toBe(false);
    expect(re.test('SYS_IDLE_01.fbx')).toBe(false);
  });

  it('does not match IDLE inside another prefix', () => {
    const re = createStateMatcher('idle');
    expect(re.test('SYS_SUBIDLE_01.vrma')).toBe(false);
    expect(re.test('preSYS_IDLE_01.vrma')).toBe(false);
  });

  it('DRAGGING prefix matches drag state', () => {
    const re = createStateMatcher('drag');
    expect(re.test('SYS_DRAGGING_01.vrma')).toBe(true);
    expect(re.test('SYS_DRAG_01.vrma')).toBe(false);
  });

  it('HIDE prefix does not match HIDE_SHOW', () => {
    const re = createStateMatcher('hide');
    expect(re.test('SYS_HIDE_01.vrma')).toBe(true);
    expect(re.test('SYS_HIDE_SHOW_01.vrma')).toBe(false);
  });

  it('PEEK prefix matches peek state', () => {
    const re = createStateMatcher('peek');
    expect(re.test('SYS_PEEK_01.vrma')).toBe(true);
    expect(re.test('SYS_HIDE_SHOW_01.vrma')).toBe(false);
  });
});

describe('matchStateFromFilename', () => {
  it('returns correct state for each valid prefix', () => {
    expect(matchStateFromFilename('SYS_IDLE_01.vrma')).toBe('idle');
    expect(matchStateFromFilename('SYS_SIT_05.vrma')).toBe('sit');
    expect(matchStateFromFilename('SYS_WALK_03.vrma')).toBe('walk');
    expect(matchStateFromFilename('SYS_DRAGGING_02.vrma')).toBe('drag');
    expect(matchStateFromFilename('SYS_PEEK_01.vrma')).toBe('peek');
    expect(matchStateFromFilename('SYS_FALL_01.vrma')).toBe('fall');
    expect(matchStateFromFilename('SYS_HIDE_01.vrma')).toBe('hide');
  });

  it('works with full paths', () => {
    expect(matchStateFromFilename('C:/app/assets/system/vrma/SYS_IDLE_01.vrma')).toBe('idle');
    expect(matchStateFromFilename('C:\\app\\assets\\SYS_WALK_02.vrma')).toBe('walk');
  });

  it('returns null for unknown files', () => {
    expect(matchStateFromFilename('SYS_HIDE_SHOW_01.vrma')).toBe(null);
    expect(matchStateFromFilename('SYS_UNKNOWN_01.vrma')).toBe(null);
    expect(matchStateFromFilename('custom.vrma')).toBe(null);
    expect(matchStateFromFilename('SYS_IDLE.vrma')).toBe(null);
  });

  it('does not confuse HIDE with HIDE_SHOW', () => {
    // 這是關鍵測試：確保 hide matcher 不會誤抓 HIDE_SHOW
    expect(matchStateFromFilename('SYS_HIDE_01.vrma')).toBe('hide');
    expect(matchStateFromFilename('SYS_HIDE_SHOW_01.vrma')).toBe(null);
  });
});

describe('filterFilesByState', () => {
  const files = [
    '/app/vrma/SYS_IDLE_01.vrma',
    '/app/vrma/SYS_IDLE_02.vrma',
    '/app/vrma/SYS_IDLE_20.vrma',
    '/app/vrma/SYS_SIT_01.vrma',
    '/app/vrma/SYS_WALK_01.vrma',
    '/app/vrma/SYS_DRAGGING_01.vrma',
    '/app/vrma/SYS_HIDE_01.vrma',
    '/app/vrma/SYS_HIDE_SHOW_01.vrma',
    '/app/vrma/SYS_PEEK_01.vrma',
    '/app/vrma/custom.vrma',
  ];

  it('filters idle files correctly', () => {
    const result = filterFilesByState(files, 'idle');
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('/app/vrma/SYS_IDLE_01.vrma');
    expect(result[2]).toBe('/app/vrma/SYS_IDLE_20.vrma');
  });

  it('filters hide without including HIDE_SHOW', () => {
    const result = filterFilesByState(files, 'hide');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('/app/vrma/SYS_HIDE_01.vrma');
  });

  it('filters peek (without HIDE_SHOW legacy)', () => {
    const result = filterFilesByState(files, 'peek');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('/app/vrma/SYS_PEEK_01.vrma');
  });

  it('returns empty array when no files match (e.g. fall)', () => {
    const result = filterFilesByState(files, 'fall');
    expect(result).toHaveLength(0);
  });

  it('preserves input order', () => {
    const result = filterFilesByState(files, 'idle');
    expect(result).toEqual([
      '/app/vrma/SYS_IDLE_01.vrma',
      '/app/vrma/SYS_IDLE_02.vrma',
      '/app/vrma/SYS_IDLE_20.vrma',
    ]);
  });
});
