/*
 * React port of face-capture/skin-metrics.js — same logic, ES-module exports.
 * Pure numeric image-processing; faithful port, type-checking off.
 */
// @ts-nocheck
/* eslint-disable */

// Catalogue — order and colours match the panel in the mock. `dir` is the
// "good" direction: 'low' = lower score is better, 'high' = higher is better,
// 'text' = categorical (Skin Type).
const METRICS = [
  { key: 'skinType',    label: 'Skin Type',           color: '#a58d7f', dir: 'text' },
  { key: 'spots',       label: 'Spots',               color: '#4db4ea', dir: 'low'  },
  { key: 'wrinkles',    label: 'Wrinkles',            color: '#7cc242', dir: 'low'  },
  { key: 'texture',     label: 'Texture',             color: '#b46fd6', dir: 'low'  },
  { key: 'acne',        label: 'Acne',                color: '#4a90d9', dir: 'low'  },
  { key: 'darkCircles', label: 'Dark Circles',        color: '#6b7a99', dir: 'low'  },
  { key: 'redness',     label: 'Redness',             color: '#e8401c', dir: 'low'  },
  { key: 'oiliness',    label: 'Oiliness',            color: '#f0921e', dir: 'low'  },
  { key: 'moisture',    label: 'Moisture',            color: '#45c8dc', dir: 'high' },
  { key: 'pores',       label: 'Pores',               color: '#9cb83f', dir: 'low'  },
  { key: 'eyeBags',     label: 'Eye bags',            color: '#b1546a', dir: 'low'  },
  { key: 'radiance',    label: 'Radiance',            color: '#b8c2cc', dir: 'high' },
  { key: 'firmness',    label: 'Firmness',            color: '#f26fc4', dir: 'high' },
  { key: 'droopyUpper', label: 'Droopy Upper Eyelid', color: '#d94fd0', dir: 'low'  },
  { key: 'droopyLower', label: 'Droopy Lower Eyelid', color: '#b52a7a', dir: 'low'  },
]

// MediaPipe canonical 478-point mesh indices, grouped into sampling regions.
const REGIONS = {
  forehead:    [10, 151, 9, 107, 336, 66, 296, 69, 299],
  glabella:    [9, 8, 168, 6, 107, 336],
  crowsFeetR:  [130, 226, 31, 228, 229, 111],
  crowsFeetL:  [359, 446, 261, 448, 449, 340],
  underEyeR:   [117, 118, 119, 120, 47, 100],
  underEyeL:   [346, 347, 348, 349, 277, 329],
  nasolabialR: [48, 64, 98, 205, 207, 187],
  nasolabialL: [278, 294, 327, 425, 427, 411],
  cheekR:      [50, 101, 205, 207, 187, 123],
  cheekL:      [280, 330, 425, 427, 411, 352],
  nose:        [4, 45, 275, 1, 2, 98, 327], // tip + alae only — stays below any glasses rim
  chin:        [175, 199, 200, 208, 428, 152, 148, 377],
}

const SAMPLE_W = 128
const MIN_REGION_PX = 0.015
const MIN_MEAN_LUM = 36

// MediaPipe FACE_OVAL loop — ordered — for the always-on face outline.
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
]

// Regions where a full ridge / mark pass is worth the cost on the live path.
const R_WRINKLE = new Set([
  'forehead', 'glabella', 'crowsFeetR', 'crowsFeetL',
  'nasolabialR', 'nasolabialL', 'underEyeR', 'underEyeL',
])
// Chin is deliberately excluded — for a big share of adult men it's beard, and
// it rarely carries marks worth flagging. Eye-line region crops are excluded
// downstream (glasses).
const R_MARK = new Set(['forehead', 'cheekR', 'cheekL', 'nose'])

