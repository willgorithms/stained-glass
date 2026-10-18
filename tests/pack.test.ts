import { describe, it, expect } from 'vitest'
import { pack } from '../src/pack'
import type { Piece, PackOpts } from '../src/pack'
import { mkRectPiece } from './helpers'

const OPTS: PackOpts = {
  plateW: 100, plateH: 100, gap: 5,
  exclCorner: 'none', exclW: 0, exclH: 0,
}

const placed = (plates: { pieces: { piece: Piece; dx: number; dy: number }[] }[]) =>
  plates.flatMap((pl) => pl.pieces)

const bounds = (pp: { piece: Piece; dx: number; dy: number }) => ({
  x: pp.piece.guideBoxMm.x + pp.dx,
  y: pp.piece.guideBoxMm.y + pp.dy,
  w: pp.piece.guideBoxMm.w,
  h: pp.piece.guideBoxMm.h,
})

describe('pack', () => {
  it('places pieces side by side on one shelf', () => {
    const { plates } = pack([mkRectPiece(1, 40, 20), mkRectPiece(2, 40, 20)], OPTS)
    expect(plates).toHaveLength(1)
    const [a, b] = placed(plates)
    expect(a.piece.id).toBe(1)
    expect(bounds(a).x).toBe(0)
    expect(bounds(b).x).toBe(45) // after w + gap
    expect(bounds(a).y).toBe(0)
    expect(bounds(b).y).toBe(0)
  })

  it('wraps to a new shelf when the row is full, then backfills it', () => {
    const { plates } = pack(
      [mkRectPiece(1, 60, 20), mkRectPiece(2, 60, 20), mkRectPiece(3, 30, 10)],
      OPTS,
    )
    expect(plates).toHaveLength(1)
    const ps = placed(plates)
    const second = ps.find((p) => p.piece.id === 2)!
    expect(bounds(second).y).toBeCloseTo(25) // shelf 2: shelf1 h=20 + gap 5
    const third = ps.find((p) => p.piece.id === 3)!
    // backfilled onto the tail of shelf 1 (first-fit visits older shelves first)
    expect(bounds(third).y).toBeCloseTo(0)
    expect(bounds(third).x).toBeCloseTo(65)
  })

  it('backfills the leftover band of a closed plate', () => {
    // two 60mm pieces force a second plate; the 30mm piece then backfills
    // plate 1's remaining vertical space instead of landing on plate 2
    const { plates } = pack(
      [mkRectPiece(1, 90, 60), mkRectPiece(2, 90, 60), mkRectPiece(3, 30, 30)],
      OPTS,
    )
    expect(plates).toHaveLength(2)
    const p1 = plates[0].pieces.map((p) => p.piece.id).sort()
    expect(p1).toEqual([1, 3])
    expect(plates[1].pieces.map((p) => p.piece.id)).toEqual([2])
  })

  it('starts a new plate when out of height', () => {
    const { plates } = pack(
      [mkRectPiece(1, 90, 60), mkRectPiece(2, 90, 60)],
      OPTS,
    )
    expect(plates).toHaveLength(2)
    expect(plates[0].pieces[0].piece.id).toBe(1)
    expect(plates[1].pieces[0].piece.id).toBe(2)
  })

  it('sorts tallest first', () => {
    const { plates } = pack(
      [mkRectPiece(1, 10, 10), mkRectPiece(2, 10, 50), mkRectPiece(3, 10, 30)],
      OPTS,
    )
    expect(plates[0].pieces.map((p) => p.piece.id)).toEqual([2, 3, 1])
  })

  it('keeps pieces out of a top-right exclusion zone', () => {
    const o: PackOpts = { ...OPTS, exclCorner: 'tr', exclW: 40, exclH: 40 }
    const { plates } = pack([mkRectPiece(1, 80, 30), mkRectPiece(2, 80, 30)], o)
    for (const pp of placed(plates)) {
      const b = bounds(pp)
      const inZone = b.x + b.w > 60 && b.y < 40
      expect(inZone).toBe(false)
    }
  })

  it('keeps pieces out of a bottom-left exclusion zone', () => {
    const o: PackOpts = { ...OPTS, exclCorner: 'bl', exclW: 30, exclH: 30 }
    // tall piece forces bottom placement
    const { plates } = pack([mkRectPiece(1, 25, 95), mkRectPiece(2, 25, 95)], o)
    for (const pp of placed(plates)) {
      const b = bounds(pp)
      const inZone = b.x < 30 && b.y + b.h > 70
      expect(inZone).toBe(false)
    }
  })

  it('hops a fully-blocked shelf band below the exclusion zone', () => {
    // exclusion covering the entire width at top: nothing fits until below it
    const o: PackOpts = { ...OPTS, exclCorner: 'tl', exclW: 100, exclH: 20 }
    const { plates } = pack([mkRectPiece(1, 30, 10)], o)
    const b = bounds(plates[0].pieces[0])
    expect(b.y).toBeGreaterThanOrEqual(20)
  })

  it('sends oversized pieces to overflow', () => {
    const { plates, overflow } = pack([mkRectPiece(1, 150, 10), mkRectPiece(2, 50, 10)], OPTS)
    expect(overflow.map((p) => p.id)).toEqual([1])
    expect(plates[0].pieces.map((p) => p.piece.id)).toEqual([2])
  })

  it('never duplicates or loses pieces', () => {
    const input = Array.from({ length: 30 }, (_, i) =>
      mkRectPiece(i + 1, 10 + (i % 4) * 8, 8 + (i % 3) * 9),
    )
    const { plates, overflow } = pack(input, OPTS)
    const ids = [...placed(plates).map((p) => p.piece.id), ...overflow.map((p) => p.id)].sort(
      (a, b) => a - b,
    )
    expect(ids).toEqual(input.map((p) => p.id))
  })

  it('does not overlap pieces on a plate', () => {
    const input = Array.from({ length: 25 }, (_, i) =>
      mkRectPiece(i + 1, 15 + (i % 5) * 6, 10 + (i % 4) * 7),
    )
    const { plates } = pack(input, OPTS)
    for (const pl of plates) {
      const bs = pl.pieces.map(bounds)
      for (let i = 0; i < bs.length; i++) {
        for (let j = i + 1; j < bs.length; j++) {
          const a = bs[i], b = bs[j]
          const overlap =
            a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
          expect(overlap).toBe(false)
        }
      }
    }
  })

  it('is deterministic', () => {
    const input = Array.from({ length: 25 }, (_, i) =>
      mkRectPiece(i + 1, 15 + (i % 5) * 6, 10 + (i % 4) * 7),
    )
    const a = pack(input, OPTS)
    const b = pack(input, OPTS)
    expect(JSON.stringify(a.plates)).toBe(JSON.stringify(b.plates))
  })
})
