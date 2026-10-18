import earcut from 'earcut'
import type { Plate } from './pack'

/** Options for {@link plateStl}. */
export interface StlOpts {
  /** Extrusion height of each guide piece, in mm. */
  heightMm: number
}

/**
 * Binary STL for one plate: every piece extruded to `heightMm` with correct
 * outward-facing normals. Y is negated — pattern space is y-down (image
 * coords) but a slicer's top-down view shows +y away.
 */
export function plateStl(plate: Plate, o: StlOpts): ArrayBuffer {
  const { heightMm: height } = o
  const tris: number[] = [] // 9 floats per triangle

  const pushTri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ) => {
    tris.push(ax, ay, az, bx, by, bz, cx, cy, cz)
  }

  const fixWinding = (
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
    wantPosZ: boolean,
  ) => {
    // normal z of tri (a,b,c) all at same z: cross = (b-a)x(c-a), z = ux*vy-uy*vx
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    const posZ = nz > 0
    if (posZ === wantPosZ) return [ax, ay, bx, by, cx, cy]
    return [ax, ay, cx, cy, bx, by]
  }

  const emitShape = (loops: { x: number; y: number }[][], cx0: number, cy0: number) => {
    const outer = loops[0]
    const holes = loops.slice(1)
    const flat: number[] = []
    for (const p of outer) flat.push(p.x, p.y)
    const holeIdx: number[] = []
    for (const h of holes) {
      holeIdx.push(flat.length / 2)
      for (const p of h) flat.push(p.x, p.y)
    }
    const idx = earcut(flat, holeIdx.length ? holeIdx : undefined)
    const at = (i: number): [number, number] => [flat[idx[i] * 2], flat[idx[i] * 2 + 1]]

    for (let i = 0; i < idx.length; i += 3) {
      const [ax, ay] = at(i)
      const [bx, by] = at(i + 1)
      const [cx, cy] = at(i + 2)
      let t = fixWinding(ax, ay, bx, by, cx, cy, true)
      pushTri(t[0], t[1], height, t[2], t[3], height, t[4], t[5], height)
      t = fixWinding(ax, ay, bx, by, cx, cy, false)
      pushTri(t[0], t[1], 0, t[2], t[3], 0, t[4], t[5], 0)
    }

    // side walls, normal pushed away from piece centroid
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]
        const b = loop[(i + 1) % loop.length]
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const ox = mx - cx0
        const oy = my - cy0
        // quad (a@0, b@0, b@h, a@h) -> two tris; orient so normal·outward > 0
        const wall = (flip: boolean) => {
          if (!flip) {
            pushTri(a.x, a.y, 0, b.x, b.y, 0, b.x, b.y, height)
            pushTri(a.x, a.y, 0, b.x, b.y, height, a.x, a.y, height)
          } else {
            pushTri(a.x, a.y, 0, b.x, b.y, height, b.x, b.y, 0)
            pushTri(a.x, a.y, 0, a.x, a.y, height, b.x, b.y, height)
          }
        }
        // normal of first tri: u=(b-a)@0, v=(b-a)@h -> cross
        const ux = b.x - a.x
        const uy = b.y - a.y
        // cross((ux,uy,0),(ux,uy,h)) = (uy*h, -ux*h, 0)
        const nx = uy * height
        const ny = -ux * height
        wall(nx * ox + ny * oy < 0)
      }
    }
  }

  for (const pp of plate.pieces) {
    // Y is negated: pattern space is y-down (image coords) but a slicer's
    // top-down view shows +y away, so unmirrored output looks flipped on
    // the plate. Negating makes the STL match the pattern top-down.
    const loops = pp.piece.guideLoopsMm.map((l) =>
      l.map((p) => ({ x: p.x + pp.dx, y: -(p.y + pp.dy) })),
    )
    emitShape(
      loops,
      pp.piece.centroidMm.x + pp.dx,
      -(pp.piece.centroidMm.y + pp.dy),
    )
  }

  const nTri = tris.length / 9
  const buf = new ArrayBuffer(84 + nTri * 50)
  const dv = new DataView(buf)
  dv.setUint32(80, nTri, true)
  let off = 84
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2]
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5]
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz) || 1
    nx /= nl; ny /= nl; nz /= nl
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true)
    dv.setFloat32(off + 12, ax, true); dv.setFloat32(off + 16, ay, true); dv.setFloat32(off + 20, az, true)
    dv.setFloat32(off + 24, bx, true); dv.setFloat32(off + 28, by, true); dv.setFloat32(off + 32, bz, true)
    dv.setFloat32(off + 36, cx, true); dv.setFloat32(off + 40, cy, true); dv.setFloat32(off + 44, cz, true)
    dv.setUint16(off + 48, 0, true)
    off += 50
  }
  return buf
}
