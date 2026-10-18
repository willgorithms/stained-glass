import { describe, it, expect } from 'vitest'
import {
  collectFieldValues, applyFieldValues, hashBlobBytes,
  savePatternSettings, loadPatternSettings, pieceSignature, SETTINGS_PREFIX,
} from '../src/settings'
import type { FieldLike, StorageLike } from '../src/settings'

const mkStore = (): StorageLike & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

const fields = (specs: Array<[string, string, string]>): FieldLike[] =>
  specs.map(([id, type, value]) => ({ id, type, value, checked: value === '1' }))

describe('settings persistence', () => {
  it('round-trips field values through storage', () => {
    const store = mkStore()
    const els = fields([
      ['patternWmm', 'number', '300'],
      ['units', 'select', 'in'],
      ['stlFlip', 'checkbox', '1'],
    ])
    savePatternSettings(store, 'abc', collectFieldValues(els))
    const data = loadPatternSettings(store, 'abc')!
    expect(data.patternWmm).toBe('300')
    expect(data.units).toBe('in')

    const els2 = fields([
      ['patternWmm', 'number', '215.9'],
      ['units', 'select', 'mm'],
      ['stlFlip', 'checkbox', ''],
    ])
    applyFieldValues(data, els2)
    expect(els2[0].value).toBe('300')
    expect(els2[1].value).toBe('in')
    expect(els2[2].checked).toBe(true)
  })

  it('skips file inputs and missing elements', () => {
    const els = fields([
      ['file', 'file', ''],
      ['patternWmm', 'number', '300'],
    ])
    const vals = collectFieldValues(els)
    expect(vals.file).toBeUndefined()
    // applying data for an id not present in the DOM is harmless
    applyFieldValues({ gone: 'x', patternWmm: '111' }, els)
    expect(els[1].value).toBe('111')
  })

  it('stores and restores the excluded set', () => {
    const store = mkStore()
    savePatternSettings(store, 'p1', { units: 'mm', _excluded: [3, 7, 12] })
    const data = loadPatternSettings(store, 'p1')!
    expect(data._excluded).toEqual([3, 7, 12])
  })

  it('keys storage under the settings prefix', () => {
    const store = mkStore()
    savePatternSettings(store, 'deadbeef', { a: 1 })
    expect(store.map.has(SETTINGS_PREFIX + 'deadbeef')).toBe(true)
    expect(loadPatternSettings(store, 'other')).toBeNull()
  })

  it('survives corrupt JSON', () => {
    const store = mkStore()
    store.map.set(SETTINGS_PREFIX + 'bad', '{nope')
    expect(loadPatternSettings(store, 'bad')).toBeNull()
  })

  it('pieceSignature is scale-invariant but piece-sensitive', () => {
    const pc = { centroidMm: { x: 54, y: 70 }, areaPx: 500, colorIdx: 2 }
    const a = pieceSignature(pc, 216, 280)
    // doubling the declared panel rescales centroids equally — same signature
    const b = pieceSignature(
      { ...pc, centroidMm: { x: 108, y: 140 } }, 432, 560,
    )
    expect(a).toBe(b)
    // a different piece (moved, resized, or recolored) signs differently
    expect(pieceSignature({ ...pc, areaPx: 501 }, 216, 280)).not.toBe(a)
    expect(pieceSignature({ ...pc, colorIdx: 3 }, 216, 280)).not.toBe(a)
    expect(
      pieceSignature({ ...pc, centroidMm: { x: 55, y: 70 } }, 216, 280),
    ).not.toBe(a)
  })

  it('hash is deterministic and content-sensitive', async () => {
    const a = new Uint8Array([1, 2, 3, 4]).buffer
    const b = new Uint8Array([1, 2, 3, 5]).buffer
    const h1 = await hashBlobBytes(a)
    const h2 = await hashBlobBytes(a)
    const h3 = await hashBlobBytes(b)
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    expect(h1).toHaveLength(16)
  })
})
