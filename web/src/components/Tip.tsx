import { useId, type ReactNode } from 'react';

export type TipAlign = 'start' | 'center' | 'end';

const ALIGN: Record<TipAlign, string> = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
};

interface TipProps {
  tip: ReactNode;
  children: ReactNode;
  /** Edge the bubble lines up with; the right-most column opens leftwards so it stays on screen. */
  align?: TipAlign;
  className?: string;
  triggerClassName?: string;
}

/**
 * A tooltip that opens on hover and on focus, so it also works on touch (a tap focuses the trigger)
 * and from the keyboard. The text is tied to the trigger with `aria-describedby`.
 */
export function Tip({ tip, children, align = 'center', className = '', triggerClassName = '' }: TipProps) {
  const id = useId();
  return (
    <span className={`group/tip relative inline-flex ${className}`}>
      <span
        tabIndex={0}
        aria-describedby={id}
        className={`cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${triggerClassName}`}
      >
        {children}
      </span>
      <span
        role="tooltip"
        id={id}
        className={`pointer-events-none invisible absolute top-full z-40 mt-1.5 w-max max-w-64 rounded-md border border-white/10 bg-navy-700 px-2.5 py-1.5 text-left text-xs leading-snug font-normal tracking-normal whitespace-normal normal-case text-ink opacity-0 shadow-lg shadow-black/30 transition-opacity duration-150 group-focus-within/tip:visible group-focus-within/tip:opacity-100 group-hover/tip:visible group-hover/tip:opacity-100 ${ALIGN[align]}`}
      >
        {tip}
      </span>
    </span>
  );
}
