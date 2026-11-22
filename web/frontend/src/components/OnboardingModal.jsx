import { useState, useEffect, useCallback } from "react";
import { X, ArrowRight } from "lucide-react";

const ONBOARDING_KEY = "cockpit-onboarding-suppressed";

const STEPS = [
  {
    eyebrow: "WELCOME TO PLEXAR STUDIO",
    title: "Run your whole fleet in one window",
    desc: "Up to eight Claude Code sessions side by side, grouped by project folder with live git status — a calm command center for parallel work.",
  },
  {
    eyebrow: "ADAPTIVE LAYOUTS",
    title: "One to eight, arranged for you",
    desc: "Pick 1–8 panes from the status bar. Even counts tile into clean grids; 3, 5 and 7 give one featured pane plus a rail. Drag a header to rearrange.",
  },
  {
    eyebrow: "BRIDGE",
    title: "Let your sessions talk",
    desc: "Relay a single message between two sessions, or start a mailbox bridge so they can work a problem out between themselves.",
  },
  {
    eyebrow: "MAKE IT YOURS",
    title: "Themes & focus glow",
    desc: "Ships in Visual Assist Night. Tune the palette, accent, and per-state focus glow anytime — or switch them off entirely — from Settings.",
  },
];

function HeroWelcome() {
  const dots = [
    { glow: "var(--cc-working)", dot: "var(--cc-working)", alpha: 55 },
    { glow: "var(--cc-waiting)", dot: "var(--cc-waiting)", alpha: 55 },
    { glow: "var(--cc-border)", dot: "var(--cc-idle)", plain: true },
    { glow: "var(--cc-working)", dot: "var(--cc-working)", alpha: 40 },
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "1fr 1fr",
        gap: 8,
        width: 210,
        height: 130,
      }}
    >
      {dots.map((d, i) => (
        <div
          key={i}
          style={{
            borderRadius: 8,
            background: "var(--cc-term)",
            boxShadow: d.plain
              ? "0 0 0 1px var(--cc-border)"
              : `0 0 0 1px color-mix(in srgb, ${d.glow} ${d.alpha}%, transparent), 0 0 16px color-mix(in srgb, ${d.glow} 30%, transparent)`,
            padding: 8,
          }}
        >
          <span
            style={{
              display: "block",
              width: 7,
              height: 7,
              borderRadius: 999,
              background: d.dot,
              boxShadow: d.plain ? "none" : `0 0 6px ${d.dot}`,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function HeroLayouts() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 52, height: 52, borderRadius: 7, border: "1px solid var(--cc-border)", background: "var(--cc-term)" }} />
      <ArrowRight size={16} style={{ color: "var(--cc-muted)" }} />
      <div style={{ display: "flex", gap: 5 }}>
        <div
          style={{
            width: 34,
            height: 52,
            borderRadius: 7,
            background: "var(--cc-term)",
            boxShadow: "0 0 0 1px color-mix(in srgb, var(--cc-accent) 55%, transparent), 0 0 14px color-mix(in srgb, var(--cc-accent) 28%, transparent)",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ width: 26, height: 23.5, borderRadius: 6, border: "1px solid var(--cc-border)", background: "var(--cc-term)" }} />
          <div style={{ width: 26, height: 23.5, borderRadius: 6, border: "1px solid var(--cc-border)", background: "var(--cc-term)" }} />
        </div>
      </div>
    </div>
  );
}

function HeroBridge() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "7px 12px",
          borderRadius: 8,
          background: "var(--cc-term)",
          boxShadow: "0 0 0 1px color-mix(in srgb, var(--cc-working) 50%, transparent)",
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--cc-working)" }} />
        <span style={{ fontSize: 11, color: "var(--cc-fg)" }}>lead</span>
      </span>
      <div style={{ width: 38, height: 2, background: "linear-gradient(90deg, var(--cc-working), var(--cc-waiting))" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            borderRadius: 8,
            background: "var(--cc-term)",
            boxShadow: "0 0 0 1px color-mix(in srgb, var(--cc-waiting) 45%, transparent)",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--cc-waiting)" }} />
          <span style={{ fontSize: 10, color: "var(--cc-dim)" }}>worker</span>
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            borderRadius: 8,
            background: "var(--cc-term)",
            boxShadow: "0 0 0 1px color-mix(in srgb, var(--cc-idle) 45%, transparent)",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--cc-idle)" }} />
          <span style={{ fontSize: 10, color: "var(--cc-dim)" }}>worker</span>
        </span>
      </div>
    </div>
  );
}

