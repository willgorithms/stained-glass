import { describe, it, expect } from 'vitest'
import { plateStl } from '../src/out-stl'
import { mkRectPiece } from './helpers'
import type { Plate } from '../src/pack'

function readStl(buf: ArrayBuffer) {
  const dv = new DataView(buf)
  const n = dv.getUint32(80, true)
  const verts: number[] = []
  const normals: number[] = []
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50
    for (let j = 0; j < 3; j++) normals.push(dv.getFloat32(o + j * 4, true))
    for (let j = 0; j < 9; j++) verts.push(dv.getFloat32(o + 12 + j * 4, true))
  }
  return { n, verts, normals, byteLength: buf.byteLength }
}

describe('plateStl', () => {
  const plate: Plate = { pieces: [{ piece: mkRectPiece(1, 30, 15), dx: 10, dy: 20 }] }

  it('writes a well-formed binary STL', () => {
    const s = readStl(plateStl(plate, { heightMm: 1 }))
    // rect: 2 top + 2 bottom + 8 wall tris = 12
    expect(s.n).toBe(12)
    expect(s.byteLength).toBe(84 + 12 * 50)
  })

  it('extrudes to the guide height with translated positions', () => {
    const s = readStl(plateStl(plate, { heightMm: 1 }))
    const xs: number[] = [], ys: number[] = [], zs: number[] = []
    for (let i = 0; i < s.verts.length; i += 3) {
      xs.push(s.verts[i]); ys.push(s.verts[i + 1]); zs.push(s.verts[i + 2])
    }
    expect(Math.min(...xs)).toBeCloseTo(10)
    expect(Math.max(...xs)).toBeCloseTo(40)
    expect(Math.min(...ys)).toBeCloseTo(-35) // y negated: pattern is y-down
    expect(Math.max(...ys)).toBeCloseTo(-20)
    expect(Math.min(...zs)).toBe(0)
    expect(Math.max(...zs)).toBe(1)
  })

  it('produces unit normals', () => {
    const s = readStl(plateStl(plate, { heightMm: 1 }))
    for (let i = 0; i < s.normals.length; i += 3) {
      const l = Math.hypot(s.normals[i], s.normals[i + 1], s.normals[i + 2])
      expect(l).toBeCloseTo(1, 5)
    }
  })

  it('top normals point up, bottom normals point down', () => {
    const s = readStl(plateStl(plate, { heightMm: 1 }))
    let up = 0, down = 0
    for (let i = 0; i < s.n; i++) {
      const nz = s.normals[i * 3 + 2]
      const z = s.verts[i * 9 + 2]
      if (z === 1 && nz > 0.9) up++
      if (z === 1 && nz < -0.9) down++
    }
    expect(up).toBe(2)
    expect(down).toBe(0)
  })

  it('mirrors Y so the top-down view matches the pattern', () => {
    // pattern space is y-down; a slicer shows +y away, so output negates y
    // or the piece appears vertically flipped on the plate
    const s = readStl(plateStl(plate, { heightMm: 1 }))
    const ys: number[] = []
    for (let i = 0; i < s.verts.length; i += 3) ys.push(s.verts[i + 1])
    expect(Math.max(...ys)).toBeCloseTo(-20)
    expect(Math.min(...ys)).toBeCloseTo(-35)
  })

  it('triangulates non-rectangular polygons', () => {
    const tri = mkRectPiece(1, 20, 20)
    tri.guideLoopsMm = [[{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 20 }]]
    const s = readStl(plateStl({ pieces: [{ piece: tri, dx: 0, dy: 0 }] }, { heightMm: 1 }))
    // 1 top + 1 bottom + 6 walls = 8
    expect(s.n).toBe(8)
  })

  it('extrudes pieces with holes', () => {
    const holed = mkRectPiece(1, 30, 30)
    holed.guideLoopsMm.push([
      { x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 },
    ])
    const s = readStl(plateStl({ pieces: [{ piece: holed, dx: 0, dy: 0 }] }, { heightMm: 1 }))
    // top: 8 tris (V-2+2H for a square frame), bottom: 8, walls: 8 outer + 8 hole
    expect(s.n).toBe(32)
    expect(s.byteLength).toBe(84 + 32 * 50)
  })

})
