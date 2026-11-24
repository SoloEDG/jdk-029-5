// 换气分析验证：用合成音频覆盖以下场景
//  A 风扇在空档中提速（底噪漂移）  B 麦克风一段无输入  C 只录到半句
//  D 换气紧邻起音 + 拖音          E 气声与风扇同能量  F 真实歌曲《潮汐之后》第一句
// 运行：node scripts/validate-breath.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(tmpdir(), 'breath-validate')
mkdirSync(outDir, { recursive: true })

function compile(relative, name) {
  const source = readFileSync(join(root, relative), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  })
  const file = join(outDir, name)
  writeFileSync(file, outputText)
  return file
}

const { analyzeTake } = await import(pathToFileURL(compile('src/features/breath/lib/analyze.ts', 'analyze.mjs')))
const { decodeWave } = await import(pathToFileURL(compile('src/features/breath/lib/decode.ts', 'decode.mjs')))
const { cutSnippet } = await import(pathToFileURL(compile('src/features/breath/lib/snippet.ts', 'snippet.mjs')))

const RATE = 48000
const LINE = { start: 0.5, end: 11.0 }
const NOTES = [
  { start: 0.5, end: 2.0, midi: 60 },
  { start: 2.7, end: 4.2, midi: 62 },
  { start: 4.9, end: 6.4, midi: 64 },
  { start: 7.1, end: 8.6, midi: 65 },
  { start: 9.3, end: 11.0, midi: 67 },
]
const GAPS = [
  { start: 2.0, end: 2.7 },
  { start: 4.2, end: 4.9 },
  { start: 6.4, end: 7.1 },
  { start: 8.6, end: 9.3 },
]
const db = value => 10 ** (value / 20)
const freq = midi => 440 * 2 ** ((midi - 69) / 12)

function noise(amp) {
  // 三个均匀分布相加近似高斯，标准差 0.5，乘 2*amp 使 RMS ≈ amp
  return (Math.random() + Math.random() + Math.random() - 1.5) * 2 * amp
}

function synth({ takeEnd = LINE.end, fan = [], breaths = [], holds = {}, silences = [] }) {
  const start = LINE.start
  const length = Math.round((takeEnd - start) * RATE)
  const samples = new Float32Array(length)
  const at = index => start + index / RATE
  for (const seg of fan) {
    const from = Math.max(0, Math.round((seg.from - start) * RATE))
    const to = Math.min(length, Math.round((seg.to - start) * RATE))
    for (let index = from; index < to; index++) {
      const progress = to === from ? 1 : (index - from) / (to - from)
      const amp = db(seg.fromDb + (seg.toDb - seg.fromDb) * progress)
      samples[index] += noise(amp)
    }
  }
  const sungTo = index => Math.min(NOTES[index].end + (holds[index] ?? 0), takeEnd)
  for (const [index, note] of NOTES.entries()) {
    const from = Math.max(0, Math.round((note.start - start) * RATE))
    const to = Math.min(length, Math.round((sungTo(index) - start) * RATE))
    for (let i = from; i < to; i++) {
      const t = at(i)
      const envelope = Math.min(1, (t - note.start) / 0.02, (sungTo(index) - t) / 0.02)
      const f = freq(note.midi)
      samples[i] += 0.25 * envelope * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t))
    }
  }
  for (const breath of breaths) {
    const from = Math.max(0, Math.round((breath.from - start) * RATE))
    const to = Math.min(length, Math.round((breath.to - start) * RATE))
    for (let index = from; index < to; index++) {
      const phase = (index - from) / Math.max(1, to - from)
      samples[index] += noise(db(breath.db)) * Math.sin(Math.PI * phase) * 1.4
    }
  }
  for (const silence of silences) {
    samples.fill(0, Math.round((silence.from - start) * RATE), Math.round((silence.to - start) * RATE))
  }
  const pitch = []
  for (let time = start + 0.02; time < takeEnd; time += 0.04) {
    const index = NOTES.findIndex((note, i) => time >= note.start && time < sungTo(i))
    pitch.push({ time, midi: index >= 0 ? NOTES[index].midi : null })
  }
  return { samples, sampleRate: RATE, start, end: takeEnd, line: LINE, notes: NOTES, pitch }
}