function HeroThemes() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: "var(--cc-working)",
            boxShadow: "0 0 12px color-mix(in srgb, var(--cc-working) 45%, transparent)",
          }}
        />
        <span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--cc-fn)" }} />
        <span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--cc-idle)" }} />
        <span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--cc-waiting)" }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>FOCUS GLOW</span>
        <div style={{ width: 34, height: 19, borderRadius: 999, background: "var(--cc-accent)", position: "relative" }}>
          <div style={{ position: "absolute", top: 2, left: 17, width: 15, height: 15, borderRadius: 999, background: "#fff" }} />
        </div>
      </div>
    </div>
  );
}

const HEROES = [HeroWelcome, HeroLayouts, HeroBridge, HeroThemes];

export default function OnboardingModal({ onDismiss }) {
  const [step, setStep] = useState(0);
  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];
  const Hero = HEROES[step];

  const finish = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_KEY, "true");
    } catch (_) {
      // localStorage unavailable — non-fatal
    }
    onDismiss();
  }, [onDismiss]);

  const next = useCallback(() => {
    if (isLast) {
      finish();
    } else {
      setStep((s) => s + 1);
    }
  }, [isLast, finish]);

  const back = useCallback(() => {
    if (!isFirst) setStep((s) => s - 1);
  }, [isFirst]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight" || e.key === "Enter") next();
      if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finish, next, back]);

  return (
    <div className="cc-modal-backdrop fixed inset-0 z-50 flex items-center justify-center" onClick={finish}>
      <div
        className="cc-modal cc-card"
        style={{
          width: 500,
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "0 40px 120px rgba(0,0,0,.6), 0 0 0 1px color-mix(in srgb, var(--cc-accent) 22%, transparent)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero visual */}
        <div
          style={{
            position: "relative",
            height: 196,
            background: "linear-gradient(180deg, color-mix(in srgb, var(--cc-accent) 10%, transparent), transparent)",
            borderBottom: "1px solid var(--cc-line)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            onClick={finish}
            aria-label="Close"
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              display: "flex",
              padding: 6,
              borderRadius: 7,
              color: "var(--cc-muted)",
              background: "rgba(0,0,0,.2)",
              border: "none",
              cursor: "pointer",
              zIndex: 2,
            }}
          >
            <X size={15} />
          </button>
          <Hero />
        </div>

        {/* Copy */}
        <div
          style={{
            padding: "22px 24px 6px",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            minHeight: 96,
          }}
        >
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".16em", color: "var(--cc-accent)" }}>
            {current.eyebrow}
          </span>
          <span style={{ fontSize: 18, fontWeight: 800, color: "var(--cc-fg)", letterSpacing: "-.01em" }}>
            {current.title}
          </span>
          <span style={{ fontSize: "12.5px", color: "var(--cc-dim)", lineHeight: 1.55, padding: "0 8px" }}>
            {current.desc}
          </span>
        </div>

        {/* Nav */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px 20px" }}>
          {!isLast ? (
            <button
              type="button"
              onClick={finish}
              style={{ fontSize: 12, fontWeight: 600, fontFamily: "inherit", color: "var(--cc-muted)", background: "none", border: "none", cursor: "pointer" }}
            >
              Skip
            </button>
          ) : (
            <span />
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {STEPS.map((_, i) => (
              <span
                key={i}
                style={{
                  width: i === step ? 20 : 7,
                  height: 7,
                  borderRadius: 999,
                  background: i === step ? "var(--cc-accent)" : "color-mix(in srgb, var(--cc-fg) 22%, transparent)",
                  transition: "all .2s",
                }}
              />
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {!isFirst && (
              <button
                type="button"
                onClick={back}
                style={{
                  height: 36,
                  padding: "0 14px",
                  borderRadius: 9,
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  color: "var(--cc-dim)",
                  background: "none",
                  border: "1px solid var(--cc-border)",
                  cursor: "pointer",
                }}
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="flex items-center gap-1.5"
              style={{
                height: 36,
                padding: "0 18px",
                borderRadius: 9,
                fontSize: 12,
                fontWeight: 700,
                fontFamily: "inherit",
                color: "#0f1216",
                background: "var(--cc-accent)",
                border: "none",
                cursor: "pointer",
                boxShadow: "0 6px 16px color-mix(in srgb, var(--cc-accent) 32%, transparent)",
              }}
            >
              {isLast ? "Get started" : "Next"}
              <ArrowRight size={14} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
