import { PDFDocument, rgb } from 'pdf-lib'
import type { Piece } from './pack'
import type { Pt } from './geom'

const PT = 72 / 25.4

/** Geometry of the calibration page: where the reference box and bar lane sit. */
export interface CalibSpec {
  pageWmm: number
  pageHmm: number
  /** Nominal printed/printed-bar length. */
  boxLenMm: number
  /** Box and bar width. */
  boxWmm: number
  /** Box left edge on the page. */
  boxXmm: number
  /** Box top edge on the page. */
  boxYmm: number
  /** Suggested bar lane left edge. */
  barXmm: number
}

/** Calibration page layout for a given paper size. */
export function calibSpec(pageWmm: number, pageHmm: number): CalibSpec {
  const boxLenMm = 250
  const boxWmm = 10
  return {
    pageWmm,
    pageHmm,
    boxLenMm,
    boxWmm,
    boxXmm: 25,
    // vertically centered — 250mm only fits inside the printable height
    boxYmm: (pageHmm - boxLenMm) / 2,
    barXmm: 55,
  }
}

/**
 * The 3D-printable calibration bar: a true-size len × w rectangle, no guide
 * shrink applied — its printed length is the ground truth we calibrate to.
 */
export function calibrationPiece(spec: CalibSpec): Piece {
  const { boxLenMm: L, boxWmm: W } = spec
  const loop: Pt[] = [
    { x: 0, y: 0 },
    { x: L, y: 0 },
    { x: L, y: W },
    { x: 0, y: W },
  ]
  return {
    id: 0,
    patternLoopsMm: [loop],
    patternBoxMm: { x: 0, y: 0, w: L, h: W },
    guideLoopsMm: [loop],
    guideBoxMm: { x: 0, y: 0, w: L, h: W },
    centroidMm: { x: L / 2, y: W / 2 },
    fillRgb: [0, 0, 0],
    colorIdx: 0,
    areaPx: 0,
  }
}

/**
 * The printable calibration page: a solid reference box, a dashed lane for the
 * printed bar, and instructions. Returns raw PDF bytes.
 */
export async function calibrationPdf(spec: CalibSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([spec.pageWmm * PT, spec.pageHmm * PT])
  const { boxXmm, boxYmm, boxLenMm, boxWmm, barXmm } = spec
  const black = rgb(0, 0, 0)
  const gray = rgb(0.55, 0.55, 0.55)

  // pdf-lib's y-axis is bottom-up; spec coords are top-down
  const yTop = (ymm: number, h: number) => (spec.pageHmm - ymm - h) * PT

  // solid reference box — filled so its edges are crisp to measure
  page.drawRectangle({
    x: boxXmm * PT,
    y: yTop(boxYmm, boxLenMm),
    width: boxWmm * PT,
    height: boxLenMm * PT,
    color: black,
  })
  // dashed lane showing where to lay the printed bar (same nominal size)
  page.drawRectangle({
    x: barXmm * PT,
    y: yTop(boxYmm, boxLenMm),
    width: boxWmm * PT,
    height: boxLenMm * PT,
    borderColor: gray,
    borderWidth: 0.4 * PT,
    borderDashArray: [3 * PT, 2 * PT],
  })

  const text = (s: string, xmm: number, ymm: number, size = 9, color = black) =>
    page.drawText(s, { x: xmm * PT, y: (spec.pageHmm - ymm) * PT, size, color })
  const tx = barXmm + 30 // instruction column, right of the lanes
  text('Pattern scale calibration — print this page at 100% / "Actual size"', tx, boxYmm + 4)
  text('1. Print calibration-bar.stl at 100% (non-white filament).', tx, boxYmm + 12, 8, gray)
  text('2. Lay the bar in the dashed lane, top edge aligned with the box.', tx, boxYmm + 16.5, 8, gray)
  text('3. Photograph the whole page straight-on and upload it in the app.', tx, boxYmm + 21, 8, gray)
  text(`nominal bar: ${boxLenMm} × ${boxWmm} mm`, tx, boxYmm + 28, 8, gray)
  text('printed box', boxXmm, boxYmm - 4, 7, gray)
  text('bar lane', barXmm, boxYmm - 4, 7, gray)

  return doc.save()
}

// ---------- photo analysis ----------

