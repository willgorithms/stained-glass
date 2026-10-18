import { describe, it, expect } from 'vitest'
import { runDetect } from '../src/pipeline'
import { mkImg, RED, BLACK } from './helpers'
import { signedArea } from '../src/geom'

const P = { minAreaMm2: 3, simplifyMm: 0.15, guideShrinkMm: 0, lineTol: 48, paletteTol: 24 }

describe('runDetect', () => {
  const cross = mkImg(40, 40, (x, y) =>
    (x >= 18 && x <= 21) || (y >= 18 && y <= 21) ? BLACK : RED,
  )

  it('scales pixels to mm by declared size', () => {
    const r = runDetect(cross, { ...P, patternWmm: 80, patternHmm: 80 })
    // 40px declared as 80mm => 2mm/px; each quadrant ~19px wide => ~38mm
    for (const p of r.pieces) {
      expect(p.patternBoxMm.w).toBeGreaterThan(30)
      expect(p.patternBoxMm.w).toBeLessThan(45)
    }
  })

  it('assigns IDs in row-major order', () => {
    const r = runDetect(cross, { ...P, patternWmm: 40, patternHmm: 40 })
    expect(r.pieces).toHaveLength(4)
    const byId = Object.fromEntries(r.pieces.map((p) => [p.id, p.centroidMm]))
    // top row (y<20): left piece first; bottom row after
    expect(byId[1].x).toBeLessThan(byId[2].x)
    expect(byId[1].y).toBeLessThan(20)
    expect(byId[3].y).toBeGreaterThan(20)
    expect(byId[3].x).toBeLessThan(byId[4].x)
  })

  it('drops specks below minAreaMm2', () => {
    const img = mkImg(50, 50, (x, y) => {
      if (x >= 10 && x < 40 && y >= 10 && y < 40) return RED
      if (x === 2 && y === 2) return RED // 1px speck
      return BLACK
    })
    const r = runDetect(img, { ...P, patternWmm: 50, patternHmm: 50, minAreaMm2: 5 })
    expect(r.dropped).toBe(1)
    expect(r.pieces).toHaveLength(1)
  })

  it('outline area tracks pixel area', () => {
    const r = runDetect(cross, { ...P, patternWmm: 40, patternHmm: 40 })
    for (const p of r.pieces) {
      const polyArea = Math.abs(signedArea(p.patternLoopsMm[0]))
      expect(polyArea).toBeGreaterThan(200) // ~19x19mm minus line half-widths
      expect(polyArea).toBeLessThan(450)
    }
  })

  it('simplified polygons stay small but faithful', () => {
    const r = runDetect(cross, { ...P, patternWmm: 40, patternHmm: 40, simplifyMm: 0.5 })
    for (const p of r.pieces) {
      expect(p.patternLoopsMm[0].length).toBeLessThan(60)
      expect(p.patternLoopsMm[0].length).toBeGreaterThanOrEqual(3)
    }
  })

  it('clusters piece fills into a glass palette', () => {
    // 4 quadrants: two near-reds (merge), one blue, one green
    const img = mkImg(80, 40, (x, y) => {
      if ((x >= 38 && x <= 41) || (y >= 18 && y <= 21)) return BLACK
      if (x < 38 && y < 18) return [200, 30, 30, 255]
      if (x < 38) return [205, 35, 28, 255]
      if (y < 18) return [30, 120, 200, 255]
      return [40, 180, 60, 255]
    })
    const r = runDetect(img, { ...P, patternWmm: 80, patternHmm: 40 })
    expect(r.pieces).toHaveLength(4)
    expect(r.palette).toHaveLength(3)
    const total = r.palette.reduce((s, e) => s + e.count, 0)
    expect(total).toBe(4)
    expect(Math.max(...r.palette.map((e) => e.count))).toBe(2) // merged reds
    for (const p of r.pieces) {
      expect(p.colorIdx).toBeGreaterThanOrEqual(0)
      expect(p.colorIdx).toBeLessThan(r.palette.length)
    }
  })

  it('respects paletteTol for distinct colors', () => {
    const img = mkImg(40, 20, (x) =>
      x >= 18 && x <= 21 ? BLACK : x < 18 ? [200, 30, 30, 255] : [160, 60, 40, 255],
    )
    const merged = runDetect(img, { ...P, patternWmm: 40, patternHmm: 20, paletteTol: 60 })
    const split = runDetect(img, { ...P, patternWmm: 40, patternHmm: 20, paletteTol: 10 })
    expect(merged.palette).toHaveLength(1)
    expect(split.palette).toHaveLength(2)
  })

  it('is deterministic', () => {
    const a = runDetect(cross, { ...P, patternWmm: 40, patternHmm: 40 })
    const b = runDetect(cross, { ...P, patternWmm: 40, patternHmm: 40 })
    expect(JSON.stringify(a.pieces)).toBe(JSON.stringify(b.pieces))
  })

  it('guide shrink pulls in only the seam sides of each guide', () => {
    const r = runDetect(cross, { ...P, patternWmm: 40, patternHmm: 40, guideShrinkMm: 2 })
    for (const p of r.pieces) {
      expect(p.guideLoopsMm.length).toBeGreaterThan(0)
      // every piece is a corner quadrant: erodes on its 2 seam sides only,
      // outer (image-edge) sides stay true-size
      expect(p.guideBoxMm.w).toBeCloseTo(p.patternBoxMm.w - 2, 0)
      expect(p.guideBoxMm.h).toBeCloseTo(p.patternBoxMm.h - 2, 0)
      expect(p.patternBoxMm.w).toBeGreaterThan(15)
    }
  })
})
