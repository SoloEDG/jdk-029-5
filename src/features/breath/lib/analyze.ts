import type { GuideNote, PitchPoint, TimeRange } from '../../../shared/document'

export interface BreathInput {
  samples: Float32Array
  sampleRate: number
  /** 录音起点对应的歌曲时间（秒） */
  start: number
  /** 录音终点对应的歌曲时间（秒） */
  end: number
  /** 练习句范围 */
  line: TimeRange
  /** 参考旋律（整首，函数内部会按句过滤） */
  notes: readonly GuideNote[]
  /** 录音时实时检测的音高点（midi 为 null 表示无基频） */
  pitch: readonly PitchPoint[]
}

export type GapVerdict = 'breath' | 'held' | 'quiet' | 'unclear' | 'uncovered'

export interface GapBaseline {
  leftDb: number | null
  rightDb: number | null
  /** 基准实际用到的窗口长度（秒），越大说明近处样本越不足 */
  leftSpan: number
  rightSpan: number
  /** 两侧底噪差（风扇变速的证据），任一侧缺失时为 null */
  driftDb: number | null
}

export interface GapReport extends TimeRange {
  index: number
  verdict: GapVerdict
  /** 判定为可听吸气的片段 */
  breaths: TimeRange[]
  /** 空档内仍有基频（有声）的片段 */
  voiced: TimeRange[]
  baseline: GapBaseline
  /** 可复听的局部底噪片段（空档两侧最近的一段无声音频） */
  listen: { left: TimeRange | null; right: TimeRange | null }
  /** 换气紧邻起音时的接界候选位置（歌曲时间） */
  boundaries: number[]
  reasons: string[]
  /** 局部样本不够时，说明这次能比较到哪里 */
  limit: string | null
}

export interface BreathFrame {
  time: number
  db: number
  silent: boolean
  voiced: boolean
}

export interface UnclassifiedRange extends TimeRange {
  reason: string
  gap: number
}

export interface BreathReport {
  line: TimeRange
  take: TimeRange
  frames: BreathFrame[]
  gaps: GapReport[]
  /** 麦克风无输入（样本接近零）的范围 */
  silences: TimeRange[]
  /** 噪声与气声叠在一起、无法归类的范围 */
  unclassified: UnclassifiedRange[]
  notes: string[]
}

const HOP = 0.01
const SPAN = 0.03
const MIN_GAP = 0.12
const SILENT_DB = -78
const MARGIN_HIGH = 5
const MARGIN_LOW = 2
const MIN_BREATH = 0.07
const MIN_BORDERLINE = 0.05
const MIN_SILENCE = 0.1
const DRIFT_DB = 3.5
const HELD_MIN = 0.12
const BASE_MIN_FRAMES = 10
/** 每侧基准取距离空档最近的可用户帧数 */
const BASE_TAKE = 20
/** 基准样本最远搜索范围（秒） */
const BASE_REACH = 4
const EDGE = 0.02

function stamp(seconds: number) {
  const tenths = Math.floor(Math.max(0, seconds) * 10 + 1e-6)
  const full = Math.floor(tenths / 10)
  return `${String(Math.floor(full / 60)).padStart(2, '0')}:${String(full % 60).padStart(2, '0')}.${tenths % 10}`
}

interface RawFrame { time: number; db: number; silent: boolean }

function buildFrames(samples: Float32Array, rate: number, start: number): RawFrame[] {
  const hop = Math.max(1, Math.round(HOP * rate))
  const span = Math.max(1, Math.round(SPAN * rate))
  const prefix = new Float64Array(samples.length + 1)
  for (let index = 0; index < samples.length; index++) {
    prefix[index + 1] = prefix[index] + samples[index] * samples[index]
  }
  const count = Math.max(0, Math.floor((samples.length - span) / hop) + 1)
  const frames: RawFrame[] = []
  for (let index = 0; index < count; index++) {
    const offset = index * hop
    const rms = Math.sqrt((prefix[offset + span] - prefix[offset]) / span)
    const db = 20 * Math.log10(rms + 1e-12)
    frames.push({ time: start + (offset + span / 2) / rate, db, silent: db < SILENT_DB })
  }
  return frames
}

