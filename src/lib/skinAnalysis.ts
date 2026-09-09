/**
 * On-device skin-texture analysis — pores, wrinkles and discrete marks
 * (spots / possible scars) — from a single still and its MediaPipe face mesh.
 *
 * This is an image-processing heuristic, not a dermatological instrument. It
 * runs entirely in the browser on a downscaled crop of each face region and
 * returns per-region scores (0 = clear, 100 = heavy) plus geometry for an
 * overlay. Nothing is uploaded and no identity information is derived.
 *
 * Established-library upgrade path: every primitive here (box blur, high-pass,
 * oriented line filters, difference-of-Gaussians, connected components) maps 1:1
 * onto OpenCV.js — `cv.boxFilter`, `cv.Laplacian`, `cv.getGaborKernel` +
 * `cv.filter2D`, `cv.morphologyEx(MORPH_TOPHAT)`, `cv.connectedComponentsWithStats`.
 * Swap the internals for those if you pull OpenCV.js in; the public shape below
 * is designed to stay the same.
 */
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------
export type SkinMetric = 'pores' | 'wrinkles' | 'marks'

export type SkinRegionScore = {
  /** 0–100, higher = more pronounced. */
  pores: number
  wrinkles: number
  marks: number
  /** Weighted blend of the three, 0–100. */
  overall: number
  /** Region bounding box in source-normalized coords (0–1), for overlays. */
  box: { x: number; y: number; w: number; h: number }
  /** Ridge (wrinkle) pixels, source-normalized, capped — for the overlay. */
  ridges: Array<[number, number]>
}

export type SkinMark = {
  region: string
  /** 'spot' = roughly round; 'linear' = elongated, flagged as a possible scar. */
  kind: 'spot' | 'linear'
  /** Source-normalized box. */
  x: number
  y: number
  w: number
  h: number
  /** 0–1 contrast of the mark against its surroundings. */
  strength: number
}

export type SkinReport = {
  regions: Record<string, SkinRegionScore>
  overall: {
    pores: number
    wrinkles: number
    marks: number
    /** Composite 0–100 skin-texture score (0 = smooth/clear). */
    score: number
  }
  marks: SkinMark[]
  meta: {
    /** Regions that could actually be sampled. */
    sampled: string[]
    /** Regions skipped (out of frame / too small / too dark). */
    skipped: string[]
    note: string
  }
}

// ---------------------------------------------------------------------------
// Region definitions — a handful of landmark indices per region; we sample the
// inset bounding box of each set. Precision beyond this doesn't matter for a
// texture statistic and keeps the module mesh-topology-agnostic.
// ---------------------------------------------------------------------------
const REGIONS: Record<string, readonly number[]> = {
  forehead: [10, 151, 9, 107, 336, 66, 296, 69, 299],
  glabella: [9, 8, 168, 6, 107, 336],
  crowsFeetR: [130, 226, 31, 228, 229, 111],
  crowsFeetL: [359, 446, 261, 448, 449, 340],
  underEyeR: [117, 118, 119, 120, 47, 100],
  underEyeL: [346, 347, 348, 349, 277, 329],
  nasolabialR: [48, 64, 98, 205, 207, 187],
  nasolabialL: [278, 294, 327, 425, 427, 411],
  cheekR: [50, 101, 205, 207, 187, 123],
  cheekL: [280, 330, 425, 427, 411, 352],
  nose: [4, 45, 275, 220, 440, 1],
  chin: [175, 199, 200, 208, 428, 152, 148, 377],
}

// Which metrics matter for which region (weights into the region "overall").
const REGION_WEIGHTS: Record<string, Partial<Record<SkinMetric, number>>> = {
  forehead: { wrinkles: 0.6, pores: 0.25, marks: 0.15 },
  glabella: { wrinkles: 0.8, marks: 0.2 },
  crowsFeetR: { wrinkles: 0.9, marks: 0.1 },
  crowsFeetL: { wrinkles: 0.9, marks: 0.1 },
  underEyeR: { wrinkles: 0.7, marks: 0.3 },
  underEyeL: { wrinkles: 0.7, marks: 0.3 },
  nasolabialR: { wrinkles: 0.75, marks: 0.25 },
  nasolabialL: { wrinkles: 0.75, marks: 0.25 },
  cheekR: { pores: 0.5, marks: 0.35, wrinkles: 0.15 },
  cheekL: { pores: 0.5, marks: 0.35, wrinkles: 0.15 },
  nose: { pores: 0.8, marks: 0.2 },
  chin: { pores: 0.4, marks: 0.4, wrinkles: 0.2 },
}

