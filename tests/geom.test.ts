import { describe, it, expect } from 'vitest'
import {
  signedArea,
  centroid,
  bbox,
  simplifyClosed,
  polyVerticalX,
  polyHorizontalX,
  pointInLoops,
  fitSizeToTile,
} from '../src/geom'
import type { Pt } from '../src/geom'

const square = (s: number, ox = 0, oy = 0): Pt[] => [
  { x: ox, y: oy },
  { x: ox + s, y: oy },
  { x: ox + s, y: oy + s },
  { x: ox, y: oy + s },
]

describe('signedArea', () => {
  it('computes area of a square', () => {
    expect(signedArea(square(10))).toBe(100)
  })
  it('flips sign when reversed', () => {
    expect(signedArea(square(10).slice().reverse())).toBe(-100)
  })
  it('is zero for a degenerate line', () => {
    expect(signedArea([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }])).toBe(0)
  })
})

describe('centroid', () => {
  it('is the center of a square', () => {
    const c = centroid(square(10))
    expect(c.x).toBeCloseTo(5)
    expect(c.y).toBeCloseTo(5)
  })
  it('offsets with translation', () => {
    const c = centroid(square(10, 3, 7))
    expect(c.x).toBeCloseTo(8)
    expect(c.y).toBeCloseTo(12)
  })
  it('falls back to mean for degenerate polygons', () => {
    const c = centroid([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }])
    expect(c.x).toBeCloseTo(10)
    expect(c.y).toBeCloseTo(0)
  })
})

describe('bbox', () => {
  it('bounds a square', () => {
    expect(bbox(square(10, 2, 3))).toEqual({ x: 2, y: 3, w: 10, h: 10 })
  })
})

describe('simplifyClosed', () => {
  it('drops collinear midpoint vertices', () => {
    const noisy = [
      { x: 0, y: 0 }, { x: 5, y: 0.001 }, { x: 10, y: 0 },
      { x: 10, y: 10 }, { x: 0, y: 10 },
    ]
    const out = simplifyClosed(noisy, 0.01)
    expect(out.length).toBe(4)
  })
  it('keeps a tiny triangle as-is', () => {
    const tri = [{ x: 0, y: 0 }, { x: 5, y: 8 }, { x: 10, y: 0 }]
    expect(simplifyClosed(tri, 1)).toHaveLength(3)
  })
  it('never returns fewer than 3 points', () => {
    const tiny = [{ x: 0, y: 0 }, { x: 0.001, y: 0 }, { x: 0, y: 0.001 }, { x: 0.002, y: 0.002 }]
    expect(simplifyClosed(tiny, 1).length).toBeGreaterThanOrEqual(3)
  })
  it('preserves a circle within tolerance', () => {
    const circle: Pt[] = []
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2
      circle.push({ x: 50 + 20 * Math.cos(a), y: 50 + 20 * Math.sin(a) })
    }
    const out = simplifyClosed(circle, 0.5)
    expect(Math.abs(signedArea(out))).toBeGreaterThan(Math.PI * 19 * 19)
    expect(Math.abs(signedArea(out))).toBeLessThan(Math.PI * 20.5 * 20.5)
    expect(out.length).toBeLessThan(64)
  })
})

describe('seam intersections', () => {
  it('finds both crossings through a square vertically', () => {
    expect(polyVerticalX(square(10), 5).sort((a, b) => a - b)).toEqual([0, 10])
  })
  it('finds both crossings through a square horizontally', () => {
    expect(polyHorizontalX(square(10), 5).sort((a, b) => a - b)).toEqual([0, 10])
  })
  it('returns none outside the shape', () => {
    expect(polyVerticalX(square(10), 15)).toEqual([])
    expect(polyHorizontalX(square(10), -1)).toEqual([])
  })
  it('handles a seam exactly through a vertex without double counting', () => {
    // diamond: vertex right on the seam
    const diamond: Pt[] = [
      { x: 5, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 5 },
    ]
    const ys = polyVerticalX(diamond, 5)
    expect(ys).toHaveLength(2)
    expect(Math.min(...ys)).toBe(0)
    expect(Math.max(...ys)).toBe(10)
  })
  it('skips an edge lying exactly on the seam', () => {
    const ys = polyVerticalX(square(10), 10)
    // crossing count must stay even (enter+exit), not broken by the coincident edge
    expect(ys.length % 2).toBe(0)
  })
})

describe('pointInLoops', () => {
  const outer = [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 },
  ]
  const hole = [
    { x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 },
  ]

  it('hits inside the outer loop, misses the hole and outside', () => {
    expect(pointInLoops({ x: 30, y: 30 }, [outer, hole])).toBe(true)
    expect(pointInLoops({ x: 15, y: 15 }, [outer, hole])).toBe(false) // inside hole
    expect(pointInLoops({ x: 50, y: 30 }, [outer, hole])).toBe(false)
    expect(pointInLoops({ x: -1, y: 20 }, [outer, hole])).toBe(false)
  })

  it('works on a plain outline with no holes', () => {
    expect(pointInLoops({ x: 20, y: 20 }, [outer])).toBe(true)
    expect(pointInLoops({ x: 41, y: 20 }, [outer])).toBe(false)
  })
})

describe('fitSizeToTile', () => {
  it('fits canvas aspect inside the tile, width-limited', () => {
    const f = fitSizeToTile(2550, 3300, 190.4, 254)
    expect(f.w).toBeCloseTo(190.4)
    expect(f.h).toBeCloseTo((190.4 * 3300) / 2550)
  })
  it('is height-limited for very tall canvases', () => {
    const f = fitSizeToTile(1000, 2000, 190.4, 254)
    expect(f.h).toBeCloseTo(254)
    expect(f.w).toBeCloseTo((254 * 1000) / 2000)
  })
  it('keeps square canvases square', () => {
    const f = fitSizeToTile(1000, 1000, 190.4, 254)
    expect(f.w).toBeCloseTo(190.4)
    expect(f.h).toBeCloseTo(190.4)
  })
})
