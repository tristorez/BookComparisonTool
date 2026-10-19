import { useCallback, useEffect, useState } from 'react';
import type { BookId } from '@shared/domain';
import type { WireBookMeta } from '@shared/wire';

/** The board's toggle: Best Price, or one book's own prices. */
export type View = 'best' | BookId;

export function readViewParam(search: string = typeof window === 'undefined' ? '' : window.location.search): string {
  return new URLSearchParams(search).get('view')?.trim().toLowerCase() || 'best';
}

/**
 * The view to render. A book view must name a book from the snapshot's registry; anything else falls
 * back to Best Price. Until the registry arrives the request is kept, so `?view=fanduel` survives load.
 */
export function resolveView(requested: string, books: readonly WireBookMeta[]): View {
  if (requested === 'best') return 'best';
  if (books.length === 0) return requested as View;
  return books.some((b) => b.id === requested) ? (requested as View) : 'best';
}

/** `?view=` as React state: switching replaces the URL (no history entry per click). */
export function useViewParam(): [string, (view: View) => void] {
  const [view, setView] = useState(() => readViewParam());
  useEffect(() => {
    const onPop = (): void => setView(readViewParam());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const select = useCallback((next: View) => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', next);
    window.history.replaceState(window.history.state, '', url);
    setView(next);
  }, []);
  return [view, select];
}
