import { useRef, type KeyboardEvent } from 'react';
import type { WireBookMeta } from '@shared/wire';
import type { View } from '../lib/view';

interface ViewToggleProps {
  books: readonly WireBookMeta[];
  view: View;
  onChange: (view: View) => void;
}

/** "Best Price" plus one tab per book in the snapshot's registry, so a third book needs no UI change. */
export function ViewToggle({ books, view, onChange }: ViewToggleProps) {
  const options: { id: View; label: string }[] = [{ id: 'best', label: 'Best Price' }, ...books.map((b) => ({ id: b.id, label: b.name }))];
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const selected = Math.max(
    0,
    options.findIndex((o) => o.id === view),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    let next: number;
    if (e.key === 'ArrowRight') next = (selected + 1) % options.length;
    else if (e.key === 'ArrowLeft') next = (selected - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    else return;
    e.preventDefault();
    const target = options[next];
    if (target === undefined) return;
    onChange(target.id);
    buttons.current.get(target.id)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Board view"
      onKeyDown={onKeyDown}
      className="flex max-w-full self-start overflow-x-auto rounded-lg border border-white/10 p-0.5"
    >
      {options.map((o, i) => {
        const active = o.id === view;
        return (
          <button
            key={o.id}
            ref={(el) => {
              if (el) buttons.current.set(o.id, el);
              else buttons.current.delete(o.id);
            }}
            id={`view-tab-${o.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls="board"
            tabIndex={i === selected ? 0 : -1}
            onClick={() => onChange(o.id)}
            className={`shrink-0 rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none ${
              active ? 'bg-navy-700 text-ink' : 'text-muted hover:bg-white/5 hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