let failures = 0
function check(condition, message) {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${message}`)
}
function show(report) {
  for (const gap of report.gaps) {
    const base = gap.baseline
    const fmt = value => (value === null ? '  —  ' : value.toFixed(1).padStart(5))
    console.log(
      `    空档${gap.index + 1} ${gap.start.toFixed(2)}–${gap.end.toFixed(2)}  ${gap.verdict.padEnd(9)}`
      + ` 基准 ${fmt(base.leftDb)}/${fmt(base.rightDb)}`
      + (base.driftDb !== null ? ` 差${base.driftDb.toFixed(1)}` : '')
      + (gap.boundaries.length ? ` 接界[${gap.boundaries.map(t => t.toFixed(2)).join(' ')}]` : '')
      + (gap.limit ? `\n        ↳ ${gap.limit}` : ''),
    )
  }
  for (const note of report.notes) console.log(`    说明: ${note}`)
  if (report.unclassified.length) {
    console.log(`    无法归类: ${report.unclassified.map(r => `${r.start.toFixed(2)}–${r.end.toFixed(2)}(${r.reason})`).join('、')}`)
  }
}

console.log('\nA. 风扇在空档 3 中提速（-50 → -40 dB），空档 4 有同能量级轻吸气')
{
  const report = analyzeTake(synth({
    fan: [{ from: 0.5, to: 6.7, fromDb: -50, toDb: -50 }, { from: 6.7, to: 6.9, fromDb: -50, toDb: -40 }, { from: 6.9, to: 11, fromDb: -40, toDb: -40 }],
    breaths: [{ from: 2.05, to: 2.45, db: -30 }, { from: 8.7, to: 9.0, db: -41 }],
  }))
  show(report)
  check(report.gaps[0].verdict === 'breath', '空档1 干净吸气 → 可听吸气')
  check(report.gaps[1].verdict === 'quiet', '空档2 无内容 → 基本安静（风扇提速不被当成吸气）')
  check(report.gaps[2].verdict === 'unclear', '空档3 底噪在空档中变化 → 证据不足，而不是误判吸气')
  check(report.gaps[2].baseline.driftDb !== null && report.gaps[2].baseline.driftDb > 8, `空档3 检出两侧底噪差 ${report.gaps[2].baseline.driftDb?.toFixed(1)} dB`)
  check(!!report.gaps[2].limit, '空档3 给出可比较范围说明')
  check(report.gaps[3].verdict === 'unclear', '空档4 轻吸气贴近新底噪 → 证据不足')
  check(report.unclassified.some(r => r.start >= 8.6 && r.end <= 9.3), '空档4 的轻吸气进入"无法归类"列表，等耳朵判断')
}

console.log('\nB. 麦克风 4.6–5.8s 无输入，空档 1、3 有清晰吸气')
{
  const report = analyzeTake(synth({
    fan: [{ from: 0.5, to: 11, fromDb: -50, toDb: -50 }],
    breaths: [{ from: 2.05, to: 2.45, db: -30 }, { from: 6.5, to: 6.85, db: -30 }],
    silences: [{ from: 4.6, to: 5.8 }],
  }))
  show(report)
  check(report.silences.length === 1 && Math.abs(report.silences[0].start - 4.6) < 0.03 && Math.abs(report.silences[0].end - 5.8) < 0.03, '检出无输入段 4.6–5.8')
  check(report.gaps[0].verdict === 'breath', '空档1 → 可听吸气')
  check(report.gaps[1].verdict === 'unclear', '空档2 尾部无输入 → 证据不足')
  check(report.gaps[2].verdict === 'breath', '空档3 吸气仍可判定（基准向更远处取）')
  check(report.gaps[2].baseline.leftSpan >= 1.5, `空档3 左侧基准取自 ${report.gaps[2].baseline.leftSpan.toFixed(1)}s 外并明示`)
  check(report.notes.some(note => note.includes('无输入')), '报告说明无输入范围')
}

console.log('\nC. 只录到半句（5.0s 停止）')
{
  const report = analyzeTake(synth({
    takeEnd: 5.0,
    fan: [{ from: 0.5, to: 5, fromDb: -50, toDb: -50 }],
    breaths: [{ from: 2.05, to: 2.45, db: -30 }],
  }))
  show(report)
  check(report.gaps[0].verdict === 'breath', '空档1 → 可听吸气')
  check(report.gaps[1].verdict === 'quiet' && !!report.gaps[1].limit, '空档2 右侧没有底噪样本 → 说明只能与左侧比较')
  check(report.gaps[2].verdict === 'uncovered' && report.gaps[3].verdict === 'uncovered', '空档3、4 → 未录到')
  check(report.gaps[2].limit?.includes('只录到'), '空档3 明示"只录到 00:05.0"')
  check(report.notes.some(note => note.includes('只录到')), '报告说明之后的空档无法比较')
}

console.log('\nD. 换气紧邻起音（吸气止于起音前 0.03s）+ 空档 3 拖音 0.6s')
{
  const report = analyzeTake(synth({
    fan: [{ from: 0.5, to: 11, fromDb: -50, toDb: -50 }],
    breaths: [{ from: 4.55, to: 4.87, db: -30 }],
    holds: { 2: 0.6 },
  }))
  show(report)
  check(report.gaps[1].verdict === 'breath', '空档2 紧邻起音的吸气 → 可听吸气，不因后面信号强就算拖音')
  check(report.gaps[1].boundaries.some(time => Math.abs(time - 4.9) <= 0.08), `空档2 给出接界候选（实测 ${report.gaps[1].boundaries.map(t => t.toFixed(2)).join('、')}，真值 4.90）`)
  check(report.gaps[2].verdict === 'held', '空档3 拖音 0.6s → 拖音')
}

console.log('\nE. 气声与风扇同能量（都 -42 dB）：空档2 应留给耳朵')
{
  const report = analyzeTake(synth({
    fan: [{ from: 0.5, to: 11, fromDb: -42, toDb: -42 }],
    breaths: [{ from: 2.05, to: 2.45, db: -30 }, { from: 4.35, to: 4.75, db: -42 }],
  }))
  show(report)
  check(report.gaps[0].verdict === 'breath', '空档1 明显高于底噪 → 可听吸气')
  check(report.gaps[1].verdict === 'unclear', '空档2 气声与风扇同能量 → 证据不足，不擅自下结论')
  check(report.unclassified.some(r => r.start >= 4.2 && r.end <= 4.9), '空档2 进入"无法归类"列表，可在图旁复听')
}

console.log('\nF. 真实歌曲《潮汐之后》第一句（空档 0.17–0.23s）')
{
  const song = JSON.parse(readFileSync(join(root, 'src/features/playback/model/demo-songs.json'), 'utf8'))[0]
  const line = song.lines[0]
  const notes = song.notes.filter(note => note.end > line.start && note.start < line.end)
  const gaps = []
  for (let index = 0; index + 1 < notes.length; index++) {
    if (notes[index + 1].start - notes[index].end >= 0.12) gaps.push({ start: notes[index].end, end: notes[index + 1].start })
  }
  if (line.end - notes.at(-1).end >= 0.12) gaps.push({ start: notes.at(-1).end, end: line.end })
  const breaths = gaps.map(gap => ({ from: gap.start + 0.02, to: gap.end - 0.02, db: -32 }))
  const length = Math.round((line.end - line.start) * RATE)
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index++) samples[index] = noise(db(-52))
  for (const note of notes) {
    for (let i = Math.round((note.start - line.start) * RATE); i < Math.round((note.end - line.start) * RATE); i++) {
      const t = line.start + i / RATE
      samples[i] += 0.25 * (Math.sin(2 * Math.PI * freq(note.midi) * t) + 0.5 * Math.sin(4 * Math.PI * freq(note.midi) * t))
    }
  }
  for (const breath of breaths) {
    const from = Math.round((breath.from - line.start) * RATE)
    const to = Math.round((breath.to - line.start) * RATE)
    for (let index = from; index < to; index++) {
      samples[index] += noise(db(breath.db)) * Math.sin(Math.PI * (index - from) / (to - from)) * 1.4
    }
  }
  const pitch = []
  for (let time = line.start + 0.02; time < line.end; time += 0.04) {
    const note = notes.find(n => time >= n.start && time < n.end)
    pitch.push({ time, midi: note ? note.midi : null })
  }
  const report = analyzeTake({ samples, sampleRate: RATE, start: line.start, end: line.end, line, notes: song.notes, pitch })
  show(report)
  check(report.gaps.length === gaps.length && gaps.length >= 3, `检出 ${report.gaps.length} 个空档目标`)
  check(report.gaps.every(gap => gap.verdict === 'breath'), '每个空档都听到吸气')
  check(!!report.gaps.at(-1).limit, '句尾空档右侧没有样本 → 明示只能与左侧比较')
}

console.log('\nG. 录音 WAV 往返：cutSnippet → decodeWave')
{
  const take = synth({ fan: [{ from: 0.5, to: 11, fromDb: -50, toDb: -50 }] })
  const blob = cutSnippet(take.samples, RATE, 1.0, 2.5)
  const decoded = decodeWave(await blob.arrayBuffer())
  check(decoded.sampleRate === RATE, `采样率保持 ${decoded.sampleRate}`)
  check(Math.abs(decoded.samples.length - 1.5 * RATE) <= 2, `片段长度 ${decoded.samples.length} ≈ 1.5s`)
}

console.log(failures ? `\n${failures} 项未通过` : '\n全部通过')
process.exit(failures ? 1 : 0)
