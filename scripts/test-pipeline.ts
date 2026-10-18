// Headless pipeline check: tests/fixtures/<name> -> pieces -> plates -> svg/stl/pdf + debug renders.
// Run: npx tsx scripts/test-pipeline.ts [patternWmm patternHmm [patternName]]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { PNG } from 'pngjs'
import { runDetect } from '../src/pipeline'
import { pack } from '../src/pack'
import type { Piece, Plate } from '../src/pack'
import { plateSvg } from '../src/out-svg'
import { plateStl } from '../src/out-stl'
import { patternPdf } from '../src/out-pdf'
import { signedArea, polyHorizontalX } from '../src/geom'
import { PDFDocument } from 'pdf-lib'

const OUT = new URL('../out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const wmm = parseFloat(process.argv[2] ?? '215.9')
const hmm = parseFloat(process.argv[3] ?? '279.4')
const name = process.argv[4] ?? 'lucky.png'

const png = PNG.sync.read(readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url).pathname))
const img = {
  width: png.width,
  height: png.height,
  data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
} as ImageData

const params = {
  patternWmm: wmm, patternHmm: hmm, minAreaMm2: 3, expandPx: 20,
  simplifyMm: 0.15, guideShrinkMm: 0.5, lineTol: 48, paletteTol: 24,
}
const det = runDetect(img, params)
console.log(`${name} @ ${wmm}x${hmm}mm | image ${det.imgW}x${det.imgH} | pieces=${det.pieces.length} dropped=${det.dropped} bg=${det.background}`)
console.log(`line color: ${det.lineRgb ? `rgb(${det.lineRgb.join(',')})` : 'none'}`)
det.palette.forEach((e, i) => console.log(`  palette #${i + 1}: rgb(${e.rgb.join(',')}) x${e.count}`))

const mmX = wmm / det.imgW
const mmY = hmm / det.imgH
let badArea = 0
for (const p of det.pieces) {
  const polyArea = Math.abs(signedArea(p.patternLoopsMm[0]))
  const pxAreaMm = p.areaPx * mmX * mmY
  const relErr = Math.abs(polyArea - pxAreaMm) / pxAreaMm
  if (relErr > 0.15) {
    badArea++
    console.log(`  piece ${p.id}: polyArea=${polyArea.toFixed(1)} pxArea=${pxAreaMm.toFixed(1)}`)
  }
}
console.log(`area sanity: ${badArea} pieces >15% off`)

// --- debug rasterizer: fill piece polygons even-odd, palette colors ---
const colorOf = (p: Piece): [number, number, number] =>
  det.palette[p.colorIdx]?.rgb ?? p.fillRgb

function render(loopsList: { loops: { x: number; y: number }[][]; piece: Piece }[], wmm2: number, hmm2: number, s: number, name: string) {
  const W = Math.round(wmm2 * s)
  const H = Math.round(hmm2 * s)
  const out = PNG.sync.write ? new PNG({ width: W, height: H }) : null
  if (!out) return
  out.data.fill(255)
  for (const item of loopsList) {
    const [r, g, b] = colorOf(item.piece)
    const allXs: number[][] = []
    for (let py = 0; py < H; py++) {
      const ymm = (py + 0.5) / s
      allXs.length = 0
      for (const loop of item.loops) allXs.push(polyHorizontalX(loop, ymm))
      const xs = allXs.flat().sort((a, b2) => a - b2)
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = Math.ceil(xs[i] * s - 0.5)
        const x1 = Math.ceil(xs[i + 1] * s - 0.5) - 1
        for (let px = x0; px <= x1; px++) {
          if (px < 0 || px >= W) continue
          const o = (py * W + px) * 4
          out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b; out.data[o + 3] = 255
        }
      }
    }
  }
  writeFileSync(`${OUT}${name}`, PNG.sync.write(out))
}

render(det.pieces.map((p) => ({ loops: p.patternLoopsMm, piece: p })), wmm, hmm, 3300 / hmm, `debug-pieces-${name}`)

const packable = det.pieces.filter((p) => p.guideLoopsMm.length > 0)
if (packable.length !== det.pieces.length) {
  console.log(`  ${det.pieces.length - packable.length} pieces vanished under guide shrink`)
}
const packed = pack(packable, {
  plateW: 256, plateH: 256, gap: 4,
  exclCorner: 'tr', exclW: 40, exclH: 40,
})
console.log(`plates=${packed.plates.length}, overflow=${packed.overflow.length}`)
packed.plates.forEach((pl: Plate, i: number) => {
  let bad = 0
  for (const pp of pl.pieces) {
    const bx = pp.piece.guideBoxMm.x + pp.dx
    const by = pp.piece.guideBoxMm.y + pp.dy
    if (bx < -0.01 || by < -0.01 || bx + pp.piece.guideBoxMm.w > 256.01 || by + pp.piece.guideBoxMm.h > 256.01) bad++
    if (bx + pp.piece.guideBoxMm.w > 256 - 40 && by < 40) {
      bad++
      console.log(`  plate ${i + 1} piece ${pp.piece.id} INTRUDES exclusion`)
    }
  }
  console.log(`  plate ${i + 1}: ${pl.pieces.length} pieces, ${bad} errors`)

  render(
    pl.pieces.map((pp) => ({
      piece: pp.piece,
      loops: pp.piece.guideLoopsMm.map((l) => l.map((q) => ({ x: q.x + pp.dx, y: q.y + pp.dy }))),
    })),
    256, 256, 3, `debug-plate-${i + 1}.png`,
  )
  writeFileSync(`${OUT}plate-${i + 1}.svg`, plateSvg(pl, 256, 256, 'tr', 2))
  const stl = plateStl(pl, { heightMm: 1 })
  writeFileSync(`${OUT}plate-${i + 1}.stl`, Buffer.from(stl))
  console.log(`    svg ${(plateSvg(pl, 256, 256, 'tr', 2).length / 1024).toFixed(0)}KB, stl ${new DataView(stl).getUint32(80, true)} tris`)
})

const pdf = await patternPdf(det.pieces, {
  pageWmm: 215.9, pageHmm: 279.4, overlapMm: 12, marginMm: 12.7,
  scalePct: 100, lineWmm: 0.6,
  patternWmm: wmm, patternHmm: hmm,
})
writeFileSync(`${OUT}pattern.pdf`, pdf)
const reloaded = await PDFDocument.load(pdf)
console.log(`pattern.pdf: ${reloaded.getPageCount()} pages, ${(pdf.length / 1024).toFixed(0)}KB`)
