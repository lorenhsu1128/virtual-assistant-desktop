import { describe, it, expect } from 'vitest';
import {
  deriveDefaultPickerFolder,
  getParentDirectory,
  buildVrmFileEntries,
  stripVrmExtension,
  clamp,
  isSysIdleFile,
  computePanLimits,
  parseVrmVersion,
  parseVrmName,
  isUndressForbiddenByLicense,
  isModificationForbiddenByLicense,
  analyzeVrmModel,
  getClothingMeshNames,
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

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(2.5, 1, 5)).toBe(2.5);
  });

  it('returns min when value below range', () => {
    expect(clamp(0.5, 1, 5)).toBe(1);
  });

  it('returns max when value above range', () => {
    expect(clamp(10, 1, 5)).toBe(5);
  });

  it('returns min when equal to min', () => {
    expect(clamp(1, 1, 5)).toBe(1);
  });

  it('returns max when equal to max', () => {
    expect(clamp(5, 1, 5)).toBe(5);
  });

  it('handles negative ranges', () => {
    expect(clamp(-3, -5, -1)).toBe(-3);
    expect(clamp(-10, -5, -1)).toBe(-5);
    expect(clamp(0, -5, -1)).toBe(-1);
  });
});

describe('isSysIdleFile', () => {
  it('matches SYS_IDLE_*.vrma in forward slash path', () => {
    expect(isSysIdleFile('C:/app/assets/system/vrma/SYS_IDLE_1.vrma')).toBe(true);
  });

  it('matches SYS_IDLE_*.vrma in backslash path', () => {
    expect(isSysIdleFile('C:\\app\\assets\\system\\vrma\\SYS_IDLE_15.vrma')).toBe(true);
  });

  it('matches plain filename without directory', () => {
    expect(isSysIdleFile('SYS_IDLE_1.vrma')).toBe(true);
  });

  it('matches case-insensitive extension', () => {
    expect(isSysIdleFile('SYS_IDLE_1.VRMA')).toBe(true);
  });

  it('rejects .vrm files', () => {
    expect(isSysIdleFile('SYS_IDLE_1.vrm')).toBe(false);
  });

  it('rejects non-SYS_IDLE .vrma', () => {
    expect(isSysIdleFile('SYS_WALK_1.vrma')).toBe(false);
    expect(isSysIdleFile('idle.vrma')).toBe(false);
    expect(isSysIdleFile('user_idle.vrma')).toBe(false);
  });

  it('does not match SYS_IDLE substring inside another filename', () => {
    expect(isSysIdleFile('preSYS_IDLE_1.vrma')).toBe(false);
  });

  it('matches with descriptive suffix', () => {
    expect(isSysIdleFile('SYS_IDLE_breathing.vrma')).toBe(true);
    expect(isSysIdleFile('SYS_IDLE_long_name_with_underscores.vrma')).toBe(true);
  });
});

describe('computePanLimits', () => {
  const FOV_RAD = (35 * Math.PI) / 180;
  const MARGIN = 0.2;

  it('returns wider limits when camera is farther', () => {
    const near = computePanLimits(1.0, FOV_RAD, 1.5, MARGIN);
    const far = computePanLimits(5.0, FOV_RAD, 1.5, MARGIN);
    expect(far.x).toBeGreaterThan(near.x);
    expect(far.y).toBeGreaterThan(near.y);
  });

  it('horizontal limit is greater than vertical when aspect > 1', () => {
    const limits = computePanLimits(2.4, FOV_RAD, 1.5, MARGIN);
    expect(limits.x).toBeGreaterThan(limits.y);
  });

  it('default-distance values are within expected range', () => {
    // distance 2.4m, fov 35°, aspect 1.5, margin 0.2
    // halfHeight = 2.4 * tan(17.5°) ≈ 0.7565
    // halfWidth  = 0.7565 * 1.5 ≈ 1.1347
    // x = max(0.1, 1.1347 - 0.2) ≈ 0.9347
    // y = max(0.2, 0.7565 - 0.2) ≈ 0.5565
    const limits = computePanLimits(2.4, FOV_RAD, 1.5, MARGIN);
    expect(limits.x).toBeCloseTo(0.9347, 2);
    expect(limits.y).toBeCloseTo(0.5565, 2);
  });

  it('clamps to minimum at very near distance', () => {
    // distance 0.5m gives halfHeight ≈ 0.158, halfWidth ≈ 0.236
    // x = max(0.1, 0.236 - 0.2) = max(0.1, 0.036) = 0.1
    // y = max(0.2, 0.158 - 0.2) = max(0.2, -0.042) = 0.2
    const limits = computePanLimits(0.5, FOV_RAD, 1.5, MARGIN);
    expect(limits.x).toBe(0.1);
    expect(limits.y).toBe(0.2);
  });

  it('handles zero distance without NaN', () => {
    const limits = computePanLimits(0, FOV_RAD, 1.5, MARGIN);
    expect(limits.x).toBe(0.1);
    expect(limits.y).toBe(0.2);
    expect(Number.isFinite(limits.x)).toBe(true);
    expect(Number.isFinite(limits.y)).toBe(true);
  });

  it('handles negative distance gracefully (clamps to 0)', () => {
    const limits = computePanLimits(-1, FOV_RAD, 1.5, MARGIN);
    expect(limits.x).toBe(0.1);
    expect(limits.y).toBe(0.2);
  });

  it('handles negative aspect ratio gracefully', () => {
    const limits = computePanLimits(2.4, FOV_RAD, -1, MARGIN);
    expect(limits.x).toBe(0.1);
    expect(Number.isFinite(limits.x)).toBe(true);
  });

  it('aspect ratio 1.0 makes x and y limits closer', () => {
    const limits = computePanLimits(2.4, FOV_RAD, 1.0, MARGIN);
    expect(limits.x).toBeCloseTo(limits.y, 5);
  });

  it('larger margin reduces limits', () => {
    const small = computePanLimits(2.4, FOV_RAD, 1.5, 0.1);
    const large = computePanLimits(2.4, FOV_RAD, 1.5, 0.5);
    expect(large.x).toBeLessThan(small.x);
    expect(large.y).toBeLessThan(small.y);
  });
});

