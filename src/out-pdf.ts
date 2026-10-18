import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { Piece } from './pack'
import { polyVerticalX, polyHorizontalX } from './geom'

/** Options for {@link patternPdf}, all lengths in mm. */
export interface PdfOpts {
  /** Page width (e.g. 215.9 for US Letter). */
  pageWmm: number
  /** Page height (e.g. 279.4 for US Letter). */
  pageHmm: number
  /** Duplicated pattern strip shared by adjacent tiles. */
  overlapMm: number
  /** Unprintable border width; all ink stays inside it. */
  marginMm: number
  /** Draw at this % of true size to compensate printer shrink. */
  scalePct: number
  /** Stroke width for the pattern outlines. */
  lineWmm: number
  /** Real-world width of the whole pattern. */
  patternWmm: number
  /** Real-world height of the whole pattern. */
  patternHmm: number
}

const MM = 72 / 25.4

/**
 * Build the printable pattern PDF, tiled across pages.
 *
 * Tiling model: the pattern is cut into tiles of (pageW - 2*margin) x
 * (pageH - 2*margin), positioned inside the page's printable area. Adjacent
 * tiles overlap by `overlapMm`. The seam between two tiles is the midline of
 * the shared strip; the covering page prints a dashed trim line there — cut
 * its paper edge at the line so the marks printed on the page underneath stay
 * visible. Marks are circles centered on the seam at every pattern-line
 * crossing: each page keeps/prints its half, and a complete circle across the
 * joint means exact alignment. Returns the raw PDF bytes.
 */
export async function patternPdf(pieces: Piece[], o: PdfOpts): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const k = o.scalePct / 100
  const totalW = o.patternWmm * k
  const totalH = o.patternHmm * k
  const pw = o.pageWmm
  const ph = o.pageHmm
  const m = Math.min(Math.max(o.marginMm, 0), pw * 0.45, ph * 0.45)
  const tw = pw - 2 * m // tile = printable area
  const th = ph - 2 * m
  const ov = Math.min(o.overlapMm, tw / 3, th / 3)
  const step = (t: number) => t - ov
  const sx = step(tw)
  const sy = step(th)
  const cols = totalW <= tw ? 1 : 1 + Math.ceil((totalW - tw) / sx)
  const rows = totalH <= th ? 1 : 1 + Math.ceil((totalH - th) / sy)

  const black = rgb(0, 0, 0)
  const gray = rgb(0.55, 0.55, 0.55)

  // seam midlines in scaled-pattern space (right/bottom covering edges)
  const seamX: number[] = []
  for (let c = 0; c < cols - 1; c++) seamX.push(c * sx + tw - ov / 2)
  const seamY: number[] = []
  for (let r = 0; r < rows - 1; r++) seamY.push(r * sy + th - ov / 2)

  // registration marks: where piece outlines cross each seam midline
  type Mark = { x: number; y: number }
  const marks: Mark[] = []
  for (const vx of seamX) {
    const ys: number[] = []
    for (const p of pieces) for (const loop of p.patternLoopsMm) {
      for (const y of polyVerticalX(loop, vx / k)) ys.push(y * k)
    }
    ys.sort((a, b) => a - b)
    const kept: number[] = []
    for (const y of ys) {
      if (kept.length === 0 || y - kept[kept.length - 1] > 4) kept.push(y)
      if (kept.length >= 60) break
    }
    if (kept.length < 3) {
      for (let i = 1; i <= 4; i++) kept.push((totalH * i) / 5)
    }
    for (const y of kept) marks.push({ x: vx, y })
  }
  for (const hy of seamY) {
    const xs: number[] = []
    for (const p of pieces) for (const loop of p.patternLoopsMm) {
      for (const x of polyHorizontalX(loop, hy / k)) xs.push(x * k)
    }
    xs.sort((a, b) => a - b)
    const kept: number[] = []
    for (const x of xs) {
      if (kept.length === 0 || x - kept[kept.length - 1] > 4) kept.push(x)
      if (kept.length >= 60) break
    }
    if (kept.length < 3) {
      for (let i = 1; i <= 4; i++) kept.push((totalW * i) / 5)
    }
    for (const x of kept) marks.push({ x, y: hy })
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const page = doc.addPage([pw * MM, ph * MM])
      const ox = c * sx // tile window origin in scaled-pattern space
      const oy = r * sy
      const X = (x: number) => (m + (x - ox)) * MM
      const Y = (y: number) => (ph - m - (y - oy)) * MM // flip y, sit inside margin

      const drawSeg = (x0: number, y0: number, x1: number, y1: number, w: number, col = black) =>
        page.drawLine({ start: { x: X(x0), y: Y(y0) }, end: { x: X(x1), y: Y(y1) }, thickness: w * MM, color: col })

      for (const p of pieces) {
        for (const loop of p.patternLoopsMm) {
          for (let i = 0; i < loop.length; i++) {
            const a = loop[i]
            const b = loop[(i + 1) % loop.length]
            if (Math.max(a.x * k, b.x * k) < ox || Math.min(a.x * k, b.x * k) > ox + tw) continue
            if (Math.max(a.y * k, b.y * k) < oy || Math.min(a.y * k, b.y * k) > oy + th) continue
            drawSeg(a.x * k, a.y * k, b.x * k, b.y * k, o.lineWmm)
          }
        }
      }

      // dashed trim lines on edges that cover a neighbor (right / bottom)
      if (c < cols - 1) {
        const tx = seamX[c]
        page.drawLine({
          start: { x: X(tx), y: Y(oy) },
          end: { x: X(tx), y: Y(oy + th) },
          thickness: 0.35 * MM, color: gray,
          dashArray: [4 * MM, 2.5 * MM],
        })
      }
      if (r < rows - 1) {
        const ty = seamY[r]
        page.drawLine({
          start: { x: X(ox), y: Y(ty) },
          end: { x: X(ox + tw), y: Y(ty) },
          thickness: 0.35 * MM, color: gray,
          dashArray: [4 * MM, 2.5 * MM],
        })
      }

      // split-circle registration marks on seam midlines
      for (const mk of marks) {
        if (mk.x < ox - 0.1 || mk.x > ox + tw + 0.1 || mk.y < oy - 0.1 || mk.y > oy + th + 0.1) continue
        page.drawCircle({
          x: X(mk.x), y: Y(mk.y), size: 2 * MM,
          borderColor: gray, borderWidth: 0.3 * MM, color: undefined,
        })
        page.drawCircle({ x: X(mk.x), y: Y(mk.y), size: 0.3 * MM, color: gray })
      }

      // piece IDs
      for (const p of pieces) {
        const cx = p.centroidMm.x * k
        const cy = p.centroidMm.y * k
        if (cx < ox || cx > ox + tw || cy < oy || cy > oy + th) continue
        const s = String(p.id)
        const size = Math.min(10, Math.max(6, Math.min(p.patternBoxMm.w, p.patternBoxMm.h) * k * 0.3))
        const wpt = font.widthOfTextAtSize(s, size)
        page.drawText(s, { x: X(cx) - wpt / 2, y: Y(cy) - size / 3, size, font, color: black })
      }

      const label = `R${r + 1}C${c + 1} of ${rows}x${cols}`
      page.drawText(label, { x: (m + 1.5) * MM, y: (m + 5.5) * MM, size: 7, font, color: gray })
      if (cols > 1 || rows > 1) {
        page.drawText('trim along dashed lines - align split circles', {
          x: (m + 1.5) * MM, y: (m + 1.5) * MM, size: 7, font, color: gray,
        })
      }
    }
  }
  return doc.save()
}
