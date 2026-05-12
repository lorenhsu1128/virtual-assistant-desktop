import * as THREE from 'three';
import { Chain3D, Bone3D, V3 } from 'ikts';

/**
 * IK 鏈建構器
 *
 * 用 ikts 為 VRM humanoid 建一條從 upperChest → neck → head → 虛擬末端骨
 * 的 IK 鏈。虛擬末端骨延伸自 head 的 forward 方向，把「頭軸對準 target」
 * 問題轉成「鏈尾位置 = target」問題（IK 解的問題）。
 *
 * 每幀 update():
 *   1. 同步 chain base 到 upperChest 世界座標
 *   2. setTarget(targetWorld) + solveForTarget
 *   3. 從 chain bones 讀出每段方向，與 rest direction 比對算出
 *      每個 VRM bone 的「世界空間」旋轉差 → quaternion
 *
 * 注意：ikts 是純 IK 數學庫，不直接觸碰 three / VRM 物件。
 * 本類別負責 three ↔ ikts 雙向同步。
 */

export interface IKBoneSpec {
  /** VRM humanoid bone 名稱 */
  vrmBoneName: 'upperChest' | 'neck' | 'head';
  /** rest pose 在世界空間的起點（建構時 snapshot） */
  restStartWorld: THREE.Vector3;
  /** rest pose 在世界空間的終點（建構時 snapshot） */
  restEndWorld: THREE.Vector3;
  /** rest 方向（end - start，normalized） */
  restDirectionWorld: THREE.Vector3;
  /** 此骨長度（rest） */
  length: number;
}

export interface BuiltIKChain {
  chain: Chain3D;
  /** Chain 中對應 VRM bone 的索引（依新增順序） */
  bones: IKBoneSpec[];
  /** 虛擬末端骨索引 = bones.length（chain.bones[length] 是虛擬骨） */
  virtualEndIndex: number;
}

const VIRTUAL_BONE_LENGTH = 0.2; // 公尺；長度只影響 IK 鏈總長，不影響方向結果

/**
 * 建立 IK 鏈。
 *
 * @param getBoneNode 由 VRMController 提供的 getBoneNode 函式
 * @returns BuiltIKChain，或 null（模型缺少必要骨骼時降級）
 */
export function buildHeadIKChain(
  getBoneNode: (name: string) => THREE.Object3D | null,
): BuiltIKChain | null {
  const boneNames: Array<'upperChest' | 'neck' | 'head'> = ['upperChest', 'neck', 'head'];
  const nodes: Record<string, THREE.Object3D | null> = {};
  for (const name of boneNames) {
    nodes[name] = getBoneNode(name);
  }
  // 必須要有 head；upperChest 不存在時退而求其次用 chest，再退求 spine
  if (!nodes.head) {
    console.warn('[IKChainBuilder] head bone missing — head tracking disabled');
    return null;
  }
  if (!nodes.upperChest) {
    const chest = getBoneNode('chest');
    const spine = getBoneNode('spine');
    nodes.upperChest = chest ?? spine;
    if (!nodes.upperChest) {
      console.warn('[IKChainBuilder] upperChest/chest/spine all missing — disabled');
      return null;
    }
  }
  if (!nodes.neck) {
    // neck 缺失時用 head 父節點當代理（多數 VRM 都有 neck，這是保險）
    const headParent = nodes.head.parent;
    nodes.neck = headParent ?? nodes.head;
  }

  // 計算 rest 方向：用每個 bone 的世界位置 → 其「下一個 bone」的世界位置作為段方向
  const order: Array<'upperChest' | 'neck' | 'head'> = ['upperChest', 'neck', 'head'];
  const specs: IKBoneSpec[] = [];
  for (let i = 0; i < order.length; i++) {
    const cur = nodes[order[i]];
    const next = i + 1 < order.length ? nodes[order[i + 1]] : null;
    if (!cur) continue;

    const start = new THREE.Vector3();
    cur.getWorldPosition(start);

    let end: THREE.Vector3;
    if (next) {
      end = new THREE.Vector3();
      next.getWorldPosition(end);
    } else {
      // head 段：用 head bone 的 local +Y 方向（VRM 規範頭頂方向）延伸固定長度
      // 取 0.15m 約頭高的一半
      const headUp = new THREE.Vector3(0, 0.15, 0);
      end = start.clone().add(headUp.applyQuaternion(cur.getWorldQuaternion(new THREE.Quaternion())));
    }
    const dir = end.clone().sub(start);
    const length = dir.length();
    if (length < 1e-5) {
      console.warn(`[IKChainBuilder] zero-length bone ${order[i]} — skipping`);
      continue;
    }
    dir.normalize();
    specs.push({
      vrmBoneName: order[i],
      restStartWorld: start,
      restEndWorld: end,
      restDirectionWorld: dir,
      length,
    });
  }

  if (specs.length === 0) {
    console.warn('[IKChainBuilder] no usable bones — disabled');
    return null;
  }

  const chain = new Chain3D();
  chain.setFixedBaseMode(true);
  chain.setBaseLocation(toV3(specs[0].restStartWorld));

  // 第一段：base→end0
  const dir0 = toV3(specs[0].restDirectionWorld);
  const bone0 = new Bone3D(
    toV3(specs[0].restStartWorld),
    undefined,
    dir0,
    specs[0].length,
  );
  chain.addBone(bone0);

  // 後續段：用 addConsecutiveBone
  for (let i = 1; i < specs.length; i++) {
    chain.addConsecutiveBone(toV3(specs[i].restDirectionWorld), specs[i].length);
  }
  // 虛擬末端骨：head 段方向延伸
  const lastDir = toV3(specs[specs.length - 1].restDirectionWorld);
  chain.addConsecutiveBone(lastDir, VIRTUAL_BONE_LENGTH);

  return {
    chain,
    bones: specs,
    virtualEndIndex: specs.length,
  };
}

/** Three.js Vector3 → ikts V3 */
export function toV3(v: THREE.Vector3): V3 {
  return new V3(v.x, v.y, v.z);
}

/** ikts V3 → Three.js Vector3 (in-place) */
export function fromV3(v: V3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(v.x, v.y, v.z);
}