// How each region contributes to the whole-face composite.
const FACE_WEIGHTS: Record<string, number> = {
  forehead: 1.4,
  glabella: 0.8,
  crowsFeetR: 0.8,
  crowsFeetL: 0.8,
  underEyeR: 0.7,
  underEyeL: 0.7,
  nasolabialR: 0.9,
  nasolabialL: 0.9,
  cheekR: 1.2,
  cheekL: 1.2,
  nose: 0.9,
  chin: 0.7,
}

const SAMPLE_W = 128 // region is drawn into a canvas this wide
const MIN_REGION_PX = 0.018 // region bbox must be at least this fraction of the frame
const MIN_MEAN_LUM = 42 // below this the region is too dark to read
// Above this coefficient of variation the crop is dominated by hair (beard,
// brow, hairline) or a hard shadow edge, not skin — its texture stats would be
// meaningless, so the region is skipped.
const MAX_SKIN_COV = 0.26
// If a single region throws more candidate "marks" than this, it is stubble /
// coarse pores / print noise, not discrete lesions — fold it into the pore
// score and emit no marks for that region.
const MAX_REGION_MARKS = 9

// ---------------------------------------------------------------------------
// Small DSP helpers over Float32 grayscale planes
// ---------------------------------------------------------------------------
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src.slice()
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const norm = 1 / (2 * r + 1)
  // horizontal
  for (let y = 0; y < h; y++) {
    let acc = 0
    const row = y * w
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm
      const add = src[row + Math.min(w - 1, x + r + 1)]
      const sub = src[row + Math.max(0, x - r)]
      acc += add - sub
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm
      const add = tmp[Math.min(h - 1, y + r + 1) * w + x]
      const sub = tmp[Math.max(0, y - r) * w + x]
      acc += add - sub
    }
  }
  return out
}

function stdev(a: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m += a[i]
  m /= a.length
  let v = 0
  for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2
  return Math.sqrt(v / a.length)
}

/** Map a raw ratio through a smooth 0–100 curve. `mid` scores 50. */
function score01(raw: number, mid: number, steep = 1.6): number {
  const x = Math.pow(Math.max(0, raw) / mid, steep)
  return Math.round((100 * x) / (1 + x))
}

// ---------------------------------------------------------------------------
// Per-region sampling
// ---------------------------------------------------------------------------
type RegionSample = {
  gray: Float32Array
  w: number
  h: number
  meanLum: number
  cov: number
  box: { x: number; y: number; w: number; h: number }
}

function sampleRegion(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  landmarks: NormalizedLandmark[],
  indices: readonly number[],
  ctx: CanvasRenderingContext2D,
): RegionSample | null {
  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  let found = 0
  for (const i of indices) {
    const p = landmarks[i]
    if (!p) continue
    found++
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  if (found < 3) return null
  const insetX = (maxX - minX) * 0.12
  const insetY = (maxY - minY) * 0.12
  minX += insetX
  maxX -= insetX
  minY += insetY
  maxY -= insetY
  const bw = maxX - minX
  const bh = maxY - minY
  if (bw < MIN_REGION_PX || bh < MIN_REGION_PX) return null

  const rw = SAMPLE_W
  const rh = Math.max(24, Math.round((bh / bw) * SAMPLE_W))
  const cv = ctx.canvas
  if (cv.width !== rw || cv.height !== rh) {
    cv.width = rw
    cv.height = rh
  }
  ctx.drawImage(
    source,
    minX * srcW,
    minY * srcH,
    bw * srcW,
    bh * srcH,
    0,
    0,
    rw,
    rh,
  )
  const data = ctx.getImageData(0, 0, rw, rh).data
  const gray = new Float32Array(rw * rh)
  let sum = 0
  for (let j = 0, p = 0; j < data.length; j += 4, p++) {
    const l = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]
    gray[p] = l
    sum += l
  }
  const meanLum = sum / gray.length
  let v = 0
  for (let i = 0; i < gray.length; i++) v += (gray[i] - meanLum) ** 2
  const cov = Math.sqrt(v / gray.length) / Math.max(1, meanLum)
  return {
    gray,
    w: rw,
    h: rh,
    meanLum,
    cov,
    box: { x: minX, y: minY, w: bw, h: bh },
  }
}