describe('parseVrmVersion', () => {
  it('returns 1.0 for VRM 1.0 meta', () => {
    expect(parseVrmVersion({ metaVersion: '1' })).toBe('1.0');
  });

  it('returns 0.x for VRM 0.x meta', () => {
    expect(parseVrmVersion({ metaVersion: '0' })).toBe('0.x');
  });

  it('returns unknown for null / undefined', () => {
    expect(parseVrmVersion(null)).toBe('unknown');
    expect(parseVrmVersion(undefined)).toBe('unknown');
  });

  it('returns unknown for missing metaVersion', () => {
    expect(parseVrmVersion({})).toBe('unknown');
    expect(parseVrmVersion({ metaVersion: '2' })).toBe('unknown');
  });
});

describe('parseVrmName', () => {
  it('reads name from VRM 1.0 meta', () => {
    expect(parseVrmName({ metaVersion: '1', name: 'Alice' })).toBe('Alice');
  });

  it('reads title from VRM 0.x meta', () => {
    expect(parseVrmName({ metaVersion: '0', title: 'Bob' })).toBe('Bob');
  });

  it('trims whitespace', () => {
    expect(parseVrmName({ name: '  Alice  ' })).toBe('Alice');
  });

  it('returns empty string when meta is null or unset', () => {
    expect(parseVrmName(null)).toBe('');
    expect(parseVrmName({})).toBe('');
  });
});

describe('isModificationForbiddenByLicense', () => {
  it('true when VRM 1.0 modification is prohibited', () => {
    expect(
      isModificationForbiddenByLicense({ metaVersion: '1', modification: 'prohibited' }),
    ).toBe(true);
  });

  it('false when VRM 1.0 modification allows it', () => {
    expect(
      isModificationForbiddenByLicense({
        metaVersion: '1',
        modification: 'allowModification',
      }),
    ).toBe(false);
  });

  it('false for VRM 0.x (no equivalent field)', () => {
    expect(
      isModificationForbiddenByLicense({ metaVersion: '0', modification: 'prohibited' }),
    ).toBe(false);
  });
});

describe('isUndressForbiddenByLicense', () => {
  it('true when VRM 1.0 modification prohibited', () => {
    expect(
      isUndressForbiddenByLicense({ metaVersion: '1', modification: 'prohibited' }),
    ).toBe(true);
  });

  it('true when VRM 1.0 explicitly forbids sexual usage', () => {
    expect(
      isUndressForbiddenByLicense({
        metaVersion: '1',
        modification: 'allowModification',
        allowExcessivelySexualUsage: false,
      }),
    ).toBe(true);
  });

  it('false when VRM 1.0 allows both modification and sexual', () => {
    expect(
      isUndressForbiddenByLicense({
        metaVersion: '1',
        modification: 'allowModification',
        allowExcessivelySexualUsage: true,
      }),
    ).toBe(false);
  });

  it('true when VRM 0.x sexualUssageName is Disallow', () => {
    expect(
      isUndressForbiddenByLicense({ metaVersion: '0', sexualUssageName: 'Disallow' }),
    ).toBe(true);
  });

  it('false when VRM 0.x sexualUssageName is Allow', () => {
    expect(
      isUndressForbiddenByLicense({ metaVersion: '0', sexualUssageName: 'Allow' }),
    ).toBe(false);
  });

  it('false for null / unknown meta', () => {
    expect(isUndressForbiddenByLicense(null)).toBe(false);
    expect(isUndressForbiddenByLicense({})).toBe(false);
  });
});

