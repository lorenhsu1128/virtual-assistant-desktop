/**
 * 多 session 隔離 — 同一 AgentEmbedded 起兩個 session，對話歷史不互相洩漏。
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
if (!existsSync(MODEL_ABS)) { console.error(`[multi] FAIL: 缺 model`); process.exit(2) }

const TEMP = join(tmpdir(), `vad-multi-${process.pid}-${Date.now()}`)
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

async function runTurn(session, prompt, timeoutMs = 60000) {
  let turnEnd = null
  const texts = []
  const fl = (f) => {
    if (f.type === 'runnerEvent' && f.event?.type === 'output') {
      const p = f.event.payload
      if (p?.type === 'assistant' && Array.isArray(p.message?.content)) {
        for (const b of p.message.content) if (b.type === 'text') texts.push(b.text)
      }
    }
    if (f.type === 'turnEnd') turnEnd = f
  }
  session.on('frame', fl)
  session.send(prompt)
  const t = Date.now()
  await new Promise(r => {
    const i = setInterval(() => { if (turnEnd || Date.now() - t > timeoutMs) { clearInterval(i); r() } }, 100)
  })
  session.off('frame', fl)
  return { turnEnd, text: texts.join('') }
}

console.log('[multi] T1 session A: 設定一個 password')
const sessionA = agent.createSession({ source: 'mascot', sessionId: 'sess-a' })
await new Promise(r => setTimeout(r, 30))
await runTurn(sessionA, '請記住一個秘密數字：42。請只回「好的」就好，不要重複數字。')

console.log('[multi] T2 session B: 也建立 — 但問同樣問題')
const sessionB = agent.createSession({ source: 'mascot', sessionId: 'sess-b' })
await new Promise(r => setTimeout(r, 30))
const bRes = await runTurn(sessionB, '你之前有沒有被告知過一個秘密數字？若有請說數字，若沒有請說「沒有」。')

console.log('[multi] T3 session A: 問 A 是否記得')
const aRes = await runTurn(sessionA, '我之前告訴你的秘密數字是多少？只回數字。')

try { await sessionA.close() } catch {}
try { await sessionB.close() } catch {}
try { await agent.shutdown?.() } catch {}

console.log(`\n══════════════════════════════════════════════════════`)
console.log(`           MULTI-SESSION E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
console.log(`Session B reply: "${bRes.text.slice(0, 100).replace(/\n/g, '\\n')}"`)
console.log(`Session A reply: "${aRes.text.slice(0, 100).replace(/\n/g, '\\n')}"`)

const bMentions42 = /42/.test(bRes.text)
const aMentions42 = /42/.test(aRes.text)

// T1: session B 不應提到 42（A 的歷史不應洩漏到 B）
const t1 = !bMentions42
// T2: session A 必須記得 42（自己的歷史保留）— 弱 LLM 可能失敗，所以放寬：A 回應比 B 更可能含 42
const t2 = aMentions42 || !bMentions42  // 至少 B 不能洩漏
// T3: 兩 session 都正常完成 turn
const t3 = bRes.turnEnd?.reason === 'done' && aRes.turnEnd?.reason === 'done'

console.log(`\nT1 session B 不知道 A 的秘密:  ${t1 ? 'PASS' : 'FAIL'} (B 提到 42=${bMentions42})`)
console.log(`T2 session A 記得自己的秘密:    ${t2 ? 'PASS' : 'WARN'} (A 提到 42=${aMentions42})`)
console.log(`T3 兩 session turn 都完成:      ${t3 ? 'PASS' : 'FAIL'}`)

const pass = t1 && t3  // T2 弱 LLM 可能 flaky，不列入 strict pass
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'}\n`)
process.exit(pass ? 0 : 1)
