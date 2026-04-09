import { describe, it, expect } from 'vitest';
import { exportMocapToVrma } from '../../src/mocap/exporter/VrmaExporter';
import { parseGlb } from '../../src/mocap/exporter/gltfWriter';
import { buildMocapFrames } from '../../src/mocap/pipeline';
import {
  generateLeftArmRaiseFixture,
  generateRestFixture,
  generateHipsWalkFixture,
} from '../../src/mocap/fixtures/testFixtures';
import type { VrmHumanBoneName } from '../../src/mocap/types';

const FULL_BONES: Set<VrmHumanBoneName> = new Set([
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm',
  'leftLowerArm', 'rightLowerArm',
  'leftHand', 'rightHand',
  'leftUpperLeg', 'rightUpperLeg',
  'leftLowerLeg', 'rightLowerLeg',
  'leftFoot', 'rightFoot',
  'leftToes', 'rightToes',
]);

interface GltfJson {
  asset: { version: string; generator?: string };
  extensionsUsed: string[];
  extensions: {
    VRMC_vrm_animation: {
      specVersion: string;
      humanoid: { humanBones: Record<string, { node: number }> };
    };
  };
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: { name: string }[];
  animations: {
    name: string;
    channels: { sampler: number; target: { node: number; path: string } }[];
    samplers: { input: number; output: number; interpolation: string }[];
  }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number }[];
  buffers: { byteLength: number }[];
}

function readAccessorAsFloat32(
  binary: Uint8Array,
  accessor: GltfJson['accessors'][number],
  bufferView: GltfJson['bufferViews'][number],
): Float32Array {
  const byteOffset = bufferView.byteOffset + (accessor.byteOffset ?? 0);
  const numComponents =
    accessor.type === 'SCALAR' ? 1 : accessor.type === 'VEC3' ? 3 : 4;
  const count = accessor.count * numComponents;
  // Copy into a new Float32Array to avoid alignment issues
  const out = new Float32Array(count);
  const dv = new DataView(binary.buffer, binary.byteOffset + byteOffset, count * 4);
  for (let i = 0; i < count; i++) {
    out[i] = dv.getFloat32(i * 4, true);
  }
  return out;
}

// ── Structural tests ──

describe('exportMocapToVrma — structural', () => {
  it('throws on empty frames array', () => {
    expect(() => exportMocapToVrma([])).toThrow();
  });

  it('produces non-empty GLB for rest fixture', () => {
    const track = generateRestFixture(30, 1.0);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const glb = exportMocapToVrma(frames);
    expect(glb.byteLength).toBeGreaterThan(12);
  });

  it('GLB round-trips via parseGlb', () => {
    const track = generateLeftArmRaiseFixture(30, 1.0);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const glb = exportMocapToVrma(frames);
    const { json } = parseGlb(glb);
    const gj = json as GltfJson;
    expect(gj.asset.version).toBe('2.0');
    expect(gj.extensionsUsed).toContain('VRMC_vrm_animation');
    expect(gj.extensions.VRMC_vrm_animation.specVersion).toBe('1.0');
  });

  it('humanBones references valid node indices', () => {
    const track = generateLeftArmRaiseFixture(30, 0.5);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const { json } = parseGlb(exportMocapToVrma(frames));
    const gj = json as GltfJson;
    const humanBones = gj.extensions.VRMC_vrm_animation.humanoid.humanBones;
    expect(Object.keys(humanBones).length).toBeGreaterThan(0);
    for (const mapping of Object.values(humanBones)) {
      expect(mapping.node).toBeGreaterThanOrEqual(0);
      expect(mapping.node).toBeLessThan(gj.nodes.length);
    }
  });

  it('each bone in humanBones has a rotation channel targeting it', () => {
    const track = generateLeftArmRaiseFixture(30, 0.5);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const { json } = parseGlb(exportMocapToVrma(frames));
    const gj = json as GltfJson;
    const humanBones = gj.extensions.VRMC_vrm_animation.humanoid.humanBones;
    const rotationTargets = new Set(
      gj.animations[0].channels
        .filter((c) => c.target.path === 'rotation')
        .map((c) => c.target.node),
    );
    for (const mapping of Object.values(humanBones)) {
      expect(rotationTargets.has(mapping.node)).toBe(true);
    }
  });

  it('generator and animation name can be customised', () => {
    const track = generateRestFixture(30, 0.5);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const glb = exportMocapToVrma(frames, {
      generator: 'test-gen',
      animationName: 'test-anim',
    });
    const { json } = parseGlb(glb);
    const gj = json as GltfJson;
    expect(gj.asset.generator).toBe('test-gen');
    expect(gj.animations[0].name).toBe('test-anim');
  });

  it('all accessors have componentType=FLOAT and valid count', () => {
    const track = generateLeftArmRaiseFixture(30, 1.0);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const { json, binary } = parseGlb(exportMocapToVrma(frames));
    const gj = json as GltfJson;
    for (const acc of gj.accessors) {
      expect(acc.componentType).toBe(5126);
      expect(acc.count).toBeGreaterThan(0);
      expect(['SCALAR', 'VEC3', 'VEC4']).toContain(acc.type);
      expect(acc.bufferView).toBeGreaterThanOrEqual(0);
      expect(acc.bufferView).toBeLessThan(gj.bufferViews.length);
    }
    expect(binary.byteLength).toBeGreaterThanOrEqual(gj.buffers[0].byteLength);
  });
});

