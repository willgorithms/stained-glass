import { describe, it, expect } from 'vitest'
import { patternPdf } from '../src/out-pdf'
import { mkRectPiece } from './helpers'
import type { Piece } from '../src/pack'
import { PDFDocument } from 'pdf-lib'

const LETTER = { pageWmm: 215.9, pageHmm: 279.4 }

function piecesIn(w: number, h: number): Piece[] {
  // four pieces covering a w×h pattern
  const mk = (id: number, x: number, y: number) => {
    const p = mkRectPiece(id, w / 2, h / 2)
    p.patternLoopsMm = [p.patternLoopsMm[0].map((q) => ({ x: q.x + x, y: q.y + y }))]
    p.centroidMm = { x: x + w / 4, y: y + h / 4 }
    p.patternBoxMm = { x, y, w: w / 2, h: h / 2 }
    return p
  }
  return [mk(1, 0, 0), mk(2, w / 2, 0), mk(3, 0, h / 2), mk(4, w / 2, h / 2)]
}

const optsFor = (w: number, h: number, scalePct = 100, marginMm = 0) => ({
  ...LETTER,
  overlapMm: 12,
  marginMm,
  scalePct,
  lineWmm: 0.9,
  patternWmm: w,
  patternHmm: h,
})

describe('patternPdf', () => {
  it('fits a letter-size pattern on one page', async () => {
    const bytes = await patternPdf(piecesIn(215.9, 279.4), optsFor(215.9, 279.4))
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getPage(0).getSize().width).toBeCloseTo(215.9 * (72 / 25.4), 1)
  })

  it('tiles a big pattern across a grid', async () => {
    const bytes = await patternPdf(piecesIn(500, 500), optsFor(500, 500))
    const doc = await PDFDocument.load(bytes)
    // cols: step 203.9 -> 1 + ceil(284.1/203.9) = 3; rows: step 267.4 -> 1 + ceil(220.6/267.4) = 2
    expect(doc.getPageCount()).toBe(6)
  })

  it('print scale grows the tile count', async () => {
    const bytes = await patternPdf(piecesIn(150, 150), optsFor(150, 150, 200))
    const doc = await PDFDocument.load(bytes)
    // drawn at 300mm: cols = 1 + ceil(84.1/203.9) = 2, rows = 2 -> 4 pages
    expect(doc.getPageCount()).toBe(4)
  })

  it('with a printer margin, tiles over the printable area', async () => {
    // margin 12.7mm: tile = 190.5 x 254 -> letter-size pattern needs 2x2
    const bytes = await patternPdf(piecesIn(215.9, 279.4), optsFor(215.9, 279.4, 100, 12.7))
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(4)
  })

  it('margin shrinks tiles but keeps content inside the printable rect', async () => {
    // tile = pw - 2*margin; a 400mm pattern over 178.5mm steps = 2 cols
    const bytes = await patternPdf(piecesIn(400, 200), optsFor(400, 200, 100, 12.7))
    const doc = await PDFDocument.load(bytes)
    // cols = 1 + ceil((400 - 190.5) / 178.5) = 3; rows = 1 (200 <= 254)
    expect(doc.getPageCount()).toBe(3)
  })

  it('is byte-identical across runs', async () => {
    const a = await patternPdf(piecesIn(500, 500), optsFor(500, 500))
    const b = await patternPdf(piecesIn(500, 500), optsFor(500, 500))
    expect(a.length).toBe(b.length)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })
})
