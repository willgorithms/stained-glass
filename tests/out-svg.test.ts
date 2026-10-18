import { describe, it, expect } from 'vitest'
import { plateSvg } from '../src/out-svg'
import { mkRectPiece } from './helpers'
import type { Plate } from '../src/pack'

const plate = (dx = 10, dy = 20): Plate => ({
  pieces: [{ piece: mkRectPiece(1, 30, 15), dx, dy }],
})

describe('plateSvg', () => {
  it('emits mm-sized viewBox matching the plate', () => {
    const s = plateSvg(plate(), 256, 256, 'none', 2)
    expect(s).toContain('width="256mm"')
    expect(s).toContain('height="256mm"')
    expect(s).toContain('viewBox="0 0 256 256"')
  })

  it('translates piece coordinates by placement offset', () => {
    const s = plateSvg(plate(10, 20), 256, 256, 'none', 2)
    expect(s).toContain('M10 20') // rect corner at (dx,dy)
    expect(s).toContain('40 35') // opposite corner (10+30, 20+15)
  })

  it('draws four dots when no corner is excluded', () => {
    const s = plateSvg(plate(), 256, 256, 'none', 2)
    expect(s.match(/<circle/g)).toHaveLength(4)
  })

  it('skips the excluded corner dot', () => {
    const s = plateSvg(plate(), 256, 256, 'tr', 2)
    expect(s.match(/<circle/g)).toHaveLength(3)
    expect(s).not.toContain('cx="254" cy="2"')
    expect(s).toContain('cx="2" cy="2"')
  })

  it('dots reach the plate edges so the bounding box is exact', () => {
    const s = plateSvg(plate(), 256, 256, 'tr', 2)
    // circles at r=2 centered 2 from edges => extents touch 0 and 256
    expect(s).toContain('cx="254" cy="254"')
    expect(s).toContain('cx="2" cy="254"')
  })

  it('emits one path per piece including hole subpaths', () => {
    const holed = mkRectPiece(1, 30, 15)
    holed.guideLoopsMm.push([
      { x: 5, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 10 }, { x: 5, y: 10 },
    ])
    const s = plateSvg({ pieces: [{ piece: holed, dx: 0, dy: 0 }] }, 256, 256, 'none', 2)
    expect(s.match(/<path/g)).toHaveLength(1)
    expect(s.match(/M[\d.]+ [\d.]+/g)!.length).toBeGreaterThanOrEqual(2) // two subpaths
    expect(s).toContain('fill-rule="evenodd"')
  })
})
