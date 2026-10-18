// Golden regression over real patterns committed in tests/fixtures/.
// Add a row when adding a pattern; expected values come from a verified run.
import { describe, it, expect } from 'vitest'
import { runDetect } from '../src/pipeline'
import { pack } from '../src/pack'
import { plateSvg } from '../src/out-svg'
import { plateStl } from '../src/out-stl'
import { patternPdf } from '../src/out-pdf'
import { loadPng } from './helpers'

const DEFAULTS = {
  minAreaMm2: 3,
  expandPx: 20,
  simplifyMm: 0.15,
  guideShrinkMm: 0.5,
  lineTol: 48,
  paletteTol: 24,
  plateW: 256,
  plateH: 256,
  gap: 4,
  exclCorner: 'tr' as const,
  exclW: 40,
  exclH: 40,
}

interface Fixture {
  file: string
  patternWmm: number
  patternHmm: number
  pieces: number
  dropped: number
  background: number
  plates: number
  pdfPages: number
  paletteColors: number
}

const FIXTURES: Fixture[] = [
  { file: 'lucky.png', patternWmm: 215.9, patternHmm: 279.4, pieces: 41, dropped: 1, background: 0, plates: 3, pdfPages: 4, paletteColors: 1 },
  { file: 'lucky-colored.png', patternWmm: 215.9, patternHmm: 279.4, pieces: 41, dropped: 3, background: 0, plates: 3, pdfPages: 4, paletteColors: 6 },
  { file: 'cherry-blossoms.png', patternWmm: 215.9, patternHmm: 279.4, pieces: 41, dropped: 13, background: 1, plates: 2, pdfPages: 4, paletteColors: 4 },
]

describe('e2e: real patterns', () => {
  for (const f of FIXTURES) {
    describe(f.file, () => {
      const img = loadPng(f.file)
      const det = runDetect(img, {
        patternWmm: f.patternWmm,
        patternHmm: f.patternHmm,
        minAreaMm2: DEFAULTS.minAreaMm2,
        expandPx: DEFAULTS.expandPx,
        simplifyMm: DEFAULTS.simplifyMm,
        guideShrinkMm: DEFAULTS.guideShrinkMm,
        lineTol: DEFAULTS.lineTol,
        paletteTol: DEFAULTS.paletteTol,
      })
      const packable = det.pieces.filter((p) => p.guideLoopsMm.length > 0)
      const packed = pack(packable, {
        plateW: DEFAULTS.plateW,
        plateH: DEFAULTS.plateH,
        gap: DEFAULTS.gap,
        exclCorner: DEFAULTS.exclCorner,
        exclW: DEFAULTS.exclW,
        exclH: DEFAULTS.exclH,
      })

      it(`detects exactly ${f.pieces} pieces`, () => {
        expect(det.pieces).toHaveLength(f.pieces)
        expect(det.dropped).toBe(f.dropped)
        expect(det.background).toBe(f.background)
      })

      it(`extracts ${f.paletteColors} glass colors covering all pieces`, () => {
        expect(det.palette).toHaveLength(f.paletteColors)
        const total = det.palette.reduce((s, e) => s + e.count, 0)
        expect(total).toBe(f.pieces)
        for (const p of det.pieces) {
          expect(p.colorIdx).toBeGreaterThanOrEqual(0)
          expect(p.colorIdx).toBeLessThan(det.palette.length)
        }
      })

      it(`packs onto ${f.plates} plates with no overflow`, () => {
        expect(packed.plates).toHaveLength(f.plates)
        expect(packed.overflow).toHaveLength(0)
      })

      it('keeps all placements in bounds and out of the exclusion zone', () => {
        for (const pl of packed.plates) {
          for (const pp of pl.pieces) {
            const b = {
              x: pp.piece.guideBoxMm.x + pp.dx,
              y: pp.piece.guideBoxMm.y + pp.dy,
              w: pp.piece.guideBoxMm.w,
              h: pp.piece.guideBoxMm.h,
            }
            expect(b.x).toBeGreaterThanOrEqual(0)
            expect(b.y).toBeGreaterThanOrEqual(0)
            expect(b.x + b.w).toBeLessThanOrEqual(DEFAULTS.plateW + 0.001)
            expect(b.y + b.h).toBeLessThanOrEqual(DEFAULTS.plateH + 0.001)
            const inZone =
              b.x + b.w > DEFAULTS.plateW - DEFAULTS.exclW && b.y < DEFAULTS.exclH
            expect(inZone).toBe(false)
          }
        }
      })

      it('emits non-empty SVG and STL per plate', () => {
        for (const pl of packed.plates) {
          const svg = plateSvg(pl, DEFAULTS.plateW, DEFAULTS.plateH, DEFAULTS.exclCorner, 2)
          expect(svg).toContain('<path')
          const stl = plateStl(pl, { heightMm: 1 })
          expect(new DataView(stl).getUint32(80, true)).toBeGreaterThan(0)
        }
      })

      it(`produces a ${f.pdfPages}-page PDF`, async () => {
        const bytes = await patternPdf(det.pieces, {
          pageWmm: 215.9,
          pageHmm: 279.4,
          overlapMm: 12,
          marginMm: 12.7,
          scalePct: 100,
          lineWmm: 0.9,
          patternWmm: f.patternWmm,
          patternHmm: f.patternHmm,
        })
        const { PDFDocument } = await import('pdf-lib')
        expect((await PDFDocument.load(bytes)).getPageCount()).toBe(f.pdfPages)
      })

      it('is deterministic end to end', () => {
        const again = runDetect(img, {
          patternWmm: f.patternWmm,
          patternHmm: f.patternHmm,
          minAreaMm2: DEFAULTS.minAreaMm2,
          expandPx: DEFAULTS.expandPx,
          simplifyMm: DEFAULTS.simplifyMm,
          guideShrinkMm: DEFAULTS.guideShrinkMm,
          lineTol: DEFAULTS.lineTol,
          paletteTol: DEFAULTS.paletteTol,
        })
        expect(JSON.stringify(again.pieces.map((p) => p.patternLoopsMm))).toBe(
          JSON.stringify(det.pieces.map((p) => p.patternLoopsMm)),
        )
        expect(JSON.stringify(again.palette)).toBe(JSON.stringify(det.palette))
      })
    })
  }
})
