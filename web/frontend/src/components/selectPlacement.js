/**
 * selectPlacement — where a portalled dropdown panel goes, from the trigger's
 * real rect.
 *
 * Extracted from NewSessionDialog because it is a pure function and the
 * react-refresh lint rule (correctly) refuses a non-component export from a
 * component module. Being pure is also what makes the direction rule testable
 * without a layout engine: jsdom reports every rect as zeros, so the only
 * honest way to assert "flips up when the trigger is at the bottom" is to feed
 * this function a rect directly.
 */

/** Gap between the trigger and the panel. */
export const PANEL_GAP = 4;
/** Breathing room against the viewport edge. */
export const PANEL_EDGE = 8;
/**
 * Preferred panel height — a PREFERENCE, not a cap on reachability. Whatever
 * height the panel ends up with, its list scrolls, so no option is stranded.
 */
export const PANEL_MAX = 280;
/** Never collapse to an unusable sliver. */
export const PANEL_MIN = 96;

/**
 * Decide placement + geometry for a panel anchored to `rect`.
 *
 * The bug this replaces: the panel hardcoded `bottom: 100%` (always upward)
 * with no max-height, which is how `Auto` and `Low` — the first two effort
 * levels — ended up above the top of the modal with no way to scroll to them.
 *
 * Prefer downward; flip up only when down cannot show a full panel AND up has
 * more room. When neither side fits, the roomier side wins and the list
 * scrolls.
 */
export function computeSelectPlacement(rect, viewportHeight) {
  const below = viewportHeight - rect.bottom - PANEL_GAP - PANEL_EDGE;
  const above = rect.top - PANEL_GAP - PANEL_EDGE;
  const placement = below < PANEL_MAX && above > below ? "up" : "down";
  const room = placement === "up" ? above : below;
  const maxHeight = Math.max(PANEL_MIN, Math.min(PANEL_MAX, room));
  const style = {
    position: "fixed",
    left: Math.max(PANEL_EDGE, rect.left),
    width: rect.width || undefined,
    maxHeight,
  };
  if (placement === "up") style.bottom = Math.max(PANEL_EDGE, viewportHeight - rect.top + PANEL_GAP);
  else style.top = Math.max(PANEL_EDGE, rect.bottom + PANEL_GAP);
  return { placement, style };
}
