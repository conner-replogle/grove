// Fractional order keys: strings that sort like the list they come from, so
// moving one item changes only that item's key and two devices' moves merge
// item by item. Keys are base-62 digit strings with no trailing zero; the
// midpoint is rocicorp/fractional-indexing's.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export const isOrderKey = (k: unknown): k is string => typeof k === 'string' && /^[0-9A-Za-z]*[1-9A-Za-z]$/.test(k)

// A key between `a` and `b` (either may be missing: the start or the end).
export function keyBetween(a: string | undefined, b: string | undefined): string {
  if (a !== undefined && b !== undefined && a >= b) b = undefined
  return midpoint(a ?? '', b)
}

function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined) {
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0
  const db = b !== undefined ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]
  if (b !== undefined && b.length > 1) return b.slice(0, 1)
  return DIGITS[da] + midpoint(a.slice(1), undefined)
}

// Keys for `ids` in this order. Items whose current key already fits (the
// longest run of increasing keys) keep it; the others get new keys between
// their neighbors. The same input always gives the same keys, so two
// devices fixing the same order agree.
export function assignKeys(ids: string[], current: (id: string) => unknown): string[] {
  const keys = ids.map((id) => {
    const k = current(id)
    return isOrderKey(k) ? k : undefined
  })
  const length: number[] = []
  const prev: number[] = []
  let end = -1
  for (let i = 0; i < keys.length; i++) {
    length[i] = 0
    prev[i] = -1
    const k = keys[i]
    if (k === undefined) continue
    length[i] = 1
    for (let j = 0; j < i; j++) {
      const kj = keys[j]
      if (kj !== undefined && kj < k && length[j] + 1 > length[i]) {
        length[i] = length[j] + 1
        prev[i] = j
      }
    }
    if (end < 0 || length[i] > length[end]) end = i
  }
  const kept = new Set<number>()
  for (let i = end; i >= 0; i = prev[i]) kept.add(i)

  const out: string[] = []
  let lo: string | undefined
  for (let i = 0; i < ids.length; i++) {
    if (kept.has(i)) {
      out.push((lo = keys[i]!))
      continue
    }
    let next = i + 1
    while (next < ids.length && !kept.has(next)) next++
    const hi = next < ids.length ? keys[next] : undefined
    out.push((lo = keyBetween(lo, hi)))
  }
  return out
}