// ── Time accessor round-trip ──

describe('exportMocapToVrma — time accessor', () => {
  it('time values match frames and have min/max', () => {
    const track = generateLeftArmRaiseFixture(30, 2.0);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const { json, binary } = parseGlb(exportMocapToVrma(frames));
    const gj = json as GltfJson;

    const timeAccessor = gj.accessors[gj.animations[0].samplers[0].input];
    expect(timeAccessor.type).toBe('SCALAR');
    expect(timeAccessor.count).toBe(frames.length);
    expect(timeAccessor.min).toBeDefined();
    expect(timeAccessor.max).toBeDefined();

    const expectedStart = 0;
    const expectedEnd = (frames[frames.length - 1].timestampMs - frames[0].timestampMs) / 1000;
    expect(timeAccessor.min![0]).toBeCloseTo(expectedStart);
    expect(timeAccessor.max![0]).toBeCloseTo(expectedEnd);

    const view = readAccessorAsFloat32(
      binary,
      timeAccessor,
      gj.bufferViews[timeAccessor.bufferView],
    );
    expect(view.length).toBe(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const expected = (frames[i].timestampMs - frames[0].timestampMs) / 1000;
      expect(view[i]).toBeCloseTo(expected);
    }
  });
});

// ── Rotation round-trip ──

