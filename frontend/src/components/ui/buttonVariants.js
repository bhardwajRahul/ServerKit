import { cn } from '../../lib/utils.js';

// Map shadcn-style `variant` prop to our SCSS .btn-* classes.
// SCSS owns all geometry, color and hover state — see styles/components/_buttons.scss
const VARIANT_CLASS = {
  default:     'btn-primary',
  primary:     'btn-primary',
  destructive: 'btn-danger',
  danger:      'btn-danger',
  outline:     'btn-secondary',
  secondary:   'btn-soft',
  ghost:       'btn-ghost',
  link:        'btn-link',
};

const SIZE_CLASS = {
  default: '',
  md:      '',
  sm:      'btn-sm',
  lg:      'btn-lg',
  icon:    'btn-icon',
};

export function buttonVariants({ variant = 'default', size = 'default', className } = {}) {
  // Custom controls (table headers, palette items, shell actions) already have
  // component-owned SCSS. Reuse the ref/Slot/DOM contract without adding the
  // geometry and colors of a standalone .btn.
  if (variant === 'unstyled') return cn(className);
  return cn(
    'btn',
    VARIANT_CLASS[variant] ?? VARIANT_CLASS.default,
    SIZE_CLASS[size] ?? '',
    className,
  );
}
