import './style.css'
import { runDetect } from './pipeline'
import type { PipelineParams, PipelineResult } from './pipeline'
import { pack } from './pack'
import type { ExclCorner, Plate, Piece } from './pack'
import { plateSvg } from './out-svg'
import { plateStl } from './out-stl'
import { patternPdf } from './out-pdf'
import { pointInLoops, fitSizeToTile } from './geom'
import { calibSpec, calibrationPdf, calibrationPiece, analyzeCalibrationPhoto } from './calibrate'
import type { CalibResult } from './calibrate'
import {
  collectFieldValues, applyFieldValues, hashBlobBytes,
  savePatternSettings, loadPatternSettings, pieceSignature,
} from './settings'
import type { FieldLike } from './settings'

/** Element lookup shorthand — every fetched id exists in index.html. */
const $ = (id: string) => document.getElementById(id) as HTMLInputElement

/** Source image currently loaded, or null on the landing screen. */
let imgData: ImageData | null = null
let pieces: Piece[] = []
let plates: Plate[] = []
let palette: { rgb: [number, number, number]; count: number }[] = []
let highlightColor: number | null = null
const excludedSigs = new Set<string>() // piece signatures kept off the 3D-print plates
const excluded = new Set<number>() // ids for the current detection, derived each repack
let currentPatternId: string | null = null // content hash → localStorage key
let restoredSettings = false
// pristine field values captured at boot — used to tell "never touched" from
// an intentional user size when choosing fit-page defaults for a new pattern
const PRISTINE_SIZE = { w: $('patternWmm').value, h: $('patternHmm').value }

/** Parse a numeric field's displayed value; non-numbers read as 0. */
const num = (id: string) => parseFloat($(id).value) || 0

// unit-aware field reads: displayed values convert to mm for the pipeline
/** Current unit selector value. */
const units = () => $('units').value as 'mm' | 'in'
/** Read a length field, converting the displayed value to mm. */
const len = (id: string) => num(id) * (units() === 'in' ? 25.4 : 1)
/** Read an area field, converting the displayed value to mm². */
const area = (id: string) => num(id) * (units() === 'in' ? 645.16 : 1)

/** Field ids holding lengths (mm) that convert when the unit toggle flips. */
const LEN_IDS = [
  'patternWmm', 'patternHmm', 'overlapMm', 'lineWmm', 'marginMm',
  'plateW', 'plateH', 'gapMm', 'exclW', 'exclH',
  'guideHmm', 'guideShrinkMm', 'dotR', 'simplifyMm',
]
/** Field ids holding areas (mm²) that convert when the unit toggle flips. */
const AREA_IDS = ['minAreaMm2']

/** Convert every length/area field's displayed value between mm and inches. */
function convertUnits() {
  const toIn = units() === 'in'
  const fmt = (v: number) => String(parseFloat(v.toFixed(toIn ? 4 : 2)))
  for (const id of LEN_IDS) {
    const el = $(id) as HTMLInputElement
    const v = parseFloat(el.value)
    if (!isNaN(v)) el.value = fmt(v * (toIn ? 1 / 25.4 : 25.4))
  }
  for (const id of AREA_IDS) {
    const el = $(id) as HTMLInputElement
    const v = parseFloat(el.value)
    if (!isNaN(v)) el.value = fmt(v * (toIn ? 1 / 645.16 : 645.16))
  }
  document.querySelectorAll('.u').forEach((s) => (s.textContent = toIn ? 'in' : 'mm'))
  document.querySelectorAll('.u2').forEach((s) => (s.textContent = toIn ? 'in²' : 'mm²'))
  run()
}

/**
 * Collect every control field into a parameter object (mm-space) for the
 * detection, packing, and output stages.
 */
function params(): PipelineParams & {
  plateW: number; plateH: number; gap: number
  exclCorner: ExclCorner; exclW: number; exclH: number
  guideH: number; dotR: number
  pageWmm: number; pageHmm: number; overlapMm: number; marginMm: number; scalePct: number; lineWmm: number
} {
  const preset = $('pagePreset').value
  const pageWmm = preset === 'a4' ? 210 : 215.9
  const pageHmm = preset === 'a4' ? 297 : 279.4
  return {
    patternWmm: len('patternWmm'),
    patternHmm: len('patternHmm'),
    minAreaMm2: area('minAreaMm2'),
    expandPx: num('expandPx'),
    simplifyMm: len('simplifyMm'),
    guideShrinkMm: len('guideShrinkMm'),
    lineTol: num('lineTol'),
    paletteTol: num('paletteTol'),
    plateW: len('plateW'),
    plateH: len('plateH'),
    gap: len('gapMm'),
    exclCorner: $('exclCorner').value as ExclCorner,
    exclW: len('exclW'),
    exclH: len('exclH'),
    guideH: len('guideHmm'),
    dotR: len('dotR'),
    pageWmm, pageHmm,
    overlapMm: len('overlapMm'),
    marginMm: len('marginMm'),
    scalePct: num('scalePct'),
    lineWmm: len('lineWmm'),
  }
}

