import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { buttonVariants } from './buttonVariants';

// forwardRef is load-bearing, not ceremony: every Radix trigger used as
// `<PopoverTrigger asChild><Button/></PopoverTrigger>` hands the button a ref
// and uses that element as the popper's anchor. Without it React drops the ref
// ("Function components cannot be given refs … Primitive.button.SlotClone"),
// floating-ui never gets a reference element, and the panel is left parked at
// its pre-position `translate(0, -200%)` — open, focusable and completely
// off-screen. That is why Sort/Columns/Views/Filter looked like dead buttons.
const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      data-slot="button"
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  );
});
Button.displayName = 'Button';

export { Button };
