/**
 * Reload cycle — shutdown → 重新 create AgentEmbedded → 對話正常。
 * 模擬桌寵 master toggle OFF → ON 後 LLM 應該完全重新可用。
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
if (!existsSync(MODEL_ABS)) { console.error(`[reload] FAIL: 缺 model`); process.exit(2) }

const TEMP = join(tmpdir(), `vad-reload-${process.pid}-${Date.now()}`)
mkdirSync(TEMP, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = TEMP
process.env.MY_AGENT_REMOTE_MEMORY_DIR = TEMP
process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'

writeFileSync(join(TEMP, 'llamacpp.jsonc'),
  `{"baseUrl":"http://127.0.0.1:8081/v1","model":"qwen3.5-9b","contextSize":131072,"debug":false,"modelAliases":["qwen3.5-9b"],"server":{"host":"127.0.0.1","port":8081,"ctxSize":131072,"gpuLayers":99,"modelPath":${JSON.stringify(MODEL_ABS)},"alias":"qwen3.5-9b","binaryPath":${JSON.stringify(resolve(MY_AGENT_REPO,'buun-llama-cpp/build/bin/Release/llama-server.exe'))},"extraArgs":["--flash-attn","on","--cache-type-k","turbo4","--cache-type-v","turbo4","-b","2048","-ub","512","--threads","12","--no-mmap"],"binaryKind":"buun"}}`, 'utf-8')

const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')

async function runOnceAndShutdown(label) {
  const t0 = Date.now()
  const agent = await AgentEmbedded.create({
    cwd: TEMP, configDir: TEMP, extraTools: [], skipMcp: true,
    canUseTool: async (_, input) => ({ behavior: 'allow', updatedInput: input }),
    onPreloadProgress: () => {},
  })
  const loadMs = Date.now() - t0
  // 也起 daemon WS 驗證服務也能重啟
  const daemon = await agent.startDaemonServer({ port: 0, host: '127.0.0.1' })
  const webUi = await agent.startWebUi({ port: 0, bindHost: '127.0.0.1' })
  // 立刻 snapshot port — webUi.port 是 getter，shutdown 後會回 null
  const daemonPort = daemon.port
  const webPort = webUi.port

  // 一個快速對話
  const session = agent.createSession({ source: 'mascot' })
  let turnEnd = null
  const texts = []
  session.on('frame', (f) => {
    if (f.type === 'runnerEvent' && f.event?.type === 'output') {
      const p = f.event.payload
      if (p?.type === 'assistant' && Array.isArray(p.message?.content)) {
        for (const b of p.message.content) if (b.type === 'text') texts.push(b.text)
      }
    }
    if (f.type === 'turnEnd') turnEnd = f
  })
  await new Promise(r => setTimeout(r, 30))
  session.send('只回「hi」一個字就好')
  const tStart = Date.now()
  await new Promise(r => {
    const i = setInterval(() => { if (turnEnd || Date.now() - tStart > 180000) { clearInterval(i); r() } }, 100)
  })
  const turnMs = Date.now() - tStart
  const turnOk = turnEnd?.reason === 'done'

  const tShutdown = Date.now()
  try { await session.close() } catch {}
  try { await agent.shutdown?.() } catch {}
  const shutdownMs = Date.now() - tShutdown

  console.log(`[reload] ${label}: load=${loadMs}ms turn=${turnMs}ms(${turnOk ? 'done' : turnEnd?.reason ?? 'NONE'}) shutdown=${shutdownMs}ms daemon=${daemonPort} web=${webPort}`)
  return { loadMs, turnMs, turnOk, shutdownMs, daemonPort, webPort }
}

console.log('[reload] === Cycle 1: 第一次啟動 ===')
const c1 = await runOnceAndShutdown('cycle1')

console.log('[reload] === Cycle 2: 重新啟動（模擬 master OFF→ON） ===')
const c2 = await runOnceAndShutdown('cycle2')

console.log('[reload] === Cycle 3: 第三次啟動（壓力測試） ===')
const c3 = await runOnceAndShutdown('cycle3')

console.log(`\n══════════════════════════════════════════════════════`)
console.log(`           RELOAD CYCLE E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
const cycles = [c1, c2, c3]
for (let i = 0; i < 3; i++) {
  const c = cycles[i]
  console.log(`  Cycle ${i + 1}: load=${c.loadMs}ms turn=${c.turnOk ? 'OK' : 'FAIL'}(${c.turnMs}ms) shutdown=${c.shutdownMs}ms`)
}

const t1 = cycles.every(c => c.turnOk)
const t2 = cycles.every(c => c.shutdownMs < 5000)  // shutdown < 5s
const t3 = cycles.every(c => c.daemonPort > 0 && c.webPort > 0)  // 服務都成功 bind

console.log(`\nT1 三 cycle 對話都 done:       ${t1 ? 'PASS' : 'FAIL'}`)
console.log(`T2 三 cycle shutdown < 5s:     ${t2 ? 'PASS' : 'FAIL'}`)
console.log(`T3 三 cycle 服務 port 都 bind: ${t3 ? 'PASS' : 'FAIL'}`)

const pass = t1 && t2 && t3
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'}\n`)
process.exit(pass ? 0 : 1)