/** Display color of a piece: its palette cluster color, else its raw fill. */
const pieceColor = (pc: Piece) => css(palette[pc.colorIdx]?.rgb ?? pc.fillRgb)

/** Last detection result, kept around for status text and preview redraws. */
let lastDet: PipelineResult | null = null

// ---------- per-pattern settings persistence ----------

/** All inputs/selects in the sidebar, for settings persistence. */
const controlFields = (): FieldLike[] => [
  ...document.querySelectorAll<HTMLInputElement>('#controls input, #controls select'),
]

/** Persist all field values plus piece exclusions under the current pattern hash. */
function saveSettings() {
  if (!currentPatternId) return
  savePatternSettings(localStorage, currentPatternId, {
    ...collectFieldValues(controlFields()),
    _excluded: [...excludedSigs],
  })
}

/**
 * Apply saved field values and exclusion signatures for the current pattern.
 * Returns whether a stored entry existed.
 */
function restoreSettings(): boolean {
  if (!currentPatternId) return false
  const data = loadPatternSettings(localStorage, currentPatternId)
  if (!data) return false
  applyFieldValues(data, controlFields())
  // Only signature strings are honored: legacy numeric ids are unverifiable
  // against the current detection and would exclude the wrong pieces.
  for (const s of (data._excluded as unknown[] | undefined) ?? []) {
    if (typeof s === 'string') excludedSigs.add(s)
  }
  return true
}

/**
 * Re-resolve exclusions onto current pieces, re-pack plates, refresh status
 * text and all panes, and persist settings.
 */
function repack() {
  const p = params()
  // Resolve the user's sig-keyed exclusions onto the current pieces; ids may
  // have renumbered since the signatures were stored.
  excluded.clear()
  for (const pc of pieces) {
    if (excludedSigs.has(pieceSignature(pc, p.patternWmm, p.patternHmm))) {
      excluded.add(pc.id)
    }
  }
  const packable = pieces.filter(
    (pc) => pc.guideLoopsMm.length > 0 && !excluded.has(pc.id),
  )
  const packed = pack(packable, {
    plateW: p.plateW, plateH: p.plateH, gap: p.gap,
    exclCorner: p.exclCorner, exclW: p.exclW, exclH: p.exclH,
  })
  plates = packed.plates

  const vanished = pieces.filter((pc) => pc.guideLoopsMm.length === 0).length
  const det = lastDet!
  $('status').textContent =
    `${det.imgW}×${det.imgH}px → ${pieces.length} pieces` +
    (det.dropped ? ` (${det.dropped} specks dropped)` : '') +
    (det.background ? ` · ${det.background} background region${det.background === 1 ? '' : 's'} excluded` : '') +
    ` · ${palette.length} colors · ${plates.length} plate${plates.length === 1 ? '' : 's'}` +
    (excluded.size ? ` · ${excluded.size} excluded from plates` : '') +
    (restoredSettings ? ' · settings restored' : '') +
    (packed.overflow.length ? ` · ${packed.overflow.length} TOO BIG FOR PLATE` : '') +
    (vanished ? ` · ${vanished} VANISHED under guide shrink` : '') +
    `\nline color: ${det.lineRgb ? `rgb(${det.lineRgb.join(',')})` : 'none detected'}`

  drawPalette()
  drawPieces()
  drawPlates(p)
  drawDownloads(p)
  saveSettings()
}

/** Re-run detection on the loaded image with current params, then repack. */
function run() {
  if (!imgData) return
  const p = params()
  const det = runDetect(imgData, p)
  lastDet = det
  pieces = det.pieces
  palette = det.palette
  repack()
}