// ---------------------------------------------------------------------------
// DSP helpers (ported from skinAnalysis.ts)
// ---------------------------------------------------------------------------
function boxBlur(src, w, h, r) {
  if (r < 1) return src.slice()
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const norm = 1 / (2 * r + 1)
  for (let y = 0; y < h; y++) {
    let acc = 0
    const row = y * w
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

function stdev(a) {
  let m = 0
  for (let i = 0; i < a.length; i++) m += a[i]
  m /= a.length
  let v = 0
  for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2
  return Math.sqrt(v / a.length)
}

/** Smooth saturating 0–100 curve; `mid` scores 50. */
function score01(raw, mid, steep) {
  const x = Math.pow(Math.max(0, raw) / mid, steep || 1.6)
  return Math.round((100 * x) / (1 + x))
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp100 = (v) => Math.round(v < 0 ? 0 : v > 100 ? 100 : v)

// ---------------------------------------------------------------------------
// Region sampling
// ---------------------------------------------------------------------------
function makeCtx() {
  const c = document.createElement('canvas')
  c.width = SAMPLE_W
  c.height = SAMPLE_W
  return c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
}

function statsFrom(data) {
  const n = data.length / 4
  let sumL = 0
  let sumR = 0
  let sumG = 0
  let sumB = 0
  const lums = new Float32Array(n)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    lums[j] = l
    sumL += l
    sumR += data[i]
    sumG += data[i + 1]
    sumB += data[i + 2]
  }
  const meanL = sumL / n
  let variance = 0
  let bright = 0
  let hi = 0
  for (let j = 0; j < n; j++) {
    variance += (lums[j] - meanL) ** 2
    if (lums[j] > 232) bright++
    // "glossy" pixels — a sebum sheen is a concentrated hot spot: clearly
    // above the region's own mean AND bright in absolute terms (a gradual
    // geometric-shading highlight fails the absolute floor).
    if (lums[j] > meanL + Math.max(40, meanL * 0.3) && lums[j] > 186) hi++
  }
  return {
    lums,
    meanLum: meanL,
    stdDev: Math.sqrt(variance / n),
    r: sumR / n,
    g: sumG / n,
    b: sumB / n,
    brightFrac: bright / n,
    glossFrac: hi / n,
  }
}

// Sample a normalized (0–1) box of the source into an SAMPLE_W-wide crop.
function sampleBox(source, srcW, srcH, box, ctx) {
  const bw = box.w
  const bh = box.h
  if (bw < MIN_REGION_PX || bh < MIN_REGION_PX) return null
  const rw = SAMPLE_W
  const rh = Math.max(24, Math.round((bh / bw) * SAMPLE_W))
  const cv = ctx.canvas
  if (cv.width !== rw || cv.height !== rh) {
    cv.width = rw
    cv.height = rh
  }
  const sx = Math.max(0, box.x * srcW)
  const sy = Math.max(0, box.y * srcH)
  const sw = Math.min(srcW - sx, Math.max(1, bw * srcW))
  const sh = Math.min(srcH - sy, Math.max(1, bh * srcH))
  ctx.clearRect(0, 0, rw, rh)
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, rw, rh)
  const rgba = ctx.getImageData(0, 0, rw, rh).data
  const st = statsFrom(rgba)
  const gray = new Float32Array(rw * rh)
  for (let i = 0; i < gray.length; i++) gray[i] = st.lums[i]
  return {
    gray,
    rgba, // kept for per-blob colour analysis in markScore
    w: rw,
    h: rh,
    meanLum: st.meanLum,
    cov: st.stdDev / Math.max(1, st.meanLum),
    stdDev: st.stdDev,
    r: st.r,
    g: st.g,
    b: st.b,
    brightFrac: st.brightFrac,
    glossFrac: st.glossFrac,
    box: { x: box.x, y: box.y, w: bw, h: bh },
  }
}

function landmarkBox(landmarks, indices, inset) {
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
  const ix = (maxX - minX) * (inset == null ? 0.12 : inset)
  const iy = (maxY - minY) * (inset == null ? 0.12 : inset)
  return { x: minX + ix, y: minY + iy, w: maxX - minX - 2 * ix, h: maxY - minY - 2 * iy }
}

function sampleRegion(source, srcW, srcH, landmarks, indices, ctx) {
  const box = landmarkBox(landmarks, indices)
  if (!box) return null
  const s = sampleBox(source, srcW, srcH, box, ctx)
  if (!s || s.meanLum < MIN_MEAN_LUM) return null
  return s
}

// ---------------------------------------------------------------------------
// Texture primitives
// ---------------------------------------------------------------------------
function poreScore(s) {
  const low = boxBlur(s.gray, s.w, s.h, 2)
  let energy = 0
  for (let i = 0; i < s.gray.length; i++) {
    const hp = s.gray[i] - low[i]
    energy += hp * hp
  }
  const rms = Math.sqrt(energy / s.gray.length)
  const ratio = rms / Math.max(6, s.meanLum * 0.06)
  return score01(ratio, 1.0, 1.8)
}

const ORIENTED = [
  [[0, 0, 0], [-1, 2, -1], [0, 0, 0]],
  [[0, -1, 0], [0, 2, 0], [0, -1, 0]],
  [[-1, 0, 0], [0, 2, 0], [0, 0, -1]],
  [[0, 0, -1], [0, 2, 0], [-1, 0, 0]],
]

function wrinkleScore(s) {
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
  const thresh = respMean + 1.75 * stdev(resp)
  let ridgePx = 0
  let ridgeEnergy = 0
  for (let i = 0; i < resp.length; i++) {
    if (resp[i] > thresh) {
      ridgePx++
      ridgeEnergy += resp[i]
    }
  }
  const frac = ridgePx / (w * h)
  const meanContrast = ridgePx ? ridgeEnergy / ridgePx / Math.max(6, s.meanLum) : 0
  return score01(frac * 12 * (0.4 + meanContrast), 1.0, 1.5)
}

// Difference-of-Gaussians blobs -> discrete marks (spots / moles / possible
// scars). Geometry gets a candidate onto the list; COLOUR decides if it stays:
// a real pigmented mark is skin-hued but darker (melanin) — not neutral black
// (glasses frame / deep shadow), not blue (shadow), not a bright specular
// highlight. A region that floods with candidates is stubble / coarse pores,
// so it emits none. Returns { score, count, points } (region-local 0–1 coords).
function markScore(s, collect) {
  const g1 = boxBlur(s.gray, s.w, s.h, 2)
  const g2 = boxBlur(s.gray, s.w, s.h, 6)
  const { w, h, rgba } = s
  const dog = new Float32Array(w * h)
  for (let i = 0; i < dog.length; i++) dog[i] = g1[i] - g2[i]
  const thr = Math.max(2.1 * stdev(dog), 2.5)
  const label = new Int32Array(w * h).fill(-1)
  let markArea = 0
  let next = 0
  const stack = []
  const cand = []
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
    let peak = 0
    let sr = 0
    let sg = 0
    let sb = 0
    while (stack.length) {
      const p = stack.pop()
      const px = p % w
      const py = (p / w) | 0
      area++
      const a = Math.abs(dog[p])
      energy += a
      if (a > peak) peak = a
      sr += rgba[p * 4]
      sg += rgba[p * 4 + 1]
      sb += rgba[p * 4 + 2]
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
    if (areaFrac < 0.001 || areaFrac > 0.14 || area < 6) continue
    // reject a blob that lies mostly along one crop edge (region boundary —
    // hairline / brow / lip), but allow one that merely clips a corner
    const edgeX = (minx <= 0 ? 1 : 0) + (maxx >= w - 1 ? 1 : 0)
    const edgeY = (miny <= 0 ? 1 : 0) + (maxy >= h - 1 ? 1 : 0)
    if ((edgeX && bh > h * 0.55) || (edgeY && bw > w * 0.55)) continue

    const strength = Math.min(1, (energy / area + peak) / 2 / Math.max(8, s.meanLum * 0.22))
    if (strength < 0.32) continue

    const elong = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh))
    const fill = area / (bw * bh)
    let kind = null
    if (elong <= 2.4 && fill >= 0.45) kind = 'spot'
    else if (elong >= 3.0 && fill < 0.62 && Math.max(bw, bh) >= w * 0.13) kind = 'linear'
    if (!kind) continue

    // --- colour gate ---
    const br = sr / area
    const bg = sg / area
    const bb = sb / area
    const bLum = 0.2126 * br + 0.7152 * bg + 0.0722 * bb
    const lumRatio = bLum / Math.max(1, s.meanLum)
    const spread = Math.max(br, bg, bb) - Math.min(br, bg, bb)
    const neutralDark = bLum < 46 && spread < 14 // glasses frame / deep shadow / hair
    const blueish = bb > br + 6 // cast shadow, not pigment
    const skinHued = br >= bg - 4 && bg >= bb - 6 // r ≳ g ≳ b, like skin & melanin
    if (neutralDark || blueish || !skinHued) continue
    if (kind === 'spot') {
      // pigmented spot / mole: darker than the surrounding skin but not a hole
      if (!(lumRatio >= 0.28 && lumRatio <= 0.97)) continue
    } else {
      // scar: real contrast either way, still skin-hued
      if (Math.abs(1 - lumRatio) < 0.05 || lumRatio < 0.4 || lumRatio > 1.35) continue
    }

    markArea += area
    cand.push({
      x: (minx + maxx) / 2 / w,
      y: (miny + maxy) / 2 / h,
      strength: +strength.toFixed(2),
      kind,
    })
  }
  const texturey = cand.length > 15
  const points = collect && !texturey ? cand : []
  const count = texturey ? 0 : cand.length
  const raw = texturey
    ? (markArea / (w * h)) * 16
    : (markArea / (w * h)) * 40 + Math.min(count, 6) * 0.1
  return { score: score01(raw, 1.0, 1.4), count, points }
}

