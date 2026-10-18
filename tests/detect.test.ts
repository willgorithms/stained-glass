import { describe, it, expect } from 'vitest'
import { detect } from '../src/detect'
import { mkImg, RED, BLACK, CLEAR } from './helpers'
import { bbox, signedArea, pointInLoops } from '../src/geom'

describe('detect', () => {
  it('finds one piece in a solid image', () => {
    const det = detect(mkImg(20, 20, () => RED), { shrinkPx: 0, lineTol: 48 })
    expect(det.pieces).toHaveLength(1)
    expect(det.pieces[0].areaPx).toBe(400)
    expect(det.pieces[0].loopsPx).toHaveLength(1)
  })

  it('splits two halves across a vertical line', () => {
    const img = mkImg(40, 20, (x) => (x >= 18 && x <= 21 ? BLACK : RED))
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.pieces).toHaveLength(2)
    // voronoi expansion puts each boundary at the line center (x = 20)
    const boxes = det.pieces.map((p) => bbox(p.loopsPx[0])).sort((a, b) => a.x - b.x)
    expect(boxes[0].x + boxes[0].w).toBeCloseTo(20, 0)
    expect(boxes[1].x).toBeCloseTo(20, 0)
    expect(boxes[0].x).toBe(0)
    expect(boxes[1].x + boxes[1].w).toBe(40)
  })

  it('splits a cross into four pieces', () => {
    const img = mkImg(40, 40, (x, y) =>
      (x >= 18 && x <= 21) || (y >= 18 && y <= 21) ? BLACK : RED,
    )
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.pieces).toHaveLength(4)
  })

  it('produces a hole loop for a ring-shaped piece', () => {
    const img = mkImg(30, 30, (x, y) => {
      const d = Math.hypot(x - 15, y - 15)
      return d >= 8 && d <= 11 ? BLACK : RED // ring of black; red inside and outside
    })
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.pieces).toHaveLength(2)
    const ring = det.pieces.find((p) => p.loopsPx.length === 2)
    const inner = det.pieces.find((p) => p.loopsPx.length === 1)
    expect(ring).toBeDefined()
    expect(inner).toBeDefined()
    // inner piece roughly fills the disc r=8 expanded to midline r≈9.5
    const innerArea = Math.abs(signedArea(inner!.loopsPx[0]))
    expect(innerArea).toBeGreaterThan(Math.PI * 7 * 7)
    expect(innerArea).toBeLessThan(Math.PI * 11 * 11)
    // hole winding opposite to outer
    expect(Math.sign(signedArea(ring!.loopsPx[0]))).not.toBe(Math.sign(signedArea(ring!.loopsPx[1])))
  })

  it('treats transparent pixels as outside, never claimed', () => {
    // red square centered in a transparent field: expansion must not grow into it
    const img = mkImg(30, 30, (x, y) =>
      x >= 10 && x < 20 && y >= 10 && y < 20 ? RED : CLEAR,
    )
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.pieces).toHaveLength(1)
    const b = bbox(det.pieces[0].loopsPx[0])
    expect(b.x).toBeCloseTo(10)
    expect(b.y).toBeCloseTo(10)
    expect(b.w).toBeCloseTo(10)
    expect(b.h).toBeCloseTo(10)
  })

  it('claims all pixels of a wide line — boundary lands on its center', () => {
    // 10px-wide line: with no reach cap, every line pixel goes to the nearer
    // piece and the shared boundary sits at x = 20
    const img = mkImg(40, 20, (x) => (x >= 15 && x < 25 ? BLACK : RED))
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.pieces).toHaveLength(2)
    const boxes = det.pieces.map((p) => bbox(p.loopsPx[0])).sort((a, b) => a.x - b.x)
    expect(boxes[0].x + boxes[0].w).toBeCloseTo(20, 0)
    expect(boxes[1].x).toBeCloseTo(20, 0)
  })

  it('wraps junctions smoothly instead of plunging to the junction core', () => {
    // two 21px-wide lines crossing: the junction blob is much wider than the
    // half-width cap, so its core stays unclaimed and each piece outline arcs
    // around it — no vertex dives deep toward the center point (40,40)
    const img = mkImg(80, 80, (x, y) =>
      Math.abs(x - 40) <= 10 || Math.abs(y - 40) <= 10 ? BLACK : RED,
    )
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.pieces).toHaveLength(4)
    for (const p of det.pieces) {
      const dists = p.loopsPx[0].map((v) => Math.hypot(v.x - 40, v.y - 40))
      const minD = Math.min(...dists)
      expect(minD).toBeGreaterThan(2) // no spike into the junction core
      expect(minD).toBeLessThan(20) // but the outline still reaches the junction
    }
    // the whole line network is reported as lead work for fill/erase
    expect(det.leadLoopsPx.length).toBeGreaterThan(0)
    const gp = det.leadLoopsPx.flat(2)
    expect(gp.some((v) => Math.hypot(v.x - 40, v.y - 40) < 15)).toBe(true)
    // and it covers the full line edge-to-edge: a point on a thin run well
    // inside the band sits inside a lead loop
    const thin = { x: 40, y: 4 }
    expect(pointInLoops(thin, det.leadLoopsPx.flat())).toBe(true)
  })

  it('traces lead regions at the art edge regardless of the claim rim', () => {
    // thin 6px line beside a fat blob: the blob's rim is piece-claimed but the
    // lead region must still cover it — otherwise outputs render a black core
    // with a white/colored halo (e.g. the cat nostrils on lucky-colored.png).
    const img = mkImg(100, 100, (x, y) => {
      if (x >= 48 && x <= 53) return BLACK // thin line
      if (x >= 20 && x <= 45 && y >= 55 && y <= 90) return BLACK // fat blob
      return RED
    })
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    const gp = det.leadLoopsPx.flat()
    expect(gp.length).toBeGreaterThan(0)
    // a rim point only 2px inside the blob edge sits inside a lead loop
    expect(gp.some((loop) => pointInLoops({ x: 22, y: 70 }, [loop]))).toBe(true)
    // and the traced outline hugs the blob's outer edge, not the bare core
    const outer = gp.find((loop) => pointInLoops({ x: 22, y: 70 }, [loop]))!
    const b = bbox(outer)
    expect(b.w).toBeGreaterThan(20)
    expect(b.h).toBeGreaterThan(30)
  })

  it('classifies any bright fill as piece, not just red', () => {
    const img = mkImg(20, 20, (x) => (x < 10 ? [0, 0, 255, 255] : [255, 200, 0, 255]))
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.pieces).toHaveLength(1) // no black line -> single piece
  })

  it('is deterministic across runs', () => {
    const img = mkImg(40, 40, (x, y) =>
      (x >= 18 && x <= 21) || (y >= 18 && y <= 21) ? BLACK : RED,
    )
    const a = detect(img, { shrinkPx: 0, lineTol: 48 })
    const b = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(a.pieces.length).toBe(b.pieces.length)
    expect(a.pieces.map((p) => p.areaPx).sort()).toEqual(b.pieces.map((p) => p.areaPx).sort())
    expect(JSON.stringify(a.pieces.map((p) => p.loopsPx))).toBe(
      JSON.stringify(b.pieces.map((p) => p.loopsPx)),
    )
  })

  it('keeps dark glass fills distinct from the black line network', () => {
    // charcoal fill (32,32,32) next to black lines: charcoal is a piece
    const img = mkImg(40, 20, (x) => {
      if (x >= 18 && x <= 21) return BLACK
      return x < 18 ? [42, 37, 32, 255] : [76, 62, 48, 255] // charcoal | brown (real values)
    })
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.pieces).toHaveLength(2)
    expect(det.lineRgb).not.toBeNull()
    const lums = det.pieces.map((p) => p.fillRgb)
    // both dark fills sampled as their own color, not swallowed by lines
    expect(lums.flat().every((c) => c > 16)).toBe(true)
  })

  it('finds the line color at the darkest luminance, not the most common dark fill', () => {
    // huge brown fill, thin black cross — mode of "all dark px" would pick brown
    const img = mkImg(60, 60, (x, y) =>
      (x >= 28 && x <= 31) || (y >= 28 && y <= 31) ? BLACK : [64, 48, 48, 255],
    )
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.lineRgb).not.toBeNull()
    expect(Math.max(...det.lineRgb!)).toBeLessThan(24)
    expect(det.pieces).toHaveLength(4)
  })

  it('treats an image with no dark pixels as having no lines', () => {
    const det = detect(mkImg(20, 20, () => RED), { shrinkPx: 0, lineTol: 48 })
    expect(det.lineRgb).toBeNull()
    expect(det.pieces).toHaveLength(1)
  })

  it('samples the dominant interior fill color per piece', () => {
    const img = mkImg(40, 20, (x) => {
      if (x >= 18 && x <= 21) return BLACK
      return x < 18 ? [200, 30, 30, 255] : [30, 120, 200, 255]
    })
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    const fills = det.pieces.map((p) => p.fillRgb).sort((a, b) => a[0] - b[0])
    // quantized to 16-step buckets; expect one reddish and one bluish fill
    expect(fills[0][0]).toBeLessThan(64)
    expect(fills[0][2]).toBeGreaterThan(160)
    expect(fills[1][0]).toBeGreaterThan(160)
  })

  it('handles anti-aliased line edges without extra pieces', () => {
    // gray transition pixels around the line should still classify as line
    const img = mkImg(40, 20, (x) => {
      if (x === 18 || x === 21) return [90, 90, 90, 255] // soft edge
      if (x === 19 || x === 20) return BLACK
      return RED
    })
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.pieces).toHaveLength(2)
  })

  describe('guide shrink', () => {
    it('erodes at piece seams but not at the image edge', () => {
      // 40x20, 4px black line at x=18..21 => seam boundary at x=20
      const img = mkImg(40, 20, (x) => (x >= 18 && x <= 21 ? BLACK : RED))
      const det = detect(img, { shrinkPx: 3, lineTol: 48 })
      expect(det.pieces).toHaveLength(2)
      const left = det.pieces.map((p) => bbox(p.guideLoopsPx[0])).sort((a, b) => a.x - b.x)[0]
      const right = det.pieces.map((p) => bbox(p.guideLoopsPx[0])).sort((a, b) => a.x - b.x)[1]
      expect(left.x).toBe(0) // image edge uneroded
      expect(left.x + left.w).toBeCloseTo(17, 0) // seam side pulled back 3px
      expect(right.x).toBeCloseTo(23, 0)
      expect(right.x + right.w).toBeCloseTo(40, 0)
      // pattern outline unaffected
      const pl = det.pieces.map((p) => bbox(p.loopsPx[0])).sort((a, b) => a.x - b.x)[0]
      expect(pl.x + pl.w).toBeCloseTo(20, 0)
    })

    it('does not erode toward transparent outside', () => {
      const img = mkImg(30, 30, (x, y) =>
        x >= 10 && x < 20 && y >= 10 && y < 20 ? RED : CLEAR,
      )
      const det = detect(img, { shrinkPx: 3, lineTol: 48 })
      const b = bbox(det.pieces[0].guideLoopsPx[0])
      expect(b.x).toBeCloseTo(10)
      expect(b.w).toBeCloseTo(10)
    })

    it('reports pieces that erode away entirely', () => {
      // 3px stripe between two 4px lines and large neighbors: it claims only
      // ~half of each line (~7px total), so a 4px erosion removes it
      const img = mkImg(40, 10, (x) =>
        x >= 10 && x < 14
          ? BLACK
          : x >= 14 && x < 17
            ? RED
            : x >= 17 && x < 21
              ? BLACK
              : [0, 0, 255, 255],
      )
      const det = detect(img, { shrinkPx: 4, lineTol: 48 })
      const stripe = det.pieces.find((p) => p.origAreaPx <= 30)
      expect(stripe).toBeDefined()
      expect(stripe!.guideLoopsPx).toHaveLength(0)
    })

    it('shrink 0 keeps guide identical to pattern outline', () => {
      const img = mkImg(40, 20, (x) => (x >= 18 && x <= 21 ? BLACK : RED))
      const det = detect(img, { shrinkPx: 0, lineTol: 48 })
      expect(det.pieces[0].guideLoopsPx[0]).toEqual(det.pieces[0].loopsPx[0])
    })
  })
})

describe('background frame detection', () => {
  it('drops the opaque margin outside a closed boundary ring', () => {
    // white margin + black ring + two interior pieces: the margin is "outside"
    const img = mkImg(120, 120, (x, y) => {
      const dx = x - 60, dy = y - 60
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > 34 && d < 42) return BLACK
      if (d <= 34 && x === 60) return BLACK // divider makes two interior pieces
      if (d <= 34) return x < 60 ? RED : [0, 0, 255, 255]
      return [250, 250, 250, 255]
    })
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.background).toBe(1)
    expect(det.pieces).toHaveLength(2)
  })

  it('keeps a border-touching donut: small hole, few enclosed pieces', () => {
    // white canvas + a corner donut (black ring around a red pupil):
    // the outside region touches the border but its hole is tiny
    const img = mkImg(60, 60, (x, y) => {
      if (x < 24 && y < 24) {
        if (x < 4 || x >= 20 || y < 4 || y >= 20) return BLACK
        return RED
      }
      return [250, 250, 250, 255]
    })
    const det = detect(img, { shrinkPx: 0, lineTol: 48 })
    expect(det.background).toBe(0)
    expect(det.pieces).toHaveLength(2) // red pupil + white outer region
  })
})