/** Format an `[r,g,b]` triple as a CSS color. */
const css = (rgb: [number, number, number]) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`

// subtle gray checker marking detected background (preview only)
let checkerPat: CanvasPattern | null = null
/** Lazily built 16px checkerboard pattern used to mark background regions. */
const checker = (ctx: CanvasRenderingContext2D): CanvasPattern | null => {
  if (!checkerPat) {
    const t = document.createElement('canvas')
    t.width = t.height = 16
    const c2 = t.getContext('2d')!
    c2.fillStyle = '#e6e6e6'
    c2.fillRect(0, 0, 16, 16)
    c2.fillStyle = '#d6d6d6'
    c2.fillRect(0, 0, 8, 8)
    c2.fillRect(8, 8, 8, 8)
    checkerPat = ctx.createPattern(t, 'repeat')
  }
  return checkerPat
}

/**
 * Render the glass palette swatches. Hovering highlights that color's pieces;
 * clicking toggles every piece of the color on/off the plates.
 */
function drawPalette() {
  const host = $('paletteHost')
  host.innerHTML = ''
  for (const [i, e] of palette.entries()) {
    const off = pieces.filter((pc) => pc.colorIdx === i && excluded.has(pc.id)).length
    const row = document.createElement('div')
    row.className = 'swatch' + (off === e.count ? ' off' : '')
    row.title = 'click to toggle this color on the plates'
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.style.background = css(e.rgb)
    const label = document.createElement('span')
    label.textContent =
      `#${i + 1} — ${e.count} piece${e.count === 1 ? '' : 's'}` +
      (off ? ` (${off} off)` : '')
    row.append(chip, label)
    row.addEventListener('mouseenter', () => {
      highlightColor = i
      drawPieces()
    })
    row.addEventListener('mouseleave', () => {
      highlightColor = null
      drawPieces()
    })
    row.addEventListener('click', () => {
      // any included -> exclude all; fully excluded -> include all
      const include = off === e.count
      const p = params()
      for (const pc of pieces) {
        if (pc.colorIdx !== i) continue
        const sig = pieceSignature(pc, p.patternWmm, p.patternHmm)
        if (include) excludedSigs.delete(sig)
        else excludedSigs.add(sig)
      }
      repack()
    })
    host.append(row)
  }
}

/**
 * Draw the piece-outlines preview: faint source image, checkerboard over
 * detected background, and each piece tinted in its palette color.
 */