function voicedIntervals(pitch: readonly PitchPoint[]): TimeRange[] {
  const times = pitch.filter(point => point.midi !== null).map(point => point.time).sort((a, b) => a - b)
  const intervals: TimeRange[] = []
  for (const time of times) {
    const last = intervals[intervals.length - 1]
    if (last && time - 0.03 - last.end <= 0.09) last.end = time + 0.03
    else intervals.push({ start: time - 0.03, end: time + 0.03 })
  }
  return intervals
}

function markVoiced(frames: BreathFrame[], intervals: readonly TimeRange[]) {
  let cursor = 0
  for (const frame of frames) {
    while (cursor < intervals.length && intervals[cursor].end < frame.time) cursor++
    frame.voiced = cursor < intervals.length && intervals[cursor].start <= frame.time
  }
}

function findSilences(frames: readonly BreathFrame[]): TimeRange[] {
  const silences: TimeRange[] = []
  let first: BreathFrame | null = null
  let last: BreathFrame | null = null
  for (const frame of frames) {
    if (frame.silent) {
      first ??= frame
      last = frame
    } else if (first && last) {
      if (last.time - first.time + HOP >= MIN_SILENCE) silences.push({ start: first.time - HOP / 2, end: last.time + HOP / 2 })
      first = last = null
    }
  }
  if (first && last && last.time - first.time + HOP >= MIN_SILENCE) {
    silences.push({ start: first.time - HOP / 2, end: last.time + HOP / 2 })
  }
  return silences
}

/** 参考旋律在句内留下的空档（含句首、句尾），即换气的目标位置 */
function targetGaps(line: TimeRange, notes: readonly GuideNote[]): TimeRange[] {
  const inside = notes
    .filter(note => note.end > line.start && note.start < line.end)
    .slice()
    .sort((a, b) => a.start - b.start)
  const gaps: TimeRange[] = []
  if (!inside.length) return gaps
  const first = inside[0]
  if (first.start - line.start >= MIN_GAP) gaps.push({ start: line.start, end: first.start })
  for (let index = 0; index + 1 < inside.length; index++) {
    const before = inside[index]
    const after = inside[index + 1]
    if (after.start - before.end >= MIN_GAP) gaps.push({ start: before.end, end: after.start })
  }
  const last = inside[inside.length - 1]
  if (line.end - last.end >= MIN_GAP) gaps.push({ start: last.end, end: line.end })
  return gaps
}

/** 抗污染估计：先取低分位锚点，再只保留锚点附近帧取中位，避免把邻隙吸气声当成底噪 */
function estimateBaseline(dbs: readonly number[]): { db: number; solid: boolean } {
  const sorted = [...dbs].sort((a, b) => a - b)
  const anchor = sorted[Math.floor((sorted.length - 1) * 0.15)]
  const kept = sorted.filter(db => db <= anchor + 4)
  return kept.length >= 6
    ? { db: kept[Math.floor((kept.length - 1) * 0.5)], solid: true }
    : { db: anchor, solid: false }
}

/** 从当遍录音里取空档一侧最近的可用帧（无声、非静音），推断局部底噪基准 */
function sideBaseline(frames: readonly BreathFrame[], gap: TimeRange, side: 'left' | 'right'): { db: number; span: number; solid: boolean } | null {
  const edge = side === 'left' ? gap.start - EDGE : gap.end + EDGE
  const usable = frames
    .filter(frame => !frame.voiced && !frame.silent && (side === 'left'
      ? frame.time < edge && frame.time >= gap.start - BASE_REACH
      : frame.time > edge && frame.time <= gap.end + BASE_REACH))
    .sort((a, b) => Math.abs(a.time - edge) - Math.abs(b.time - edge))
  if (usable.length < BASE_MIN_FRAMES) return null
  const nearest = usable.slice(0, BASE_TAKE)
  const span = Math.max(...nearest.map(frame => Math.abs(frame.time - edge))) + SPAN / 2
  const { db, solid } = estimateBaseline(nearest.map(frame => frame.db))
  return { db, span, solid }
}

interface Baseline extends GapBaseline {
  leftSolid: boolean
  rightSolid: boolean
}

