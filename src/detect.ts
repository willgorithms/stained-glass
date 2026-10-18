import { signedArea, centroid, pointInLoops } from './geom'
import type { Pt } from './geom'

/** A single detected glass piece, in pixel space. */
export interface RawPiece {
  /** Pattern outline `[outer, ...holes]`, grid-corner pixel coords. */
  loopsPx: Pt[][]
  /** Eroded guide outline; `[]` if the piece shrank away entirely. */
  guideLoopsPx: Pt[][]
  centroidPx: Pt
  /** Dominant interior fill color. */
  fillRgb: [number, number, number]
  /** Pixel count after voronoi expansion. */
  areaPx: number
  /** Pixel count before expansion — the real "piece size" for filtering. */
  origAreaPx: number
}

/** Result of {@link detect}: pieces plus metadata about what was excluded. */
export interface Detected {
  pieces: RawPiece[]
  /** Detected line color, or `null` if no dark lines were found. */
  lineRgb: [number, number, number] | null
  /** Number of border-touching frame regions dropped as "outside the artwork". */
  background: number
  /** Outlines of those background regions (preview only). */
  bgLoopsPx: Pt[][][]
  /**
   * Outlines of the lead work itself: every connected line-pixel region,
   * traced at the art's own outer edge. The pattern PDF fills them black and
   * the preview erases them to transparency, so thin runs and thick junctions
   * render as one uniform lead network.
   */
  leadLoopsPx: Pt[][][]
  width: number
  height: number
}

/** Tuning knobs for {@link detect}. */
export interface DetectOpts {
  /** Inward erosion for guide outlines, in px. `0` skips erosion. */
  shrinkPx: number
  /** RGB distance from the detected line color that still counts as line. */
  lineTol: number
}

/**
 * Estimate the line color as the dominant color among the darkest opaque
 * pixels. Lines are drawn in the darkest color present; restricting the
 * histogram to colors near the global minimum luminance keeps large dark
 * *fills* (charcoal, dark brown) from being mistaken for the line network.
 * Returns null when nothing is convincingly dark — i.e. no lines at all.
 */
function estimateLineColor(d: Uint8ClampedArray): [number, number, number] | null {
  const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b
  let minLum = 255
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue
    const l = lum(d[i], d[i + 1], d[i + 2])
    if (l < minLum) minLum = l
  }
  if (minLum > 72) return null // no dark pixels => no line work to find

  const cap = Math.max(minLum + 16, 48)
  const histo = new Map<number, number>()
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue
    const r = d[i], g = d[i + 1], b = d[i + 2]
    if (lum(r, g, b) > cap) continue
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    histo.set(key, (histo.get(key) ?? 0) + 1)
  }
  if (!histo.size) return null

  // darkest color with meaningful coverage wins: lines are the darkest element
  // present, and a dark fill region should not win just by being more numerous
  const opaque = d.length / 4
  const floor = Math.max(64, opaque * 0.001)
  const keys = [...histo.keys()].sort(
    (a, b) =>
      lum(((a >> 8) & 15) << 4, ((a >> 4) & 15) << 4, (a & 15) << 4) -
      lum(((b >> 8) & 15) << 4, ((b >> 4) & 15) << 4, (b & 15) << 4),
  )
  let best = keys.find((k) => histo.get(k)! >= floor)
  if (best === undefined) {
    // nothing clears the floor — fall back to the mode
    let bestN = 0
    for (const [k, c] of histo) if (c > bestN) { best = k; bestN = c }
  }
  return [(((best! >> 8) & 15) << 4) | 8, (((best! >> 4) & 15) << 4) | 8, ((best! & 15) << 4) | 8]
}

/**
 * Segment a pattern image into glass pieces. Pieces = pixels far from the line
 * color; lines = near it (or transparent = outside, never claimed). After
 * component labeling, line pixels are claimed by the nearest piece via
 * multi-source BFS so the traced boundary lands on the line center. The claim
 * reach is capped at the measured half-width of the line network: pieces then
 * meet on the centerline of straight runs but wrap junction blobs in a smooth
 * offset arc, instead of either detouring around stranded islands (cap too
 * deep) or plunging to the junction center as a spike (no cap).
 */