/** Outcome of {@link analyzeCalibrationPhoto}; `warnings` are advisory. */
export interface CalibResult {
  /** True once both the printed box and bar have been measured. */
  ok: boolean
  warnings: string[]
  /** Detected page corners in photo px (TL, TR, BR, BL). */
  corners?: Pt[]
  /** Rectified page image, `pxPerMm` px per mm. */
  rect?: ImageData
  labelMap?: Int32Array
  boxLabel?: number
  barLabel?: number
  pxPerMm?: number
  /** Measured printed box length (captures paper printer error). */
  LboxMm?: number
  /** Measured printed bar length (captures 3D printer error). */
  LbarMm?: number
  paperFactor?: number
  printer3dFactor?: number
  /** Suggested Print scale: `LbarMm / LboxMm * 100`. */
  scalePct?: number
}

const lumAt = (d: Uint8ClampedArray, i: number) =>
  0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
const chromaAt = (d: Uint8ClampedArray, i: number) =>
  Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])

// 4-connected component labeling. Returns label map (labels start at 0,
// sorted by descending pixel count) and per-label pixel arrays.
function components(mask: Uint8Array, W: number, H: number) {
  const labels = new Int32Array(W * H).fill(-1)
  const stacks: number[] = []
  const raw: { count: number; px: number[] }[] = []
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || labels[s] !== -1) continue
    const id = raw.length
    stacks.length = 0
    stacks.push(s)
    labels[s] = id
    const px: number[] = []
    while (stacks.length) {
      const p = stacks.pop()!
      px.push(p)
      const x = p % W
      const y = (p / W) | 0
      if (x > 0 && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; stacks.push(p - 1) }
      if (x < W - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; stacks.push(p + 1) }
      if (y > 0 && mask[p - W] && labels[p - W] === -1) { labels[p - W] = id; stacks.push(p - W) }
      if (y < H - 1 && mask[p + W] && labels[p + W] === -1) { labels[p + W] = id; stacks.push(p + W) }
    }
    raw.push({ count: px.length, px })
  }
  // re-label so label 0 is the largest component
  const order = raw.map((_, i) => i).sort((a, b) => raw[b].count - raw[a].count)
  const remap = new Int32Array(raw.length)
  order.forEach((old, nu) => (remap[old] = nu))
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) labels[i] = remap[labels[i]]
  const comps = order.map((old) => raw[old])
  return { labels, comps }
}

/**
 * 8-parameter homography (h9 = 1) via DLT + Gaussian elimination.
 * `src` and `dst` are four corresponding points; returns row-major 3×3.
 */
export function solveHomography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  for (let col = 0; col < 8; col++) {
    let piv = col
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    ;[A[col], A[piv]] = [A[piv], A[col]]
    ;[b[col], b[piv]] = [b[piv], b[col]]
    const d = A[col][col]
    for (let r = col + 1; r < 8; r++) {
      const f = A[r][col] / d
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c]
      b[r] -= f * b[col]
    }
  }
  const h = new Array(9)
  h[8] = 1
  for (let i = 7; i >= 0; i--) {
    let s = b[i]
    for (let c = i + 1; c < 8; c++) s -= A[i][c] * h[c]
    h[i] = s / A[i][i]
  }
  return h // row-major 3x3
}

/** Apply a row-major 3×3 homography to a point. */
export const applyH = (H: number[], x: number, y: number): [number, number] => {
  const w = H[6] * x + H[7] * y + H[8]
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]
}

/** Invert a row-major 3×3 matrix. */
export function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]
}

interface Line { nx: number; ny: number; c: number }

// total-least-squares line fit (principal axis through the centroid)
function fitLine(pts: Pt[]): Line {
  let mx = 0, my = 0
  for (const p of pts) { mx += p.x; my += p.y }
  mx /= pts.length; my /= pts.length
  let sxx = 0, syy = 0, sxy = 0
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const dx = Math.cos(th), dy = Math.sin(th)
  const nx = -dy, ny = dx
  return { nx, ny, c: nx * mx + ny * my }
}

const intersect = (a: Line, b: Line): Pt | null => {
  const det = a.nx * b.ny - b.nx * a.ny
  if (Math.abs(det) < 1e-9) return null
  return {
    x: (a.c * b.ny - b.c * a.ny) / det,
    y: (a.nx * b.c - b.nx * a.c) / det,
  }
}

