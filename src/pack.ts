import type { Pt, Box } from './geom'

/** A glass piece in mm space, ready for packing and output. */
export interface Piece {
  /** 1-based number shown on the pattern PDF and stamped on the piece. */
  id: number
  /** True outline `[outer, ...holes]` at line center — used for the printed pattern. */
  patternLoopsMm: Pt[][]
  patternBoxMm: Box
  /** Shrunk outline for printed guides; `[]` if it vanished under shrink. */
  guideLoopsMm: Pt[][]
  guideBoxMm: Box
  centroidMm: Pt
  /** Dominant interior fill color from the source image. */
  fillRgb: [number, number, number]
  /** Index into the clustered palette. */
  colorIdx: number
  areaPx: number
}

/** A piece translated onto a plate: rendered loops are `loopsMm + (dx, dy)`. */
export interface PlacedPiece {
  piece: Piece
  dx: number
  dy: number
}

/** One physical guide plate holding placed pieces. */
export interface Plate {
  pieces: PlacedPiece[]
}

/** Plate corner reserved for hardware (e.g. a bed-slinger clip); `none` disables. */
export type ExclCorner = 'none' | 'tl' | 'tr' | 'br' | 'bl'

/** Plate geometry for {@link pack}, all in mm. */
export interface PackOpts {
  plateW: number
  plateH: number
  /** Minimum spacing between pieces on a plate. */
  gap: number
  exclCorner: ExclCorner
  /** Width of the corner exclusion zone. */
  exclW: number
  /** Height of the corner exclusion zone. */
  exclH: number
}

interface Shelf {
  y: number
  h: number
  ints: Array<[number, number]> // usable x-intervals (exclusion zone applied)
  xCur: number
}

/**
 * Shelf packing with backfill: sort pieces by height desc, then first-fit each
 * piece through every open shelf on every plate (oldest plate first) before
 * opening a new shelf on the last plate or a fresh plate. When a plate closes,
 * its leftover vertical band is recorded as a shelf so later small pieces can
 * still fill it. Deterministic: same input, same layout.
 *
 * Returns the packed plates plus any `overflow` pieces too large to fit.
 */
export function pack(pieces: Piece[], o: PackOpts): { plates: Plate[]; overflow: Piece[] } {
  const excl =
    o.exclCorner === 'none' || o.exclW <= 0 || o.exclH <= 0
      ? null
      : {
          x0: o.exclCorner === 'tl' || o.exclCorner === 'bl' ? 0 : o.plateW - o.exclW,
          x1: o.exclCorner === 'tl' || o.exclCorner === 'bl' ? o.exclW : o.plateW,
          y0: o.exclCorner === 'tl' || o.exclCorner === 'tr' ? 0 : o.plateH - o.exclH,
          y1: o.exclCorner === 'tl' || o.exclCorner === 'tr' ? o.exclH : o.plateH,
        }

  const intervals = (y: number, h: number): Array<[number, number]> => {
    if (!excl || y + h <= excl.y0 || y >= excl.y1) return [[0, o.plateW]]
    const out: Array<[number, number]> = []
    if (excl.x0 > 0) out.push([0, excl.x0])
    if (excl.x1 < o.plateW) out.push([excl.x1, o.plateW])
    return out
  }

  const order = pieces
    .slice()
    .sort((a, b) => b.guideBoxMm.h - a.guideBoxMm.h || b.guideBoxMm.w - a.guideBoxMm.w || a.id - b.id)

  const plates: { plate: Plate; shelves: Shelf[] }[] = [{ plate: { pieces: [] }, shelves: [] }]
  const overflow: Piece[] = []

  const tryPlace = (p: Piece, s: Shelf, pl: Plate): boolean => {
    if (p.guideBoxMm.h > s.h) return false
    for (const [x0, x1] of s.ints) {
      const x = Math.max(s.xCur, x0)
      if (x + p.guideBoxMm.w <= x1) {
        pl.pieces.push({
          piece: p,
          dx: x - p.guideBoxMm.x,
          dy: s.y - p.guideBoxMm.y,
        })
        s.xCur = x + p.guideBoxMm.w + o.gap
        return true
      }
    }
    return false
  }

  // open a shelf on plate `pl` at y (hopping the exclusion band if needed);
  // returns false if the piece doesn't fit vertically
  const openShelf = (pl: (typeof plates)[number], y: number, h: number): boolean => {
    let ints = intervals(y, h)
    if (ints.length === 0 && excl && y + h > excl.y0 && y < excl.y1) {
      y = excl.y1
      ints = intervals(y, h)
    }
    if (ints.length === 0 || y + h > o.plateH) return false
    pl.shelves.push({ y, h, ints, xCur: ints[0][0] })
    return true
  }

  for (const p of order) {
    const w = p.guideBoxMm.w
    const h = p.guideBoxMm.h
    if (w > o.plateW || h > o.plateH) {
      overflow.push(p)
      continue
    }

    // first-fit across every existing shelf, oldest plate first
    let placed = false
    for (const pl of plates) {
      for (const s of pl.shelves) {
        if (tryPlace(p, s, pl.plate)) {
          placed = true
          break
        }
      }
      if (placed) break
    }
    if (placed) continue

    // open a shelf on the last plate, or close it and start a new one
    const last = plates[plates.length - 1]
    const top = last.shelves.length
      ? last.shelves[last.shelves.length - 1].y +
        last.shelves[last.shelves.length - 1].h +
        o.gap
      : 0
    if (openShelf(last, top, h) && tryPlace(p, last.shelves[last.shelves.length - 1], last.plate)) {
      continue
    }

    // last plate is full: expose its leftover vertical band for backfill
    const remY = last.shelves.length
      ? last.shelves[last.shelves.length - 1].y +
        last.shelves[last.shelves.length - 1].h +
        o.gap
      : 0
    const remH = o.plateH - remY
    if (remH > 0) {
      const ri = intervals(remY, remH)
      last.shelves.push({ y: remY, h: remH, ints: ri, xCur: ri.length ? ri[0][0] : 0 })
    }

    plates.push({ plate: { pieces: [] }, shelves: [] })
    const fresh = plates[plates.length - 1]
    if (!(openShelf(fresh, 0, h) && tryPlace(p, fresh.shelves[0], fresh.plate))) {
      overflow.push(p) // fits the plate dims but not the usable x-intervals
    }
  }

  const out = plates.map((pl) => pl.plate).filter((pl, i) => i === 0 || pl.pieces.length > 0)
  return { plates: out, overflow }
}
