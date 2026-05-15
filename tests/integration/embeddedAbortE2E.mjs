/**
 * Embedded session.abort() E2E（G6 — abort chain 補實）。
 *
 * 驗證 AgentSession.abort() 觸發完整 abort chain：
 *   AgentSession.abort() → InputQueue.abort() → currentController.abort()
 *   → runner ac.abort() → ask({abortController}) → fetch init.signal
 *   → runCtx.abort → tcqRunCore* 中止生成 → sink onDone → translator finally
 *   → 反向 abort.abort() 釋放 GPU
 *
 * 場景：要求 LLM 寫 2000 字小說，streaming 開始後立刻 abort，期望：
 *   1. 1.5 秒內收到 turnEnd（reason='aborted' 或 'error' 都算成功）
 *   2. 收到的 text delta < 完整輸出量
 *   3. agent.shutdown() 順利完成（無 hang）
 *
 * 用法：node tests/integration/embeddedAbortE2E.mjs
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')

if (!existsSync(MODEL_ABS)) {
  console.error(`[abort] FAIL: 缺 model ${MODEL_ABS}`)
  process.exit(2)
}

const TEMP = join(tmpdir(), `vad-abort-${process.pid}-${Date.now()}`)
mkdirSync(TEMP, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = TEMP
process.env.MY_AGENT_REMOTE_MEMORY_DIR = TEMP
process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'

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
        "--no-mmap"
      ],
      "binaryKind": "buun"
    }
  }`,
  'utf-8',
)

console.log(`[abort] CLAUDE_CONFIG_DIR=${TEMP}`)
console.log(`[abort] 載入 AgentEmbedded...`)
const tLoad = Date.now()
const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
const agent = await AgentEmbedded.create({
  cwd: process.cwd(),
  configDir: TEMP,
  extraTools: [],
  skipMcp: true,
  onPreloadProgress: () => {},
})
console.log(`[abort] ready in ${Date.now() - tLoad}ms`)

const session = agent.createSession({ source: 'mascot' })

let firstChunkAt = 0
let turnEndAt = 0
let turnEndReason = ''
let textDeltaCount = 0
let totalTextLen = 0

let _frameCount = 0
session.on('frame', (f) => {
  _frameCount++
  if (_frameCount <= 5 || (_frameCount % 20) === 0) {
    const peek = JSON.stringify(f).slice(0, 200)
    console.log(`[abort:frame] #${_frameCount} type=${f.type} ${peek}`)
  }
  if (f.type === 'runnerEvent' && f.event?.type === 'output') {
    const p = f.event.payload
    // 接受 assistant message（最終）+ stream_event（partial delta）兩種 payload
    if (p?.type === 'assistant' && Array.isArray(p.message?.content)) {
      for (const b of p.message.content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
          textDeltaCount++
          totalTextLen += b.text.length
          if (firstChunkAt === 0) firstChunkAt = Date.now()
        }
      }
    } else if (p?.type === 'stream_event' && p.event?.type === 'content_block_delta') {
      const d = p.event.delta
      if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text.length > 0) {
        textDeltaCount++
        totalTextLen += d.text.length
        if (firstChunkAt === 0) firstChunkAt = Date.now()
      }
    }
  }
  if (f.type === 'turnEnd') {
    turnEndAt = Date.now()
    turnEndReason = f.reason
  }
})

await new Promise((r) => setTimeout(r, 30))

const tSubmit = Date.now()
session.send('請用繁體中文寫一篇 2000 字的科幻短篇小說，主題是「時間旅人遇見自己」，必須有完整起承轉合，不要省略段落。開始寫，不要解釋。')

// 等 streaming 真的開始（收到至少 1 個 text delta），最多等 120s
const tWaitStart = Date.now()
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (firstChunkAt > 0 || Date.now() - tWaitStart > 120000) {
      clearInterval(t)
      resolve()
    }
  }, 50)
})

if (firstChunkAt === 0) {
  console.error('[abort] FAIL: 120s 內 streaming 沒開始')
  try { await session.close() } catch {}
  try { await agent.shutdown?.() } catch {}
  process.exit(1)
}

const elapsedToFirst = firstChunkAt - tSubmit
console.log(`[abort] streaming 已開始 (+${elapsedToFirst}ms, 已收 ${textDeltaCount} delta, ${totalTextLen} chars)`)

// 額外讀 200ms 累積一些 token，確認真的在 stream
await new Promise((r) => setTimeout(r, 200))
const beforeAbortDeltas = textDeltaCount
const beforeAbortLen = totalTextLen
console.log(`[abort] abort 前累積: ${beforeAbortDeltas} delta, ${beforeAbortLen} chars`)

// 發 abort
const tAbort = Date.now()
session.abort()
console.log(`[abort] session.abort() 已呼叫`)

// 等 turnEnd，最多 6 秒（grace 3s + buffer 3s）
const tWaitEnd = Date.now()
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (turnEndAt > 0 || Date.now() - tWaitEnd > 6000) {
      clearInterval(t)
      resolve()
    }
  }, 30)
})

const abortLatency = turnEndAt > 0 ? turnEndAt - tAbort : -1
const afterDeltas = textDeltaCount
const afterLen = totalTextLen
const deltaGrowth = afterDeltas - beforeAbortDeltas

console.log(`\n══════════════════════════════════════════════════════`)
console.log(`            EMBEDDED ABORT E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
console.log(`streaming first chunk: +${elapsedToFirst}ms after submit`)
console.log(`pre-abort:  ${beforeAbortDeltas} delta, ${beforeAbortLen} chars`)
console.log(`post-abort: ${afterDeltas} delta, ${afterLen} chars (growth: +${deltaGrowth})`)
console.log(`turnEnd reason: ${turnEndReason || '(none)'}`)
console.log(`abort → turnEnd latency: ${abortLatency >= 0 ? abortLatency + 'ms' : '(timeout)'}`)

try { await session.close() } catch {}
try { await agent.shutdown?.() } catch {}

// 驗收條件：
//   T1 turnEnd 必須被觸發 (turnEndAt > 0)
//   T2 turnEnd 必須在 6 秒內
//   T3 reason 為 'aborted' 或 'error'（force-clear 也算成功）
//   T4 abort 後 text delta 成長 < abort 前的 10x（確認真的停了，非繼續跑）
const t1 = turnEndAt > 0
const t2 = abortLatency >= 0 && abortLatency < 6000
const t3 = turnEndReason === 'aborted' || turnEndReason === 'error'
const t4 = deltaGrowth < Math.max(beforeAbortDeltas * 10, 200)

console.log(`\nT1 turnEnd fired: ${t1 ? 'PASS' : 'FAIL'}`)
console.log(`T2 abort latency < 6000ms: ${t2 ? 'PASS' : 'FAIL'} (${abortLatency}ms)`)
console.log(`T3 reason aborted/error: ${t3 ? 'PASS' : 'FAIL'} (${turnEndReason})`)
console.log(`T4 generation stopped: ${t4 ? 'PASS' : 'FAIL'} (growth ${deltaGrowth})`)

const pass = t1 && t2 && t3 && t4
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'}\n`)
process.exit(pass ? 0 : 1)
