import { describe, it, expect } from 'vitest';
import {
  deriveDefaultPickerFolder,
  getParentDirectory,
  buildVrmFileEntries,
  stripVrmExtension,
} from '../../src/vrm-picker/pickerLogic';
import type { AppConfig } from '../../src/types/config';

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    vrmModelPath: null,
    animationFolderPath: null,
    windowPosition: { x: 0, y: 0 },
    windowSize: { width: 400, height: 600 },
    scale: 1.0,
    micEnabled: false,
    cameraEnabled: false,
    targetFps: 30,
    powerSaveMode: false,
    autonomousMovementPaused: false,
    animationLoopEnabled: true,
    autoExpressionEnabled: true,
    allowedAutoExpressions: [],
    animationSpeed: 1.0,
    moveSpeedMultiplier: 1.0,
    systemAssetsDir: 'assets/system',
    ...overrides,
  };
}

describe('deriveDefaultPickerFolder', () => {
  it('returns null when config is null', () => {
    expect(deriveDefaultPickerFolder(null)).toBeNull();
  });

  it('returns null when no fields set', () => {
    expect(deriveDefaultPickerFolder(makeConfig())).toBeNull();
  });

  it('prefers vrmPickerFolder when set', () => {
    const config = makeConfig({
      vrmPickerFolder: 'D:/picker',
      vrmModelPath: 'D:/other/Alice.vrm',
    });
    expect(deriveDefaultPickerFolder(config)).toBe('D:/picker');
  });

  it('falls back to dirname of vrmModelPath when picker folder unset', () => {
    const config = makeConfig({ vrmModelPath: 'D:/vrmodels/Alice.vrm' });
    expect(deriveDefaultPickerFolder(config)).toBe('D:/vrmodels');
  });

  it('handles backslashes in vrmModelPath', () => {
    const config = makeConfig({ vrmModelPath: 'D:\\vrmodels\\Alice.vrm' });
    expect(deriveDefaultPickerFolder(config)).toBe('D:/vrmodels');
  });

  it('handles unix-style paths', () => {
    const config = makeConfig({ vrmModelPath: '/Users/foo/models/Alice.vrm' });
    expect(deriveDefaultPickerFolder(config)).toBe('/Users/foo/models');
  });

  it('returns null when vrmPickerFolder is empty string', () => {
    const config = makeConfig({ vrmPickerFolder: '', vrmModelPath: 'D:/vrmodels/Alice.vrm' });
    expect(deriveDefaultPickerFolder(config)).toBe('D:/vrmodels');
  });
});

describe('getParentDirectory', () => {
  it('returns null for path with no separator', () => {
    expect(getParentDirectory('Alice.vrm')).toBeNull();
  });

  it('extracts directory from forward slash path', () => {
    expect(getParentDirectory('D:/vrmodels/Alice.vrm')).toBe('D:/vrmodels');
  });

  it('extracts directory from backslash path', () => {
    expect(getParentDirectory('D:\\vrmodels\\Alice.vrm')).toBe('D:/vrmodels');
  });

  it('handles nested directories', () => {
    expect(getParentDirectory('/a/b/c/d.vrm')).toBe('/a/b/c');
  });
});

describe('stripVrmExtension', () => {
  it('removes .vrm extension', () => {
    expect(stripVrmExtension('Alice.vrm')).toBe('Alice');
  });

  it('removes .VRM (case insensitive)', () => {
    expect(stripVrmExtension('Alice.VRM')).toBe('Alice');
  });

  it('leaves files without extension untouched', () => {
    expect(stripVrmExtension('Alice')).toBe('Alice');
  });

  it('only removes trailing .vrm', () => {
    expect(stripVrmExtension('My.vrm.backup.vrm')).toBe('My.vrm.backup');
  });
});

describe('buildVrmFileEntries', () => {
  it('builds entries with displayName stripped', () => {
    const paths = ['D:/vrmodels/Alice.vrm', 'D:/vrmodels/Bob.vrm'];
    const entries = buildVrmFileEntries(paths);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      fullPath: 'D:/vrmodels/Alice.vrm',
      fileName: 'Alice.vrm',
      displayName: 'Alice',
    });
    expect(entries[1].displayName).toBe('Bob');
  });

  it('handles backslash paths', () => {
    const entries = buildVrmFileEntries(['D:\\vrmodels\\Alice.vrm']);
    expect(entries[0].fileName).toBe('Alice.vrm');
    expect(entries[0].displayName).toBe('Alice');
  });

  it('returns empty array for empty input', () => {
    expect(buildVrmFileEntries([])).toEqual([]);
  });
});
