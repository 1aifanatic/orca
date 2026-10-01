// LRU bound for the native-chat composer's per-scope draft cache (text and image
// attachments), keyed by stable pane identity. A scope key for a permanently-removed
// pane is never revisited, so without a bound its unsent entry would linger in memory
// and on disk. delete-then-set keeps the actively-edited scope most-recent so
// eviction only sheds the oldest untouched scopes.
export const NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX = 128

export function setBoundedScopeCacheEntry<T>(
  cache: Map<string, T>,
  scopeKey: string,
  value: T,
  onEvict?: (evictedScopeKey: string) => void
): void {
  cache.delete(scopeKey)
  cache.set(scopeKey, value)
  while (cache.size > NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    cache.delete(oldest)
    onEvict?.(oldest)
  }
}
