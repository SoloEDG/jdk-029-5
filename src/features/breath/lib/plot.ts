import type { GuideNote } from '../../../shared/document'
import { clockLabel } from '../../../shared/time'
import type { BreathReport, GapVerdict } from './analyze'

interface BreathPlot {
  report: BreathReport
  notes: readonly GuideNote[]
  position: number | null
}

export const VERDICT_COLORS: Record<GapVerdict, string> = {
  breath: '#b8dc9d',
  held: '#f09982',
  unclear: '#e5bd70',
  quiet: '#767b6b',
  uncovered: '#5c5f56',
}

export function drawBreath(canvas: HTMLCanvasElement, width: number, height: number, plot: BreathPlot) {
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const context = canvas.getContext('2d')
  if (!context) return
  context.scale(ratio, ratio)
  const { report } = plot
  const left = 43
  const right = width - 15
  const bottom = height - 30
  const top = 18
  const first = report.line.start
  const duration = report.line.end - first
  if (duration <= 0) return

  const audible = report.frames.filter(frame => !frame.silent)
  let low = Math.min(-56, ...audible.map(frame => frame.db)) - 4
  let high = Math.max(-18, ...audible.map(frame => frame.db)) + 4
  low = Math.max(-84, Math.floor(low))
  high = Math.min(0, Math.ceil(high))
  if (high - low < 24) {
    const pad = (24 - (high - low)) / 2
    low -= pad
    high += pad
  }
  const x = (time: number) => left + (time - first) / duration * (right - left)
  const y = (db: number) => bottom - (db - low) / (high - low) * (bottom - top)
  const ticks = width < 370 ? 3 : width < 520 ? 5 : 8
  context.font = '10px "IBM Plex Mono", monospace'

  for (let db = Math.ceil(low / 6) * 6; db <= high; db += 6) {
    const major = db % 12 === 0
    context.strokeStyle = major ? '#383d33' : '#2a3027'
    context.beginPath()
    context.moveTo(left, y(db))
    context.lineTo(right, y(db))
    context.stroke()
    if (major) {
      context.fillStyle = '#a5ac96'
      context.textAlign = 'left'
      context.fillText(`${db}`, 10, y(db) + 3)
    }
  }
  for (let index = 0; index <= ticks; index++) {
    const time = first + duration * index / ticks
    const px = x(time)
    context.strokeStyle = '#343a30'
    context.beginPath()
    context.moveTo(px, top)
    context.lineTo(px, bottom)
    context.stroke()
    context.fillStyle = '#a5ac96'
    context.textAlign = index === 0 ? 'left' : index === ticks ? 'right' : 'center'
    context.fillText(clockLabel(time, duration < 6), px, height - 10)
  }

  context.save()
  context.beginPath()
  context.rect(left, top, right - left, bottom - top)
  context.clip()

  // 录音覆盖不到的范围
  context.fillStyle = 'rgba(0, 0, 0, 0.35)'
  if (report.take.start > first) context.fillRect(left, top, x(report.take.start) - left, bottom - top)
  if (report.take.end < report.line.end) context.fillRect(x(report.take.end), top, right - x(report.take.end), bottom - top)

  // 空档底色按判定着色
  for (const gap of report.gaps) {
    const color = VERDICT_COLORS[gap.verdict]
    context.fillStyle = `${color}1f`
    context.fillRect(x(gap.start), top, x(gap.end) - x(gap.start), bottom - top)
    context.strokeStyle = `${color}59`
    context.beginPath()
    context.moveTo(x(gap.start), top)
    context.lineTo(x(gap.start), bottom)
    context.moveTo(x(gap.end), top)
    context.lineTo(x(gap.end), bottom)
    context.stroke()
    context.fillStyle = '#a5ac96'
    context.textAlign = 'center'
    context.fillText(`${gap.index + 1}`, (x(gap.start) + x(gap.end)) / 2, top + 10)
  }

  // 无输入段
  for (const range of report.silences) {
    context.fillStyle = 'rgba(0, 0, 0, 0.5)'
    context.fillRect(x(range.start), top, x(range.end) - x(range.start), bottom - top)
    context.strokeStyle = '#f09982'
    context.setLineDash([3, 3])
    context.beginPath()
    context.moveTo(x(range.start), top)
    context.lineTo(x(range.start), bottom)
    context.moveTo(x(range.end), top)
    context.lineTo(x(range.end), bottom)
    context.stroke()
    context.setLineDash([])
  }

  // 参考旋律（顶部细条）
  for (const note of plot.notes) {
    if (note.end < first || note.start > report.line.end) continue
    context.fillStyle = '#e5bd70'
    context.beginPath()
    context.roundRect(x(note.start), top + 1, Math.max(3, x(note.end) - x(note.start)), 4, 2)
    context.fill()
  }

  // 局部底噪基准（虚线，两侧不同说明底噪在变）
  for (const gap of report.gaps) {
    const { leftDb, rightDb, leftSpan, rightSpan, driftDb } = gap.baseline
    const drifting = driftDb !== null && driftDb > 3.5
    context.lineWidth = 1.5
    context.setLineDash([5, 4])
    if (leftDb !== null) {
      context.strokeStyle = drifting ? '#f09982' : '#85cbd5'
      context.beginPath()
      context.moveTo(Math.max(left, x(gap.start - leftSpan)), y(leftDb))
      context.lineTo(x(gap.start), y(leftDb))
      context.stroke()
    }
    if (rightDb !== null) {
      context.strokeStyle = drifting ? '#f09982' : '#85cbd5'
      context.beginPath()
      context.moveTo(x(gap.end), y(rightDb))
      context.lineTo(Math.min(right, x(gap.end + rightSpan)), y(rightDb))
      context.stroke()
    }
    context.setLineDash([])
  }

  // 能量曲线
  context.strokeStyle = '#f1ecdb'
  context.lineWidth = 1.6
  context.beginPath()
  let pen = false
  for (const frame of report.frames) {
    if (frame.silent) { pen = false; continue }
    const px = x(frame.time)
    const py = y(Math.max(low, Math.min(high, frame.db)))
    if (pen) context.lineTo(px, py)
    else context.moveTo(px, py)
    pen = true
  }
  context.stroke()

  // 底部三段泳道：有声（珊瑚）/ 无法归类（金）/ 吸气（绿）
  const lane = (range: { start: number; end: number }, offset: number, color: string) => {
    context.fillStyle = color
    context.beginPath()
    context.roundRect(x(range.start), bottom - offset, Math.max(2, x(range.end) - x(range.start)), 4, 2)
    context.fill()
  }
  for (const gap of report.gaps) {
    for (const range of gap.voiced) lane(range, 15, '#f09982')
    for (const range of gap.breaths) lane(range, 5, '#b8dc9d')
  }
  for (const range of report.unclassified) lane(range, 10, '#e5bd70')

  // 接界候选（换气紧邻起音）
  context.fillStyle = '#e5bd70'
  for (const gap of report.gaps) {
    for (const time of gap.boundaries) {
      const px = x(time)
      context.beginPath()
      context.moveTo(px, top + 12)
      context.lineTo(px - 4, top + 4)
      context.lineTo(px + 4, top + 4)
      context.closePath()
      context.fill()
    }
  }

  if (plot.position !== null && plot.position >= first && plot.position <= report.line.end) {
    context.strokeStyle = '#f6eddb'
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(x(plot.position), top)
    context.lineTo(x(plot.position), bottom)
    context.stroke()
  }
  context.restore()
}
