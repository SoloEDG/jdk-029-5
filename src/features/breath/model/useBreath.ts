import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import type { GuideNote, LyricLine, Take, TimeRange } from '../../../shared/document'
import { analyzeTake, type BreathReport } from '../lib/analyze'
import { decodeWave } from '../lib/decode'
import { cutSnippet } from '../lib/snippet'

interface CachedTake {
  samples: Float32Array
  rate: number
  report: BreathReport
}

export function useBreath(takes: Ref<Take[]>, line: Ref<LyricLine | null>, notes: Ref<readonly GuideNote[]>) {
  const takeId = ref<string | null>(null)
  const report = shallowRef<BreathReport | null>(null)
  const issue = ref('')
  const analyzing = ref(false)
  const playingKey = ref<string | null>(null)
  const cache = new Map<string, CachedTake>()
  const player = new Audio()
  let source: string | null = null
  let token = 0

  const take = computed(() => takes.value.find(item => item.id === takeId.value) ?? takes.value[0] ?? null)

  watch(takes, list => {
    if (takeId.value && !list.some(item => item.id === takeId.value)) takeId.value = null
    for (const id of [...cache.keys()]) {
      if (!list.some(item => item.id === id)) cache.delete(id)
    }
  })

  function stop() {
    player.pause()
    if (source) {
      player.removeAttribute('src')
      player.load()
      URL.revokeObjectURL(source)
      source = null
    }
    playingKey.value = null
  }

  watch([take, line, notes], async ([current, currentLine, currentNotes]) => {
    stop()
    report.value = null
    issue.value = ''
    if (!current || !currentLine) return
    const own = ++token
    analyzing.value = true
    try {
      let cached = cache.get(current.id)
      if (!cached) {
        const decoded = decodeWave(await current.audio.arrayBuffer())
        cached = {
          samples: decoded.samples,
          rate: decoded.sampleRate,
          report: analyzeTake({
            samples: decoded.samples,
            sampleRate: decoded.sampleRate,
            start: current.start,
            end: current.end,
            line: currentLine,
            notes: currentNotes,
            pitch: current.pitch,
          }),
        }
        cache.set(current.id, cached)
        if (cache.size > 6) cache.delete(cache.keys().next().value!)
      }
      if (own !== token) return
      report.value = cached.report
    } catch {
      if (own === token) issue.value = '无法分析这条录音。'
    } finally {
      if (own === token) analyzing.value = false
    }
  }, { immediate: true })

  async function play(key: string, range: TimeRange) {
    if (playingKey.value === key) {
      stop()
      return
    }
    stop()
    const current = take.value
    const cached = current && cache.get(current.id)
    if (!current || !cached) return
    issue.value = ''
    const from = Math.max(0, range.start - current.start)
    const to = Math.min(current.end - current.start, range.end - current.start)
    if (to - from < 0.05) return
    source = URL.createObjectURL(cutSnippet(cached.samples, cached.rate, from, to))
    player.src = source
    playingKey.value = key
    try {
      await player.play()
    } catch {
      if (playingKey.value === key) {
        stop()
        issue.value = '无法播放这段音频。'
      }
    }
  }

  player.addEventListener('ended', stop)
  onBeforeUnmount(() => {
    player.removeEventListener('ended', stop)
    stop()
  })
  return { takeId, take, report, analyzing, issue, playingKey, play, stop }
}
