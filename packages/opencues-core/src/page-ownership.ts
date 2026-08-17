/**
 * Which OpenCues host owns a given web page.
 *
 * Two OpenCues hosts can end up in the same document, and they cannot see
 * each other any other way. A chrome content script runs in an **isolated
 * world**: its own `window`, its own module graph, its own globals. So the
 * page-level singleton each host uses to survive its own remounts
 * (`window.__ocSingleton`) is invisible across the boundary. What they DO
 * share is the document — the same textarea, the same
 * `CSS.highlights` registry, the same key events.
 *
 * Left unguarded that is not a cosmetic clash, it is data loss. Verified on
 * DeepSeek Harness with the chrome extension also installed: the extension
 * has no API key of its own on a fresh profile, so its missing-key fallback
 * won the race and wrote
 *
 *     the capital of iceland is [OpenCues: no API key — open the extension popup]
 *
 * over the plugin's answer — an error about a credential that host does not
 * even need, since it routes through the app's own model.
 *
 * ## The contract
 *
 * A host embedded IN the page (a dsh plugin, a future web-IDE integration)
 * calls `claimPage(hostName)`. A host attaching FROM OUTSIDE (the chrome
 * extension) calls `pageClaimedByOther(hostName)` and stands down when it
 * answers true.
 *
 * Precedence is deliberate and one-directional: **the embedded host wins.**
 * It knows the editor's real shape, it is version-matched to the surface it
 * was written for, and it usually has an LLM route already configured. A
 * generic extension guessing at someone else's composer is the weaker
 * claim.
 *
 * ## Read it live, do not cache it
 *
 * Ordering cannot be relied on. A content script runs at `document_end`,
 * while an embedded plugin typically boots later (framework mount, async
 * config fetch), so the marker frequently appears AFTER the extension has
 * already initialised. A once-at-startup check would therefore miss the
 * common case. `pageClaimedByOther` is a cheap attribute read — call it at
 * each point where the host is about to act on the document.
 */

/** Attribute set on `<html>`. Chosen over a global so it crosses worlds. */
export const PAGE_HOST_ATTR = 'data-opencues-host';

/**
 * Announce that `hostName` owns this document's OpenCues behaviour.
 *
 * Safe to call repeatedly and in a non-DOM environment (no-op there, so a
 * host's boot path need not branch on it). Returns a disposer that clears
 * the claim — worth calling if a host tears itself down and wants an
 * outside host to take over, though nothing depends on it.
 */
export function claimPage(hostName: string): () => void {
  if (typeof document === 'undefined' || !document.documentElement) return () => {};
  const el = document.documentElement;
  el.setAttribute(PAGE_HOST_ATTR, hostName);
  return () => {
    // Only retract our own claim: another host may have replaced it, and
    // clearing theirs would hand the page to nobody.
    if (el.getAttribute(PAGE_HOST_ATTR) === hostName) el.removeAttribute(PAGE_HOST_ATTR);
  };
}

/** The host that claimed this document, or null if none has. */
export function pageClaimedBy(): string | null {
  if (typeof document === 'undefined' || !document.documentElement) return null;
  const v = document.documentElement.getAttribute(PAGE_HOST_ATTR);
  return v && v.trim() ? v.trim() : null;
}

/**
 * Should `hostName` stand down here — i.e. has a DIFFERENT host claimed
 * this page?
 *
 * False when nobody has claimed it (the ordinary case: a normal web page
 * with only the extension present) and false when the claim is our own, so
 * a host can call this unconditionally without excluding itself.
 */
export function pageClaimedByOther(hostName: string): boolean {
  const owner = pageClaimedBy();
  return owner !== null && owner !== hostName;
}
