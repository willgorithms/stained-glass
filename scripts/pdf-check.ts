import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { runDetect } from '../src/pipeline'
import { patternPdf } from '../src/out-pdf'

const png = PNG.sync.read(readFileSync('tests/fixtures/lucky-colored.png'))
const img = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength), colorSpace: 'srgb' } as ImageData
const det = runDetect(img, {
  patternWmm: 215.9, patternHmm: 279.4, minAreaMm2: 3,
  simplifyMm: 0.15, guideShrinkMm: 0, lineTol: 48, paletteTol: 24,
})
console.log('pieces:', det.pieces.length, 'lead loops:', det.leadLoopsMm.length)
const bytes = await patternPdf(det.pieces, {
  pageWmm: 215.9, pageHmm: 279.4, overlapMm: 12, marginMm: 0,
  scalePct: 100, lineWmm: 0.9, patternWmm: 215.9, patternHmm: 279.4,
  leadLoopsMm: det.leadLoopsMm,
})
writeFileSync('/tmp/pattern-check.pdf', bytes)
console.log('wrote /tmp/pattern-check.pdf')
