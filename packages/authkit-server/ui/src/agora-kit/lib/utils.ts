// shadcn/ui's `lib/utils` (the `cn` helper every vendored component imports).
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** `clsx` for conditionals + `tailwind-merge` so a caller's `className` wins over a variant default. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
