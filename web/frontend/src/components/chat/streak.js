/**
 * Pure helpers for the gamified strip. Separate from the component so they can
 * be exported and tested without tripping fast-refresh, which requires a
 * component file to export only components.
 *
 * THE RULE THESE ENCODE: every number shown is a real measurement of something
 * the user actually did. No invented points, no arbitrary XP curve. A counter
 * that rewards you for nothing teaches you to ignore the counter.
 */

/** Milestones on a conversation's own length. Deliberately sparse: a badge
 *  that fires constantly is wallpaper. */
export const DEPTH_TIERS = [
  { at: 5, label: "Warmed up" },
  { at: 15, label: "In the weeds" },
  { at: 40, label: "Deep dive" },
  { at: 100, label: "Epic" },
];

export function depthTier(count) {
  let hit = null;
  for (const t of DEPTH_TIERS) if (count >= t.at) hit = t;
  return hit;
}

/**
 * Consecutive days ending today that have at least one conversation.
 *
 * Counts BACKWARD from today and stops at the first gap — a streak with a hole
 * in it is not a streak, and quietly bridging one would make the number a
 * decoration rather than a fact. Yesterday-but-not-today still counts as live,
 * so the streak does not appear broken before the day is over.
 */
export function computeStreak(conversations, now = new Date()) {
  const days = new Set();
  for (const c of conversations || []) {
    const iso = c.last_message_at || c.updated_at || c.created_at;
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    days.add(d.toDateString());
  }
  if (days.size === 0) return 0;

  const cursor = new Date(now);
  // Grace: if today has nothing yet but yesterday does, the streak is alive.
  if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (days.has(cursor.toDateString())) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
