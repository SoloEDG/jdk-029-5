<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watchEffect } from 'vue'
import { Ear, Info, Play, Square, Wind } from '@lucide/vue'
import type { GuideNote, LyricLine, Take } from '../../../shared/document'
import { clockLabel } from '../../../shared/time'
import { useBreath } from '../model/useBreath'
import { drawBreath, VERDICT_COLORS } from '../lib/plot'
import type { GapReport, GapVerdict } from '../lib/analyze'

const props = defineProps<{ takes: Take[]; line: LyricLine | null; notes: GuideNote[]; position: number }>()
const breath = useBreath(toRef(props, 'takes'), toRef(props, 'line'), toRef(props, 'notes'))

const VERDICT_LABELS: Record<GapVerdict, string> = {
  breath: '可听吸气',
  held: '拖音',
  quiet: '基本安静',
  unclear: '证据不足',
  uncovered: '未录到',
}

const selectedId = computed({
  get: () => breath.takeId.value ?? breath.take.value?.id ?? '',
  set: (id: string) => { breath.takeId.value = id || null },
})

const canvas = ref<HTMLCanvasElement | null>(null)
const size = ref({ width: 0, height: 0 })
let observer: ResizeObserver | undefined
onMounted(() => {
  if (!canvas.value) return
  observer = new ResizeObserver(([entry]) => {
    size.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  observer.observe(canvas.value)
})
onBeforeUnmount(() => observer?.disconnect())

watchEffect(() => {
  const { width, height } = size.value
  const report = breath.report.value
  if (!canvas.value || !report || width < 80 || height < 80) return
  drawBreath(canvas.value, width, height, { report, notes: props.notes, position: props.position })
})

function baselineText(gap: GapReport) {
  const { leftDb, rightDb, driftDb } = gap.baseline
  const side = (db: number | null) => (db === null ? '—' : `${db.toFixed(1)}`)
  const drift = driftDb !== null && driftDb > 3.5 ? ` · 两侧差 ${driftDb.toFixed(1)}` : ''
  return `底噪 左 ${side(leftDb)} · 右 ${side(rightDb)} dB${drift}`
}

function listenGap(gap: GapReport) {
  void breath.play(`gap-${gap.index}`, { start: gap.start - 0.12, end: gap.end + 0.12 })
}
function listenBaseline(gap: GapReport, side: 'left' | 'right') {
  const range = gap.listen[side]
  if (range) void breath.play(`base-${gap.index}-${side}`, range)
}
function listenBoundary(gap: GapReport) {
  const time = gap.boundaries[0]
  if (time !== undefined) void breath.play(`boundary-${gap.index}`, { start: time - 0.3, end: time + 0.3 })
}
function listenUnclassified(index: number, range: { start: number; end: number }) {
  void breath.play(`unclassified-${index}`, { start: range.start - 0.15, end: range.end + 0.15 })
}
</script>

<template>
  <section class="breath-panel" aria-labelledby="breath-title">
    <div class="breath-heading">
      <h2 id="breath-title" class="panel-heading"><Wind :size="17" /> 换气回看</h2>
      <select v-if="breath.take.value" v-model="selectedId" aria-label="选择要分析的录音" class="breath-picker">
        <option v-for="(item, index) in takes" :key="item.id" :value="item.id">录音 {{ takes.length - index }}</option>
      </select>
    </div>

    <div v-if="!takes.length" class="breath-empty">这一句还没有录音，先录一遍再回看换气。</div>
    <div v-else-if="breath.analyzing.value" class="breath-empty">正在分析录音…</div>
    <template v-else-if="breath.report.value">
      <canvas ref="canvas" class="breath-canvas" role="img"
        :aria-label="`能量曲线与换气分析，共 ${breath.report.value.gaps.length} 个空档`"></canvas>
      <div class="breath-legend" aria-hidden="true">
        <span><i class="swatch" :style="{ background: VERDICT_COLORS.breath }"></i>可听吸气</span>
        <span><i class="swatch" :style="{ background: VERDICT_COLORS.held }"></i>拖音</span>
        <span><i class="swatch" :style="{ background: VERDICT_COLORS.unclear }"></i>证据不足</span>
        <span><i class="swatch" :style="{ background: VERDICT_COLORS.uncovered }"></i>未录到</span>
        <span><i class="swatch dash"></i>局部底噪</span>
        <span><i class="swatch triangle"></i>接界候选</span>
      </div>

      <ol class="gap-list">
        <li v-for="gap in breath.report.value.gaps" :key="gap.index" class="gap-row">
          <div class="gap-main">
            <span class="gap-index mono">{{ gap.index + 1 }}</span>
            <span class="gap-time mono">{{ clockLabel(gap.start, true) }}–{{ clockLabel(gap.end, true) }}</span>
            <span class="gap-verdict" :style="{ color: VERDICT_COLORS[gap.verdict] }">{{ VERDICT_LABELS[gap.verdict] }}</span>
            <span class="gap-actions">
              <button class="evidence-button" :aria-label="`复听空档 ${gap.index + 1}`" @click="listenGap(gap)">
                <Square v-if="breath.playingKey.value === `gap-${gap.index}`" :size="11" fill="currentColor" /><Play v-else :size="11" fill="currentColor" />空档
              </button>
              <button class="evidence-button" :disabled="!gap.listen.left"
                :title="gap.listen.left ? '复听空档前的局部底噪' : '空档前没有可复听的底噪样本'"
                :aria-label="`复听空档 ${gap.index + 1} 前的底噪`" @click="listenBaseline(gap, 'left')">
                <Square v-if="breath.playingKey.value === `base-${gap.index}-left`" :size="11" fill="currentColor" /><Play v-else :size="11" fill="currentColor" />前基准
              </button>
              <button class="evidence-button" :disabled="!gap.listen.right"
                :title="gap.listen.right ? '复听空档后的局部底噪' : '空档后没有可复听的底噪样本'"
                :aria-label="`复听空档 ${gap.index + 1} 后的底噪`" @click="listenBaseline(gap, 'right')">
                <Square v-if="breath.playingKey.value === `base-${gap.index}-right`" :size="11" fill="currentColor" /><Play v-else :size="11" fill="currentColor" />后基准
              </button>
              <button v-if="gap.boundaries.length" class="evidence-button boundary"
                :title="`接界候选 ${gap.boundaries.map(time => clockLabel(time, true)).join('、')}`"
                :aria-label="`复听空档 ${gap.index + 1} 的接界位置`" @click="listenBoundary(gap)">
                <Square v-if="breath.playingKey.value === `boundary-${gap.index}`" :size="11" fill="currentColor" /><Play v-else :size="11" fill="currentColor" />接界
              </button>
            </span>
          </div>
          <div class="gap-meta mono">{{ baselineText(gap) }}</div>
          <p v-for="reason in gap.reasons" :key="reason" class="gap-note">{{ reason }}</p>
          <p v-if="gap.limit" class="gap-limit">{{ gap.limit }}</p>
        </li>
      </ol>

      <div v-if="breath.report.value.unclassified.length" class="breath-unclassified">
        <p><Ear :size="14" /> 无法归类（噪声与气声叠在一起，请用耳朵判断）</p>
        <div v-for="(range, index) in breath.report.value.unclassified" :key="index" class="unclassified-row">
          <span class="mono">{{ clockLabel(range.start, true) }}–{{ clockLabel(range.end, true) }}</span>
          <span class="subdued">{{ range.reason }}</span>
          <button class="evidence-button" :aria-label="`复听无法归类的片段 ${index + 1}`" @click="listenUnclassified(index, range)">
            <Square v-if="breath.playingKey.value === `unclassified-${index}`" :size="11" fill="currentColor" /><Play v-else :size="11" fill="currentColor" />听
          </button>
        </div>
      </div>

      <ul v-if="breath.report.value.notes.length" class="breath-notes">
        <li v-for="note in breath.report.value.notes" :key="note"><Info :size="13" /> {{ note }}</li>
      </ul>
    </template>
    <p v-if="breath.issue.value" class="inline-error" role="alert">{{ breath.issue.value }}</p>
  </section>
</template>
