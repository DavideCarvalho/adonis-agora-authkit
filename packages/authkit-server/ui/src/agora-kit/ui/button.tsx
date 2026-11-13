// Vendored from shadcn/ui, registry style "base-vega" (Base UI flavour), item "button".
// Fetched 2026-11-13 from https://ui.shadcn.com/r/styles/base-vega/button.json. Local edits are marked "agora:".
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // agora: authkit's primary — solid accent, lighter on hover.
        default: 'bg-primary text-primary-foreground hover:bg-brand-hover',
        // agora: authkit's `.btn` — raised surface, hairline border, muted label.
        outline:
          'border-border bg-panel-2 text-dim hover:border-line-strong hover:bg-panel-3 hover:text-foreground aria-expanded:bg-panel-3 aria-expanded:text-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        // agora: authkit's `.btn-ghost`.
        ghost:
          'text-dim hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40',
        link: 'text-primary underline-offset-4 hover:underline',
        // agora: semantic tints (translucent fill + border, bright label) used across the consoles.
        brand: 'border-brand-border bg-brand-soft text-brand hover:bg-brand/20',
        warn: 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20',
        info: 'border-info/30 bg-info/10 text-info hover:bg-info/20',
        alt: 'border-violet/30 bg-violet/10 text-violet hover:bg-violet/20',
        chip: 'border-border bg-panel-2 text-dim hover:border-line-strong hover:text-foreground aria-pressed:border-brand-border aria-pressed:bg-brand-soft aria-pressed:text-foreground',
      },
      size: {
        // agora: authkit's 32px button with a 12px label.
        default:
          'h-8 gap-1.5 px-3 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        // agora: authkit's `.btn-sm` (26px, 11px label).
        sm: "h-[26px] gap-1 rounded-[6px] px-2.5 text-[11px] [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        icon: 'size-9',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          'size-8 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-md',
        'icon-lg': 'size-10',
        // agora: dense sizes for inline chips in data rows and toolbars.
        micro: "h-5 gap-1 rounded-sm px-1.5 text-[10px] [&_svg:not([class*='size-'])]:size-3",
        chip: "h-7 gap-1.5 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
