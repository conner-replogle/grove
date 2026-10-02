// Grove's own settings, kept in <profile>/grove-settings.json.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DEFAULT_SETTINGS, type GroveSettings } from '../shared/protocol.ts'

export class Settings {
  private readonly path: string
  private value: GroveSettings

  constructor(path: string) {
    this.path = path
    let raw: Partial<GroveSettings> = {}
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // Defaults.
    }
    this.value = clean({ ...DEFAULT_SETTINGS, ...raw })
  }

  get(): GroveSettings {
    return this.value
  }

  // Returns the settings that changed.
  update(patch: Partial<GroveSettings>): Partial<GroveSettings> {
    const next = clean({ ...this.value, ...patch })
    const changed = Object.fromEntries(
      Object.entries(next).filter(([k, v]) => this.value[k as keyof GroveSettings] !== v)
    ) as Partial<GroveSettings>
    if (!Object.keys(changed).length) return changed
    this.value = next
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next, null, 1) + '\n')
    renameSync(`${this.path}.tmp`, this.path)
    return changed
  }
}

function clean(s: GroveSettings): GroveSettings {
  return {
    syncTabs: s.syncTabs === 'pinned' ? 'pinned' : 'all',
    resume: s.resume !== false
  }
}
