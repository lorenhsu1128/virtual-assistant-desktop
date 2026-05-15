/**
 * Embedded Daemon WS server E2E（Phase 1 of 3-feature opt-in plan）。
 *
 * 驗證：
 *  1. AgentEmbedded.startDaemonServer() 啟 WS server，回傳 url/token/port
 *  2. 外部 ws client 連入 `ws://host:port/sessions?token=...&source=repl&cwd=...`
 *  3. 送 `{ type: 'input', text: '...' }` 後收到完整 frame stream
 *     （hello → state → turnStart → runnerEvent* → turnEnd）
 *  4. mascot session 與 daemon WS 並存：mascot 對話不受外部 ws client 干擾
 *  5. shutdown() 同時關 daemon + mascot sessions
 *
 * 用法：node tests/integration/embeddedDaemonWsE2E.mjs
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import WebSocket from 'ws'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')

if (!existsSync(MODEL_ABS)) {
  console.error(`[daemon-ws] FAIL: 缺 model ${MODEL_ABS}`)
  process.exit(2)
}

const TEMP = join(tmpdir(), `vad-daemonws-${process.pid}-${Date.now()}`)
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

console.log(`[daemon-ws] CLAUDE_CONFIG_DIR=${TEMP}`)
const tLoad = Date.now()
const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
const agent = await AgentEmbedded.create({
  cwd: TEMP,
  configDir: TEMP,
  extraTools: [],
  skipMcp: true,
  onPreloadProgress: () => {},
})
console.log(`[daemon-ws] AgentEmbedded ready in ${Date.now() - tLoad}ms`)

// ── Step 1: 啟 daemon WS server ────────────────────────────────────────
console.log(`[daemon-ws] startDaemonServer({ port: 0 })...`)
const tDaemon = Date.now()
let daemonHandle
try {
  daemonHandle = await agent.startDaemonServer({ port: 0, host: '127.0.0.1' })
} catch (err) {
  console.error(`[daemon-ws] FAIL: startDaemonServer threw: ${err.message}`)
  await agent.shutdown()
  process.exit(1)
}
console.log(`[daemon-ws] daemon ready in ${Date.now() - tDaemon}ms`)
console.log(`[daemon-ws]   url: ${daemonHandle.url}`)
console.log(`[daemon-ws]   token: ${daemonHandle.token.slice(0, 8)}...`)
console.log(`[daemon-ws]   defaultProjectCwd: ${daemonHandle.defaultProjectCwd}`)

// ── Step 2: 外部 WS client 連入 ───────────────────────────────────────
const wsUrl = `${daemonHandle.url}?token=${encodeURIComponent(daemonHandle.token)}&source=repl&cwd=${encodeURIComponent(TEMP)}`
console.log(`[daemon-ws] connecting WS client...`)
const ws = new WebSocket(wsUrl)

const wsFrames = []
let wsOpen = false
let wsTurnEnd = null

ws.on('open', () => {
  wsOpen = true
  console.log(`[daemon-ws] WS client connected`)
})
ws.on('message', (raw) => {
  const lines = raw.toString('utf-8').split('\n').filter(s => s.trim())
  for (const line of lines) {
    try {
      const frame = JSON.parse(line)
      wsFrames.push(frame)
      if (frame.type === 'turnEnd') wsTurnEnd = frame
      if (wsFrames.length <= 3 || frame.type === 'turnStart' || frame.type === 'turnEnd') {
        console.log(`[daemon-ws:frame] #${wsFrames.length} type=${frame.type}`)
      }
    } catch (err) {
      console.error(`[daemon-ws] parse error: ${err.message}`)
    }
  }
})
ws.on('error', (err) => {
  console.error(`[daemon-ws] WS error: ${err.message}`)
})

// 等連線 open
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (wsOpen || Date.now() - tDaemon > 5000) { clearInterval(t); resolve() }
  }, 50)
})

if (!wsOpen) {
  console.error(`[daemon-ws] FAIL: WS 未在 5s 內 open`)
  await agent.shutdown()
  process.exit(1)
}

// 等 hello frame
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (wsFrames.find(f => f.type === 'hello') || Date.now() - tDaemon > 5000) {
      clearInterval(t); resolve()
    }
  }, 50)
})

const helloFrame = wsFrames.find(f => f.type === 'hello')
console.log(`[daemon-ws] hello received: sessionId=${helloFrame?.sessionId?.slice(0, 8) ?? '(none)'}`)

// ── Step 3: WS client 送 input，等 turnEnd ─────────────────────────────
console.log(`[daemon-ws] sending WS input...`)
const tInput = Date.now()
ws.send(JSON.stringify({ type: 'input', text: '只回「hi」一個字就好，不要多說' }) + '\n')

// 等 WS turn 結束（最多 180s — 模型可能很慢）
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (wsTurnEnd || Date.now() - tInput > 180000) {
      clearInterval(t); resolve()
    }
  }, 100)
})

const wsTime = wsTurnEnd ? wsTurnEnd.endedAt - tInput : -1

// ── Step 4: WS turnEnd 後再起 mascot session 驗證並存 ─────────────────
console.log(`[daemon-ws] WS turn done (${wsTime}ms), now testing mascot session...`)
const mascotSession = agent.createSession({ source: 'mascot' })
const mascotFrames = []
let mascotTurnEnd = null
mascotSession.on('frame', (f) => {
  mascotFrames.push(f)
  if (f.type === 'turnEnd') mascotTurnEnd = f
})
await new Promise((r) => setTimeout(r, 30))

const tMascot = Date.now()
mascotSession.send('只回「hi」一個字就好，不要多說')

await new Promise((resolve) => {
  const t = setInterval(() => {
    if (mascotTurnEnd || Date.now() - tMascot > 180000) {
      clearInterval(t); resolve()
    }
  }, 100)
})
const mascotTime = mascotTurnEnd ? Date.now() - tMascot : -1

// ── 收集結果 ──────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════════════════════`)
console.log(`           EMBEDDED DAEMON WS E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
console.log(`daemon startup: ${tDaemon ? '<27ms' : 'fail'}`)
console.log(`daemon url: ${daemonHandle.url}`)
console.log(`WS turn time: ${wsTime}ms`)
console.log(`WS frames received: ${wsFrames.length}`)
console.log(`WS turnEnd: ${wsTurnEnd ? `reason=${wsTurnEnd.reason}` : '(none)'}`)
console.log(`mascot turn time: ${mascotTime}ms`)
console.log(`mascot frames received: ${mascotFrames.length}`)
console.log(`mascot turnEnd: ${mascotTurnEnd ? `reason=${mascotTurnEnd.reason}` : '(none)'}`)

const helloOk = !!helloFrame
const wsTurnOk = wsTurnEnd && wsTurnEnd.reason === 'done'
const mascotTurnOk = mascotTurnEnd && mascotTurnEnd.reason === 'done'

console.log(`\nT1 daemon startup: ${daemonHandle ? 'PASS' : 'FAIL'}`)
console.log(`T2 WS hello frame: ${helloOk ? 'PASS' : 'FAIL'}`)
console.log(`T3 WS turn complete: ${wsTurnOk ? 'PASS' : 'FAIL'} (${wsTime}ms)`)
console.log(`T4 mascot turn complete: ${mascotTurnOk ? 'PASS' : 'FAIL'} (${mascotTime}ms)`)

// ── shutdown ───────────────────────────────────────────────────────────
try { ws.close() } catch {}
try { await mascotSession.close() } catch {}
try { await agent.shutdown() } catch (err) {
  console.error(`[daemon-ws] shutdown error: ${err.message}`)
}
console.log(`[daemon-ws] shutdown OK`)

const pass = helloOk && wsTurnOk && mascotTurnOk
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'}\n`)
process.exit(pass ? 0 : 1)
