import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

// Mock ipc so MouseCursorTracker can be constructed.
vi.mock('../../src/bridge/ElectronIPC', () => ({
  ipc: { onCursorPosition: vi.fn(() => () => {}) },
}));

import { HeadTrackingController } from '../../src/headtracking/HeadTrackingController';
import { MouseCursorTracker } from '../../src/headtracking/MouseCursorTracker';

/** Fake VRMController exposing the methods HeadTrackingController uses */
function makeFakeVRMController(
  bones: Record<string, THREE.Object3D | null>,
  modelRoot?: THREE.Object3D,
) {
  const setBoneRotation = vi.fn((name: string, q: THREE.Quaternion) => {
    const node = bones[name];
    if (node) node.quaternion.copy(q);
  });
  const getBoneNode = vi.fn((name: string) => bones[name] ?? null);
  const root = modelRoot ?? new THREE.Object3D();
  return {
    setBoneRotation,
    getBoneNode,
    getHumanoidBoneMapping: vi.fn(() => null),
    getModelRoot: vi.fn(() => root),
  } as unknown as Parameters<typeof HeadTrackingController.prototype.constructor>[0];
}

/** 建立 spine→upperChest→neck→head 的簡單 humanoid 階層 */
function makeBoneHierarchy() {
  const root = new THREE.Object3D();
  const spine = new THREE.Object3D();
  spine.position.set(0, 1.0, 0);
  const upperChest = new THREE.Object3D();
  upperChest.position.set(0, 0.15, 0);
  const neck = new THREE.Object3D();
  neck.position.set(0, 0.15, 0);
  const head = new THREE.Object3D();
  head.position.set(0, 0.1, 0);
  root.add(spine);
  spine.add(upperChest);
  upperChest.add(neck);
  neck.add(head);
  root.updateMatrixWorld(true);
  return { root, spine, upperChest, neck, head };
}

describe('HeadTrackingController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isEnabled() reflects setEnabled', () => {
    const bones = makeBoneHierarchy();
    const vrm = makeFakeVRMController({
      upperChest: bones.upperChest,
      neck: bones.neck,
      head: bones.head,
    });
    const tracker = new MouseCursorTracker();
    const ctrl = new HeadTrackingController(vrm, tracker);
    expect(ctrl.isEnabled()).toBe(true);
    ctrl.setEnabled(false);
    expect(ctrl.isEnabled()).toBe(false);
    ctrl.setEnabled(true);
    expect(ctrl.isEnabled()).toBe(true);
  });

  it('rebuildChain() succeeds with full humanoid bones', () => {
    const bones = makeBoneHierarchy();
    const vrm = makeFakeVRMController({
      upperChest: bones.upperChest,
      neck: bones.neck,
      head: bones.head,
    });
    const tracker = new MouseCursorTracker();
    const ctrl = new HeadTrackingController(vrm, tracker);
    ctrl.rebuildChain();
    // No throw, no warning beyond console; chain is built
    expect(vrm.getBoneNode).toHaveBeenCalledWith('upperChest');
    expect(vrm.getBoneNode).toHaveBeenCalledWith('head');
  });

  it('rebuildChain() degrades gracefully when head is missing', () => {
    const vrm = makeFakeVRMController({
      upperChest: new THREE.Object3D(),
      neck: new THREE.Object3D(),
      head: null,
    });
    const tracker = new MouseCursorTracker();
    const ctrl = new HeadTrackingController(vrm, tracker);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctrl.rebuildChain();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('applyPerFrame() is no-op when disabled', () => {
    const bones = makeBoneHierarchy();
    const vrm = makeFakeVRMController({
      upperChest: bones.upperChest,
      neck: bones.neck,
      head: bones.head,
    });
    const tracker = new MouseCursorTracker();
    const ctrl = new HeadTrackingController(vrm, tracker);
    ctrl.rebuildChain();
    ctrl.setEnabled(false);
    ctrl.setTargetProvider(() => new THREE.Vector3(5, 5, 5));
    ctrl.applyPerFrame(0.016);
    // setBoneRotation should not be called when disabled (no fade in progress on first frame)
    // Note: setEnabled(false) on already-disabled chain triggers fade path; check carefully
    // After fresh init, lastAppliedQuaternions is empty → fadeOutToAnimation early-returns
    expect(vrm.setBoneRotation).not.toHaveBeenCalled();
  });

  it('applyPerFrame() writes rotations to upperChest / neck / head when enabled', () => {
    const bones = makeBoneHierarchy();
    const vrm = makeFakeVRMController({
      upperChest: bones.upperChest,
      neck: bones.neck,
      head: bones.head,
    });
    const tracker = new MouseCursorTracker();
    const ctrl = new HeadTrackingController(vrm, tracker);
    ctrl.rebuildChain();
    // Target far to the side so non-trivial rotation happens
    ctrl.setTargetProvider(() => new THREE.Vector3(2, 1.4, 0));
    ctrl.applyPerFrame(0.016);
    const namesWritten = (vrm.setBoneRotation as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(namesWritten).toContain('upperChest');
    expect(namesWritten).toContain('neck');
    expect(namesWritten).toContain('head');
  });

  it('weight=0 (via hide state override) suppresses bone writes', () => {
    const bones = makeBoneHierarchy();
    const vrm = makeFakeVRMController({
      upperChest: bones.upperChest,
      neck: bones.neck,
      head: bones.head,
    });
    const tracker = new MouseCursorTracker();
    const ctrl = new HeadTrackingController(vrm, tracker);
    ctrl.rebuildChain();
    ctrl.setStateOverride('hide');
    ctrl.setTargetProvider(() => new THREE.Vector3(2, 1.4, 0));
    ctrl.applyPerFrame(0.016);
    expect(vrm.setBoneRotation).not.toHaveBeenCalled();
  });

  it('peek / opendoor / enterdoor also suppress tracking', () => {
    const bones = makeBoneHierarchy();
    const vrm = makeFakeVRMController({
      upperChest: bones.upperChest,
      neck: bones.neck,
      head: bones.head,
    });
    const tracker = new MouseCursorTracker();
    const ctrl = new HeadTrackingController(vrm, tracker);
    ctrl.rebuildChain();
    ctrl.setTargetProvider(() => new THREE.Vector3(2, 1.4, 0));
    for (const state of ['peek', 'opendoor', 'enterdoor'] as const) {
      (vrm.setBoneRotation as ReturnType<typeof vi.fn>).mockClear();
      ctrl.setStateOverride(state);
      ctrl.applyPerFrame(0.016);
      expect(vrm.setBoneRotation).not.toHaveBeenCalled();
    }
  });
});