function drawPieces() {
  const c = $('piecesCanvas') as unknown as HTMLCanvasElement
  const ctx = c.getContext('2d')!
  if (!imgData) return
  const W = Math.min(imgData.width, 1600)
  const s = W / imgData.width
  c.width = W
  c.height = Math.round(imgData.height * s)
  c.style.width = '100%'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  // faint source image
  const tmp = document.createElement('canvas')
  tmp.width = imgData.width
  tmp.height = imgData.height
  tmp.getContext('2d')!.putImageData(imgData, 0, 0)
  ctx.globalAlpha = 0.25
  ctx.drawImage(tmp, 0, 0, c.width, c.height)
  ctx.globalAlpha = 1

  // negative space: subtle checkerboard where detection found background
  const pat = checker(ctx)
  if (pat) {
    for (const loops of lastDet?.bgLoopsPx ?? []) {
      ctx.beginPath()
      for (const loop of loops) {
        loop.forEach((q, i) => {
          if (i === 0) ctx.moveTo(q.x * s, q.y * s)
          else ctx.lineTo(q.x * s, q.y * s)
        })
        ctx.closePath()
      }
      ctx.fillStyle = pat
      ctx.fill('evenodd')
    }
  }

  const p = params()
  const mmx = p.patternWmm / imgData.width
  const mmy = p.patternHmm / imgData.height
  const toPx = (xmm: number, ymm: number): [number, number] => [(xmm / mmx) * s, (ymm / mmy) * s]

  for (const pc of pieces) {
    const off = excluded.has(pc.id)
    const hl = highlightColor === null || pc.colorIdx === highlightColor
    for (const loop of pc.patternLoopsMm) {
      ctx.beginPath()
      loop.forEach((q, i) => {
        const [x, y] = toPx(q.x, q.y)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.closePath()
      ctx.fillStyle = off ? '#888' : pieceColor(pc)
      ctx.globalAlpha = off ? 0.08 : hl ? 0.9 : 0.12
      ctx.fill()
      ctx.globalAlpha = 1
      if (off) {
        ctx.setLineDash([3, 3])
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'
      } else {
        ctx.strokeStyle = hl ? '#000' : 'rgba(0,0,0,0.25)'
      }
      ctx.lineWidth = highlightColor !== null && hl && !off ? 1.6 : 0.8
      ctx.stroke()
      ctx.setLineDash([])
    }
    const [cx, cy] = toPx(pc.centroidMm.x, pc.centroidMm.y)
    ctx.fillStyle = off ? 'rgba(0,0,0,0.25)' : hl ? '#000' : 'rgba(0,0,0,0.3)'
    ctx.font = 'bold 12px system-ui'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(pc.id), cx, cy)
  }
}

/** Draw one canvas per plate: guide outlines, exclusion zone, corner dots. */
function drawPlates(p: ReturnType<typeof params>) {
  const host = $('plates')
  host.innerHTML = ''
  plates.forEach((plate, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'plate'
    const c = document.createElement('canvas')
    const s = 520 / p.plateW
    c.width = Math.round(p.plateW * s)
    c.height = Math.round(p.plateH * s)
    c.style.width = '260px'
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.strokeStyle = '#888'
    ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1)

    if (p.exclCorner !== 'none' && p.exclW > 0 && p.exclH > 0) {
      const ex = {
        x: p.exclCorner === 'tl' || p.exclCorner === 'bl' ? 0 : p.plateW - p.exclW,
        y: p.exclCorner === 'tl' || p.exclCorner === 'tr' ? 0 : p.plateH - p.exclH,
      }
      ctx.fillStyle = 'rgba(200,0,0,0.18)'
      ctx.fillRect(ex.x * s, ex.y * s, p.exclW * s, p.exclH * s)
    }

    for (const pp of plate.pieces) {
      for (const loop of pp.piece.guideLoopsMm) {
        ctx.beginPath()
        loop.forEach((q, j) => {
          const x = (q.x + pp.dx) * s
          const y = (q.y + pp.dy) * s
          if (j === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.closePath()
        ctx.fillStyle = '#bbb'
        ctx.fill()
        ctx.strokeStyle = '#000'
        ctx.lineWidth = 0.7
        ctx.stroke()
      }
      const cx = (pp.piece.centroidMm.x + pp.dx) * s
      const cy = (pp.piece.centroidMm.y + pp.dy) * s
      ctx.fillStyle = '#333'
      ctx.font = '9px system-ui'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(pp.piece.id), cx, cy)
    }

    const r = p.dotR
    const corners: Array<[number, number, ExclCorner]> = [
      [r, r, 'tl'], [p.plateW - r, r, 'tr'],
      [p.plateW - r, p.plateH - r, 'br'], [r, p.plateH - r, 'bl'],
    ]
    ctx.fillStyle = '#000'
    for (const [cx, cy, corner] of corners) {
      if (corner === p.exclCorner) continue
      ctx.beginPath()
      ctx.arc(cx * s, cy * s, r * s, 0, Math.PI * 2)
      ctx.fill()
    }

    const label = document.createElement('span')
    label.textContent = `plate ${i + 1} — ${plate.pieces.length} pieces`
    wrap.append(c, label)
    host.append(wrap)
  })
}

/** Trigger a browser download of `blob` as `name`. */
function download(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

/**
 * Rebuild the export buttons: pattern.pdf, Print, and one SVG + STL per plate.
 * Blobs are generated lazily on click.
 */
function drawDownloads(p: ReturnType<typeof params>) {
  const host = $('downloads')
  host.innerHTML = ''
  if (!pieces.length) return

  const mkBtn = (label: string, fn: () => Promise<Blob> | Blob) => {
    const b = document.createElement('button')
    b.textContent = label
    b.onclick = async () => download(label.replace(/\s+/g, '-'), await fn())
    host.append(b)
  }

  const pdfBytes = () =>
    patternPdf(pieces, {
      pageWmm: p.pageWmm, pageHmm: p.pageHmm, overlapMm: p.overlapMm, marginMm: p.marginMm,
      scalePct: p.scalePct, lineWmm: p.lineWmm,
      patternWmm: p.patternWmm, patternHmm: p.patternHmm,
    })
  mkBtn('pattern.pdf', async () =>
    new Blob([await pdfBytes() as unknown as BlobPart], { type: 'application/pdf' }))

  const printBtn = document.createElement('button')
  printBtn.textContent = 'Print pattern…'
  printBtn.onclick = async () => {
    const url = URL.createObjectURL(
      new Blob([await pdfBytes() as unknown as BlobPart], { type: 'application/pdf' }),
    )
    const f = document.createElement('iframe')
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
    f.src = url
    f.onload = () => {
      const w = f.contentWindow
      if (!w) return
      const cleanup = () => {
        URL.revokeObjectURL(url)
        f.remove()
      }
      w.addEventListener('afterprint', cleanup)
      w.focus()
      w.print()
      // fallback cleanup if afterprint never fires
      setTimeout(cleanup, 60_000)
    }
    document.body.appendChild(f)
  }
  host.append(printBtn)
  plates.forEach((plate, i) => {
    mkBtn(`plate-${i + 1}.svg`, () =>
      new Blob([plateSvg(plate, p.plateW, p.plateH, p.exclCorner, p.dotR)], { type: 'image/svg+xml' }))
    mkBtn(`plate-${i + 1}.stl`, () =>
      new Blob([plateStl(plate, { heightMm: p.guideH })],
        { type: 'application/octet-stream' }))
  })
}

/**
 * Decode a PNG blob into `imgData`, key its settings by content hash, restore
 * saved settings (or fit-page default sizes for a fresh pattern), reveal the
 * controls, and run the pipeline.
 */
async function loadFile(blob: Blob) {
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  const ctx = c.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  imgData = ctx.getImageData(0, 0, bmp.width, bmp.height)
  document.body.classList.add('loaded') // reveal controls + preview panes
  currentPatternId = await hashBlobBytes(await blob.arrayBuffer())
  excludedSigs.clear()
  excluded.clear()
  restoredSettings = restoreSettings()
  // New pattern with untouched size fields: default to the biggest declared
  // size matching the canvas aspect that still fits one printable tile, so
  // the pattern PDF is a single page whenever it can be.
  if (
    !restoredSettings &&
    $('patternWmm').value === PRISTINE_SIZE.w &&
    $('patternHmm').value === PRISTINE_SIZE.h
  ) {
    const p = params()
    const fit = fitSizeToTile(
      imgData.width, imgData.height,
      p.pageWmm - 2 * p.marginMm, p.pageHmm - 2 * p.marginMm,
    )
    const div = units() === 'in' ? 25.4 : 1
    $('patternWmm').value = String(parseFloat((fit.w / div).toFixed(2)))
    $('patternHmm').value = String(parseFloat((fit.h / div).toFixed(2)))
  }
  run()
}

// click a piece in the preview to toggle it off the print plates
$('piecesCanvas').addEventListener('click', (e) => {
  if (!imgData || !pieces.length) return
  const c = e.currentTarget as HTMLCanvasElement
  const rect = c.getBoundingClientRect()
  const px = (e.clientX - rect.left) * (c.width / rect.width)
  const py = (e.clientY - rect.top) * (c.height / rect.height)
  const p = params()
  const s = c.width / imgData.width
  const xmm = (px / s) * (p.patternWmm / imgData.width)
  const ymm = (py / s) * (p.patternHmm / imgData.height)
  // topmost match wins; pieces tile without overlap so first hit is fine
  for (const pc of pieces) {
    if (!pointInLoops({ x: xmm, y: ymm }, pc.patternLoopsMm)) continue
    const sig = pieceSignature(pc, p.patternWmm, p.patternHmm)
    if (excludedSigs.has(sig)) excludedSigs.delete(sig)
    else excludedSigs.add(sig)
    repack()
    break
  }
})

// ---------- printer calibration ----------

/** Calibration spec for the currently selected page size. */
const calibSpecNow = () => {
  const p = params()
  return calibSpec(p.pageWmm, p.pageHmm)
}

$('calibPdf').addEventListener('click', async () => {
  download(
    'calibration.pdf',
    new Blob([await calibrationPdf(calibSpecNow()) as unknown as BlobPart], {
      type: 'application/pdf',
    }),
  )
})

$('calibStl').addEventListener('click', () => {
  const p = params()
  const piece = calibrationPiece(calibSpecNow())
  download(
    'calibration-bar.stl',
    new Blob([plateStl({ pieces: [{ piece, dx: 0, dy: 0 }] }, {
      heightMm: p.guideH,
    })], { type: 'application/octet-stream' }),
  )
})

/**
 * Show calibration analysis: measured factors, warnings, a rectified-page
 * overlay (box green, bar red), and an apply-scale button.
 */
function renderCalibResult(res: CalibResult) {
  const host = $('calibResult')
  host.innerHTML = ''
  const lines: string[] = []
  if (res.LboxMm !== undefined)
    lines.push(`printed box: ${res.LboxMm.toFixed(1)}mm — paper printer at ${(res.paperFactor! * 100).toFixed(1)}%`)
  if (res.LbarMm !== undefined)
    lines.push(`printed bar: ${res.LbarMm.toFixed(1)}mm — 3D printer at ${(res.printer3dFactor! * 100).toFixed(1)}%`)
  if (res.scalePct !== undefined)
    lines.push(`suggested print scale: ${res.scalePct.toFixed(2)}%`)
  lines.push(...res.warnings)
  const txt = document.createElement('div')
  txt.className = 'calibLines'
  txt.textContent = lines.join('\n')
  host.append(txt)

  const cc = $('calibCanvas') as unknown as HTMLCanvasElement
  if (res.rect && res.labelMap) {
    cc.width = res.rect.width
    cc.height = res.rect.height
    const cctx = cc.getContext('2d')!
    const overlay = new ImageData(new Uint8ClampedArray(res.rect.data), cc.width, cc.height)
    const d = overlay.data
    for (let i = 0; i < res.labelMap.length; i++) {
      const l = res.labelMap[i]
      const o = i * 4
      if (l === res.boxLabel) {
        d[o] *= 0.3; d[o + 1] = Math.min(255, d[o + 1] * 0.4 + 150); d[o + 2] *= 0.3
      } else if (l === res.barLabel) {
        d[o] = Math.min(255, d[o] * 0.4 + 150); d[o + 1] *= 0.3; d[o + 2] *= 0.3
      }
    }
    cctx.putImageData(overlay, 0, 0)
  }

  if (res.scalePct !== undefined) {
    const btn = document.createElement('button')
    btn.textContent = `Apply ${res.scalePct.toFixed(2)}% to Print scale`
    btn.onclick = () => {
      $('scalePct').value = res.scalePct!.toFixed(2)
      saveSettings()
    }
    host.append(btn)
  }
}

$('calibPhoto').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  const bmp = await createImageBitmap(f)
  const s = Math.min(1, 2000 / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bmp.width * s))
  c.height = Math.max(1, Math.round(bmp.height * s))
  const ctx = c.getContext('2d')!
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  const res = analyzeCalibrationPhoto(
    ctx.getImageData(0, 0, c.width, c.height),
    calibSpecNow(),
  )
  renderCalibResult(res)
})