// ---------------------------------------------------------------------------
// Metric 1 — pores: fine high-frequency stipple. High-pass the region, then
// measure the energy of the residual relative to the region's own contrast.
// ---------------------------------------------------------------------------
function poreScore(s: RegionSample): number {
  const low = boxBlur(s.gray, s.w, s.h, 2)
  let energy = 0
  let n = 0
  for (let i = 0; i < s.gray.length; i++) {
    const hp = s.gray[i] - low[i]
    energy += hp * hp
    n++
  }
  const rms = Math.sqrt(energy / n)
  // normalize by region brightness so dark skin isn't penalised
  const ratio = rms / Math.max(6, s.meanLum * 0.06)
  return score01(ratio, 1.0, 1.8)
}

// ---------------------------------------------------------------------------
// Metric 2 — wrinkles: elongated ridges. Take the max response of four oriented
// second-derivative line filters, threshold adaptively, and measure how much of
// the region is covered by ridge pixels (weighted by their contrast).
// ---------------------------------------------------------------------------
const ORIENTED = [
  [
    [0, 0, 0],
    [-1, 2, -1],
    [0, 0, 0],
  ], // horizontal ridge
  [
    [0, -1, 0],
    [0, 2, 0],
    [0, -1, 0],
  ], // vertical ridge
  [
    [-1, 0, 0],
    [0, 2, 0],
    [0, 0, -1],
  ], // ╲
  [
    [0, 0, -1],
    [0, 2, 0],
    [-1, 0, 0],
  ], // ╱
] as const

function wrinkleAnalysis(s: RegionSample): { score: number; ridges: Array<[number, number]> } {
  const base = boxBlur(s.gray, s.w, s.h, 1)
  const { w, h } = s
  const resp = new Float32Array(w * h)
  let respMean = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let best = 0
      for (const k of ORIENTED) {
        let acc = 0
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            acc += base[(y + ky) * w + (x + kx)] * k[ky + 1][kx + 1]
          }
        }
        const v = Math.abs(acc)
        if (v > best) best = v
      }
      resp[y * w + x] = best
      respMean += best
    }
  }
  respMean /= (w - 2) * (h - 2)
  const sd = stdev(resp)
  const thresh = respMean + 1.75 * sd
  let ridgePx = 0
  let ridgeEnergy = 0
  const ridges: Array<[number, number]> = []
  const CAP = 220
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = resp[y * w + x]
      if (v > thresh) {
        ridgePx++
        ridgeEnergy += v
        if (ridges.length < CAP && (x + y) % 2 === 0) {
          ridges.push([
            s.box.x + (x / w) * s.box.w,
            s.box.y + (y / h) * s.box.h,
          ])
        }
      }
    }
  }
  const frac = ridgePx / (w * h)
  const meanContrast = ridgePx ? ridgeEnergy / ridgePx / Math.max(6, s.meanLum) : 0
  // few faint ridges (pores/noise) score low; broad or high-contrast ridging scores high
  const raw = frac * 12 * (0.4 + meanContrast)
  return { score: score01(raw, 1.0, 1.5), ridges }
}

