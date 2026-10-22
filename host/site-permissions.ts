// Site permissions Chrome's extension API can't set (MIDI, fonts, local
// network, ...): Grove keeps the person's answers in grove-permissions.json
// in the profile and applies them as DevTools permission overrides, which
// last as long as the launcher's DevTools connection, so every start
// applies them again.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { PERMISSION_KINDS, type PermissionKind } from '../shared/protocol.ts'

// Chrome's own permission descriptors for each kind. Local network access
// went by a few names across Chrome versions; set all of them.
const DESCRIPTORS: Partial<Record<PermissionKind, object[]>> = {
  cameraPanTiltZoom: [{ name: 'camera', panTiltZoom: true }],
  midi: [{ name: 'midi' }],
  midiSysex: [{ name: 'midi', sysex: true }],
  idleDetection: [{ name: 'idle-detection' }],
  windowManagement: [{ name: 'window-management' }],
  localFonts: [{ name: 'local-fonts' }],
  storageAccess: [{ name: 'storage-access' }],
  localNetwork: [{ name: 'local-network-access' }, { name: 'local-network' }, { name: 'loopback-network' }]
}

export const keptByHost = (kind: PermissionKind): boolean => kind in DESCRIPTORS

export type Setting = 'granted' | 'denied'
// Applies one override: Browser.setPermission.
export type ApplyPermission = (descriptor: object, setting: Setting, origin: string) => Promise<unknown>

interface Saved {
  origin: string
  kind: PermissionKind
  setting: Setting
}

export class SitePermissions {
  private saved: Saved[] = []
  private readonly path: string
  private readonly apply: ApplyPermission

  constructor(path: string, apply: ApplyPermission) {
    this.path = path
    this.apply = apply
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(raw)) {
        this.saved = raw.filter(
          (s): s is Saved =>
            typeof s?.origin === 'string' &&
            PERMISSION_KINDS.includes(s.kind) &&
            keptByHost(s.kind) &&
            (s.setting === 'granted' || s.setting === 'denied')
        )
      }
    } catch {}
  }

  async applyAll(): Promise<void> {
    await Promise.all(this.saved.map((s) => this.applyOne(s)))
  }

  async set(origin: string, kind: PermissionKind, setting: Setting): Promise<void> {
    if (!keptByHost(kind)) return
    const entry = { origin, kind, setting }
    this.saved = [...this.saved.filter((s) => s.origin !== origin || s.kind !== kind), entry]
    this.save()
    await this.applyOne(entry)
  }

  // What the site was given.
  forOrigin(origin: string): { kind: PermissionKind; setting: Setting }[] {
    return this.saved.filter((s) => s.origin === origin).map(({ kind, setting }) => ({ kind, setting }))
  }

  private async applyOne({ origin, kind, setting }: Saved): Promise<void> {
    for (const descriptor of DESCRIPTORS[kind] ?? []) {
      // A name this Chrome doesn't know is refused; the others still apply.
      await this.apply(descriptor, setting, origin).catch(() => {})
    }
  }

  private save(): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.saved, null, 1))
    renameSync(tmp, this.path)
  }
}
