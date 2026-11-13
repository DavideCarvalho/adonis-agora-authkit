// Vendored from shadcn/ui, registry style "base-vega" (Base UI flavour), item "badge".
// Fetched 2026-11-13 from https://ui.shadcn.com/r/styles/base-vega/badge.json. Local edits are marked "agora:".
import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

// agora: authkit's `.badge` — 18px mono pill, soft fill + 22% border.
const badgeVariants = cva(
  'group/badge inline-flex h-[18px] w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 font-mono text-[10px] font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        destructive: 'border-bad/22 bg-bad/12 text-bad',
        outline: 'border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground',
        ghost: 'hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50',
        link: 'text-primary underline-offset-4 hover:underline',
        // agora: semantic tones (status, provenance, axes), translucent like the tinted buttons.
        brand: 'border-brand-border bg-brand-soft text-brand',
        good: 'border-good/22 bg-good/12 text-good',
        warn: 'border-warn/22 bg-warn/12 text-warn',
        info: 'border-info/22 bg-info/12 text-info',
        violet: 'border-violet/22 bg-violet/12 text-violet',
        teal: 'border-teal/22 bg-teal/12 text-teal',
        neutral: 'border-border bg-hover text-dim',
        bare: 'h-auto rounded-none border-transparent px-0 uppercase tracking-wider',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: 'badge',
      variant,
    },
  });
}

export { Badge, badgeVariants };
