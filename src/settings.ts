// Per-pattern settings persistence: the pattern's content hash keys a
// localStorage entry holding every control field's value (plus piece
// exclusions), so re-uploading the same PNG restores the session.

/** localStorage key prefix for persisted per-pattern settings. */
export const SETTINGS_PREFIX = 'sgp:settings:'

/** Structural subset of an input/select element this module can read/write. */
export interface FieldLike {
  id: string
  type: string
  value: string
  checked?: boolean
}

/** Structural subset of Storage (localStorage) for testability. */
export interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

/**
 * Snapshot field values into a `{id: value}` map. File inputs are skipped;
 * checkboxes persist as booleans.
 */
export function collectFieldValues(fields: FieldLike[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (const f of fields) {
    if (!f.id || f.type === 'file') continue
    out[f.id] = f.type === 'checkbox' ? !!f.checked : f.value
  }
  return out
}

/** Write a saved `{id: value}` map back onto fields; unknown ids are ignored. */
export function applyFieldValues(data: Record<string, unknown>, fields: FieldLike[]): void {
  for (const f of fields) {
    if (!f.id || f.type === 'file' || !(f.id in data)) continue
    if (f.type === 'checkbox') f.checked = !!data[f.id]
    else f.value = String(data[f.id])
  }
}

/**
 * Content-hash a buffer for use as a settings key. SHA-256 (truncated) when
 * webcrypto exists (browsers, modern node); FNV-1a64 fallback otherwise.
 */
export async function hashBlobBytes(buf: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const d = await subtle.digest('SHA-256', buf)
    return [...new Uint8Array(d)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16)
  }
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4
  const b = new Uint8Array(buf)
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ b[i], 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/**
 * Persist `values` under the pattern's content-hash key. Best-effort:
 * storage failures (private mode, quota) are swallowed.
 */
export function savePatternSettings(
  store: StorageLike | null,
  patternId: string,
  values: Record<string, unknown>,
): void {
  try {
    store?.setItem(SETTINGS_PREFIX + patternId, JSON.stringify(values))
  } catch {
    /* storage unavailable / quota — persistence is best-effort */
  }
}

/**
 * Load settings previously saved under `patternId`, or `null` if absent,
 * corrupt, or storage is unavailable.
 */
export function loadPatternSettings(
  store: StorageLike | null,
  patternId: string,
): Record<string, unknown> | null {
  try {
    const raw = store?.getItem(SETTINGS_PREFIX + patternId)
    if (!raw) return null
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/**
 * Stable identity for an exclusion toggle: the piece's centroid as a
 * fraction of the declared panel, its pixel area, and its color. Survives
 * piece-id renumbering when detection changes and panel re-scaling.
 */
export function pieceSignature(
  pc: { centroidMm: { x: number; y: number }; areaPx: number; colorIdx: number },
  patternWmm: number,
  patternHmm: number,
): string {
  const fx = pc.centroidMm.x / patternWmm
  const fy = pc.centroidMm.y / patternHmm
  return `${fx.toFixed(4)},${fy.toFixed(4)},${pc.areaPx},${pc.colorIdx}`
}
