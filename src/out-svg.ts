import type { Plate, ExclCorner } from './pack'

/** Round to 0.001 mm — plenty for SVG path output. */
const f = (v: number) => Math.round(v * 1000) / 1000

/**
 * Render a plate as an SVG document in true mm dimensions: filled piece
 * outlines plus registration dots at every corner except the excluded one
 * (their extents bound the plate so "scale to W×H" in a slicer is exact).
 */
export function plateSvg(
  plate: Plate,
  plateW: number,
  plateH: number,
  exclCorner: ExclCorner,
  dotR: number,
): string {
  const parts: string[] = []
  for (const pp of plate.pieces) {
    let d = ''
    for (const loop of pp.piece.guideLoopsMm) {
      const pts = loop.map((p) => ({ x: p.x + pp.dx, y: p.y + pp.dy }))
      d += 'M' + pts.map((p) => `${f(p.x)} ${f(p.y)}`).join('L') + 'Z'
    }
    parts.push(`<path d="${d}" fill="#000" fill-rule="evenodd"/>`)
  }

  // registration dots at every corner except the excluded one:
  // their extents bound the plate so "scale to WxH" in the slicer is exact
  const corners: Array<[number, number, ExclCorner]> = [
    [dotR, dotR, 'tl'],
    [plateW - dotR, dotR, 'tr'],
    [plateW - dotR, plateH - dotR, 'br'],
    [dotR, plateH - dotR, 'bl'],
  ]
  for (const [cx, cy, corner] of corners) {
    if (corner === exclCorner) continue
    parts.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(dotR)}" fill="#000"/>`)
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(plateW)}mm" height="${f(plateH)}mm" viewBox="0 0 ${f(plateW)} ${f(plateH)}">\n` +
    parts.join('\n') +
    '\n</svg>\n'
  )
}
