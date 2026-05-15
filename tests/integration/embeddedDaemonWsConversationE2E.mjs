/**
 * 外部 WS client 完整對話 — 模擬 my-agent CLI / 第二個視窗連入 daemon WS，
 * 送 input → 收到 turnStart → 收到 LLM 回應 → turnEnd done。
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import WebSocket from 'ws'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
if (!existsSync(MODEL_ABS)) { console.error(`[ws-conv] FAIL: 缺 model`); process.exit(2) }

const TEMP = join(tmpdir(), `vad-wsconv-${process.pid}-${Date.now()}`)
mkdirSync(TEMP, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = TEMP
process.env.MY_AGENT_REMOTE_MEMORY_DIR = TEMP
process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'

writeFileSync(join(TEMP, 'llamacpp.jsonc'),
  `{"baseUrl":"http://127.0.0.1:8081/v1","model":"qwen3.5-9b","contextSize":131072,"debug":false,"modelAliases":["qwen3.5-9b"],"server":{"host":"127.0.0.1","port":8081,"ctxSize":131072,"gpuLayers":99,"modelPath":${JSON.stringify(MODEL_ABS)},"alias":"qwen3.5-9b","binaryPath":${JSON.stringify(resolve(MY_AGENT_REPO,'buun-llama-cpp/build/bin/Release/llama-server.exe'))},"extraArgs":["--flash-attn","on","--cache-type-k","turbo4","--cache-type-v","turbo4","-b","2048","-ub","512","--threads","12","--no-mmap"],"binaryKind":"buun"}}`, 'utf-8')

const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
const agent = await AgentEmbedded.create({
  cwd: TEMP, configDir: TEMP, extraTools: [], skipMcp: true,
  canUseTool: async (_, input) => ({ behavior: 'allow', updatedInput: input }),
  onPreloadProgress: () => {},
})
const daemon = await agent.startDaemonServer({ port: 0, host: '127.0.0.1' })

const wsUrl = `${daemon.url}?token=${encodeURIComponent(daemon.token)}&source=repl&cwd=${encodeURIComponent(TEMP)}`
const frames = []
let hello = null, turnStart = null, turnEnd = null
let textChunks = 0
let totalTextLen = 0

const ws = new WebSocket(wsUrl)
// 先註冊 message handler 才 await open — 避免 hello 在 open 與 register 之間丟掉
ws.on('message', (raw) => {
  for (const line of raw.toString('utf-8').split('\n').filter(s => s.trim())) {
    try {
      const f = JSON.parse(line)
      frames.push(f)
      if (f.type === 'hello') hello = f
      if (f.type === 'turnStart') turnStart = f
      if (f.type === 'turnEnd') turnEnd = f
      if (f.type === 'runnerEvent' && f.event?.type === 'output') {
        const p = f.event.payload
        if (p?.type === 'assistant' && Array.isArray(p.message?.content)) {
          for (const b of p.message.content) {
            if (b.type === 'text' && b.text) { textChunks++; totalTextLen += b.text.length }
          }
        }
      }
    } catch {}
  }
})

// 等 open
await new Promise(r => ws.on('open', () => r()))

// 等 hello（最多 5s）
const tHello = Date.now()
await new Promise(r => {
  const t = setInterval(() => {
    if (hello || Date.now() - tHello > 5000) { clearInterval(t); r() }
  }, 50)
})
if (!hello) {
  console.error('[ws-conv] FAIL: 5s 內沒收到 hello')
  try { ws.close() } catch {}
  try { await agent.shutdown?.() } catch {}
  process.exit(1)
}

// 送 input frame（NDJSON 結尾要換行）
ws.send(JSON.stringify({ type: 'input', text: '只回「hi」一個字就好，別多說' }) + '\n')

const tStart = Date.now()
await new Promise(r => {
  const t = setInterval(() => { if (turnEnd || Date.now() - tStart > 180000) { clearInterval(t); r() } }, 100)
})
const elapsed = Date.now() - tStart

try { ws.close() } catch {}
try { await agent.shutdown?.() } catch {}

console.log(`\n══════════════════════════════════════════════════════`)
console.log(`     EXTERNAL WS CLIENT CONVERSATION E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
console.log(`hello: sessionId=${hello?.sessionId?.slice(0, 8) ?? '(none)'}`)
console.log(`turnStart: inputId=${turnStart?.inputId?.slice(0, 8) ?? '(none)'} source=${turnStart?.source}`)
console.log(`turnEnd: reason=${turnEnd?.reason ?? '(none)'} elapsed=${elapsed}ms`)
console.log(`text chunks: ${textChunks}, total ${totalTextLen} chars`)
console.log(`total frames: ${frames.length}`)

const t1 = !!hello
const t2 = !!turnStart && turnStart.source === 'repl'
const t3 = turnEnd?.reason === 'done'
const t4 = totalTextLen > 0  // 真的有 LLM 回應
const t5 = elapsed < 180000

console.log(`\nT1 收到 hello frame:           ${t1 ? 'PASS' : 'FAIL'}`)
console.log(`T2 turnStart source=repl:      ${t2 ? 'PASS' : 'FAIL'}`)
console.log(`T3 turnEnd reason=done:        ${t3 ? 'PASS' : 'FAIL'}`)
console.log(`T4 LLM 有文字回應:             ${t4 ? 'PASS' : 'FAIL'}`)
console.log(`T5 完成在 180s 內:             ${t5 ? 'PASS' : 'FAIL'}`)

const pass = t1 && t2 && t3 && t4 && t5
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'}\n`)
process.exit(pass ? 0 : 1)
