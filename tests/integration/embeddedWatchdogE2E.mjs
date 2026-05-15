/**
 * Embedded watchdog E2E — 三層 watchdog（interChunk / reasoning / tokenCap）
 * 在 in-process embedded streaming path 啟用後應該觸發 graceful 收尾。
 *
 * 設計：
 *   - 寫 jsonc 含 watchdog 設定（極短 cap / gap 強制觸發）
 *   - 跑 streaming prompt
 *   - 觀察：應該收到 turnEnd（graceful）+ stderr 含 [llamacpp-watchdog] aborted
 *
 * 三個子測試各自獨立 child process（避免 watchdog state cross-contaminate）：
 *   T1 tokenCap：default cap=50 tokens → 短 prompt 也會被截斷
 *   T2 interChunk：gapMs=200ms + 模型 prefill latency > 200ms → 一定觸發
 *   T3 disabled：watchdog enabled=false → 整段正常完成，無 aborted log
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
const MMPROJ_ABS = resolve(MY_AGENT_REPO, 'models/mmproj-Qwen3.5-9B-F16.gguf')

if (!existsSync(MODEL_ABS)) {
  console.error(`[watchdog] FAIL: GGUF 不存在 ${MODEL_ABS}`)
  process.exit(2)
}

function buildJsonc(watchdog) {
  return `{
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
      "vision": {"mmprojPath": ${JSON.stringify(MMPROJ_ABS)}},
      "binaryKind": "buun"
    },
    "vision": {"enabled": false},
    "watchdog": ${JSON.stringify(watchdog)}
  }`
}

// ── Child process body ────────────────────────────────────────────────────
if (process.env.VAD_WATCHDOG_CHILD === '1') {
  const scenario = process.env.VAD_WATCHDOG_SCENARIO
  const TEMP = join(tmpdir(), `vad-watchdog-${scenario}-${process.pid}-${Date.now()}`)
  mkdirSync(TEMP, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = TEMP
  process.env.MY_AGENT_REMOTE_MEMORY_DIR = TEMP
  process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'

  const watchdog = JSON.parse(process.env.VAD_WATCHDOG_JSON)
  writeFileSync(join(TEMP, 'llamacpp.jsonc'), buildJsonc(watchdog), 'utf-8')

  console.error(`[child:${scenario}] loading agent...`)
  const tLoad = Date.now()
  const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
  const agent = await AgentEmbedded.create({
    cwd: process.cwd(),
    configDir: TEMP,
    skipMcp: true,
    onPreloadProgress: () => {},
  })
  console.error(`[child:${scenario}] ready in ${Date.now() - tLoad}ms`)

  const session = agent.createSession({ source: 'mascot' })
  let turnEnded = false
  let assistantText = ''
  session.on('frame', (f) => {
    if (f.type === 'turnEnd') turnEnded = true
    if (f.type === 'runnerEvent' && f.event?.type === 'output') {
      const p = f.event.payload
      if (p?.type === 'assistant' && Array.isArray(p.message?.content)) {
        for (const b of p.message.content) {
          if (b.type === 'text' && b.text) assistantText += b.text
        }
      }
    }
  })

  await new Promise((r) => setTimeout(r, 30))
  const tSend = Date.now()
  // 兩種 prompt 都會生成 > 50 tokens — tokenCap 必觸發；reasoning 跑 <think> 大量
  // 文字 — 任 watchdog 都會擊中
  session.send(
    scenario === 'tokenCap'
      ? 'Count from 1 to 50 in plain English, one per line. No tools.'
      : 'Think carefully and explain in detail what is 2+2 with reasoning.',
  )

  // 等 90s 上限
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (turnEnded || Date.now() - tSend > 90000) { clearInterval(t); resolve() }
    }, 50)
  })

  const elapsed = Date.now() - tSend
  console.error(`[child:${scenario}] turnEnded=${turnEnded} elapsed=${elapsed}ms textLen=${assistantText.length}`)
  console.error(`[child:${scenario}] textPreview="${assistantText.slice(0, 100).replace(/\n/g, '\\n')}"`)

  try { await session.close() } catch {}
  try { await agent.shutdown?.() } catch {}
  process.exit(0)
}

// ── Parent driver ─────────────────────────────────────────────────────────
function runScenario(name, watchdog) {
  console.log(`\n── ${name} ─────────────────────────`)
  console.log(`watchdog config: ${JSON.stringify(watchdog)}`)
  const tStart = Date.now()
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname.slice(1)], {
    env: {
      ...process.env,
      VAD_WATCHDOG_CHILD: '1',
      VAD_WATCHDOG_SCENARIO: name,
      VAD_WATCHDOG_JSON: JSON.stringify(watchdog),
    },
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 32,
  })
  const elapsed = Date.now() - tStart
  const stderr = child.stderr ?? ''
  const watchdogLog = stderr.split('\n').filter((l) => l.includes('[llamacpp-watchdog]'))
  const lastLine = stderr.split('\n').filter((l) => l.includes(`[child:${name}]`)).slice(-2)

  return {
    name,
    elapsedMs: elapsed,
    exit: child.status,
    watchdogTriggered: watchdogLog.length > 0,
    watchdogLog,
    childSummary: lastLine,
  }
}

const results = []

// T1: tokenCap — default cap 50 tokens
results.push(runScenario('tokenCap', {
  enabled: true,
  tokenCap: { enabled: true, default: 50, memoryPrefetch: 50, sideQuery: 50, background: 50 },
}))

// T2: interChunk — gap 100ms（Qwen prefill > 1s 一定觸發）
results.push(runScenario('interChunk', {
  enabled: true,
  interChunk: { enabled: true, gapMs: 100 },
}))

// T3: disabled — watchdog 全關，無 abort log
results.push(runScenario('disabled', {
  enabled: false,
}))

console.log(`\n══════════════════════════════════════════════════════`)
console.log(`            WATCHDOG E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
let allPass = true
for (const r of results) {
  const expectTrigger = r.name !== 'disabled'
  const ok = r.watchdogTriggered === expectTrigger
  if (!ok) allPass = false
  console.log(`\n[${r.name}] ${ok ? 'PASS' : 'FAIL'} elapsed=${r.elapsedMs}ms exit=${r.exit}`)
  console.log(`  expected trigger=${expectTrigger}, actual=${r.watchdogTriggered}`)
  for (const ln of r.watchdogLog.slice(0, 2)) console.log(`  ${ln.trim()}`)
  for (const ln of r.childSummary) console.log(`  ${ln.trim()}`)
}
console.log(`\nOverall: ${allPass ? 'PASS' : 'FAIL'}\n`)
process.exit(allPass ? 0 : 1)