$('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) loadFile(f)
})

/**
 * Opens the system file picker. Prefers the File System Access API — a
 * separate activation path from programmatically clicking a hidden input,
 * which some browsers/extensions suppress; falls back to the input where the
 * API is unavailable (Firefox, Safari) or rejects for a reason other than the
 * user cancelling.
 */
async function openPicker() {
  const showPicker = (
    window as unknown as {
      showOpenFilePicker?: (o: {
        types?: { description?: string; accept: Record<string, string[]> }[]
        multiple?: boolean
      }) => Promise<{ getFile(): Promise<File> }[]>
    }
  ).showOpenFilePicker
  if (showPicker) {
    try {
      const [handle] = await showPicker({
        types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }],
        multiple: false,
      })
      const f = await handle?.getFile()
      if (f) loadFile(f)
      return
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return // user cancelled
      // otherwise fall through to the hidden input
    }
  }
  $('file').value = '' // allow re-picking the same file
  $('file').click()
}

/**
 * Wire a dropzone element (hero landing + the mini one in Input): click opens
 * the file picker; a dropped PNG loads directly. Non-PNG drops flash a
 * rejection style.
 */
function wireDropzone(el: HTMLElement) {
  el.addEventListener('click', () => openPicker())
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    openPicker()
  })
  el.addEventListener('dragover', (e) => {
    e.preventDefault()
    el.classList.add('drag')
  })
  el.addEventListener('dragleave', () => el.classList.remove('drag'))
  el.addEventListener('drop', (e) => {
    e.preventDefault()
    el.classList.remove('drag')
    const f = e.dataTransfer?.files?.[0]
    if (!f) return
    if (f.type !== 'image/png' && !f.name.toLowerCase().endsWith('.png')) {
      el.classList.add('nope')
      setTimeout(() => el.classList.remove('nope'), 700)
      return
    }
    loadFile(f)
  })
}
wireDropzone($('dropzone') as unknown as HTMLElement)
wireDropzone($('dropzoneMini') as unknown as HTMLElement)

$('units').addEventListener('change', convertUnits)

let debounce = 0
document.querySelectorAll('#controls input, #controls select').forEach((el) => {
  el.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = window.setTimeout(run, 150)
  })
})