// extent of a point set along its principal axes, in the given units
function pcaExtents(pts: Pt[]): { major: number; minor: number; cx: number; cy: number; ux: number; uy: number } {
  let mx = 0, my = 0
  for (const p of pts) { mx += p.x; my += p.y }
  mx /= pts.length; my /= pts.length
  let sxx = 0, syy = 0, sxy = 0
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const ux = Math.cos(th), uy = Math.sin(th)
  let mnU = Infinity, mxU = -Infinity, mnV = Infinity, mxV = -Infinity
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my
    const u = dx * ux + dy * uy
    const v = -dx * uy + dy * ux
    if (u < mnU) mnU = u
    if (u > mxU) mxU = u
    if (v < mnV) mnV = v
    if (v > mxV) mxV = v
  }
  const major = mxU - mnU
  const minor = mxV - mnV
  return major >= minor
    ? { major, minor, cx: mx, cy: my, ux, uy }
    : { major: minor, minor: major, cx: mx, cy: my, ux: -uy, uy: ux }
}

/**
 * Analyze a photo of the calibration page: locate the paper, rectify it to
 * page space, measure the printed box and the 3D-printed bar, and derive the
 * scale correction the pattern PDF needs so printed pieces match the guides.
 * `pxPerMm` is the rectified-page resolution.
 */
