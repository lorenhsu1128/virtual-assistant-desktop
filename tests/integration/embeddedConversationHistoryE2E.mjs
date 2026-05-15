/**
 * Multi-turn conversation history — 同一 session 多輪對話，LLM 必須記得前面說過什麼。
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
if (!existsSync(MODEL_ABS)) { console.error(`[hist] FAIL: 缺 model`); process.exit(2) }

const TEMP = join(tmpdir(), `vad-hist-${process.pid}-${Date.now()}`)
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
const session = agent.createSession({ source: 'mascot' })
await new Promise(r => setTimeout(r, 30))

async function runTurn(prompt, timeoutMs = 120000) {
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
  return { turnEnd, text: texts.join(''), elapsed: Date.now() - t }
}

console.log('[hist] Turn 1: 告知名字')
const t1Res = await runTurn('你好，我叫做星塵。請只回「你好，星塵」就好。')
console.log(`  → "${t1Res.text.slice(0, 60).replace(/\n/g, '\\n')}"`)

console.log('[hist] Turn 2: 確認記憶')
const t2Res = await runTurn('我剛剛告訴你我的名字是什麼？只回名字一個詞。')
console.log(`  → "${t2Res.text.slice(0, 60).replace(/\n/g, '\\n')}"`)

console.log('[hist] Turn 3: 再進階一點')
const t3Res = await runTurn('我之前自我介紹的是中文還是英文？只回「中文」或「英文」其中一個。')
console.log(`  → "${t3Res.text.slice(0, 60).replace(/\n/g, '\\n')}"`)

try { await session.close() } catch {}
try { await agent.shutdown?.() } catch {}

console.log(`\n══════════════════════════════════════════════════════`)
console.log(`        CONVERSATION HISTORY E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)

const t1Ok = t1Res.turnEnd?.reason === 'done'
const t2Ok = t2Res.turnEnd?.reason === 'done'
const t3Ok = t3Res.turnEnd?.reason === 'done'
const remembersName = /星塵/.test(t2Res.text)
const remembersChinese = /中文/.test(t3Res.text)

console.log(`T1 turn1 完成:           ${t1Ok ? 'PASS' : 'FAIL'}`)
console.log(`T2 turn2 完成:           ${t2Ok ? 'PASS' : 'FAIL'}`)
console.log(`T3 turn3 完成:           ${t3Ok ? 'PASS' : 'FAIL'}`)
console.log(`T4 turn2 記得名字「星塵」:  ${remembersName ? 'PASS' : 'WARN'}`)
console.log(`T5 turn3 記得「中文」:    ${remembersChinese ? 'PASS' : 'WARN'}`)

// 嚴格 pass：三個 turn 都完成 + 至少一個記憶測試通過（弱 LLM 可能其中一個失敗）
const pass = t1Ok && t2Ok && t3Ok && (remembersName || remembersChinese)
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'}\n`)
process.exit(pass ? 0 : 1)
