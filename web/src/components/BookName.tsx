import type { WireBookMeta } from '@shared/wire';

/**
 * A sportsbook's color dot and name: the game page's row labels. `compact` is smaller and shows the
 * book's short code on phones, for narrow columns and inline lists.
 */
export function BookName({ meta, compact = false }: { meta: WireBookMeta; compact?: boolean }) {
  return (
    <span className={`flex min-w-0 items-center font-semibold ${compact ? 'gap-1.5 text-xs text-muted' : 'gap-2 text-sm text-ink'}`}>
      <span aria-hidden="true" className={`${compact ? 'size-1.5' : 'size-2'} shrink-0 rounded-full`} style={{ backgroundColor: meta.color }} />
      {compact ? (
        <>
          <abbr title={meta.name} className="no-underline sm:hidden">
            {meta.short}
          </abbr>
          <span className="hidden truncate sm:inline">{meta.name}</span>
        </>
      ) : (
        <span title={meta.name} className="truncate">
          {meta.name}
        </span>
      )}
    </span>
  );
}
