/** 从解码后的 PCM 中截取一段（秒，相对于 samples 起点），导出为 WAV Blob 供复听 */
export function cutSnippet(samples: Float32Array, rate: number, from: number, to: number): Blob {
  const first = Math.max(0, Math.min(samples.length, Math.round(from * rate)))
  const last = Math.max(first, Math.min(samples.length, Math.round(to * rate)))
  const length = last - first
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const mark = (offset: number, tag: string) => {
    for (const [index, value] of Array.from(tag).entries()) view.setUint8(offset + index, value.charCodeAt(0))
  }
  mark(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  mark(8, 'WAVE')
  mark(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  mark(36, 'data')
  view.setUint32(40, length * 2, true)
  for (let index = 0; index < length; index++) {
    const value = Math.max(-1, Math.min(1, samples[first + index]))
    view.setInt16(44 + index * 2, Math.round(value * 32767), true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
