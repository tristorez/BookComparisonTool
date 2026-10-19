import { Board } from './components/Board';
import { Header } from './components/Header';
import { StaleBanner } from './components/StaleBanner';
import { useBooks } from './lib/store';
import { resolveView, useViewParam } from './lib/view';

const listFormat = new Intl.ListFormat('en', { type: 'conjunction' });

export function App() {
  const books = useBooks();
  const [requested, setView] = useViewParam();
  const view = resolveView(requested, books);
  const regions = [...new Set(books.map((b) => b.region).filter((r): r is string => !!r))];
  return (
    <div className="min-h-dvh bg-navy-950 text-ink">
      <a
        href="#board"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-navy-950"
      >
        Skip to the board
      </a>
      <Header view={view} onView={setView} />
      <StaleBanner />
      <main className="mx-auto max-w-5xl px-3 pt-4 pb-10 sm:px-6">
        <Board view={view} />
      </main>
      <footer className="mx-auto max-w-5xl px-4 pb-10 text-xs leading-relaxed text-faint sm:px-6">
        <p>
          Prices from {books.length > 0 ? listFormat.format(books.map((b) => b.name)) : 'each sportsbook'}, pushed to this page as they
          move. Best Price compares eligible prices only; hatched prices are shown for reference but not used.{' '}
          <span className="text-muted">est.</span> and <span className="text-muted">by line</span> mark picks made across different
          lines.
        </p>
        {regions.length > 0 && (
          <p className="mt-2">
            Lines shown are each book&apos;s <span className="text-muted">{regions.join(' / ')}</span> lines; other jurisdictions
            (e.g. Ontario) may price the same games differently.
          </p>
        )}
      </footer>
    </div>
  );
}
