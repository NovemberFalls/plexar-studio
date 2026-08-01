/**
 * The gamified strip: streak, depth, and the conversation's own milestones.
 *
 * The design rule here, because gamification is easy to get wrong: EVERY
 * number shown is a real measurement of something the user actually did. No
 * invented points, no arbitrary XP curve, no fake scarcity. A counter that
 * rewards you for nothing teaches you to ignore the counter — the same
 * argument the reporting surfaces make about a row that is always red.
 *
 * So: messages exchanged, days in a row with at least one conversation, and
 * the longest single thread. All derived from the store, all verifiable by
 * counting.
 */

import { Flame, MessagesSquare, Trophy } from "lucide-react";

import { computeStreak, depthTier } from "./streak.js";

function Stat({ icon: Icon, value, label, tone }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }} title={label}>
      <Icon size={11} style={{ color: tone || "var(--cc-muted)" }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--cc-fg)" }}>{value}</span>
      <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>{label}</span>
    </div>
  );
}

export default function ChatStreak({ conversations, activeMessageCount }) {
  const list = conversations || [];
  const streak = computeStreak(list);
  const totalMessages = list.reduce((n, c) => n + (c.message_count || 0), 0);
  const longest = list.reduce((n, c) => Math.max(n, c.message_count || 0), 0);
  const tier = depthTier(activeMessageCount || 0);

  // Nothing to celebrate yet: an all-zero row is noise on a first run.
  if (totalMessages === 0) return null;

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
        padding: "6px 14px", borderBottom: "1px solid var(--cc-line)",
      }}
    >
      {streak > 0 && (
        <Stat
          icon={Flame}
          value={streak}
          label={`day${streak === 1 ? "" : "s"} in a row`}
          tone="var(--cc-accent)"
        />
      )}
      <Stat icon={MessagesSquare} value={totalMessages.toLocaleString()} label="messages" />
      {longest > 0 && <Stat icon={Trophy} value={longest} label="longest thread" />}
      {tier && (
        <span
          style={{
            marginLeft: "auto", fontSize: 9, fontWeight: 800, letterSpacing: ".07em",
            textTransform: "uppercase", color: "var(--cc-accent)",
            border: "1px solid var(--cc-accent)", borderRadius: 999, padding: "1px 8px",
          }}
          title={`This conversation has passed ${tier.at} messages`}
        >
          {tier.label}
        </span>
      )}
    </div>
  );
}
