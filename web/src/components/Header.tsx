import { useBooks } from '../lib/store';
import type { View } from '../lib/view';
import { BookStatusChip } from './BookStatusChip';
import { ConnectionIndicator } from './ConnectionIndicator';
import { LogoMark } from './icons';
import { ViewToggle } from './ViewToggle';

/** `showToggle` is off on a game's comparison page, which lists every book anyway. */
export function Header({ view, onView, showToggle = true }: { view: View; onView: (view: View) => void; showToggle?: boolean }) {
  const books = useBooks();
  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-navy-950/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl flex-col gap-2.5 px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <LogoMark className="size-7 shrink-0" />
            <h1 className="truncate text-[15px] font-bold tracking-tight text-ink">NFL Odds Board</h1>
          </div>
          <ConnectionIndicator />
        </div>
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          {showToggle && <ViewToggle books={books} view={view} onChange={onView} />}
          {books.length > 0 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Sportsbook status">
              {books.map((b) => (
                <BookStatusChip key={b.id} meta={b} />
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
