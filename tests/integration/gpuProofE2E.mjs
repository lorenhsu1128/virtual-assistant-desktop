/**
 * GPU 使用率證明 — 在 LLM inference 進行中採樣 nvidia-smi，確認 GPU 真有運算。
 *
 * 採樣策略：
 *  1. 起動 nvidia-smi pmon -i 0 -d 1 子進程（每秒一筆 GPU compute %）
 *  2. 紀錄 baseline（model 未載入前）
 *  3. AgentEmbedded.create 載入 model → 紀錄 VRAM 增量
 *  4. session.send 觸發 inference → 採樣這段時間的 GPU util 峰值
 *  5. shutdown → 確認 VRAM 釋放
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'

const MY_AGENT_REPO = 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
const MMPROJ_ABS = resolve(MY_AGENT_REPO, 'models/mmproj-Qwen3.5-9B-F16.gguf')

const TEMP = join(tmpdir(), `vad-gpuproof-${process.pid}-${Date.now()}`)
mkdirSync(TEMP, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = TEMP
// loader 讀 ~/.virtual-assistant-desktop/llamacpp.jsonc，但 getMemoryBaseDir
// 認的是 MY_AGENT_REMOTE_MEMORY_DIR — 用此 env 把測試導向 TEMP。
process.env.MY_AGENT_REMOTE_MEMORY_DIR = TEMP
process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'

// 完整 extraArgs 模擬使用者 jsonc — 驗證 client.ts parseServerExtraArgs +
// embedded ensureSession 端到端把 turbo4 / batch / threads / flashAttn / noMmap
// 全部送到 tcq-shim ensureSession（與 HTTP server 路徑完全一致）。
writeFileSync(
  join(TEMP, 'llamacpp.jsonc'),
  `{
    "baseUrl": "http://127.0.0.1:8081/v1",
    "model": "qwen3.5-9b",
    "contextSize": 131072,
    "autoCompactBufferTokens": 4000,
    "debug": false,
    "modelAliases": ["qwen3.5-9b"],
    "server": {
      "host": "127.0.0.1", "port": 8081, "ctxSize": 131072, "gpuLayers": 99,
      "modelPath": ${JSON.stringify(MODEL_ABS)}, "alias": "qwen3.5-9b",
      "binaryPath": ${JSON.stringify(resolve(MY_AGENT_REPO, 'buun-llama-cpp/build/bin/Release/llama-server.exe'))},
      "extraArgs": [
        "--flash-attn", "on",
        "--cache-type-k", "turbo4",
        "--cache-type-v", "turbo4",
        "-b", "2048",
        "-ub", "512",
        "--threads", "12",
        "--threads-batch", "12",
        "--no-mmap"
      ],
      "vision": {"mmprojPath": ${JSON.stringify(MMPROJ_ABS)}},
      "binaryKind": "buun"
    },
    "vision": {"enabled": false}
  }`,
  'utf-8',
)

function gpuQuery() {
  const out = execSync(
    'nvidia-smi --query-gpu=memory.used,utilization.gpu,utilization.memory --format=csv,noheader,nounits',
    { encoding: 'utf8' },
  ).trim()
  const [mem, util, memUtil] = out.split(',').map((s) => parseInt(s.trim(), 10))
  return { mem, util, memUtil }
}

// ── 採樣器 ─────────────────────────────────────────────────────────────
const samples = []
let sampling = true
async function sampler() {
  while (sampling) {
    try {
      const s = gpuQuery()
      samples.push({ t: Date.now(), ...s })
    } catch (e) {/* ignore */}
    await new Promise((r) => setTimeout(r, 250))
  }
}
sampler() // fire-and-forget

const t0 = Date.now()
function dt() { return ((Date.now() - t0) / 1000).toFixed(1) + 's' }

console.log(`[gpu-proof] ${dt()} baseline GPU:`, gpuQuery())

