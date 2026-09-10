import { useEffect, useRef } from 'react'
import { mountFaceApp } from './faceCapture'
import './faceApp.css'

/**
 * The standalone guided-face-capture + live skin-map screen, ported to React.
 * Route: /face-app. The markup mirrors face-capture/index.html; all behaviour
 * lives in ./faceCapture (mountFaceApp), driven imperatively against these ids.
 */
export function FaceApp() {
  const mounted = useRef(false)

  useEffect(() => {
    // React 18 StrictMode double-invokes effects in dev; mountFaceApp is
    // idempotent and returns a teardown, so a second run is harmless.
    if (mounted.current) return
    mounted.current = true
    let cleanup: (() => void) | undefined
    try {
      cleanup = mountFaceApp()
    } catch (err) {
      console.error('face-app mount failed', err)
    }
    return () => {
      mounted.current = false
      cleanup?.()
    }
  }, [])

  return (
    <div className="fc-app">
      <div className="app">
        <h1>Time for your close-up</h1>

        {/* Fallback / error — appears only when the camera can't auto-start. */}
        <section id="screen-choose" hidden>
          <p className="sub">
            Natural light, no filters, face centered — this helps us read your skin accurately.
          </p>
          <p id="camera-error" className="error" role="alert" hidden />
          <div className="choices">
            <button type="button" id="start-btn" className="choice">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              <span>Start camera</span>
            </button>
          </div>
        </section>

        {/* Camera */}
        <section id="screen-camera">
          <div className="chips">
            <div className="chip" id="chip-light">
              <div className="chip-title">Lighting</div>
              <div className="chip-label">—</div>
            </div>
            <div className="chip" id="chip-pose">
              <div className="chip-title">Look Straight</div>
              <div className="chip-label">No Face</div>
            </div>
            <div className="chip" id="chip-position">
              <div className="chip-title">Face Position</div>
              <div className="chip-label">No Face</div>
            </div>
            <div className="chip" id="chip-coverage">
              <div className="chip-title">Face Clear</div>
              <div className="chip-label">No Face</div>
            </div>
          </div>

          <div className="camera-row">
            <div className="frame">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                id="video"
                autoPlay
                muted
                playsInline
                disablePictureInPicture
              />
              <canvas id="overlay" className="overlay" aria-hidden="true" hidden />
              <div className="guide" id="guide" data-shape="rectangle" data-valid="false">
                <div className="rect-guide">
                  <div className="scrim scrim-top" />
                  <div className="scrim scrim-bottom" />
                  <div className="scrim scrim-left" />
                  <div className="scrim scrim-right" />
                  <div className="rect-window">
                    <div className="bracket tl" />
                    <div className="bracket tr" />
                    <div className="bracket bl" />
                    <div className="bracket br" />
                  </div>
                </div>
                <svg
                  className="oval-guide"
                  viewBox="0 0 300 400"
                  preserveAspectRatio="xMidYMid slice"
                  aria-hidden="true"
                >
                  <defs>
                    <mask id="oval-mask">
                      <rect width="300" height="400" fill="white" />
                      <ellipse cx="150" cy="200" rx="117" ry="152" fill="black" />
                    </mask>
                  </defs>
                  <rect width="300" height="400" fill="rgba(0,0,0,0.28)" mask="url(#oval-mask)" />
                  <ellipse
                    className="oval-ellipse"
                    cx="150"
                    cy="200"
                    rx="117"
                    ry="152"
                    fill="none"
                    stroke="rgba(255,255,255,0.75)"
                    strokeWidth="3"
                    strokeDasharray="10 8"
                  />
                </svg>
              </div>
            </div>
            <div className="metric-side" id="metric-side" hidden>
              <div className="spot-count" id="spot-count" hidden />
              <div className="metric-rail" id="metric-rail" hidden />
            </div>
          </div>

          <div className="layer-strip" id="layer-strip" hidden />
          <p className="metric-strip-hint" id="metric-strip-hint" hidden>
            <span style={{ color: '#ffbe3c' }}>◯</span> spot / mole {'  '}
            <span style={{ color: '#ff465a' }}>▢</span> possible scar
          </p>

          <p className="message" id="message" data-ok="false">
            Loading face detection…
          </p>
          <canvas id="capture-canvas" className="hidden" />

          <div className="actions">
            <button type="button" id="take-btn" className="btn" disabled>
              Line up the checks first
            </button>
            <button type="button" id="cancel-btn" className="btn secondary">
              Cancel
            </button>
          </div>

          <div className="settings">
            <label>
              Auto-capture when ready
              <input type="checkbox" id="opt-autocapture" />
            </label>
            <label>
              Oval guide
              <input type="checkbox" id="opt-guideshape" />
            </label>
            <label>
              Face-covering check
              <input type="checkbox" id="opt-coverage" />
            </label>
            <label>
              Live skin map
              <input type="checkbox" id="opt-livemap" />
            </label>
          </div>
          <p className="hint">Framing &amp; coverage guidance only — not a liveness check.</p>
        </section>

        {/* Preview */}
        <section id="screen-preview" hidden>
          <p className="sub">Natural light, no filters, face centered.</p>
          <div className="frame bordered">
            <img id="photo" alt="Captured face" />
          </div>
          <p className="preview-message" id="preview-message" data-state="checking">
            Checking your photo…
          </p>
          <p className="hint">Your photo stays in your browser — nothing is uploaded.</p>

          <section className="skin-panel" id="skin-panel" hidden>
            <div className="skin-age">
              Skin Age: <span id="skin-age-val">•••</span>
            </div>
            <div className="skin-grid" id="skin-grid" />
            <p className="skin-disclaimer">
              On-device estimate from a single photo — a skincare guide, not a medical assessment.
            </p>
          </section>

          <div className="actions">
            <button type="button" id="retake-btn" className="btn secondary">
              Retake
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

export default FaceApp