// ---------------------------------------------------------------------------
// Eyelid geometry
// ---------------------------------------------------------------------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

function eyelidGeometry(L) {
  // right eye (subject's right): outer 33, inner 133, upper-lid 159, lower-lid 145, brow 105
  // left  eye:                   outer 263, inner 362, upper-lid 386, lower-lid 374, brow 334
  const eye = (outer, inner, up, lo, brow) => {
    const o = L[outer]
    const i = L[inner]
    const u = L[up]
    const d = L[lo]
    const b = L[brow]
    if (!o || !i || !u || !d || !b) return null
    const width = dist(o, i) || 1e-6
    const c = mid(o, i)
    return {
      openness: dist(u, d) / width, // aperture / width; hooded lids read low
      browGap: dist(b, u) / width, // brow-to-lash gap; heavy/low brow reads low
      lidAsym: dist(c, d) / (dist(c, u) + 1e-6), // lower vs upper lid offset; >1 = lower lid rides low
    }
  }
  const r = eye(33, 133, 159, 145, 105)
  const l = eye(263, 362, 386, 374, 334)
  const both = [r, l].filter(Boolean)
  if (!both.length) return null
  const avg = (k) => both.reduce((sum, e) => sum + e[k], 0) / both.length
  return { openness: avg('openness'), browGap: avg('browGap'), lidAsym: avg('lidAsym') }
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------
function wavg(pairs) {
  let acc = 0
  let wsum = 0
  for (const [val, wt] of pairs) {
    if (val == null || Number.isNaN(val)) continue
    acc += val * wt
    wsum += wt
  }
  return wsum ? acc / wsum : null
}

function ratingWord(dir, v) {
  if (dir === 'high') return v >= 70 ? 'Great' : v >= 45 ? 'Fair' : 'Low'
  return v < 25 ? 'Low' : v < 55 ? 'Moderate' : 'High'
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
let workCtx: CanvasRenderingContext2D | null = null

function analyze(landmarks, source, sourceW, sourceH) {
  if (!workCtx) workCtx = makeCtx()
  const ctx = workCtx

  // --- sample every region ---
  const S = {}
  let sampledCount = 0
  for (const name of Object.keys(REGIONS)) {
    const s = sampleRegion(source, sourceW, sourceH, landmarks, REGIONS[name], ctx)
    S[name] = s
    if (s) sampledCount++
  }

  // full-face crop for radiance / evenness
  let faceBox = null
  {
    let minX = 1
    let minY = 1
    let maxX = 0
    let maxY = 0
    for (const p of landmarks) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    const ix = (maxX - minX) * 0.08
    const iy = (maxY - minY) * 0.06
    faceBox = sampleBox(
      source,
      sourceW,
      sourceH,
      { x: minX + ix, y: minY + iy, w: maxX - minX - 2 * ix, h: maxY - minY - 2 * iy },
      ctx,
    )
  }

  const list = (names) => names.map((n) => S[n]).filter(Boolean)
  const meanOf = (sigs, pick) =>
    sigs.length ? sigs.reduce((sum, s) => sum + pick(s), 0) / sigs.length : null

  const cheeks = list(['cheekR', 'cheekL'])
  const tzone = list(['forehead', 'nose', 'glabella'])
  const underEye = list(['underEyeR', 'underEyeL'])

  const cheekLum = meanOf(cheeks, (s) => s.meanLum)
  const cheekCov = meanOf(cheeks, (s) => s.cov)
  const cheekR = meanOf(cheeks, (s) => s.r)
  const cheekG = meanOf(cheeks, (s) => s.g)
  const cheekB = meanOf(cheeks, (s) => s.b)

  // ---- texture metrics ----
  const pores = clamp100(
    meanOf(list(['cheekR', 'cheekL', 'nose']), poreScore) ?? 12,
  )
  const wrinkles = clamp100(
    wavg([
      [S.glabella && wrinkleScore(S.glabella), 1.3],
      [S.forehead && wrinkleScore(S.forehead), 1.2],
      [S.crowsFeetR && wrinkleScore(S.crowsFeetR), 1.1],
      [S.crowsFeetL && wrinkleScore(S.crowsFeetL), 1.1],
      [S.nasolabialR && wrinkleScore(S.nasolabialR), 0.9],
      [S.nasolabialL && wrinkleScore(S.nasolabialL), 0.9],
      [S.underEyeR && wrinkleScore(S.underEyeR), 0.8],
      [S.underEyeL && wrinkleScore(S.underEyeL), 0.8],
    ]) ?? 14,
  )
  const spotSigs = list(['forehead', 'cheekR', 'cheekL', 'chin', 'nose'])
  const spotResults = spotSigs.map((s) => markScore(s))
  const spots = clamp100(
    spotResults.length
      ? spotResults.reduce((sum, m) => sum + m.score, 0) / spotResults.length
      : 8,
  )
  const spotCount = spotResults.reduce((sum, m) => sum + m.count, 0)
  const texture = clamp100(0.5 * pores + 0.3 * spots + 0.2 * wrinkles)

  // ---- colour metrics ----
  // Separating clinical redness (irritation / rosacea / flush) from a naturally
  // warm skin tone or warm lighting is hard from mean RGB alone, so this stays
  // conservative: well-toned skin sits near r-fraction 0.40–0.44, and only a
  // clear excess above that — with the red channel also running hot relative to
  // luma — is scored up.
  let redness = 10
  if (cheekR != null) {
    const rFrac = cheekR / (cheekR + cheekG + cheekB + 1)
    const rOverLum = (cheekR - (cheekG + cheekB) / 2) / Math.max(1, cheekLum)
    const raw =
      Math.max(0, (rFrac - 0.4) / 0.06) * 0.6 +
      Math.max(0, (rOverLum - 0.35) / 0.25) * 0.4
    redness = score01(Math.min(2.5, raw), 1.0, 1.3)
  }
  redness = clamp100(redness)

  const acne = clamp100(
    spotCount >= 4 ? spots * (0.5 + 0.7 * (redness / 100)) : spots * 0.35,
  )

  // ---- oiliness / skin type ----
  const tzoneBright = meanOf(tzone, (s) => s.brightFrac) ?? 0
  const tzoneLum = meanOf(tzone, (s) => s.meanLum) ?? cheekLum ?? 120
  const tzoneGloss = meanOf(tzone, (s) => s.glossFrac) ?? 0
  const cheekBright = meanOf(cheeks, (s) => s.brightFrac) ?? 0
  const cheekGloss = meanOf(cheeks, (s) => s.glossFrac) ?? 0
  // shine = fully-clipped highlights + glossy (above-mean) fraction. No
  // absolute-brightness term — bright lighting is not oil.
  const tShine = Math.min(100, tzoneBright * 2600 + tzoneGloss * 360)
  const cShine = Math.min(100, cheekBright * 2600 + cheekGloss * 360)
  const oiliness = clamp100(tShine * 0.9 + Math.max(0, tzoneLum - 168) * 0.35)
  const cheekOil = clamp100(cShine)

  // ---- moisture ----
  const flaky = cheekCov != null ? Math.min(100, cheekCov * 260) : 30
  const dark = cheekLum != null ? Math.max(0, 115 - cheekLum) : 0
  const dryness = 0.4 * pores + 0.42 * flaky + 0.18 * dark
  let moisture = clamp100(86 - dryness * 0.85 - 0.12 * texture)

  // ---- dark circles / eye bags ----
  const ueLum = meanOf(underEye, (s) => s.meanLum)
  let darkCircles = 18
  if (ueLum != null && cheekLum != null && cheekLum > 1) {
    darkCircles = clamp100(clamp01((1 - ueLum / cheekLum) / 0.16) * 100)
  }
  const ueRidge = meanOf(underEye, wrinkleScore) ?? 12
  const eyeBags = clamp100(0.5 * darkCircles + 0.5 * ueRidge)

  // ---- radiance ----
  let radiance = 55
  if (faceBox) {
    const lumScore = 100 - Math.min(100, Math.abs(faceBox.meanLum - 150) * 0.9)
    const evenScore = 100 - Math.min(100, faceBox.cov * 220)
    radiance = clamp100(0.45 * lumScore + 0.3 * evenScore + 0.25 * (100 - spots))
  }

  // ---- firmness ----
  const nasoDepth = meanOf(list(['nasolabialR', 'nasolabialL']), wrinkleScore) ?? 14
  const firmness = clamp100(100 - 0.5 * wrinkles - 0.5 * nasoDepth)

  // ---- eyelids ----
  const geo = eyelidGeometry(landmarks)
  let droopyUpper = 20
  let droopyLower = 18
  if (geo) {
    const openS = clamp01((0.3 - geo.openness) / 0.14)
    const browS = clamp01((0.52 - geo.browGap) / 0.3)
    droopyUpper = clamp100((0.6 * openS + 0.4 * browS) * 100)
    const asymS = clamp01((geo.lidAsym - 1.0) / 0.6)
    droopyLower = clamp100((0.62 * asymS + 0.38 * (eyeBags / 100)) * 100)
  }

  // ---- skin type (categorical) ----
  // T-zone shine vs cheek shine + overall dryness. Combination = a glossy
  // T-zone over comparatively matte cheeks (the common case).
  let skinType = 'Normal'
  if (tShine >= 30 && cShine >= 24) skinType = 'Oily'
  else if (tShine >= 26 && tShine - cShine >= 18) skinType = 'Combination'
  else if (dryness >= 26 || moisture <= 46) skinType = 'Dry'
  const skinTypeShort = { Normal: 'Norm', Oily: 'Oily', Combination: 'Combo', Dry: 'Dry' }[skinType]

  // ---- skin age ----
  const ageRaw =
    19 +
    0.14 * wrinkles +
    0.09 * (100 - firmness) +
    0.05 * spots +
    0.03 * pores +
    0.06 * darkCircles +
    0.04 * eyeBags +
    0.03 * (100 - radiance) +
    0.03 * droopyUpper +
    0.03 * droopyLower
  const skinAge = Math.max(14, Math.min(85, Math.round(ageRaw)))

  // ---- assemble ----
  const values = {
    skinType,
    spots,
    wrinkles,
    texture,
    acne,
    darkCircles,
    redness,
    oiliness,
    moisture,
    pores,
    eyeBags,
    radiance,
    firmness,
    droopyUpper,
    droopyLower,
  }

  const metrics = METRICS.map((m) => {
    if (m.dir === 'text') {
      return { ...m, value: skinType, display: skinTypeShort, rating: skinType }
    }
    const v = clamp100(values[m.key])
    return { ...m, value: v, display: String(v), rating: ratingWord(m.dir, v) }
  })

  const report = {
    skinAge,
    confidence: sampledCount >= 4 ? 'ok' : 'low',
    sampled: sampledCount,
    metrics,
    values,
  }
  return report
}

// ---------------------------------------------------------------------------
// Live face-map — lightweight per-region pass for the on-camera overlay.
// Returns region polygons + scores + discrete mark points, all in
// frame-normalized (0–1) coords. Cheaper than analyze(): ridge/mark passes
// only run where they matter, and nothing is aggregated.
// ---------------------------------------------------------------------------
function regionRedness(s) {
  const rFrac = s.r / (s.r + s.g + s.b + 1)
  const rOverLum = (s.r - (s.g + s.b) / 2) / Math.max(1, s.meanLum)
  const raw =
    Math.max(0, (rFrac - 0.4) / 0.06) * 0.6 +
    Math.max(0, (rOverLum - 0.35) / 0.25) * 0.4
  return clamp100(score01(Math.min(2.5, raw), 1.0, 1.3))
}
function regionOiliness(s) {
  return clamp100(
    0.72 * Math.min(100, s.brightFrac * 2600) + 0.28 * Math.max(0, s.meanLum - 150) * 1.6,
  )
}
function regionDryness(s, pore) {
  return clamp100(
    0.4 * pore + 0.42 * Math.min(100, s.cov * 260) + 0.18 * Math.max(0, 115 - s.meanLum),
  )
}

// Landmark points of a region, sorted by angle around their centroid so they
// stroke/fill as a simple blob.
function polyFromIndices(L, idx) {
  const pts = idx.map((i) => L[i]).filter(Boolean).map((p) => [p.x, p.y])
  if (pts.length < 3) return pts
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length
  return pts
    .slice()
    .sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))
}

