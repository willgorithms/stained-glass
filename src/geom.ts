/** A 2D point. Units are context-dependent: pixels during detection, mm after. */
export interface Pt {
  x: number
  y: number
}

/** Axis-aligned bounding box (`x`,`y` = min corner; `w`,`h` = extents). */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Signed area of a closed polygon; positive when counterclockwise. */
export function signedArea(p: Pt[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const u = p[i]
    const v = p[(i + 1) % p.length]
    a += u.x * v.y - v.x * u.y
  }
  return a / 2
}

/**
 * Centroid of a closed polygon. Degenerate (near-zero-area) rings fall back
 * to the mean of their vertices.
 */
export function centroid(p: Pt[]): Pt {
  const a = signedArea(p)
  if (Math.abs(a) < 1e-9) {
    let x = 0
    let y = 0
    for (const q of p) {
      x += q.x
      y += q.y
    }
    return { x: x / p.length, y: y / p.length }
  }
  let cx = 0
  let cy = 0
  for (let i = 0; i < p.length; i++) {
    const u = p[i]
    const v = p[(i + 1) % p.length]
    const w = u.x * v.y - v.x * u.y
    cx += (u.x + v.x) * w
    cy += (u.y + v.y) * w
  }
  return { x: cx / (6 * a), y: cy / (6 * a) }
}

/** Bounding box of a point set. Empty input returns infinities. */
export function bbox(p: Pt[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const q of p) {
    if (q.x < x0) x0 = q.x
    if (q.y < y0) y0 = q.y
    if (q.x > x1) x1 = q.x
    if (q.y > y1) y1 = q.y
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function pointSegDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/**
 * Simplify a closed loop by iterative vertex elimination: any vertex within
 * `eps` of the chord joining its neighbors is dropped; repeat until stable.
 * No anchor points, so no seam artifacts.
 */
export function simplifyClosed(poly: Pt[], eps: number): Pt[] {
  let pts = poly.slice()
  let changed = true
  let guard = 0
  while (changed && pts.length > 4 && guard++ < 64) {
    changed = false
    const n = pts.length
    const remove = new Uint8Array(n)
    let lastRm = -2
    for (let i = 0; i < n; i++) {
      if ((i - 1 + n) % n === lastRm) continue // don't remove adjacent vertices in one pass
      const a = pts[(i - 1 + n) % n]
      const b = pts[i]
      const c = pts[(i + 1) % n]
      if (pointSegDist(b, a, c) < eps) {
        remove[i] = 1
        lastRm = i
        changed = true
      }
    }
    if (changed) pts = pts.filter((_, i) => !remove[i])
  }
  return pts.length >= 3 ? pts : poly.slice(0, Math.max(3, poly.length))
}

/**
 * Intersections of a polygon with a vertical line `x = xs`. Returns y values.
 * Half-open rule: a vertex exactly on `xs` belongs to the left side, so each
 * seam-crossing is counted exactly once.
 */
export function polyVerticalX(poly: Pt[], xs: number): number[] {
  const ys: number[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if ((a.x <= xs) === (b.x <= xs)) continue
    const t = (xs - a.x) / (b.x - a.x)
    ys.push(a.y + t * (b.y - a.y))
  }
  return ys
}

/**
 * Intersections of a polygon with a horizontal line `y = ys`. Returns x values.
 */
export function polyHorizontalX(poly: Pt[], ys: number): number[] {
  const xs: number[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if ((a.y <= ys) === (b.y <= ys)) continue
    const t = (ys - a.y) / (b.y - a.y)
    xs.push(a.x + t * (b.x - a.x))
  }
  return xs
}

/**
 * Point-in-piece test over an outline + holes via even-odd crossing count
 * across every loop: inside the outer loop but not inside a hole = hit.
 */
export function pointInLoops(pt: Pt, loops: Pt[][]): boolean {
  let crossings = 0
  for (const poly of loops) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      if ((a.y <= pt.y) === (b.y <= pt.y)) continue
      const t = (pt.y - a.y) / (b.y - a.y)
      if (a.x + t * (b.x - a.x) > pt.x) crossings++
    }
  }
  return crossings % 2 === 1
}

/** Largest size matching an image aspect that fits inside a w×h tile. */
export function fitSizeToTile(
  imgW: number,
  imgH: number,
  tileW: number,
  tileH: number,
): { w: number; h: number } {
  let w = tileW
  let h = (tileW * imgH) / imgW
  if (h > tileH) {
    h = tileH
    w = (tileH * imgW) / imgH
  }
  return { w, h }
}
