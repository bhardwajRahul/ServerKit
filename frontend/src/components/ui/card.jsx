import { cn } from '@/lib/utils';

// The legacy skin keeps existing .card layouts intact while callers migrate
// to these shared components. Both skins are owned by the SCSS design system.
function Card({ className, variant, ...props }) {
  return <div data-slot="card" className={cn(variant === 'legacy' ? 'card' : 'ui-card', className)} {...props} />;
}

function CardHeader({ className, variant, ...props }) {
  const base = variant === 'legacy-row' ? 'card-header-row' : variant === 'legacy' ? 'card-header' : 'ui-card-header';
  return <div data-slot="card-header" className={cn(base, className)} {...props} />;
}

function CardTitle({ className, ...props }) {
  return <div data-slot="card-title" className={cn('ui-card-title', className)} {...props} />;
}

function CardDescription({ className, ...props }) {
  return <div data-slot="card-description" className={cn('ui-card-description', className)} {...props} />;
}

function CardContent({ className, variant, ...props }) {
  return <div data-slot="card-content" className={cn(variant === 'legacy' ? 'card-body' : 'ui-card-content', className)} {...props} />;
}

function CardFooter({ className, variant, ...props }) {
  return <div data-slot="card-footer" className={cn(variant === 'legacy' ? 'card-actions' : 'ui-card-footer', className)} {...props} />;
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
