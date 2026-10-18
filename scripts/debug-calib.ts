// Debug: run calibration analysis on a real photo PNG (absolute path arg).
// Optionally pass "flip" to rotate the image 180 degrees first.
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { analyzeCalibrationPhoto, calibSpec } from '../src/calibrate'

const [file, mode] = process.argv.slice(2)
const png = PNG.sync.read(readFileSync(file))
let { width: W, height: H } = png
let data = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength)
if (mode === 'flip') {
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4
      const d = ((H - 1 - y) * W + (W - 1 - x)) * 4
      for (let c = 0; c < 4; c++) out[d + c] = data[s + c]
    }
  data = out
}
const img = { width: W, height: H, data } as ImageData
const r = analyzeCalibrationPhoto(img, calibSpec(215.9, 279.4))
console.log(JSON.stringify({ ...r, rect: undefined, labelMap: undefined, corners: r.corners?.map((c) => `${c.x.toFixed(0)},${c.y.toFixed(0)}`) }, null, 2))
