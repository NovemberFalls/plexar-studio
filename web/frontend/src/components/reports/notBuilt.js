/**
 * Why a surface is empty, and where the information lives today.
 *
 * Exported so a test can hold the prose to account. Copy that names a
 * destination which does not exist is worse than no copy: it sends the reader
 * somewhere, they find nothing, and they conclude the whole feature is missing.
 * That is exactly what happened here — the Traces entry once said
 * "Engine ▸ Traces" and Engine has never had a Traces tab.
 *
 * S26 (2026-08-03) moved the real trace renderer into Reports ▸ Traces; T11
 * (2026-08-04) removed that tab altogether when the lane broker went, because
 * the broker was its only producer.
 */

/* THE TRACES TAB IS GONE (T11, 2026-08-04), and with it TRACES_EMPTY_WHY /
 * TRACES_WILL. The explanation those strings carried has been overtaken by
 * the fact: the lane broker was the ONLY backend that ever published traces,
 * and it is removed entirely. There is no recorder to switch on and no
 * renderer left to explain, so a tab saying "empty for these reasons" would
 * be describing a feature that no longer exists.
 */

/** Tabs that genuinely have no implementation. Empty today — kept because the
 *  panel that renders it is still the right shape for the next one. */
export const NOT_BUILT_TABS = {};
