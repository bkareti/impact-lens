/**
 * Tokenization helpers shared by the indexer, search engine, and tests.
 *
 * Two different tokenizers serve two different goals:
 *
 * - `indexTokenize` powers the MiniSearch full-text index. It splits
 *   aggressively (delimiters + camelCase + underscores + dots) to maximize
 *   *recall* — typing "service" can still surface `AccountService`.
 *
 * - `preciseTokens` powers the reference-graph lookup. It splits ONLY on
 *   structural separators (dots and underscores), never camelCase, so the
 *   default search is *precise*: "Account" matches `Account` and
 *   `Account.Name` but NOT `AccountService`.
 *
 * This module intentionally has no `vscode` import so it can be unit-tested
 * outside the extension host.
 */

/** Delimiters that separate identifiers in code/markup. */
const DELIMITERS = /[\s.,;:!?(){}[\]<>/\\|@#$%^&*+=~`'"]+/;

/**
 * Tokenizer for the MiniSearch full-text index. Maximizes recall by also
 * emitting camelCase / underscore / dot sub-tokens.
 */
export function indexTokenize(text: string): string[] {
  return text
    .split(DELIMITERS)
    .flatMap((token) => {
      const parts: string[] = [token];
      // Split camelCase / PascalCase
      const camelSplit = token.split(/(?=[A-Z])/).filter(Boolean);
      if (camelSplit.length > 1) {
        parts.push(...camelSplit);
      }
      // Split on underscores (common in SF API names)
      const underscoreSplit = token.split('_').filter(Boolean);
      if (underscoreSplit.length > 1) {
        parts.push(...underscoreSplit);
      }
      // Handle Object.Field format
      const dotSplit = token.split('.');
      if (dotSplit.length > 1) {
        parts.push(...dotSplit);
      }
      return parts;
    })
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Precise identifier tokens for a reference-graph keyword.
 *
 * Emits the whole (lowercased) identifier plus each dot-segment and
 * underscore-word — but never camelCase splits. Tokens shorter than two
 * characters are dropped to avoid noise from `__c` / `__r` suffixes.
 *
 * Examples:
 *   "Account"            -> ["account"]
 *   "Account.Name"       -> ["account.name", "account", "name"]
 *   "Account.Status__c"  -> ["account.status__c", "account", "status__c", "status"]
 *   "AccountService"     -> ["accountservice"]   (NOT "account")
 */
export function preciseTokens(keyword: string): string[] {
  const lower = keyword.toLowerCase().trim();
  if (!lower) {
    return [];
  }

  const tokens = new Set<string>();
  tokens.add(lower); // whole identifier

  for (const segment of lower.split('.')) {
    if (segment.length >= 2) {
      tokens.add(segment);
    }
    for (const word of segment.split(/_+/)) {
      if (word.length >= 2) {
        tokens.add(word);
      }
    }
  }

  return [...tokens];
}
