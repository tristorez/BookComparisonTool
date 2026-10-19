import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
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

/** `?game=`: the game open for comparison, or null for the board. */
export function readGameParam(search: string = typeof window === 'undefined' ? '' : window.location.search): string | null {
  return new URLSearchParams(search).get('game')?.trim() || null;
}

/** This page's URL with `?game=` set, or removed for null: real link targets, so a new tab works too. */
export function gameHref(game: string | null, href: string = window.location.href): string {
  const url = new URL(href);
  if (game === null) url.searchParams.delete('game');
  else url.searchParams.set('game', game);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A plain left click, which the page handles; modified clicks keep the browser's own behavior. */
export function isPlainClick(e: MouseEvent): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export interface GameNav {
  game: string | null;
  open: (game: string) => void;
  close: () => void;
}

/**
 * `?game=` as React state. Opening a game pushes a history entry, so Back returns to the board; the
 * board comes back where it was scrolled, and a game opens at the top.
 */
export function useGameParam(): GameNav {
  const [game, setGame] = useState(() => readGameParam());
  const current = useRef(game);
  const boardY = useRef(0);
  const go = useCallback((next: string | null) => {
    if (current.current === null && next !== null) boardY.current = window.scrollY;
    current.current = next;
    setGame(next);
  }, []);
  useEffect(() => {
    const onPop = (): void => go(readGameParam());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [go]);
  const shown = useRef(game);
  useLayoutEffect(() => {
    if (shown.current === game) return;
    shown.current = game;
    window.scrollTo(0, game === null ? boardY.current : 0);
  }, [game]);
  const open = useCallback(
    (next: string) => {
      if (next === current.current) return;
      window.history.pushState({ ...(window.history.state as object | null), fromBoard: true }, '', gameHref(next));
      go(next);
    },
    [go],
  );
  const close = useCallback(() => {
    // Opened from the board: step back through history, so Back and this link agree.
    if ((window.history.state as { fromBoard?: boolean } | null)?.fromBoard === true) {
      window.history.back();
      return;
    }
    window.history.replaceState(window.history.state, '', gameHref(null));
    go(null);
  }, [go]);
  return { game, open, close };
}