describe('exportMocapToVrma — rotation data', () => {
  it('leftLowerArm rotation round-trips within 1e-5 per component', () => {
    const track = generateLeftArmRaiseFixture(30, 2.0);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const { json, binary } = parseGlb(exportMocapToVrma(frames));
    const gj = json as GltfJson;

    const targetNode = gj.extensions.VRMC_vrm_animation.humanoid.humanBones.leftLowerArm.node;
    const channel = gj.animations[0].channels.find(
      (c) => c.target.node === targetNode && c.target.path === 'rotation',
    );
    expect(channel).toBeDefined();

    const sampler = gj.animations[0].samplers[channel!.sampler];
    const acc = gj.accessors[sampler.output];
    expect(acc.type).toBe('VEC4');
    expect(acc.count).toBe(frames.length);

    const view = readAccessorAsFloat32(binary, acc, gj.bufferViews[acc.bufferView]);
    for (let i = 0; i < frames.length; i++) {
      const q = frames[i].boneRotations.leftLowerArm ?? { x: 0, y: 0, z: 0, w: 1 };
      expect(view[i * 4 + 0]).toBeCloseTo(q.x, 5);
      expect(view[i * 4 + 1]).toBeCloseTo(q.y, 5);
      expect(view[i * 4 + 2]).toBeCloseTo(q.z, 5);
      expect(view[i * 4 + 3]).toBeCloseTo(q.w, 5);
    }
  });

  it('rest fixture → all VEC4 accessors are identity quat', () => {
    const track = generateRestFixture(30, 0.5);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    // Remove hips translation so we only test rotation channels
    for (const f of frames) f.hipsWorldPosition = null;
    const { json, binary } = parseGlb(exportMocapToVrma(frames));
    const gj = json as GltfJson;

    for (const sampler of gj.animations[0].samplers) {
      const acc = gj.accessors[sampler.output];
      if (acc.type !== 'VEC4') continue;
      const view = readAccessorAsFloat32(binary, acc, gj.bufferViews[acc.bufferView]);
      for (let i = 0; i < acc.count; i++) {
        expect(view[i * 4 + 0]).toBeCloseTo(0);
        expect(view[i * 4 + 1]).toBeCloseTo(0);
        expect(view[i * 4 + 2]).toBeCloseTo(0);
        expect(view[i * 4 + 3]).toBeCloseTo(1);
      }
    }
  });
});

// ── Hips translation round-trip ──

describe('exportMocapToVrma — VRM 0.x coordinate compensation', () => {
  it('sourceMetaVersion="0" negates x/z of rotation quaternions', () => {
    const track = generateLeftArmRaiseFixture(30, 0.5);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const { json: json1, binary: bin1 } = parseGlb(exportMocapToVrma(frames));
    const { json: json0, binary: bin0 } = parseGlb(
      exportMocapToVrma(frames, { sourceMetaVersion: '0' }),
    );
    const gj1 = json1 as GltfJson;
    const gj0 = json0 as GltfJson;

    const leftLowerArm1 = gj1.extensions.VRMC_vrm_animation.humanoid.humanBones.leftLowerArm.node;
    const leftLowerArm0 = gj0.extensions.VRMC_vrm_animation.humanoid.humanBones.leftLowerArm.node;

    const channel1 = gj1.animations[0].channels.find(
      (c) => c.target.node === leftLowerArm1 && c.target.path === 'rotation',
    )!;
    const channel0 = gj0.animations[0].channels.find(
      (c) => c.target.node === leftLowerArm0 && c.target.path === 'rotation',
    )!;

    const acc1 = gj1.accessors[gj1.animations[0].samplers[channel1.sampler].output];
    const acc0 = gj0.accessors[gj0.animations[0].samplers[channel0.sampler].output];

    const view1 = readAccessorAsFloat32(bin1, acc1, gj1.bufferViews[acc1.bufferView]);
    const view0 = readAccessorAsFloat32(bin0, acc0, gj0.bufferViews[acc0.bufferView]);

    for (let i = 0; i < frames.length; i++) {
      expect(view0[i * 4 + 0]).toBeCloseTo(-view1[i * 4 + 0]); // x flipped
      expect(view0[i * 4 + 1]).toBeCloseTo(view1[i * 4 + 1]);  // y unchanged
      expect(view0[i * 4 + 2]).toBeCloseTo(-view1[i * 4 + 2]); // z flipped
      expect(view0[i * 4 + 3]).toBeCloseTo(view1[i * 4 + 3]);  // w unchanged
    }
  });

  it('sourceMetaVersion="1" or undefined does not negate anything', () => {
    const track = generateLeftArmRaiseFixture(30, 0.3);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const { json: j1, binary: b1 } = parseGlb(exportMocapToVrma(frames, { sourceMetaVersion: '1' }));
    const { json: jUndef, binary: bUndef } = parseGlb(exportMocapToVrma(frames));

    const gj1 = j1 as GltfJson;
    const gjU = jUndef as GltfJson;
    expect(gj1.accessors.length).toBe(gjU.accessors.length);
    // Compare raw binary content
    expect(b1.byteLength).toBe(bUndef.byteLength);
    for (let i = 0; i < b1.byteLength; i++) {
      expect(b1[i]).toBe(bUndef[i]);
    }
  });
});

