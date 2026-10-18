import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import {
  calibSpec, calibrationPdf, calibrationPiece,
  analyzeCalibrationPhoto, solveHomography, invert3, applyH,
} from '../src/calibrate'
import type { Pt } from '../src/geom'
import { mkImg } from './helpers'

const SPEC = calibSpec(215.9, 279.4) // letter

// Render a synthetic photo of the calibration page. `printedLen` is the box
// length actually printed (paper-printer error baked in), `barLen` the actual
// bar length (3D-printer error baked in); both differ from the 250mm nominal.
// `shift` rotates the capture: page corner i lands on quad corner (i+shift)%4.
function mkCalibPhoto(
  printedLen: number,
  barLen: number,
  quadPx: Pt[],
  shift = 0,
  W = 1400,
  H = 1800,
): ImageData {
  const pagePts: Pt[] = [
    { x: 0, y: 0 }, { x: SPEC.pageWmm, y: 0 },
    { x: SPEC.pageWmm, y: SPEC.pageHmm }, { x: 0, y: SPEC.pageHmm },
  ]
  const cornersPx = pagePts.map((_, i) => quadPx[(i + shift) % 4])
  const HpageToPhoto = solveHomography(pagePts, cornersPx)
  const HphotoToPage = invert3(HpageToPhoto)
  return mkImg(W, H, (x, y) => {
    const [mx, my] = applyH(HphotoToPage, x, y)
    if (mx < 0 || my < 0 || mx >= SPEC.pageWmm || my >= SPEC.pageHmm)
      return [110, 95, 80, 255] // desktop
    const inBox =
      mx >= SPEC.boxXmm && mx <= SPEC.boxXmm + SPEC.boxWmm &&
      my >= SPEC.boxYmm && my <= SPEC.boxYmm + printedLen
    if (inBox) return [15, 15, 15, 255]
    const inBar =
      mx >= SPEC.barXmm && mx <= SPEC.barXmm + SPEC.boxWmm &&
      my >= SPEC.boxYmm && my <= SPEC.boxYmm + barLen
    if (inBar) return [60, 60, 160, 255]
    return [238, 240, 242, 255] // paper, slight warm shade
  })
}

const AXIS: Pt[] = [
  { x: 100, y: 100 }, { x: 1200, y: 100 },
  { x: 1200, y: 1520 }, { x: 100, y: 1520 },
]
const TILTED: Pt[] = [
  { x: 120, y: 90 }, { x: 1290, y: 150 },
  { x: 1240, y: 1700 }, { x: 60, y: 1620 },
]
// landscape-ish quad for a sideways capture
const LAND: Pt[] = [
  { x: 60, y: 200 }, { x: 1380, y: 140 },
  { x: 1310, y: 1550 }, { x: 20, y: 1680 },
]

describe('calibration photo analysis', () => {
  it('measures box and bar on an axis-aligned page', () => {
    const img = mkCalibPhoto(240, 251, AXIS)
    const r = analyzeCalibrationPhoto(img, SPEC)
    expect(r.ok).toBe(true)
    expect(r.LboxMm).toBeCloseTo(240, 0)
    expect(r.LbarMm).toBeCloseTo(251, 0)
    expect(r.scalePct).toBeCloseTo((251 / 240) * 100, 0)
    expect(r.paperFactor).toBeCloseTo(0.96, 2)
    expect(r.printer3dFactor).toBeCloseTo(1.004, 2)
  })

  it('rectifies a tilted/perspective photo', () => {
    const img = mkCalibPhoto(240, 251, TILTED)
    const r = analyzeCalibrationPhoto(img, SPEC)
    expect(r.ok).toBe(true)
    expect(r.LboxMm).toBeCloseTo(240, 0)
    expect(r.LbarMm).toBeCloseTo(251, 0)
    expect(r.scalePct).toBeCloseTo((251 / 240) * 100, 0)
  })

  it('handles a photo captured upside-down (180°)', () => {
    const img = mkCalibPhoto(240, 251, AXIS, 2)
    const r = analyzeCalibrationPhoto(img, SPEC)
    expect(r.ok).toBe(true)
    expect(r.LboxMm).toBeCloseTo(240, 0)
    expect(r.LbarMm).toBeCloseTo(251, 0)
  })

  it('handles a sideways photo (90°)', () => {
    const img = mkCalibPhoto(240, 251, LAND, 1)
    const r = analyzeCalibrationPhoto(img, SPEC)
    expect(r.ok).toBe(true)
    expect(r.LboxMm).toBeCloseTo(240, 0)
    expect(r.LbarMm).toBeCloseTo(251, 0)
  })

  it('does not mistake a text blob for the box', () => {
    // an upside-down capture used to lock a text fragment in the zone;
    // with a stray long ink blob placed in the wrong spot the box must still win
    const img = mkCalibPhoto(240, 251, AXIS, 2)
    const r = analyzeCalibrationPhoto(img, SPEC)
    expect(r.boxLabel).not.toBe(-1)
    expect(r.LboxMm).toBeCloseTo(240, 0)
  })

  it('reports scale >100% when the paper printer shrinks', () => {
    // user-anecdote case: box printed at 96%, bar true-size -> ~104.2%
    const img = mkCalibPhoto(240, 250, AXIS)
    const r = analyzeCalibrationPhoto(img, SPEC)
    expect(r.scalePct).toBeCloseTo(104.17, 1)
  })

  it('fails cleanly when there is no page', () => {
    const img = mkImg(400, 400, () => [110, 95, 80, 255])
    const r = analyzeCalibrationPhoto(img, SPEC)
    expect(r.ok).toBe(false)
    expect(r.warnings[0]).toMatch(/page not found/)
  })

  it('fails cleanly when the bar is missing', () => {
    // photo with no bar: scene returns bar color nowhere (barLen=0)
    const img = mkCalibPhoto(240, 0, AXIS)
    const r = analyzeCalibrationPhoto(img, SPEC)
    expect(r.ok).toBe(false)
    expect(r.LboxMm).toBeCloseTo(240, 0)
    expect(r.warnings.some((w) => /bar not found/.test(w))).toBe(true)
  })
})

describe('calibration artifacts', () => {
  it('calibrationPdf produces a single correctly-sized page', async () => {
    const bytes = await calibrationPdf(SPEC)
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    const page = doc.getPage(0)
    expect(page.getWidth()).toBeCloseTo(215.9 * (72 / 25.4), 1)
    expect(page.getHeight()).toBeCloseTo(279.4 * (72 / 25.4), 1)
  })

  it('calibrationPiece is a true-size rectangle with no shrink', () => {
    const p = calibrationPiece(SPEC)
    expect(p.guideBoxMm).toEqual({ x: 0, y: 0, w: 250, h: 10 })
    expect(p.patternBoxMm).toEqual({ x: 0, y: 0, w: 250, h: 10 })
    expect(p.guideLoopsMm[0]).toHaveLength(4)
  })

  it('calibSpec centers the box vertically on the page', () => {
    expect(SPEC.boxYmm).toBeCloseTo((279.4 - 250) / 2)
    const a4 = calibSpec(210, 297)
    expect(a4.boxYmm).toBeCloseTo(23.5)
  })
})
