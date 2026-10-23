import type { WireBookMeta } from '@shared/wire';
import type { View } from '../lib/view';
import { TabList, type TabOption } from './TabList';

interface ViewToggleProps {
  books: readonly WireBookMeta[];
  view: View;
  onChange: (view: View) => void;
}

/** "Best Price" plus one tab per book in the snapshot's registry, so a third book needs no UI change. */
export function ViewToggle({ books, view, onChange }: ViewToggleProps) {
  const options: TabOption<View>[] = [{ id: 'best', label: 'Best Price' }, ...books.map((b) => ({ id: b.id, label: b.name }))];
  return <TabList options={options} value={view} onChange={onChange} label="Board view" idPrefix="view-tab" controls="board" />;
}
