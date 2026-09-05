import { SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button as SharedButton } from '@/components/ui/button';

// The top bar's filter affordance. Icon-only with a count badge so it occupies
// the same width whether or not filters are active — the search field next to
// it must not shift when you add a condition.
export function GridFilterButton({ count = 0, onClick, title = 'Filters & fields (⌘F)' }) {
    return (
        <SharedButton variant="unstyled"
            type="button"
            className={cn('sk-gridicon', count > 0 && 'is-on')}
            onClick={onClick}
            title={title}
            aria-label={title}
        >
            <SlidersHorizontal size={16} />
            {count > 0 && <span className="sk-gridicon__count">{count}</span>}
        </SharedButton>
    );
}

export default GridFilterButton;