describe('getClothingMeshNames', () => {
  it('returns only clothing meshes (filtered)', () => {
    const result = getClothingMeshNames([
      'Body',
      'Face',
      'Hair',
      'Outfit_Top',
      'Outfit_Skirt',
    ]);
    expect(result).toEqual(['Outfit_Top', 'Outfit_Skirt']);
  });

  it('returns empty when no clothing keywords match', () => {
    expect(getClothingMeshNames(['Body', 'Face', 'Hair'])).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(getClothingMeshNames([])).toEqual([]);
  });

  it('matches case-insensitively as substring', () => {
    expect(getClothingMeshNames(['CHARACTER_DRESS', 'PantsLayer'])).toEqual([
      'CHARACTER_DRESS',
      'PantsLayer',
    ]);
  });

  it('preserves original order', () => {
    expect(
      getClothingMeshNames(['Shoes', 'Body', 'Jacket', 'Hair', 'Skirt']),
    ).toEqual(['Shoes', 'Jacket', 'Skirt']);
  });

  it('matches all keyword categories', () => {
    const result = getClothingMeshNames([
      'cloth_a',
      'shirt_main',
      'underwear_set',
      'hat_01',
      'glove_l',
      'sock_r',
    ]);
    expect(result).toHaveLength(6);
  });
});

describe('analyzeVrmModel', () => {
  const permissiveV1 = {
    metaVersion: '1',
    name: 'Alice',
    modification: 'allowModification',
    allowExcessivelySexualUsage: true,
  };

  it('detects clothing meshes and reports yes/maybe (permissive license)', () => {
    const info = analyzeVrmModel(
      permissiveV1,
      ['Body', 'Face', 'Hair', 'Outfit_Top', 'Outfit_Skirt'],
      ['happy', 'sad'],
    );
    expect(info.name).toBe('Alice');
    expect(info.vrmVersion).toBe('1.0');
    expect(info.canChangeClothes).toBe('yes');
    expect(info.canUndress).toBe('maybe');
    expect(info.expressions).toEqual(['happy', 'sad']);
  });

  it('reports no when no clothing meshes detected', () => {
    const info = analyzeVrmModel(permissiveV1, ['Body', 'Face', 'Hair'], []);
    expect(info.canChangeClothes).toBe('no');
    expect(info.canUndress).toBe('no');
  });

  it('reports no for both when modification prohibited', () => {
    const info = analyzeVrmModel(
      { metaVersion: '1', name: 'Alice', modification: 'prohibited' },
      ['Body', 'Outfit_Top'],
      [],
    );
    expect(info.canChangeClothes).toBe('no');
    expect(info.canUndress).toBe('no');
  });

  it('reports yes/no for VRM 0.x with sexual usage disallowed', () => {
    const info = analyzeVrmModel(
      { metaVersion: '0', title: 'Bob', sexualUssageName: 'Disallow' },
      ['Body', 'Shirt', 'Pants'],
      [],
    );
    expect(info.vrmVersion).toBe('0.x');
    expect(info.name).toBe('Bob');
    expect(info.canChangeClothes).toBe('yes'); // VRM 0.x 沒有 modification 概念
    expect(info.canUndress).toBe('no');
  });

  it('handles unknown meta version gracefully', () => {
    const info = analyzeVrmModel(null, ['Body', 'Cloth_A'], ['neutral']);
    expect(info.vrmVersion).toBe('unknown');
    expect(info.name).toBe('');
    expect(info.canChangeClothes).toBe('yes');
    expect(info.canUndress).toBe('maybe');
    expect(info.expressions).toEqual(['neutral']);
  });

  it('clothing keyword match is case-insensitive and substring', () => {
    const info = analyzeVrmModel(permissiveV1, ['Hair_001', 'CHARACTER_DRESS'], []);
    expect(info.canChangeClothes).toBe('yes');
  });

  it('returns a copy of expressions array', () => {
    const exprs = ['a', 'b'];
    const info = analyzeVrmModel(permissiveV1, ['Body'], exprs);
    info.expressions.push('c');
    expect(exprs).toEqual(['a', 'b']);
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