// ---------------------------------------------------------------------------
// Metric 3 — discrete marks: spots and possible scars. Difference-of-Gaussians
// at a mid scale isolates blobs bigger than pores; connected dark/bright
// components are filtered by size and elongation.
// ---------------------------------------------------------------------------
function markAnalysis(
  s: RegionSample,
  regionName: string,
): { score: number; marks: SkinMark[]; texturey: boolean } {
  const g1 = boxBlur(s.gray, s.w, s.h, 2)
  const g2 = boxBlur(s.gray, s.w, s.h, 6)
  const { w, h } = s
  const dog = new Float32Array(w * h)
  for (let i = 0; i < dog.length; i++) dog[i] = g1[i] - g2[i]
  const sd = stdev(dog)
  const thr = 2.4 * sd
  const label = new Int32Array(w * h).fill(-1)
  const marks: SkinMark[] = []
  let markArea = 0
  let next = 0
  const stack: number[] = []
  for (let start = 0; start < dog.length; start++) {
    if (label[start] !== -1 || Math.abs(dog[start]) < thr) continue
    const sign = Math.sign(dog[start])
    const id = next++
    label[start] = id
    stack.length = 0
    stack.push(start)
    let minx = w
    let maxx = 0
    let miny = h
    let maxy = 0
    let area = 0
    let energy = 0
    while (stack.length) {
      const p = stack.pop() as number
      const px = p % w
      const py = (p / w) | 0
      area++
      energy += Math.abs(dog[p])
      if (px < minx) minx = px
      if (px > maxx) maxx = px
      if (py < miny) miny = py
      if (py > maxy) maxy = py
      const nb = [p - 1, p + 1, p - w, p + w]
      for (const q of nb) {
        if (q < 0 || q >= dog.length) continue
        if (Math.abs(px - (q % w)) > 1) continue
        if (label[q] === -1 && Math.abs(dog[q]) >= thr * 0.6 && Math.sign(dog[q]) === sign) {
          label[q] = id
          stack.push(q)
        }
      }
    }
    const bw = maxx - minx + 1
    const bh = maxy - miny + 1
    const areaFrac = area / (w * h)
    // pores are tiny; a full-region shadow is huge — keep the middle band
    if (areaFrac < 0.0015 || areaFrac > 0.16) continue
    if (area < 8) continue
    const elong = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh))
    const fill = area / (bw * bh)
    const strength = Math.min(1, energy / area / Math.max(8, s.meanLum * 0.25))
    if (strength < 0.35) continue
    markArea += area
    marks.push({
      region: regionName,
      // 'linear' (possible scar) needs a genuine streak: clearly elongated,
      // poorly filled, and a real length — a freckle chain or eyelid crease
      // stays a 'spot'.
      kind:
        elong >= 3.4 && fill < 0.5 && Math.max(bw, bh) >= w * 0.16
          ? 'linear'
          : 'spot',
      x: s.box.x + (minx / w) * s.box.w,
      y: s.box.y + (miny / h) * s.box.h,
      w: (bw / w) * s.box.w,
      h: (bh / h) * s.box.h,
      strength: +strength.toFixed(2),
    })
  }
  // A flood of candidates means texture (stubble / coarse pores / print grain),
  // not discrete lesions: score it as elevated pore texture and emit no marks.
  if (marks.length > MAX_REGION_MARKS) {
    const texRaw = (markArea / (w * h)) * 18
    return { score: score01(texRaw, 1.0, 1.6), marks: [], texturey: true }
  }
  // score from covered area + count, capped
  const raw = (markArea / (w * h)) * 40 + Math.min(marks.length, 6) * 0.12
  return { score: score01(raw, 1.0, 1.4), marks: marks.slice(0, 8), texturey: false }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export function analyzeSkin(
  landmarks: NormalizedLandmark[],
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  workCtx?: CanvasRenderingContext2D,
): SkinReport {
  const ctx =
    workCtx ??
    (() => {
      const c = document.createElement('canvas')
      c.width = SAMPLE_W
      c.height = SAMPLE_W
      return c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
    })()

  const regions: Record<string, SkinRegionScore> = {}
  const marks: SkinMark[] = []
  const sampled: string[] = []
  const skipped: string[] = []

  for (const [name, idx] of Object.entries(REGIONS)) {
    const s = sampleRegion(source, sourceW, sourceH, landmarks, idx, ctx)
    if (!s || s.meanLum < MIN_MEAN_LUM || s.cov > MAX_SKIN_COV) {
      skipped.push(name)
      continue
    }
    sampled.push(name)
    const mk = markAnalysis(s, name)
    // when the region was a flood of tiny blobs, roll that energy into pores
    const pores = Math.min(100, poreScore(s) + (mk.texturey ? mk.score : 0))
    const wr = wrinkleAnalysis(s)
    marks.push(...mk.marks)

    const wts = REGION_WEIGHTS[name] ?? { pores: 0.34, wrinkles: 0.33, marks: 0.33 }
    let wsum = 0
    let acc = 0
    for (const [m, wv] of Object.entries(wts) as Array<[SkinMetric, number]>) {
      const val = m === 'pores' ? pores : m === 'wrinkles' ? wr.score : mk.score
      acc += val * wv
      wsum += wv
    }
    regions[name] = {
      pores,
      wrinkles: wr.score,
      marks: mk.texturey ? 0 : mk.score,
      overall: Math.round(acc / (wsum || 1)),
      box: s.box,
      ridges: wr.ridges,
    }
  }

  // whole-face composite
  const agg = (pick: (r: SkinRegionScore) => number) => {
    let wsum = 0
    let acc = 0
    for (const [name, r] of Object.entries(regions)) {
      const w = FACE_WEIGHTS[name] ?? 1
      acc += pick(r) * w
      wsum += w
    }
    return wsum ? Math.round(acc / wsum) : 0
  }
  const pores = agg((r) => r.pores)
  const wrinkles = agg((r) => r.wrinkles)
  const marksScore = agg((r) => r.marks)

  return {
    regions,
    overall: {
      pores,
      wrinkles,
      marks: marksScore,
      score: Math.round(0.34 * pores + 0.4 * wrinkles + 0.26 * marksScore),
    },
    marks: marks.sort((a, b) => b.strength - a.strength).slice(0, 24),
    meta: {
      sampled,
      skipped,
      note:
        sampled.length < 4
          ? 'Low confidence — few regions could be sampled (face small, off-frame, or uneven light).'
          : 'Heuristic texture estimate, not a diagnosis.',
    },
  }
}