function baselineFor(frames: readonly BreathFrame[], gap: TimeRange): Baseline {
  const left = sideBaseline(frames, gap, 'left')
  const right = sideBaseline(frames, gap, 'right')
  return {
    leftDb: left?.db ?? null,
    rightDb: right?.db ?? null,
    leftSpan: left?.span ?? BASE_REACH,
    rightSpan: right?.span ?? BASE_REACH,
    driftDb: left && right ? Math.abs(left.db - right.db) : null,
    leftSolid: left?.solid ?? false,
    rightSolid: right?.solid ?? false,
  }
}

/** 空档一侧最近的一段连续无声、非静音帧，作为可复听的局部底噪证据 */
function listenRange(frames: readonly BreathFrame[], gap: TimeRange, side: 'left' | 'right'): TimeRange | null {
  const usable = frames.filter(frame => !frame.voiced && !frame.silent && (side === 'left'
    ? frame.time < gap.start - EDGE && frame.time >= gap.start - BASE_REACH
    : frame.time > gap.end + EDGE && frame.time <= gap.end + BASE_REACH))
  if (!usable.length) return null
  const anchor = side === 'left' ? usable.length - 1 : 0
  let edge = usable[anchor].time
  const step = side === 'left' ? -1 : 1
  for (let index = anchor + step; index >= 0 && index < usable.length; index += step) {
    if (Math.abs(usable[index - step].time - usable[index].time) > 0.025) break
    if (Math.abs(usable[index].time - usable[anchor].time) >= 0.7) break
    edge = usable[index].time
  }
  const range = side === 'left'
    ? { start: edge - HOP / 2, end: usable[anchor].time + HOP / 2 }
    : { start: usable[anchor].time - HOP / 2, end: edge + HOP / 2 }
  return range.end - range.start >= 0.12 ? range : null
}

type FrameClass = 'voiced' | 'elevated' | 'borderline' | 'noise' | 'silent'

function segments(frames: readonly BreathFrame[], classes: readonly FrameClass[], want: FrameClass, minDuration: number): TimeRange[] {
  const groups: { first: number; last: number }[] = []
  let current: { first: number; last: number } | null = null
  for (let index = 0; index < frames.length; index++) {
    if (classes[index] !== want) continue
    if (current && index - current.last <= 2) current.last = index
    else {
      if (current) groups.push(current)
      current = { first: index, last: index }
    }
  }
  if (current) groups.push(current)
  return groups
    .map(group => ({ start: frames[group.first].time - HOP / 2, end: frames[group.last].time + HOP / 2 }))
    .filter(range => range.end - range.start >= minDuration)
}

function overlap(a: TimeRange, b: TimeRange) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

interface GapOutcome {
  report: GapReport
  unclassified: UnclassifiedRange[]
}