// ── 載入 AgentEmbedded ─────────────────────────────────────────────────
console.log(`[gpu-proof] ${dt()} 載入 AgentEmbedded...`)
const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')

const tLoad = Date.now()
const agent = await AgentEmbedded.create({
  cwd: process.cwd(),
  configDir: TEMP,
  extraTools: [],
  skipMcp: true,
  onPreloadProgress: () => {},
})
console.log(`[gpu-proof] ${dt()} AgentEmbedded ready in ${Date.now() - tLoad}ms`)
console.log(`[gpu-proof] ${dt()} post-load GPU:`, gpuQuery())

// ── 跑一個 turn ────────────────────────────────────────────────────────
const session = agent.createSession({ source: 'mascot' })
let turnEnded = false
session.on('frame', (f) => {
  if (f.type === 'turnEnd') turnEnded = true
})
await new Promise((r) => setTimeout(r, 30))

console.log(`[gpu-proof] ${dt()} sending prompt → 推論開始...`)
const tInferStart = Date.now()
session.send('Write a short haiku about CUDA GPUs in exactly 3 lines.')

while (!turnEnded && Date.now() - tInferStart < 60000) {
  await new Promise((r) => setTimeout(r, 200))
}
const tInferEnd = Date.now()
console.log(`[gpu-proof] ${dt()} 推論結束 in ${tInferEnd - tInferStart}ms (turnEnded=${turnEnded})`)

// ── 停採樣 + 分析 ─────────────────────────────────────────────────────
sampling = false
await new Promise((r) => setTimeout(r, 400))

const inferSamples = samples.filter((s) => s.t >= tInferStart && s.t <= tInferEnd)
const utilPeak = Math.max(0, ...inferSamples.map((s) => s.util))
const utilAvg = inferSamples.length
  ? inferSamples.reduce((a, b) => a + b.util, 0) / inferSamples.length
  : 0
const memPeak = Math.max(0, ...inferSamples.map((s) => s.mem))

console.log(`\n══════════════════════════════════════`)
console.log(`            GPU PROOF REPORT`)
console.log(`══════════════════════════════════════`)
console.log(`Inference window samples: ${inferSamples.length} (250ms cadence)`)
console.log(`GPU compute util peak:   ${utilPeak}%`)
console.log(`GPU compute util avg:    ${utilAvg.toFixed(1)}%`)
console.log(`VRAM peak during infer:  ${memPeak} MiB`)
console.log(`VRAM at idle (baseline): ${samples[0]?.mem ?? '?'} MiB`)
console.log('')
console.log(`Samples 摘要（顯示 util > 0% 的所有採樣點）:`)
const nonZero = inferSamples.filter((s) => s.util > 0)
console.log(`  ${nonZero.length} / ${inferSamples.length} 樣本含 GPU 計算（util > 0）`)
if (nonZero.length > 0) {
  const first5 = nonZero.slice(0, 5)
  for (const s of first5) {
    console.log(`  +${((s.t - tInferStart) / 1000).toFixed(1)}s util=${s.util}% mem=${s.mem}MiB`)
  }
  if (nonZero.length > 5) console.log(`  ... 還有 ${nonZero.length - 5} 個樣本`)
}

const verdict =
  utilPeak >= 30 ? '✅ GPU 確實有運算' :
  utilPeak >= 5 ? '⚠️ GPU 有用但峰值偏低（可能瓶頸在 IO）' :
  '❌ GPU util 全程 < 5%，可能跑在 CPU'
console.log(`\nVerdict: ${verdict}\n`)

// ── shutdown + 確認 VRAM 釋放 ─────────────────────────────────────────
try { await session.close() } catch {}
await agent.shutdown()
await new Promise((r) => setTimeout(r, 1000))
console.log(`[gpu-proof] ${dt()} shutdown 後 GPU:`, gpuQuery())

process.exit(utilPeak < 5 ? 1 : 0)