describe('exportMocapToVrma — hips translation', () => {
  it('hips walk fixture produces a translation channel on hips node', () => {
    const track = generateHipsWalkFixture(30, 2.0);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const { json, binary } = parseGlb(exportMocapToVrma(frames));
    const gj = json as GltfJson;

    const hipsNode = gj.extensions.VRMC_vrm_animation.humanoid.humanBones.hips.node;
    const translationChannel = gj.animations[0].channels.find(
      (c) => c.target.node === hipsNode && c.target.path === 'translation',
    );
    expect(translationChannel).toBeDefined();

    const sampler = gj.animations[0].samplers[translationChannel!.sampler];
    const acc = gj.accessors[sampler.output];
    expect(acc.type).toBe('VEC3');
    expect(acc.count).toBe(frames.length);

    const view = readAccessorAsFloat32(binary, acc, gj.bufferViews[acc.bufferView]);
    for (let i = 0; i < frames.length; i++) {
      const pos = frames[i].hipsWorldPosition!;
      expect(view[i * 3 + 0]).toBeCloseTo(pos.x, 5);
      expect(view[i * 3 + 1]).toBeCloseTo(pos.y, 5);
      expect(view[i * 3 + 2]).toBeCloseTo(pos.z, 5);
    }
  });

  it('no hips translation channel when all hipsWorldPosition are null', () => {
    const track = generateLeftArmRaiseFixture(30, 0.5);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    for (const f of frames) f.hipsWorldPosition = null;
    const { json } = parseGlb(exportMocapToVrma(frames));
    const gj = json as GltfJson;

    const translationChannels = gj.animations[0].channels.filter(
      (c) => c.target.path === 'translation',
    );
    expect(translationChannels.length).toBe(0);
  });

  it('no hips translation channel when all hipsWorldPosition are zero (bug fix: avoid NaN)', () => {
    // Regression test: generator 常用 (0,0,0) 當「無運動」佔位符，
    // exporter 應該把這當成「無 translation 軌道」跳過，否則會覆寫
    // 主視窗 VRM hips rest pose 造成 VRMController applyHipSmoothing
    // 產生 NaN、角色消失。
    const track = generateLeftArmRaiseFixture(30, 0.5); // trans 全為 [0,0,0]
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    // 確認 pipeline 產生的是 {x:0, y:0, z:0}（非 null）
    expect(frames[0].hipsWorldPosition).toEqual({ x: 0, y: 0, z: 0 });
    const { json } = parseGlb(exportMocapToVrma(frames));
    const gj = json as GltfJson;

    const translationChannels = gj.animations[0].channels.filter(
      (c) => c.target.path === 'translation',
    );
    expect(translationChannels.length).toBe(0);
  });

  it('combined fixture: rotations + hips translation', () => {
    // Manually build a combined frame: left arm raise + walking hips
    const track = generateLeftArmRaiseFixture(30, 1.0);
    for (let i = 0; i < track.trans.length; i++) {
      track.trans[i] = [i * 0.01, 0.5 + 0.1 * Math.sin(i * 0.3), 0];
    }
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const { json } = parseGlb(exportMocapToVrma(frames));
    const gj = json as GltfJson;

    const rotationCount = gj.animations[0].channels.filter((c) => c.target.path === 'rotation').length;
    const translationCount = gj.animations[0].channels.filter((c) => c.target.path === 'translation').length;
    expect(rotationCount).toBeGreaterThan(0);
    expect(translationCount).toBe(1);
  });
});