function analyzeGap(
  index: number,
  gap: TimeRange,
  frames: readonly BreathFrame[],
  silences: readonly TimeRange[],
  take: TimeRange,
): GapOutcome {
  const length = gap.end - gap.start
  const baseline = baselineFor(frames, gap)
  const listen = { left: listenRange(frames, gap, 'left'), right: listenRange(frames, gap, 'right') }
  const reasons: string[] = []
  const limits: string[] = []
  const unclassified: UnclassifiedRange[] = []
  const finish = (
    verdict: GapVerdict,
    extra: Partial<Pick<GapReport, 'breaths' | 'voiced' | 'boundaries'>> = {},
  ): GapOutcome => ({
    report: {
      index, start: gap.start, end: gap.end, verdict,
      breaths: extra.breaths ?? [], voiced: extra.voiced ?? [], boundaries: extra.boundaries ?? [],
      baseline, listen, reasons, limit: limits.length ? limits.join('；') : null,
    },
    unclassified,
  })

  const coverage = overlap(take, gap) / length
  if (coverage < 0.6) {
    limits.push(take.end < gap.end
      ? `本遍只录到 ${stamp(take.end)}，这个空档无法比较`
      : `录音从 ${stamp(take.start)} 才开始，空档前段缺失`)
    return finish('uncovered')
  }

  const silentInside = silences.reduce((total, range) => total + overlap(range, gap), 0)
  if (silentInside / length > 0.4) {
    reasons.push('空档内大部分时间麦克风无输入')
    limits.push('这段没有可比较的声音')
    return finish('unclear')
  }
  if (silentInside > 0.02) reasons.push(`空档内有约 ${silentInside.toFixed(1)} 秒无输入，该段跳过`)

  const inside = frames.filter(frame => frame.time >= gap.start && frame.time < gap.end)

  // 基准被气声污染守卫：干净簇不扎实且明显高于空档内最静水平，或高出太多（不像风扇提速），
  // 说明取到的多是气声而非底噪。真实的风扇提速（均匀变响）不会被误丢。
  const quietInside = inside.filter(frame => !frame.voiced && !frame.silent).map(frame => frame.db).sort((a, b) => a - b)
  const floor = quietInside.length >= 8 ? quietInside[Math.floor((quietInside.length - 1) * 0.1)] : null
  let leftPolluted = false
  let rightPolluted = false
  if (floor !== null) {
    leftPolluted = baseline.leftDb !== null && (baseline.leftDb > floor + 14 || (!baseline.leftSolid && baseline.leftDb > floor + 8))
    rightPolluted = baseline.rightDb !== null && (baseline.rightDb > floor + 14 || (!baseline.rightSolid && baseline.rightDb > floor + 8))
    if (leftPolluted) baseline.leftDb = null
    if (rightPolluted) baseline.rightDb = null
  }

  const { leftDb, rightDb, leftSpan, rightSpan } = baseline
  const driftDb = leftDb !== null && rightDb !== null ? Math.abs(leftDb - rightDb) : null
  baseline.driftDb = driftDb
  if (leftDb === null && rightDb === null) {
    limits.push(leftPolluted && rightPolluted
      ? '空档两侧底噪样本都被气声污染，无法比较'
      : leftPolluted || rightPolluted
        ? `底噪样本被气声污染，空档前后 ${BASE_REACH} 秒内没有可比较的基准`
        : `空档前后 ${BASE_REACH} 秒内没有可用的底噪样本，无法比较`)
    return finish('unclear')
  }
  if (leftDb === null) limits.push(leftPolluted ? '空档左侧底噪样本被气声污染，只能与右侧比较' : '空档左侧没有底噪样本，只能与右侧比较')
  if (rightDb === null) limits.push(rightPolluted ? '空档右侧底噪样本被气声污染，只能与左侧比较' : '空档右侧没有底噪样本，只能与左侧比较')
  if (leftDb !== null && leftSpan > 0.6) reasons.push(`左侧近处底噪样本不足，基准取自空档前 ${leftSpan.toFixed(1)} 秒范围`)
  if (rightDb !== null && rightSpan > 0.6) reasons.push(`右侧近处底噪样本不足，基准取自空档后 ${rightSpan.toFixed(1)} 秒范围`)
  const drifting = driftDb !== null && driftDb > DRIFT_DB
  if (drifting) {
    reasons.push(`空档两侧底噪相差 ${driftDb!.toFixed(1)} dB（像风扇变速），轻吸气无法确认`)
    limits.push('只能确认高于两侧基准的声音')
  }

  const mid = (gap.start + gap.end) / 2
  const baseFor = (time: number) => {
    if (drifting) return Math.max(leftDb!, rightDb!)
    if (leftDb !== null && rightDb !== null) return time < mid ? leftDb : rightDb
    return (leftDb ?? rightDb)!
  }
  const classes: FrameClass[] = inside.map(frame => {
    if (frame.silent) return 'silent'
    if (frame.voiced) return 'voiced'
    const base = baseFor(frame.time)
    if (frame.db > base + MARGIN_HIGH) return 'elevated'
    if (frame.db > base + MARGIN_LOW) return 'borderline'
    return 'noise'
  })

  const breaths = segments(inside, classes, 'elevated', MIN_BREATH)
  const voiced = segments(inside, classes, 'voiced', 0.06)
  const borderline = segments(inside, classes, 'borderline', MIN_BORDERLINE)
    .filter(range => !breaths.some(breath => overlap(breath, range) > 0
      || Math.abs(breath.end - range.start) < 0.03 || Math.abs(range.end - breath.start) < 0.03))
  const shortElevated = segments(inside, classes, 'elevated', 0.02)
    .filter(range => range.end - range.start < MIN_BREATH)
  for (const range of borderline) unclassified.push({ ...range, reason: '气声与底噪能量相近', gap: index })
  for (const range of shortElevated) unclassified.push({ ...range, reason: '高于底噪但太短', gap: index })

  const boundaries: number[] = []
  for (const breath of breaths) {
    if (breath.end >= gap.end - 0.18 && breath.end <= gap.end + 0.05) boundaries.push(Math.min(breath.end, gap.end))
  }
  const nearEnd = [...breaths, ...borderline].some(range => gap.end - range.end <= 0.25 && gap.end - range.end >= -0.05)
  if (nearEnd) {
    let bestSlope = 0
    let bestTime: number | null = null
    for (let position = 1; position < frames.length; position++) {
      const frame = frames[position]
      if (frame.time < gap.end - 0.2 || frame.time > gap.end + 0.15) continue
      const slope = (frame.db - frames[position - 1].db) / Math.max(1e-6, frame.time - frames[position - 1].time)
      if (slope > bestSlope) { bestSlope = slope; bestTime = frame.time }
    }
    if (bestTime !== null && bestSlope > 30) boundaries.push(bestTime)
  }

  const voicedTotal = voiced.reduce((total, range) => total + range.end - range.start, 0)
  const firstVoiced = voiced[0]?.start
  const held = voicedTotal >= HELD_MIN && firstVoiced !== undefined && firstVoiced < gap.start + 0.55 * length
  if (held) reasons.push(`有声部分拖进空档约 ${voicedTotal.toFixed(2)} 秒`)
  else if (voicedTotal >= 0.06 && firstVoiced !== undefined) {
    reasons.push('空档尾部提前出声，可能是下一个音的起音')
    boundaries.push(firstVoiced)
  }
  for (const breath of breaths) reasons.push(`可听吸气约 ${(breath.end - breath.start).toFixed(2)} 秒（${stamp(breath.start)}–${stamp(breath.end)}）`)
  if (borderline.length) reasons.push('有与底噪能量相近的气声，建议复听分辨')
  if (shortElevated.length) reasons.push('有高于底噪的短信号，时长太短无法确认')

  const sortedBoundaries = boundaries
    .sort((a, b) => a - b)
    .filter((time, position, all) => position === 0 || time - all[position - 1] > 0.06)
  const verdict: GapVerdict = held ? 'held'
    : breaths.length ? 'breath'
    : borderline.length || shortElevated.length || drifting ? 'unclear'
    : 'quiet'
  return finish(verdict, { breaths, voiced, boundaries: sortedBoundaries })
}