function analyzeMap(landmarks, source, sourceW, sourceH) {
  if (!workCtx) workCtx = makeCtx()
  const ctx = workCtx
  const regions = []
  const marks = []

  for (const name of Object.keys(REGIONS)) {
    const s = sampleRegion(source, sourceW, sourceH, landmarks, REGIONS[name], ctx)
    if (!s) continue
    // Hair-dominated crop (beard / stubble / brow / hairline): its texture
    // stats are meaningless — drop the region, same intent as analyzeSkin's
    // MAX_SKIN_COV guard.
    if (s.cov > 0.4) continue
    const hairy = s.cov > 0.3 // suspect but not certain — keep tint, drop marks
    const pore = poreScore(s)
    const wr = R_WRINKLE.has(name) ? wrinkleScore(s) : Math.round(pore * 0.4)
    const mk = R_MARK.has(name) && !hairy ? markScore(s, true) : { score: 0, points: [] }
    const scores = {
      redness: regionRedness(s),
      oiliness: regionOiliness(s),
      dryness: regionDryness(s, pore),
      wrinkles: clamp100(wr),
      pores: clamp100(pore),
      spots: clamp100(mk.score),
      texture: clamp100(0.5 * pore + 0.3 * mk.score + 0.2 * wr),
      darkCircles: 0,
      eyeBags: 0,
    }
    regions.push({
      name,
      lum: s.meanLum,
      gloss: s.glossFrac,
      bright: s.brightFrac,
      box: s.box,
      poly: polyFromIndices(landmarks, REGIONS[name]),
      scores,
    })
    for (const pt of mk.points) {
      marks.push({
        x: s.box.x + pt.x * s.box.w,
        y: s.box.y + pt.y * s.box.h,
        strength: pt.strength,
        kind: pt.kind,
      })
    }
  }

  // Exclude the eye / glasses band: brow line down to a bit above the nose tip.
  // Marks there are overwhelmingly spectacle frames, lash shadow or the lid
  // crease, not skin lesions.
  const brow = Math.min(landmarks[105]?.y ?? 1, landmarks[334]?.y ?? 1)
  const noseTip = landmarks[4]?.y ?? 1
  const bandLo = brow - 0.015
  const bandHi = brow + 0.62 * Math.max(0, noseTip - brow)
  let fMinX = 1
  let fMaxX = 0
  for (const p of landmarks) {
    if (p.x < fMinX) fMinX = p.x
    if (p.x > fMaxX) fMaxX = p.x
  }
  const inset = (fMaxX - fMinX) * 0.09
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]
    const drop =
      (m.y > bandLo && m.y < bandHi) || // eye / glasses band
      m.x < fMinX + inset || // outer face edge (hair / jaw shadow)
      m.x > fMaxX - inset ||
      (m.kind === 'linear' && Math.abs(m.x - 0.5) < 0.08) // nose-bridge / philtrum shadow
    if (drop) marks.splice(i, 1)
  }

  const cheekRegions = regions.filter((r) => r.name === 'cheekR' || r.name === 'cheekL')
  const cheekLum = cheekRegions.length
    ? cheekRegions.reduce((a, r) => a + r.lum, 0) / cheekRegions.length
    : null
  for (const r of regions) {
    if (r.name !== 'underEyeR' && r.name !== 'underEyeL') continue
    const dc = cheekLum ? clamp100(clamp01((1 - r.lum / cheekLum) / 0.16) * 100) : 0
    r.scores.darkCircles = dc
    r.scores.eyeBags = clamp100(0.5 * dc + 0.5 * r.scores.wrinkles)
  }

  // Live skin type — same T-zone-vs-cheek shine read as analyze().
  let skinType = null
  const tzR = regions.filter((r) => r.name === 'forehead' || r.name === 'nose' || r.name === 'glabella')
  if (tzR.length && cheekRegions.length) {
    const mean = (arr, pick) => arr.reduce((a, r) => a + pick(r), 0) / arr.length
    const tS = Math.min(100, mean(tzR, (r) => r.bright) * 2600 + mean(tzR, (r) => r.gloss) * 360)
    const cS = Math.min(100, mean(cheekRegions, (r) => r.bright) * 2600 + mean(cheekRegions, (r) => r.gloss) * 360)
    const dryM = mean(cheekRegions, (r) => r.scores.dryness)
    if (tS >= 30 && cS >= 24) skinType = 'Oily'
    else if (tS >= 26 && tS - cS >= 18) skinType = 'Combination'
    else if (dryM >= 40) skinType = 'Dry'
    else skinType = 'Normal'
  }

  // Dedupe marks from overlapping region crops (cheek/nose, forehead/glabella),
  // keeping the stronger. Then cap: a genuine face rarely shows more than a
  // handful of prominent discrete marks — more than that is noise, so keep only
  // the strongest few.
  const deduped = []
  for (const m of marks.sort((a, b) => b.strength - a.strength)) {
    if (deduped.some((d) => Math.hypot(d.x - m.x, d.y - m.y) < 0.03)) continue
    deduped.push(m)
  }

  // Drop a mirrored pair of streaks at the same height on opposite sides of the
  // face — that's an eyeglass frame sitting on the cheekbones, not two scars.
  const linear = deduped.filter((m) => m.kind === 'linear')
  const eyewear = new Set()
  for (let a = 0; a < linear.length; a++) {
    for (let b = a + 1; b < linear.length; b++) {
      if (
        Math.abs(linear[a].y - linear[b].y) < 0.035 &&
        (linear[a].x - 0.5) * (linear[b].x - 0.5) < 0
      ) {
        eyewear.add(linear[a])
        eyewear.add(linear[b])
      }
    }
  }

  return {
    regions,
    marks: deduped.filter((m) => !eyewear.has(m)).slice(0, 14),
    skinType,
    sampled: regions.length,
  }
}

export { analyze, analyzeMap, METRICS, FACE_OVAL, REGIONS, polyFromIndices }