export function analyzeCalibrationPhoto(img: ImageData, spec: CalibSpec, pxPerMm = 4): CalibResult {
  const warnings: string[] = []
  const { width: W, height: H, data } = img

  // 1. find the paper: largest bright, low-saturation component
  const paper = new Uint8Array(W * H)
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    if (data[p + 3] < 128) continue
    paper[i] = lumAt(data, p) > 150 && chromaAt(data, p) < 50 ? 1 : 0
  }
  const { labels: pLabels, comps: pComps } = components(paper, W, H)
  if (!pComps.length || pComps[0].count < W * H * 0.08) {
    return { ok: false, warnings: ['page not found — fill the frame with the paper on a darker, non-white surface'] }
  }
  const paperId = 0

  // 2. page corners: extreme points, refined by fitting the four edge lines
  let tl: Pt = { x: 0, y: 0 }, tr = tl, br = tl, bl = tl
  let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity
  for (const p of pComps[0].px) {
    const x = p % W, y = (p / W) | 0
    const s = x + y, d = x - y
    if (s < sMin) { sMin = s; tl = { x, y } }
    if (s > sMax) { sMax = s; br = { x, y } }
    if (d > dMax) { dMax = d; tr = { x, y } }
    if (d < dMin) { dMin = d; bl = { x, y } }
  }
  const rough = [tl, tr, br, bl]

  // boundary pixels of the paper component
  const bnd: Pt[] = []
  for (const p of pComps[0].px) {
    const x = p % W, y = (p / W) | 0
    if (
      x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
      pLabels[p - 1] !== paperId || pLabels[p + 1] !== paperId ||
      pLabels[p - W] !== paperId || pLabels[p + W] !== paperId
    ) bnd.push({ x, y })
  }

  // assign boundary points to the nearest side (excluding the corner tails)
  const sidePts: Pt[][] = [[], [], [], []]
  for (const p of bnd) {
    let best = -1, bestD = Infinity
    for (let i = 0; i < 4; i++) {
      const a = rough[i], b = rough[(i + 1) % 4]
      const ex = b.x - a.x, ey = b.y - a.y
      const len2 = ex * ex + ey * ey
      if (len2 < 1) continue
      const len = Math.sqrt(len2)
      const t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2
      if (t < 0.07 || t > 0.93) continue
      const dist = Math.abs((p.x - a.x) * ey - (p.y - a.y) * ex) / len
      if (dist < bestD) { bestD = dist; best = i }
    }
    if (best >= 0 && bestD < Math.max(4, W * 0.006)) sidePts[best].push(p)
  }

  const corners = rough.slice()
  const lines: (Line | null)[] = sidePts.map((pts) => (pts.length >= 20 ? fitLine(pts) : null))
  for (let i = 0; i < 4; i++) {
    const la = lines[(i + 3) % 4], lb = lines[i]
    if (!la || !lb) continue
    const c = intersect(la, lb)
    if (c) corners[i] = c
  }

  // sanity: interior angles between ~45° and ~135°
  let badAngle = false
  for (let i = 0; i < 4; i++) {
    const a = corners[(i + 3) % 4], b = corners[i], c = corners[(i + 1) % 4]
    const u1 = a.x - b.x, u2 = a.y - b.y, v1 = c.x - b.x, v2 = c.y - b.y
    const cos = (u1 * v1 + u2 * v2) / (Math.hypot(u1, u2) * Math.hypot(v1, v2) + 1e-9)
    const deg = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI
    if (deg < 45 || deg > 135) badAngle = true
  }
  if (badAngle) warnings.push('page is very oblique — accuracy suffers; shoot straighter-on')

  // 3. pick the page rotation: the capture may be in any of 4 orientations,
  // so try each cyclic corner assignment and keep the one that lands the most
  // on-page ink inside the box's known zone
  const pagePts: Pt[] = [
    { x: 0, y: 0 }, { x: spec.pageWmm, y: 0 },
    { x: spec.pageWmm, y: spec.pageHmm }, { x: 0, y: spec.pageHmm },
  ]
  // "on the page" = enclosed by the paper blob: flood non-paper inward from
  // the borders; whatever isn't reached (paper + its holes: box, bar) is on-page
  const outside = new Uint8Array(W * H)
  const oStack: number[] = []
  const pushOut = (i: number) => {
    if (!paper[i] && !outside[i]) { outside[i] = 1; oStack.push(i) }
  }
  for (let x = 0; x < W; x++) { pushOut(x); pushOut((H - 1) * W + x) }
  for (let y = 0; y < H; y++) { pushOut(y * W); pushOut(y * W + W - 1) }
  while (oStack.length) {
    const p = oStack.pop()!
    const x = p % W, y = (p / W) | 0
    if (x > 0) pushOut(p - 1)
    if (x < W - 1) pushOut(p + 1)
    if (y > 0) pushOut(p - W)
    if (y < H - 1) pushOut(p + W)
  }
  const photoMarks = new Uint8Array(W * H)
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    photoMarks[i] = !outside[i] && (lumAt(data, p) < 120 || chromaAt(data, p) > 55) ? 1 : 0
  }
  let HphotoToPage: number[] = []
  let bestScore = -1
  for (let k = 0; k < 4; k++) {
    const cand = [corners[k], corners[(k + 1) % 4], corners[(k + 2) % 4], corners[(k + 3) % 4]]
    const Hk = invert3(solveHomography(pagePts, cand))
    let score = 0
    for (let i = 0; i < W * H; i++) {
      if (!photoMarks[i]) continue
      const [mx, my] = applyH(Hk, i % W, (i / W) | 0)
      if (
        mx > spec.boxXmm - 10 && mx < spec.boxXmm + spec.boxWmm + 10 &&
        my > spec.boxYmm - 10 && my < spec.boxYmm + spec.boxLenMm + 10
      ) score++
    }
    if (score > bestScore) { bestScore = score; HphotoToPage = Hk }
  }
  if (bestScore < 100) warnings.push('little ink found near the box zone — wrong page or heavy cropping?')
  const HpageToPhoto = invert3(HphotoToPage)
  const RW = Math.round(spec.pageWmm * pxPerMm)
  const RH = Math.round(spec.pageHmm * pxPerMm)
  const rect = { width: RW, height: RH, data: new Uint8ClampedArray(RW * RH * 4) } as ImageData
  const rd = rect.data
  for (let ry = 0; ry < RH; ry++) {
    for (let rx = 0; rx < RW; rx++) {
      const [sx, sy] = applyH(HpageToPhoto, (rx + 0.5) / pxPerMm, (ry + 0.5) / pxPerMm)
      // bilinear sample
      const x0 = Math.floor(sx), y0 = Math.floor(sy)
      const fx = sx - x0, fy = sy - y0
      const di = (ry * RW + rx) * 4
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) {
        rd[di + 3] = 255
        continue
      }
      for (let ch = 0; ch < 3; ch++) {
        const s00 = data[(y0 * W + x0) * 4 + ch]
        const s01 = data[(y0 * W + x0 + 1) * 4 + ch]
        const s10 = data[((y0 + 1) * W + x0) * 4 + ch]
        const s11 = data[((y0 + 1) * W + x0 + 1) * 4 + ch]
        rd[di + ch] =
          s00 * (1 - fx) * (1 - fy) + s01 * fx * (1 - fy) +
          s10 * (1 - fx) * fy + s11 * fx * fy
      }
      rd[di + 3] = 255
    }
  }

  // 4. non-paper marks on the rectified page: printed ink + the bar
  const marks = new Uint8Array(RW * RH)
  for (let i = 0, p = 0; i < RW * RH; i++, p += 4) {
    marks[i] = lumAt(rd, p) < 140 || chromaAt(rd, p) > 45 ? 1 : 0
  }
  const { labels, comps } = components(marks, RW, RH)

  // helper: PCA extents (in mm) of a component's member pixels
  const compInfo = new Map<number, ReturnType<typeof pcaExtents> & { count: number; minR: number; maxR: number; minC: number; maxC: number }>()
  const infoFor = (id: number) => {
    let info = compInfo.get(id)
    if (!info) {
      const pts: Pt[] = []
      let minR = RH, maxR = 0, minC = RW, maxC = 0
      for (const p of comps[id].px) {
        const c = p % RW, r = (p / RW) | 0
        pts.push({ x: c, y: r })
        if (r < minR) minR = r
        if (r > maxR) maxR = r
        if (c < minC) minC = c
        if (c > maxC) maxC = c
      }
      const ext = pcaExtents(pts)
      info = { ...ext, major: ext.major / pxPerMm, minor: ext.minor / pxPerMm, count: comps[id].count, minR, maxR, minC, maxC }
      compInfo.set(id, info)
    }
    return info
  }

  // 5. the printed box: largest component overlapping its expected zone
  const zx0 = Math.round((spec.boxXmm - 15) * pxPerMm)
  const zx1 = Math.round((spec.boxXmm + spec.boxWmm + 15) * pxPerMm)
  const zy0 = Math.round(Math.max(0, spec.boxYmm - 15) * pxPerMm)
  const zy1 = Math.round(Math.min(spec.pageHmm, spec.boxYmm + spec.boxLenMm + 15) * pxPerMm)
  const zoneHits = new Set<number>()
  for (let r = zy0; r < zy1; r++)
    for (let c = zx0; c < zx1; c++) {
      const l = labels[r * RW + c]
      if (l >= 0) zoneHits.add(l)
    }
  let boxLabel = -1, boxExt = 0
  for (const l of zoneHits) {
    if (comps[l].count < 200) continue
    const inf = infoFor(l)
    const solidness = inf.count / (inf.major * inf.minor * pxPerMm * pxPerMm + 1e-9)
    // a solid bar-sized object: reject text blobs and squiggles
    if (
      inf.minor > 60 || solidness < 0.4 ||
      inf.major < spec.boxLenMm * 0.7 || inf.major > spec.boxLenMm * 1.35
    ) continue
    if (inf.major > boxExt) { boxExt = inf.major; boxLabel = l }
  }
  let LboxMm: number | undefined
  if (boxLabel < 0) {
    return { ok: false, warnings: [...warnings, 'printed box not found — clipped by printer margins, or not this page?'], corners, rect, pxPerMm, labelMap: labels }
  }
  const boxInfo = infoFor(boxLabel)
  LboxMm = boxInfo.major
  if (LboxMm < spec.boxLenMm * 0.7 || LboxMm > spec.boxLenMm * 1.3) {
    warnings.push(`box measured ${LboxMm.toFixed(1)}mm vs ${spec.boxLenMm}mm nominal — suspicious; check the photo`)
  }
  if (boxInfo.minR < 4 * pxPerMm || boxInfo.maxR > RH - 4 * pxPerMm ||
      boxInfo.minC < 4 * pxPerMm || boxInfo.maxC > RW - 4 * pxPerMm) {
    warnings.push('box touches a page edge — it may be clipped by printer margins')
  }

  // 6. the bar: biggest solid component that isn't the box
  let barLabel = -1, barExt = 0
  for (let l = 0; l < comps.length; l++) {
    if (l === boxLabel || comps[l].count < 600) continue
    const inf = infoFor(l)
    const solidness = inf.count / (inf.major * inf.minor * pxPerMm * pxPerMm + 1e-9)
    if (
      inf.minor > 80 || solidness < 0.45 ||
      inf.major < spec.boxLenMm * 0.5 || inf.major > spec.boxLenMm * 1.35
    ) continue // reject text blobs / thin lines / wrong-size objects
    if (inf.major > barExt) { barExt = inf.major; barLabel = l }
  }
  let LbarMm: number | undefined
  if (barLabel < 0) {
    return {
      ok: false,
      warnings: [...warnings, 'printed bar not found — lay it in the dashed lane; white filament on white paper can\'t be seen'],
      corners, rect, pxPerMm, labelMap: labels, boxLabel, LboxMm,
      paperFactor: LboxMm / spec.boxLenMm,
    }
  }
  LbarMm = infoFor(barLabel).major

  const paperFactor = LboxMm / spec.boxLenMm
  const printer3dFactor = LbarMm / spec.boxLenMm
  const scalePct = (LbarMm / LboxMm) * 100
  if (scalePct < 85 || scalePct > 120) {
    warnings.push(`computed scale ${scalePct.toFixed(1)}% is implausible — double-check the photo`)
  }

  return {
    ok: true, // both objects measured; warnings are advisory
    warnings,
    corners, rect, pxPerMm, labelMap: labels, boxLabel, barLabel,
    LboxMm, LbarMm, paperFactor, printer3dFactor, scalePct,
  }
}