export function analyzeTake(input: BreathInput): BreathReport {
  const take = { start: input.start, end: input.end }
  const frames: BreathFrame[] = buildFrames(input.samples, input.sampleRate, input.start)
    .map(frame => ({ ...frame, voiced: false }))
  markVoiced(frames, voicedIntervals(input.pitch))
  const silences = findSilences(frames)
  const gaps: GapReport[] = []
  const unclassified: UnclassifiedRange[] = []
  for (const [index, gap] of targetGaps(input.line, input.notes).entries()) {
    const outcome = analyzeGap(index, gap, frames, silences, take)
    gaps.push(outcome.report)
    unclassified.push(...outcome.unclassified)
  }
  const notes: string[] = []
  if (silences.length) {
    notes.push(`本遍有 ${silences.length} 段无输入（${silences.map(range => `${stamp(range.start)}–${stamp(range.end)}`).join('、')}），这些范围无法判断。`)
  }
  if (take.end < input.line.end - 0.25) notes.push(`本遍只录到 ${stamp(take.end)}，之后的空档无法比较。`)
  if (take.start > input.line.start + 0.25) notes.push(`录音从 ${stamp(take.start)} 才开始，之前的空档无法比较。`)
  if (!gaps.length) notes.push('这一句的参考旋律没有留出空档。')
  return { line: input.line, take, frames, gaps, silences, unclassified, notes }
}
