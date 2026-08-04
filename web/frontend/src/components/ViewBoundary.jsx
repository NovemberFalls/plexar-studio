import { Component } from "react";

/**
 * A PER-VIEW error boundary. One per full-area destination, INSIDE the shell.
 *
 * ── WHY THIS EXISTS, IN THE WORDS OF THE FAILURE ──────────────────────────
 * There was exactly one boundary in this app: `ErrorBoundary`, mounted at the
 * root in `main.jsx`. It renders `position: fixed; inset: 0` over the whole
 * window and its only way out is `window.location.reload()`. Two consequences,
 * and BOTH of them actually happened:
 *
 *  1. **It does not CONTAIN.** A render error anywhere — one panel, one tab —
 *     takes the entire product. The rail, the sidebar, the terminals and every
 *     view that was fine go with it. The blast radius of a bug in a reporting
 *     panel was a multi-session terminal multiplexer.
 *
 *  2. **`hasError` LATCHES.** Nothing resets it. Once tripped it stays tripped
 *     for the life of the mount, so every subsequent navigation renders the
 *     SAME stale error. The owner reported the fault against Traces; Traces was
 *     innocent and had never rendered. A boundary that latches is a WORSE
 *     instrument than no boundary, because it manufactures false evidence about
 *     surfaces that are working. The cost of that bug was not the crash — it
 *     was the wrong surface being blamed for it.
 *
 * So this component has three obligations, and each one is a gate:
 *
 *  (a) CONTAIN — the fallback is INLINE (`flex: 1`), never `position: fixed`.
 *      Its siblings, the rail, and the shell keep rendering and stay navigable.
 *      A full-screen fallback is the defect, not the styling.
 *  (b) RESET — `resetKey` is compared in `getDerivedStateFromProps`. When the
 *      caller navigates, the key changes and the error clears. React runs
 *      gDSFP on the post-`getDerivedStateFromError` re-render too, with props
 *      unchanged, so the reset check cannot swallow the error it just caught.
 *  (c) NAME THE VIEW — `name` is rendered verbatim in the fallback heading.
 *      "Something went wrong" tells the reader to guess, and the guess is what
 *      cost us the last round.
 *
 * The root `ErrorBoundary` STAYS. It is the last resort for an error thrown
 * outside every view (the shell itself, a provider, a hook at App level), and
 * removing it would trade a bad fallback for a white screen. This one catches
 * first because it is nearer the throw.
 */
export default class ViewBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, lastResetKey: props.resetKey };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  /** (b) The reset. A changed `resetKey` means the user navigated, so the old
   *  error describes a surface they are no longer looking at. Carrying it
   *  forward is the exact defect this class was written to remove. */
  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.lastResetKey) {
      return { lastResetKey: props.resetKey, hasError: false, error: null };
    }
    return null;
  }

  componentDidCatch(error, info) {
    // Named, so a console report identifies the surface without a screenshot.
    console.error(`[ViewBoundary:${this.props.name}] Uncaught error:`, error, info);
  }

  /** In-place recovery. A transient failure (a bad poll response, a race on
   *  first paint) should not cost the user their terminals — which is what
   *  the root boundary's `location.reload()` does. */
  retry() {
    this.setState({ hasError: false, error: null });
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const name = this.props.name || "This view";
    return (
      <div
        role="alert"
        data-testid="view-boundary-fallback"
        data-view={this.props.name}
        className="flex-1 min-w-0 flex flex-col"
        style={{
          background: "var(--cc-bg)",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          gap: 14,
          overflow: "auto",
        }}
      >
        <div style={{ maxWidth: 560, textAlign: "center" }}>
          {/* (c) The view is NAMED. This heading is the whole reason the
              component takes a `name` prop. */}
          <h2
            data-testid="view-boundary-title"
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: "var(--cc-error, #e0698a)",
              marginBottom: 8,
            }}
          >
            {name} failed to render
          </h2>
          <p style={{ fontSize: 12, color: "var(--cc-muted)", marginBottom: 14, lineHeight: 1.6 }}>
            Only this view is affected. Your sessions are still running and the rest of
            Plexar Studio is still usable — switch to another section from the rail, or
            try this one again.
          </p>
          <pre
            data-testid="view-boundary-error"
            style={{
              fontSize: 11,
              textAlign: "left",
              color: "var(--cc-error, #e0698a)",
              background: "color-mix(in srgb, var(--cc-error, #e0698a) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--cc-error, #e0698a) 30%, transparent)",
              borderRadius: 8,
              padding: 10,
              margin: "0 0 14px",
              maxWidth: "100%",
              overflow: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {this.state.error?.message || "Unknown error"}
          </pre>
          <button
            type="button"
            data-testid="view-boundary-retry"
            onClick={this.retry}
            className="transition-colors hover-bg-elevated"
            style={{
              height: 26,
              padding: "0 14px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              fontFamily: "inherit",
              color: "var(--cc-error, #e0698a)",
              background: "transparent",
              border: "1px solid color-mix(in srgb, var(--cc-error, #e0698a) 45%, transparent)",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
