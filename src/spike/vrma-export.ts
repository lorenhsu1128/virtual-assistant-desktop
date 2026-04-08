/**
 * Spike B — VRMA round-trip
 *
 * 目標：驗證 `GLTFExporter` + 注入 `VRMC_vrm_animation` extension 能否產出
 *       被 `@pixiv/three-vrm-animation` 的 `VRMAnimationLoaderPlugin` 正確讀回的 `.vrma` 檔
 *
 * 流程：
 *   1. 建最小 humanoid bone hierarchy 的 THREE.Scene
 *   2. 建 2 秒的 AnimationClip（hip Y translation + leftUpperArm Z rotation）
 *   3. GLTFExporter.parseAsync(binary) 輸出 glb
 *   4. 解 glb container → 注入 VRMC_vrm_animation extension → 重組 glb
 *   5. 觸發下載 spike-output.vrma
 *   6. 讓使用者載入 .vrm 與剛下載的 .vrma，用 VRMAnimationLoaderPlugin 讀回並套到模型播放
 *
 * 此檔為 investigative spike，不進入 production build。
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  VRMAnimation,
  createVRMAnimationClip,
} from '@pixiv/three-vrm-animation';

// ────────────────────────────────────────────────────────────────
// VRM humanoid bone 階層（簡化版，只包含 body bones，無手指）
// ────────────────────────────────────────────────────────────────

type HumanoidBoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  | 'leftShoulder'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'leftHand'
  | 'rightShoulder'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'rightHand'
  | 'leftUpperLeg'
  | 'leftLowerLeg'
  | 'leftFoot'
  | 'rightUpperLeg'
  | 'rightLowerLeg'
  | 'rightFoot';

interface BoneSpec {
  name: HumanoidBoneName;
  parent: HumanoidBoneName | null;
  restPos: [number, number, number]; // 相對於 parent 的位置（粗估）
}

const HUMANOID_SPEC: readonly BoneSpec[] = [
  { name: 'hips', parent: null, restPos: [0, 1.0, 0] },
  { name: 'spine', parent: 'hips', restPos: [0, 0.1, 0] },
  { name: 'chest', parent: 'spine', restPos: [0, 0.15, 0] },
  { name: 'upperChest', parent: 'chest', restPos: [0, 0.1, 0] },
  { name: 'neck', parent: 'upperChest', restPos: [0, 0.15, 0] },
  { name: 'head', parent: 'neck', restPos: [0, 0.1, 0] },

  { name: 'leftShoulder', parent: 'upperChest', restPos: [0.1, 0.1, 0] },
  { name: 'leftUpperArm', parent: 'leftShoulder', restPos: [0.08, 0, 0] },
  { name: 'leftLowerArm', parent: 'leftUpperArm', restPos: [0.25, 0, 0] },
  { name: 'leftHand', parent: 'leftLowerArm', restPos: [0.25, 0, 0] },

  { name: 'rightShoulder', parent: 'upperChest', restPos: [-0.1, 0.1, 0] },
  { name: 'rightUpperArm', parent: 'rightShoulder', restPos: [-0.08, 0, 0] },
  { name: 'rightLowerArm', parent: 'rightUpperArm', restPos: [-0.25, 0, 0] },
  { name: 'rightHand', parent: 'rightLowerArm', restPos: [-0.25, 0, 0] },

  { name: 'leftUpperLeg', parent: 'hips', restPos: [0.08, -0.05, 0] },
  { name: 'leftLowerLeg', parent: 'leftUpperLeg', restPos: [0, -0.4, 0] },
  { name: 'leftFoot', parent: 'leftLowerLeg', restPos: [0, -0.4, 0] },

  { name: 'rightUpperLeg', parent: 'hips', restPos: [-0.08, -0.05, 0] },
  { name: 'rightLowerLeg', parent: 'rightUpperLeg', restPos: [0, -0.4, 0] },
  { name: 'rightFoot', parent: 'rightLowerLeg', restPos: [0, -0.4, 0] },
];

// ────────────────────────────────────────────────────────────────
// Logger
// ────────────────────────────────────────────────────────────────

const logEl = document.getElementById('spike-log') as HTMLDivElement;

function log(
  message: string,
  level: 'info' | 'success' | 'warn' | 'error' | 'section' = 'info',
): void {
  const line = document.createElement('div');
  line.className = `log-${level}`;
  const stamp = new Date().toLocaleTimeString();
  line.textContent = `[${stamp}] ${message}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  // eslint-disable-next-line no-console
  console.log(`[spike-vrma] ${message}`);
}

// ────────────────────────────────────────────────────────────────
// Step 1: 建 minimal humanoid bone scene
// ────────────────────────────────────────────────────────────────

interface HumanoidSceneResult {
  scene: THREE.Scene;
  bones: Record<HumanoidBoneName, THREE.Bone>;
  rootBone: THREE.Bone;
}

function buildHumanoidScene(): HumanoidSceneResult {
  const scene = new THREE.Scene();
  const bones: Partial<Record<HumanoidBoneName, THREE.Bone>> = {};

  for (const spec of HUMANOID_SPEC) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    bone.position.set(spec.restPos[0], spec.restPos[1], spec.restPos[2]);
    bones[spec.name] = bone;
  }

  // 連父子
  for (const spec of HUMANOID_SPEC) {
    const bone = bones[spec.name]!;
    if (spec.parent) {
      bones[spec.parent]!.add(bone);
    }
  }

  const rootBone = bones.hips!;
  scene.add(rootBone);

  return { scene, bones: bones as Record<HumanoidBoneName, THREE.Bone>, rootBone };
}

// ────────────────────────────────────────────────────────────────
// Step 2: 建測試 AnimationClip
// ────────────────────────────────────────────────────────────────

function buildTestClip(bones: Record<HumanoidBoneName, THREE.Bone>): THREE.AnimationClip {
  const duration = 2.0;
  const fps = 30;
  const totalFrames = Math.floor(duration * fps) + 1;

  const times: number[] = [];
  for (let i = 0; i < totalFrames; i++) {
    times.push(i / fps);
  }

  // 1. hips position: Y 軸正弦搖動 ±10cm，週期 1 秒
  const hipsBase = bones.hips.position;
  const hipsPosValues: number[] = [];
  for (const t of times) {
    const y = hipsBase.y + Math.sin(t * Math.PI * 2) * 0.1;
    hipsPosValues.push(hipsBase.x, y, hipsBase.z);
  }
  const hipsPosTrack = new THREE.VectorKeyframeTrack(
    'hips.position',
    times,
    hipsPosValues,
  );

  // 2. leftUpperArm quaternion: Z 軸 ±45°，週期 1 秒
  const leftArmQuatValues: number[] = [];
  const axis = new THREE.Vector3(0, 0, 1);
  for (const t of times) {
    const angle = Math.sin(t * Math.PI * 2) * (Math.PI / 4);
    const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    leftArmQuatValues.push(q.x, q.y, q.z, q.w);
  }
  const leftArmQuatTrack = new THREE.QuaternionKeyframeTrack(
    'leftUpperArm.quaternion',
    times,
    leftArmQuatValues,
  );

  // 3. rightUpperArm quaternion: Z 軸 ∓45°（反向，用於視覺驗證左右區分）
  const rightArmQuatValues: number[] = [];
  for (const t of times) {
    const angle = -Math.sin(t * Math.PI * 2) * (Math.PI / 4);
    const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    rightArmQuatValues.push(q.x, q.y, q.z, q.w);
  }
  const rightArmQuatTrack = new THREE.QuaternionKeyframeTrack(
    'rightUpperArm.quaternion',
    times,
    rightArmQuatValues,
  );

  return new THREE.AnimationClip('spike-test', duration, [
    hipsPosTrack,
    leftArmQuatTrack,
    rightArmQuatTrack,
  ]);
}

// ────────────────────────────────────────────────────────────────
// Step 3: GLTFExporter → glb ArrayBuffer
// ────────────────────────────────────────────────────────────────

async function exportToGlb(
  scene: THREE.Scene,
  clip: THREE.AnimationClip,
): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, {
    binary: true,
    animations: [clip],
    trs: true, // 確保 node 用 TRS 而非 matrix
    onlyVisible: false,
    embedImages: false,
  });

  if (!(result instanceof ArrayBuffer)) {
    throw new Error('GLTFExporter 回傳的不是 ArrayBuffer（應該設 binary: true）');
  }
  return result;
}

// ────────────────────────────────────────────────────────────────
// Step 4: 解析 glb container + 注入 VRMC_vrm_animation extension
// ────────────────────────────────────────────────────────────────

interface GlbChunks {
  jsonBytes: Uint8Array;
  binBytes: Uint8Array | null;
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

function parseGlbContainer(buf: ArrayBuffer): GlbChunks {
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const length = dv.getUint32(8, true);
  if (magic !== GLB_MAGIC) throw new Error('非 glb 檔（magic 不符）');
  if (version !== 2) throw new Error(`不支援的 glb version: ${version}`);
  if (length !== buf.byteLength) {
    throw new Error(`glb 長度欄位 ${length} 與實際 ${buf.byteLength} 不符`);
  }

  let offset = 12;
  let jsonBytes: Uint8Array | null = null;
  let binBytes: Uint8Array | null = null;

  while (offset < length) {
    const chunkLen = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const chunkData = new Uint8Array(buf, offset + 8, chunkLen);
    if (chunkType === CHUNK_TYPE_JSON) {
      jsonBytes = chunkData;
    } else if (chunkType === CHUNK_TYPE_BIN) {
      binBytes = chunkData;
    }
    offset += 8 + chunkLen;
  }

  if (!jsonBytes) throw new Error('glb 內無 JSON chunk');
  return { jsonBytes, binBytes };
}

function padTo4(bytes: Uint8Array, padByte: number): Uint8Array {
  const remainder = bytes.byteLength % 4;
  if (remainder === 0) return bytes;
  const padLen = 4 - remainder;
  const padded = new Uint8Array(bytes.byteLength + padLen);
  padded.set(bytes);
  for (let i = bytes.byteLength; i < padded.byteLength; i++) {
    padded[i] = padByte;
  }
  return padded;
}

function repackGlb(jsonBytes: Uint8Array, binBytes: Uint8Array | null): ArrayBuffer {
  const paddedJson = padTo4(jsonBytes, 0x20); // JSON chunk padded with spaces
  const paddedBin = binBytes ? padTo4(binBytes, 0x00) : null;

  const jsonChunkSize = 8 + paddedJson.byteLength;
  const binChunkSize = paddedBin ? 8 + paddedBin.byteLength : 0;
  const totalSize = 12 + jsonChunkSize + binChunkSize;

  const out = new ArrayBuffer(totalSize);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);

  // Header
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalSize, true);

  // JSON chunk
  dv.setUint32(12, paddedJson.byteLength, true);
  dv.setUint32(16, CHUNK_TYPE_JSON, true);
  u8.set(paddedJson, 20);

  // BIN chunk
  if (paddedBin) {
    const binOffset = 20 + paddedJson.byteLength;
    dv.setUint32(binOffset, paddedBin.byteLength, true);
    dv.setUint32(binOffset + 4, CHUNK_TYPE_BIN, true);
    u8.set(paddedBin, binOffset + 8);
  }

  return out;
}

interface InjectResult {
  buffer: ArrayBuffer;
  nodeMapping: Record<string, number>;
}

function injectVrmAnimationExtension(glb: ArrayBuffer): InjectResult {
  const { jsonBytes, binBytes } = parseGlbContainer(glb);

  const textDec = new TextDecoder('utf-8');
  const jsonText = textDec.decode(jsonBytes);
  const gltf = JSON.parse(jsonText) as {
    extensionsUsed?: string[];
    extensions?: Record<string, unknown>;
    nodes?: Array<{ name?: string }>;
  };

  // 建 boneName → node index map
  const nodeMapping: Record<string, number> = {};
  const humanoidBoneNames = new Set<string>(HUMANOID_SPEC.map((s) => s.name));
  gltf.nodes?.forEach((node, idx) => {
    if (node.name && humanoidBoneNames.has(node.name)) {
      nodeMapping[node.name] = idx;
    }
  });

  log(`  偵測到 humanoid bone 對應：${Object.keys(nodeMapping).length} 根`, 'info');
  for (const spec of HUMANOID_SPEC) {
    if (!(spec.name in nodeMapping)) {
      log(`  ⚠ 遺失 bone: ${spec.name}`, 'warn');
    }
  }

  // 注入 extension
  const humanBones: Record<string, { node: number }> = {};
  for (const [name, idx] of Object.entries(nodeMapping)) {
    humanBones[name] = { node: idx };
  }

  gltf.extensionsUsed = Array.from(
    new Set([...(gltf.extensionsUsed ?? []), 'VRMC_vrm_animation']),
  );
  gltf.extensions = gltf.extensions ?? {};
  gltf.extensions.VRMC_vrm_animation = {
    specVersion: '1.0',
    humanoid: { humanBones },
  };

  const textEnc = new TextEncoder();
  const newJsonBytes = textEnc.encode(JSON.stringify(gltf));
  const repacked = repackGlb(newJsonBytes, binBytes);
  return { buffer: repacked, nodeMapping };
}

// ────────────────────────────────────────────────────────────────
// Step 5: Download
// ────────────────────────────────────────────────────────────────

function downloadBuffer(buf: ArrayBuffer, filename: string): void {
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ────────────────────────────────────────────────────────────────
// Step 6+: Three.js 預覽 scene（右半邊 canvas 顯示 VRM）
// ────────────────────────────────────────────────────────────────

interface PreviewContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  clock: THREE.Clock;
  mixer: THREE.AnimationMixer | null;
  vrm: VRM | null;
  currentAction: THREE.AnimationAction | null;
}

function initPreview(canvas: HTMLCanvasElement): PreviewContext {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x15151f, 1);
  renderer.setPixelRatio(window.devicePixelRatio);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(1, 2, 2);
  scene.add(dir);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, 1.2, 2.5);
  camera.lookAt(0, 1, 0);

  const ctx: PreviewContext = {
    renderer,
    scene,
    camera,
    clock: new THREE.Clock(),
    mixer: null,
    vrm: null,
    currentAction: null,
  };

  // Resize observer
  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  };
  resize();
  new ResizeObserver(resize).observe(canvas.parentElement!);

  // Render loop
  const tick = (): void => {
    const dt = ctx.clock.getDelta();
    if (ctx.mixer) ctx.mixer.update(dt);
    if (ctx.vrm) ctx.vrm.update(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  tick();

  return ctx;
}

async function loadVrmFromFile(file: File, ctx: PreviewContext): Promise<void> {
  const buf = await file.arrayBuffer();
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  // parse from buffer
  const gltf = await loader.parseAsync(buf, '');
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error('載入的檔案不是有效的 VRM');

  // Clear previous
  if (ctx.vrm) {
    ctx.scene.remove(ctx.vrm.scene);
  }
  ctx.vrm = vrm;
  ctx.scene.add(vrm.scene);
  ctx.mixer = new THREE.AnimationMixer(vrm.scene);
  log(`  VRM 載入成功：${file.name}`, 'success');
  log(`  Humanoid bones: ${Object.keys(vrm.humanoid.normalizedHumanBones).length}`, 'info');
}

async function loadVrmaFromFile(file: File, ctx: PreviewContext): Promise<THREE.AnimationClip> {
  if (!ctx.vrm) throw new Error('請先載入 VRM 模型');

  const buf = await file.arrayBuffer();
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.parseAsync(buf, '');
  const vrmAnims = (gltf.userData.vrmAnimations ?? []) as VRMAnimation[];
  if (vrmAnims.length === 0) {
    throw new Error('載入的 .vrma 沒有 VRM animation 資料（VRMC_vrm_animation extension 可能缺失）');
  }
  const vrmAnim = vrmAnims[0];
  log(`  VRMA 載入成功：${vrmAnims.length} 個 animation`, 'success');

  const clip = createVRMAnimationClip(vrmAnim, ctx.vrm);
  log(`  AnimationClip 建立：${clip.tracks.length} 條 tracks、duration ${clip.duration.toFixed(2)}s`, 'success');
  return clip;
}

// ────────────────────────────────────────────────────────────────
// Wire up UI
// ────────────────────────────────────────────────────────────────

let exportedGlb: ArrayBuffer | null = null;
let loadedVrmaClip: THREE.AnimationClip | null = null;

const previewCanvas = document.getElementById('spike-canvas') as HTMLCanvasElement;
const previewCtx = initPreview(previewCanvas);

const btnExport = document.getElementById('btn-export') as HTMLButtonElement;
const btnDownload = document.getElementById('btn-download') as HTMLButtonElement;
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const fileVrm = document.getElementById('file-vrm') as HTMLInputElement;
const fileVrma = document.getElementById('file-vrma') as HTMLInputElement;

btnExport.addEventListener('click', async () => {
  try {
    log('═══ 開始產出測試 VRMA ═══', 'section');
    log('Step 1: 建 humanoid bone scene...', 'info');
    const { scene } = buildHumanoidScene();
    log(`  建立 ${HUMANOID_SPEC.length} 根 bone`, 'success');

    log('Step 2: 建測試 AnimationClip...', 'info');
    const { bones } = buildHumanoidScene(); // 另建一份用於抓 position
    const clip = buildTestClip(bones);
    log(`  clip tracks: ${clip.tracks.length}, duration: ${clip.duration}s`, 'success');

    log('Step 3: GLTFExporter → glb...', 'info');
    const glb = await exportToGlb(scene, clip);
    log(`  glb 大小: ${glb.byteLength} bytes`, 'success');

    log('Step 4: 注入 VRMC_vrm_animation extension...', 'info');
    const { buffer, nodeMapping } = injectVrmAnimationExtension(glb);
    log(`  重組 glb 大小: ${buffer.byteLength} bytes`, 'success');
    log(`  humanBones 對應數: ${Object.keys(nodeMapping).length}`, 'success');

    exportedGlb = buffer;
    btnDownload.disabled = false;
    log('✓ Spike B Part 1 完成，點「下載 spike-output.vrma」', 'success');
  } catch (err) {
    log(`✗ 錯誤: ${(err as Error).message}`, 'error');
    // eslint-disable-next-line no-console
    console.error(err);
  }
});

btnDownload.addEventListener('click', () => {
  if (!exportedGlb) return;
  downloadBuffer(exportedGlb, 'spike-output.vrma');
  log('已觸發下載 spike-output.vrma', 'info');
});

fileVrm.addEventListener('change', async () => {
  const file = fileVrm.files?.[0];
  if (!file) return;
  try {
    log('═══ 載入 VRM ═══', 'section');
    await loadVrmFromFile(file, previewCtx);
    maybeEnablePlay();
  } catch (err) {
    log(`✗ VRM 載入失敗: ${(err as Error).message}`, 'error');
    // eslint-disable-next-line no-console
    console.error(err);
  }
});

fileVrma.addEventListener('change', async () => {
  const file = fileVrma.files?.[0];
  if (!file) return;
  try {
    log('═══ 載入 VRMA ═══', 'section');
    loadedVrmaClip = await loadVrmaFromFile(file, previewCtx);
    maybeEnablePlay();
  } catch (err) {
    log(`✗ VRMA 載入失敗: ${(err as Error).message}`, 'error');
    // eslint-disable-next-line no-console
    console.error(err);
  }
});

btnPlay.addEventListener('click', () => {
  if (!previewCtx.mixer || !loadedVrmaClip) return;
  if (previewCtx.currentAction) {
    previewCtx.currentAction.stop();
  }
  const action = previewCtx.mixer.clipAction(loadedVrmaClip);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();
  previewCtx.currentAction = action;
  log('▶ 開始播放 VRMA clip（觀察手臂與 hip 是否動起來）', 'success');
});

btnClear.addEventListener('click', () => {
  logEl.innerHTML = '';
});

function maybeEnablePlay(): void {
  btnPlay.disabled = !(previewCtx.vrm && loadedVrmaClip);
}

log('═══ Spike B: VRMA round-trip ═══', 'section');
log('流程：', 'info');
log('  1. 按「產出測試 VRMA」→ 2. 下載檔案', 'info');
log('  3. 載入任意 .vrm → 4. 載入剛下載的 .vrma → 5. 播放驗證', 'info');
log('成功準則：右邊 VRM 的左右上臂搖動、hip 上下搖', 'info');
