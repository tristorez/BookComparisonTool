import { useRef, type KeyboardEvent } from 'react';

export interface TabOption<T extends string> {
  id: T;
  label: string;
}

interface TabListProps<T extends string> {
  options: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The tablist's accessible name. */
  label: string;
  /** Each tab's id is `<idPrefix>-<option id>`, which the panel names in `aria-labelledby`. */
  idPrefix: string;
  /** The id of the panel the tabs control. */
  controls: string;
  /** Smaller tabs, for a section of the page rather than its header. */
  compact?: boolean;
}

/**
 * A row of tabs (the WAI-ARIA tabs pattern): one tab stop, the arrow keys and Home/End move between tabs,
 * and selection follows focus. The board's view toggle and the game page's prop groups are both one.
 */
export function TabList<T extends string>({ options, value, onChange, label, idPrefix, controls, compact = false }: TabListProps<T>) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const selected = Math.max(
    0,
    options.findIndex((o) => o.id === value),
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
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex max-w-full self-start overflow-x-auto rounded-lg border border-white/10 p-0.5">
      {options.map((o, i) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            ref={(el) => {
              if (el) buttons.current.set(o.id, el);
              else buttons.current.delete(o.id);
            }}
            id={`${idPrefix}-${o.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={controls}
            tabIndex={i === selected ? 0 : -1}
            onClick={() => onChange(o.id)}
            // Selected: the accent pill (8.6:1 against the header; a hovered tab stays a faint grey). In
            // Windows high contrast, which repaints backgrounds, an underline marks it instead.
            className={`shrink-0 rounded-md py-1 font-medium whitespace-nowrap transition-colors focus-ring forced-colors:aria-selected:underline ${
              compact ? 'px-2.5 text-xs' : 'px-3 text-sm'
            } ${active ? 'bg-accent text-navy-950' : 'text-muted hover:bg-white/5 hover:text-ink'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
