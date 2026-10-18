import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import type { Piece } from '../src/pack'

export type Rgba = [number, number, number, number]

export const RED: Rgba = [255, 0, 0, 255]
export const BLACK: Rgba = [0, 0, 0, 255]
export const CLEAR: Rgba = [0, 0, 0, 0]

// Build a synthetic ImageData from a per-pixel fill function.
export function mkImg(w: number, h: number, fill: (x: number, y: number) => Rgba): ImageData {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const c = fill(x, y)
      data[o] = c[0]
      data[o + 1] = c[1]
      data[o + 2] = c[2]
      data[o + 3] = c[3]
    }
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData
}

export function loadPng(fixtureFile: string): ImageData {
  const p = new URL(`./fixtures/${fixtureFile}`, import.meta.url).pathname
  const png = PNG.sync.read(readFileSync(p))
  return {
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
    colorSpace: 'srgb',
  } as ImageData
}

// A rectangular piece for packing/output tests.
export function mkRectPiece(id: number, w: number, h: number): Piece {
  const loop = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ]
  return {
    id,
    patternLoopsMm: [loop],
    patternBoxMm: { x: 0, y: 0, w, h },
    guideLoopsMm: [loop],
    guideBoxMm: { x: 0, y: 0, w, h },
    centroidMm: { x: w / 2, y: h / 2 },
    fillRgb: [200, 100, 50],
    colorIdx: 0,
    areaPx: w * h,
  }
}
