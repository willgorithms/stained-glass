import { detect } from './detect'
import type { Piece } from './pack'
import { simplifyClosed, bbox, centroid } from './geom'
import type { Pt } from './geom'

/** User-facing detection parameters; lengths in mm, counts in px. */
export interface PipelineParams {
  /** Real-world width of the finished panel, in mm. */
  patternWmm: number
  /** Real-world height of the finished panel, in mm. */
  patternHmm: number
  /** Minimum piece area in mm²; smaller specks are dropped. */
  minAreaMm2: number
  /** Max px distance a piece may claim line pixels (voronoi reach). */
  expandPx: number
  /** Outline simplification tolerance in mm. */
  simplifyMm: number
  /** Inward erosion applied to guide outlines, in mm (foil allowance). */
  guideShrinkMm: number
  /** RGB distance from the detected line color that still counts as line. */
  lineTol: number
  /** RGB distance under which piece fills merge into one palette entry. */
  paletteTol: number
}

/** One clustered glass color and how many pieces use it. */
export interface PaletteEntry {
  rgb: [number, number, number]
  /** Number of pieces in this color. */
  count: number
}

/** Output of {@link runDetect}: mm-space pieces plus detection metadata. */
export interface PipelineResult {
  pieces: Piece[]
  palette: PaletteEntry[]
  /** Pieces dropped for being below `minAreaMm2`. */
  dropped: number
  /** Opaque margin regions excluded from the pattern entirely. */
  background: number
  /** Outlines of those regions, in px (preview only). */
  bgLoopsPx: Pt[][][]
  lineRgb: [number, number, number] | null
  imgW: number
  imgH: number
}

/**
 * Run the full detection stage: segment `img` into pieces, convert outlines
 * to mm using the declared panel size, drop sub-`minAreaMm2` specks, number
 * pieces in reading order, and cluster fills into a glass palette.
 */
export function runDetect(img: ImageData, p: PipelineParams): PipelineResult {
  const mmX = p.patternWmm / img.width
  const mmY = p.patternHmm / img.height
  const shrinkPx = p.guideShrinkMm / ((mmX + mmY) / 2)
  const det = detect(img, { expandPx: p.expandPx, shrinkPx, lineTol: p.lineTol })
  const minPx = p.minAreaMm2 / (mmX * mmY)

  // filter on pre-expansion size: a speck must not inflate itself out of the filter
  const kept = det.pieces.filter((pc) => pc.origAreaPx >= minPx)
  const toMm = (q: { x: number; y: number }) => ({ x: q.x * mmX, y: q.y * mmY })
  const pieces: Piece[] = kept.map((pc) => {
    const patternLoopsMm = pc.loopsPx.map((loop) =>
      simplifyClosed(loop.map(toMm), p.simplifyMm),
    )
    const guideLoopsMm = pc.guideLoopsPx.map((loop) =>
      simplifyClosed(loop.map(toMm), p.simplifyMm),
    )
    return {
      id: 0,
      patternLoopsMm,
      patternBoxMm: bbox(patternLoopsMm[0]),
      guideLoopsMm,
      guideBoxMm: guideLoopsMm.length ? bbox(guideLoopsMm[0]) : { x: 0, y: 0, w: 0, h: 0 },
      centroidMm: centroid(patternLoopsMm[0]),
      fillRgb: pc.fillRgb,
      colorIdx: 0,
      areaPx: pc.areaPx,
    }
  })

  // IDs in row-major order: bucket by y (fraction of median piece height), then x
  const medH = median(pieces.map((p) => p.patternBoxMm.h)) || 1
  pieces.sort((a, b) => {
    const ra = Math.floor(a.centroidMm.y / (medH * 0.75))
    const rb = Math.floor(b.centroidMm.y / (medH * 0.75))
    return ra - rb || a.centroidMm.x - b.centroidMm.x
  })
  pieces.forEach((p, i) => (p.id = i + 1))

  // glass palette: greedy merge of fill colors within paletteTol, keeping a
  // running mean per cluster so the swatch reflects member colors
  const clusters: { r: number; g: number; b: number; n: number }[] = []
  for (const pc of pieces) {
    let best = -1
    let bestD = p.paletteTol
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i]
      const dr = pc.fillRgb[0] - c.r / c.n
      const dg = pc.fillRgb[1] - c.g / c.n
      const db = pc.fillRgb[2] - c.b / c.n
      const dist = Math.sqrt(dr * dr + dg * dg + db * db)
      if (dist < bestD) {
        bestD = dist
        best = i
      }
    }
    if (best < 0) {
      pc.colorIdx = clusters.length
      clusters.push({ r: pc.fillRgb[0], g: pc.fillRgb[1], b: pc.fillRgb[2], n: 1 })
    } else {
      pc.colorIdx = best
      const c = clusters[best]
      c.r += pc.fillRgb[0]
      c.g += pc.fillRgb[1]
      c.b += pc.fillRgb[2]
      c.n++
    }
  }
  const palette: PaletteEntry[] = clusters.map((c) => ({
    rgb: [Math.round(c.r / c.n), Math.round(c.g / c.n), Math.round(c.b / c.n)],
    count: c.n,
  }))

  return {
    pieces,
    palette,
    dropped: det.pieces.length - kept.length,
    background: det.background,
    bgLoopsPx: det.bgLoopsPx,
    lineRgb: det.lineRgb,
    imgW: det.width,
    imgH: det.height,
  }
}

/** Median of `v`, or 0 for an empty list. */
function median(v: number[]): number {
  if (!v.length) return 0
  const s = v.slice().sort((a, b) => a - b)
  return s[s.length >> 1]
}
