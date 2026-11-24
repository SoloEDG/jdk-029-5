/** 解析本应用录制的 WAV（PCM 16bit），兼容常见的 fmt / data 块布局 */
export function decodeWave(buffer: ArrayBuffer): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(buffer)
  const tag = (offset: number) =>
    String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
  if (view.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('不是 WAV 文件')
  let format: { channels: number; sampleRate: number; bits: number; pcm: boolean } | null = null
  let data: { offset: number; size: number } | null = null
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const size = view.getUint32(offset + 4, true)
    if (tag(offset) === 'fmt ') {
      format = {
        pcm: view.getUint16(offset + 8, true) === 1,
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bits: view.getUint16(offset + 22, true),
      }
    }
    if (tag(offset) === 'data') data = { offset: offset + 8, size: Math.min(size, view.byteLength - offset - 8) }
    offset += 8 + size + (size % 2)
  }
  if (!format?.pcm || format.bits !== 16 || !format.channels || !data) throw new Error('只支持 16 位 PCM 录音')
  const count = Math.floor(data.size / 2 / format.channels)
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index++) {
    samples[index] = view.getInt16(data.offset + index * 2 * format.channels, true) / 32768
  }
  return { samples, sampleRate: format.sampleRate }
}