// ---------------------------------------------------------------------------
// Overlay rendering — draws the source with wrinkle ridges, region severity
// tint and mark boxes. Returns a fresh canvas at the requested width.
// ---------------------------------------------------------------------------
export function renderSkinOverlay(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  report: SkinReport,
  opts: { width?: number; show?: Partial<Record<SkinMetric, boolean>> } = {},
): HTMLCanvasElement {
  const show = { pores: true, wrinkles: true, marks: true, ...opts.show }
  const W = opts.width ?? Math.min(720, sourceW)
  const H = Math.round((sourceH / sourceW) * W)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d') as CanvasRenderingContext2D
  g.drawImage(source, 0, 0, W, H)

  // region severity tint
  for (const [, r] of Object.entries(report.regions)) {
    const sev = r.overall / 100
    if (sev < 0.15) continue
    g.fillStyle = `rgba(${Math.round(120 + 135 * sev)}, ${Math.round(90 * (1 - sev))}, 40, ${0.06 + 0.12 * sev})`
    g.fillRect(r.box.x * W, r.box.y * H, r.box.w * W, r.box.h * H)
  }

  // wrinkle ridges
  if (show.wrinkles) {
    g.fillStyle = 'rgba(0, 210, 255, 0.85)'
    for (const [, r] of Object.entries(report.regions)) {
      for (const [nx, ny] of r.ridges) g.fillRect(nx * W - 0.5, ny * H - 0.5, 1.5, 1.5)
    }
  }

  // marks
  if (show.marks) {
    g.lineWidth = Math.max(1.5, W / 400)
    for (const m of report.marks) {
      g.strokeStyle = m.kind === 'linear' ? 'rgba(255, 60, 90, 0.95)' : 'rgba(255, 190, 40, 0.95)'
      const pad = 2
      g.strokeRect(m.x * W - pad, m.y * H - pad, m.w * W + pad * 2, m.h * H + pad * 2)
    }
  }

  return cv
}