export function detect(img: ImageData, o: DetectOpts): Detected {
  const { shrinkPx, lineTol } = o
  const W = img.width
  const H = img.height
  const n = W * H
  const d = img.data

  const lineRgb = estimateLineColor(d)
  const tol2 = lineTol * lineTol

  // kind: 0 = piece pixel, 1 = line pixel (claimable), 2 = outside (transparent)
  const kind = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o4 = i * 4
    if (d[o4 + 3] < 128) {
      kind[i] = 2
      continue
    }
    if (lineRgb === null) {
      kind[i] = 0
      continue
    }
    const dr = d[o4] - lineRgb[0]
    const dg = d[o4 + 1] - lineRgb[1]
    const db = d[o4 + 2] - lineRgb[2]
    kind[i] = dr * dr + dg * dg + db * db <= tol2 ? 1 : 0
  }

  const labels = new Int32Array(n).fill(-1)
  const areas: number[] = []
  const sumX: number[] = []
  const sumY: number[] = []
  const touchesBorder: boolean[] = []
  const stack = new Int32Array(n)

  for (let i = 0; i < n; i++) {
    if (kind[i] !== 0 || labels[i] >= 0) continue
    const id = areas.length
    areas.push(0)
    sumX.push(0)
    sumY.push(0)
    touchesBorder.push(false)
    let sp = 0
    stack[sp++] = i
    labels[i] = id
    while (sp > 0) {
      const p = stack[--sp]
      areas[id]++
      const x = p % W
      const y = (p / W) | 0
      sumX[id] += x
      sumY[id] += y
      if (x === 0 || x === W - 1 || y === 0 || y === H - 1) touchesBorder[id] = true
      if (x > 0 && kind[p - 1] === 0 && labels[p - 1] < 0) {
        labels[p - 1] = id
        stack[sp++] = p - 1
      }
      if (x < W - 1 && kind[p + 1] === 0 && labels[p + 1] < 0) {
        labels[p + 1] = id
        stack[sp++] = p + 1
      }
      if (y > 0 && kind[p - W] === 0 && labels[p - W] < 0) {
        labels[p - W] = id
        stack[sp++] = p - W
      }
      if (y < H - 1 && kind[p + W] === 0 && labels[p + W] < 0) {
        labels[p + W] = id
        stack[sp++] = p + W
      }
    }
  }

  const origAreas = areas.slice()

  // Dominant fill color per component, sampled on interior pixels only
  // (all four neighbors same label => away from line bleed and AA fringe).
  const colorHist = new Map<number, Map<number, number>>()
  for (let p = 0; p < n; p++) {
    const L = labels[p]
    if (L < 0) continue
    const x = p % W
    const y = (p / W) | 0
    if (
      x === 0 || x === W - 1 || y === 0 || y === H - 1 ||
      labels[p - 1] !== L || labels[p + 1] !== L || labels[p - W] !== L || labels[p + W] !== L
    ) continue
    const o4 = p * 4
    const key = ((d[o4] >> 4) << 8) | ((d[o4 + 1] >> 4) << 4) | (d[o4 + 2] >> 4)
    let m = colorHist.get(L)
    if (!m) {
      m = new Map()
      colorHist.set(L, m)
    }
    m.set(key, (m.get(key) ?? 0) + 1)
  }
  // Sliver pieces with no interior px: sample whatever they have — must happen
  // now, pre-expansion, before labels[] starts covering claimed line pixels.
  const missing = new Set<number>()
  for (let p = 0; p < n; p++) {
    const L = labels[p]
    if (L >= 0 && !colorHist.has(L)) missing.add(L)
  }
  if (missing.size) {
    for (let p = 0; p < n; p++) {
      const L = labels[p]
      if (L < 0 || !missing.has(L)) continue
      const o4 = p * 4
      const key = ((d[o4] >> 4) << 8) | ((d[o4 + 1] >> 4) << 4) | (d[o4 + 2] >> 4)
      const m = colorHist.get(L) ?? new Map<number, number>()
      colorHist.set(L, m)
      m.set(key, (m.get(key) ?? 0) + 1)
    }
  }
  const fillOf = (id: number): [number, number, number] => {
    const m = colorHist.get(id)
    if (!m || m.size === 0) return [128, 128, 128]
    let best = 0
    let bestN = -1
    for (const [k, c] of m) if (c > bestN) { best = k; bestN = c }
    return [(((best >> 8) & 15) << 4) | 8, (((best >> 4) & 15) << 4) | 8, ((best & 15) << 4) | 8]
  }

  // Distance transform of the line network: for each line pixel, its depth
  // (4-connected) from the nearest non-line pixel. Ridge pixels — local maxima
  // of that field — are the medial axis; their median depth estimates the
  // half-width of a typical line.
  const lineDist = new Uint16Array(n).fill(0xffff)
  const q0 = new Int32Array(n)
  let h0 = 0, t0 = 0
  for (let p = 0; p < n; p++) {
    if (kind[p] !== 1) continue
    const x = p % W
    const y = (p / W) | 0
    if (
      x === 0 || x === W - 1 || y === 0 || y === H - 1 ||
      kind[p - 1] !== 1 || kind[p + 1] !== 1 || kind[p - W] !== 1 || kind[p + W] !== 1
    ) {
      lineDist[p] = 1
      q0[t0++] = p
    }
  }
  while (h0 < t0) {
    const p = q0[h0++]
    const x = p % W
    const y = (p / W) | 0
    const nd = lineDist[p] + 1
    if (x > 0 && kind[p - 1] === 1 && lineDist[p - 1] > nd) { lineDist[p - 1] = nd; q0[t0++] = p - 1 }
    if (x < W - 1 && kind[p + 1] === 1 && lineDist[p + 1] > nd) { lineDist[p + 1] = nd; q0[t0++] = p + 1 }
    if (y > 0 && kind[p - W] === 1 && lineDist[p - W] > nd) { lineDist[p - W] = nd; q0[t0++] = p - W }
    if (y < H - 1 && kind[p + W] === 1 && lineDist[p + W] > nd) { lineDist[p + 1] = nd; q0[t0++] = p + W }
  }
  const ridge: number[] = []
  for (let p = 0; p < n; p++) {
    if (kind[p] !== 1) continue
    const v = lineDist[p]
    if (v === 0xffff) continue
    const x = p % W
    const y = (p / W) | 0
    if (
      (x > 0 && lineDist[p - 1] > v) || (x < W - 1 && lineDist[p + 1] > v) ||
      (y > 0 && lineDist[p - W] > v) || (y < H - 1 && lineDist[p + W] > v)
    ) continue // strictly uphill neighbor => not on the ridge
    ridge.push(v)
  }
  ridge.sort((a, b) => a - b)
  const reachPx = ridge.length ? ridge[(ridge.length / 2) | 0] : 0

  // Voronoi expansion into line pixels, capped at the measured half-width so
  // boundaries land on line centers without overrunning junction interiors.
  const dist = new Uint16Array(n).fill(0xffff)
  const q = new Int32Array(n)
  let qh = 0
  let qt = 0
  for (let i = 0; i < n; i++) {
    if (labels[i] >= 0) {
      dist[i] = 0
      q[qt++] = i
    }
  }
  while (qh < qt) {
    const p = q[qh++]
    if (dist[p] >= reachPx) continue
    const x = p % W
    const y = (p / W) | 0
    if (x > 0 && labels[p - 1] === -1 && kind[p - 1] === 1) {
      labels[p - 1] = labels[p]
      dist[p - 1] = dist[p] + 1
      areas[labels[p]]++
      q[qt++] = p - 1
    }
    if (x < W - 1 && labels[p + 1] === -1 && kind[p + 1] === 1) {
      labels[p + 1] = labels[p]
      dist[p + 1] = dist[p] + 1
      areas[labels[p]]++
      q[qt++] = p + 1
    }
    if (y > 0 && labels[p - W] === -1 && kind[p - W] === 1) {
      labels[p - W] = labels[p]
      dist[p - W] = dist[p] + 1
      areas[labels[p]]++
      q[qt++] = p - W
    }
    if (y < H - 1 && labels[p + W] === -1 && kind[p + W] === 1) {
      labels[p + W] = labels[p]
      dist[p + W] = dist[p] + 1
      areas[labels[p]]++
      q[qt++] = p + W
    }
  }

  // Boundary edges per label, oriented interior-on-right (screen-coords CW).
  const VW = W + 1
  const vid = (x: number, y: number) => x + y * VW
  const vx = (v: number) => v % VW
  const vy = (v: number) => (v / VW) | 0

  const traceAll = (lab: Int32Array): Map<number, Pt[][]> => {
    const edgeMaps = new Map<number, Map<number, number[]>>()
    const addEdge = (m: Map<number, number[]>, x0: number, y0: number, x1: number, y1: number) => {
      const s = vid(x0, y0)
      let arr = m.get(s)
      if (!arr) {
        arr = []
        m.set(s, arr)
      }
      arr.push(vid(x1, y1))
    }
    for (let p = 0; p < n; p++) {
      const L = lab[p]
      if (L < 0) continue
      const x = p % W
      const y = (p / W) | 0
      const t = y === 0 || lab[p - W] !== L
      const r = x === W - 1 || lab[p + 1] !== L
      const b = y === H - 1 || lab[p + W] !== L
      const l = x === 0 || lab[p - 1] !== L
      if (!(t || r || b || l)) continue
      let m = edgeMaps.get(L)
      if (!m) {
        m = new Map()
        edgeMaps.set(L, m)
      }
      if (t) addEdge(m, x, y, x + 1, y)
      if (r) addEdge(m, x + 1, y, x + 1, y + 1)
      if (b) addEdge(m, x + 1, y + 1, x, y + 1)
      if (l) addEdge(m, x, y + 1, x, y)
    }

    const traceLoops = (m: Map<number, number[]>): Pt[][] => {
      const loops: Pt[][] = []
      for (const start of m.keys()) {
        let outs = m.get(start)
        while (outs && outs.length > 0) {
          const loop: Pt[] = []
          let v = start
          let prev = -1
          for (;;) {
            const out = m.get(v)
            if (!out || out.length === 0) break
            let next = out[0]
            if (out.length > 1 && prev >= 0) {
              // pinch vertex: prefer the sharpest right turn so each loop
              // stays on its own side of the pinch
              const dx = vx(v) - vx(prev)
              const dy = vy(v) - vy(prev)
              let bestScore = -Infinity
              for (const e of out) {
                const ex = vx(e) - vx(v)
                const ey = vy(e) - vy(v)
                const cross = dx * ey - dy * ex
                const dot = dx * ex + dy * ey
                const score = cross * 4 + dot
                if (score > bestScore) {
                  bestScore = score
                  next = e
                }
              }
            }
            out.splice(out.indexOf(next), 1)
            loop.push({ x: vx(v), y: vy(v) })
            prev = v
            v = next
            if (v === start) break
            if (loop.length > 4 * (W + H) + 16) break
          }
          if (loop.length >= 3) loops.push(loop)
          outs = m.get(start)
        }
      }
      return loops
    }

    const result = new Map<number, Pt[][]>()
    for (const [id, m] of edgeMaps) result.set(id, traceLoops(m))
    return result
  }

  const finalize = (loops: Pt[][]): Pt[][] => {
    if (!loops.length) return loops
    // outer = largest |area|; normalize winding: outer positive, holes negative
    loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))
    if (signedArea(loops[0]) < 0) loops[0].reverse()
    for (let i = 1; i < loops.length; i++) {
      if (signedArea(loops[i]) > 0) loops[i].reverse()
    }
    for (const lp of loops) {
      for (let i = lp.length - 1; i > 0; i--) {
        if (lp[i].x === lp[i - 1].x && lp[i].y === lp[i - 1].y) lp.splice(i, 1)
      }
    }
    return loops
  }

  // pattern-space outlines at line centers
  const patternLoops = traceAll(labels)

  // Lead work: every connected line-pixel region, traced at the art's own
  // outer edge. The PDF fills these black and the preview erases them to
  // transparent, so thin runs and thick junctions render as one uniform
  // lead network — no white rims or core-only blobs.
  const leadLabels = new Int32Array(n).fill(-1)
  let lcount = 0
  for (let i = 0; i < n; i++) {
    if (kind[i] !== 1 || leadLabels[i] >= 0) continue
    let sp = 0
    stack[sp++] = i
    leadLabels[i] = lcount
    while (sp > 0) {
      const p = stack[--sp]
      const x = p % W
      const y = (p / W) | 0
      if (x > 0 && kind[p - 1] === 1 && leadLabels[p - 1] < 0) {
        leadLabels[p - 1] = lcount
        stack[sp++] = p - 1
      }
      if (x < W - 1 && kind[p + 1] === 1 && leadLabels[p + 1] < 0) {
        leadLabels[p + 1] = lcount
        stack[sp++] = p + 1
      }
      if (y > 0 && kind[p - W] === 1 && leadLabels[p - W] < 0) {
        leadLabels[p - W] = lcount
        stack[sp++] = p - W
      }
      if (y < H - 1 && kind[p + W] === 1 && leadLabels[p + W] < 0) {
        leadLabels[p + W] = lcount
        stack[sp++] = p + W
      }
    }
    lcount++
  }
  const leadLoopsPx = lcount
    ? [...traceAll(leadLabels).values()].map((loops) => finalize(loops))
    : []

  // Background frame detection: a component that touches the image border AND
  // encloses a hole covering a big share of the canvas AND containing other
  // components is the opaque margin outside the artwork, not a piece. (A ring
  // piece at the edge is safe: its hole is small and encloses at most a pupil.)
  // Its pixels stay non-foreign during guide erosion so the panel's outer edge
  // isn't eroded as if it were a seam.
  const bgIds = new Set<number>()
  for (const [id, loops] of patternLoops) {
    if (!touchesBorder[id] || loops.length < 2) continue
    const fl = finalize(loops.slice())
    for (const hole of fl.slice(1)) {
      if (Math.abs(signedArea(hole)) < n * 0.2) continue
      let enclosed = 0
      for (const [id2] of patternLoops) {
        if (id2 === id) continue
        if (pointInLoops({ x: sumX[id2] / areas[id2], y: sumY[id2] / areas[id2] }, [hole])) {
          enclosed++
        }
      }
      if (enclosed >= 2) {
        bgIds.add(id)
        break
      }
    }
  }

  // guide-space outlines: erode each region inward by shrinkPx, but only at
  // seams between pieces or unclaimed line — never at the image edge or
  // transparent outside, so the panel's outer boundary stays true-size.
  let guideLoops = patternLoops
  if (shrinkPx > 0) {
    const dist2 = new Uint16Array(n).fill(0xffff)
    const q2 = new Int32Array(n)
    let h2 = 0
    let t2 = 0
    const foreign = (p: number, nb: number) => {
      const nl = labels[nb]
      // a background region is "outside", not a seam neighbor
      return nl >= 0 ? nl !== labels[p] && !bgIds.has(nl) : kind[nb] === 1
    }
    for (let p = 0; p < n; p++) {
      if (labels[p] < 0) continue
      const x = p % W
      const y = (p / W) | 0
      if (
        (x > 0 && foreign(p, p - 1)) ||
        (x < W - 1 && foreign(p, p + 1)) ||
        (y > 0 && foreign(p, p - W)) ||
        (y < H - 1 && foreign(p, p + W))
      ) {
        dist2[p] = 0
        q2[t2++] = p
      }
    }
    while (h2 < t2) {
      const p = q2[h2++]
      const x = p % W
      const y = (p / W) | 0
      const nd = dist2[p] + 1
      if (x > 0 && labels[p - 1] === labels[p] && dist2[p - 1] > nd) {
        dist2[p - 1] = nd
        q2[t2++] = p - 1
      }
      if (x < W - 1 && labels[p + 1] === labels[p] && dist2[p + 1] > nd) {
        dist2[p + 1] = nd
        q2[t2++] = p + 1
      }
      if (y > 0 && labels[p - W] === labels[p] && dist2[p - W] > nd) {
        dist2[p - W] = nd
        q2[t2++] = p - W
      }
      if (y < H - 1 && labels[p + W] === labels[p] && dist2[p + W] > nd) {
        dist2[p + W] = nd
        q2[t2++] = p + W
      }
    }
    for (let p = 0; p < n; p++) {
      if (labels[p] >= 0 && dist2[p] < shrinkPx) labels[p] = -1
    }
    guideLoops = traceAll(labels)
  }

  const pieces: RawPiece[] = []
  const bgLoopsPx: Pt[][][] = []
  for (const [id, loops] of patternLoops) {
    if (bgIds.has(id)) {
      bgLoopsPx.push(finalize(loops))
      continue
    }
    if (loops.length === 0) continue
    const fl = finalize(loops)
    pieces.push({
      loopsPx: fl,
      guideLoopsPx: finalize(guideLoops.get(id) ?? []),
      centroidPx: centroid(fl[0]),
      fillRgb: fillOf(id),
      areaPx: areas[id],
      origAreaPx: origAreas[id],
    })
  }

  return { pieces, lineRgb, bgLoopsPx, leadLoopsPx, width: W, height: H, background: bgIds.size }
}
