// Hybrid logical clock stamps for sync: "<wall ms>-<counter>-<device>",
// padded so that of two stamps the later change is the greater string, even
// when two devices' clocks disagree a little.
export type Stamp = string

const WALL = 10
const COUNTER = 5

export const newDeviceId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('')

function format(wall: number, counter: number, device: string): Stamp {
  return `${wall.toString(36).padStart(WALL, '0')}-${counter.toString(36).padStart(COUNTER, '0')}-${device}`
}

function parse(s: Stamp): { wall: number; counter: number } | undefined {
  const m = /^([0-9a-z]{10})-([0-9a-z]{5})-[0-9a-z]+$/.exec(s)
  return m ? { wall: parseInt(m[1], 36), counter: parseInt(m[2], 36) } : undefined
}

export const isStamp = (s: unknown): s is Stamp => typeof s === 'string' && parse(s) !== undefined

export class Clock {
  private wall = 0
  private counter = 0
  readonly device: string
  private readonly now: () => number

  constructor(device: string, last?: Stamp, now = () => Date.now()) {
    this.device = device
    this.now = now
    if (last) this.observe(last)
  }

  // A stamp for a change made now, later than any stamp seen so far.
  tick(): Stamp {
    const t = this.now()
    if (t > this.wall) {
      this.wall = t
      this.counter = 0
    } else {
      this.counter++
    }
    return format(this.wall, this.counter, this.device)
  }

  // Moves the clock past a stamp from another device.
  observe(s: Stamp): void {
    const p = parse(s)
    if (!p) return
    if (p.wall > this.wall) {
      this.wall = p.wall
      this.counter = p.counter
    } else if (p.wall === this.wall && p.counter > this.counter) {
      this.counter = p.counter
    }
  }

  get last(): Stamp {
    return format(this.wall, this.counter, this.device)
  }
}
