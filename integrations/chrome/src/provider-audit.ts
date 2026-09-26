/**
 * The `<feature>-provider: <id>` lines of OPENCUES.md frontmatter that name a CHAT provider (global
 * `provider:` as `global`). `decisions-provider` is left out: it names the decision model (TypeSafe or the
 * OpenCues service), which is never a chat provider, so it was flagged "unknown provider" on every load.
 */
export function llmProviderDirectives(fm: string): { feature: string; provider: string }[] {
  const directives: { feature: string; provider: string }[] = [];
  const re = /^(?:([\w-]+)-)?provider:\s*([a-z]+)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fm)) !== null) {
    const feature = m[1] ?? 'global';
    if (feature === 'decisions') continue;
    directives.push({ feature, provider: m[2].toLowerCase() });
  }
  return directives;
}
