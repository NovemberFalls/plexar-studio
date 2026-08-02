import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary] Uncaught error:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: "fixed", inset: 0,
          background: "#0a0a0f",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column", gap: "16px",
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          color: "#e0e0e0",
        }}>
          <div style={{ zIndex: 1, textAlign: "center", maxWidth: "600px", padding: "32px" }}>
            <h1 style={{ fontSize: "24px", color: "#ff6b6b", marginBottom: "12px" }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: "14px", color: "#888", marginBottom: "24px" }}>
              Plexar Studio encountered an unexpected error.
            </p>
            <pre style={{
              fontSize: "12px", color: "#ff9999",
              background: "rgba(255,107,107,0.1)",
              padding: "12px", borderRadius: "6px",
              maxWidth: "100%", overflow: "auto",
              textAlign: "left", marginBottom: "24px",
              border: "1px solid rgba(255,107,107,0.2)",
            }}>
              {this.state.error?.message || "Unknown error"}
            </pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: "#ff6b6b", color: "#fff",
                border: "none", padding: "10px 24px",
                borderRadius: "6px", cursor: "pointer",
                fontSize: "14px", fontWeight: 600,
              }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
