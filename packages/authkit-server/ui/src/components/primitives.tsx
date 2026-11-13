/**
 * The admin console's form and layout pieces, built on the Agora kit (Tailwind + kit tokens +
 * vendored shadcn). Page code composes these and the kit's blocks; no hand-written CSS classes.
 */
import type { ComponentProps, ReactNode } from 'react';
import { SearchIcon } from '../agora-kit/icons';
import { cn } from '../agora-kit/lib/utils';
import { Input } from '../agora-kit/ui/input';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../agora-kit/ui/table';
import { Textarea } from '../agora-kit/ui/textarea';

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** authkit's `.input` look on the shadcn input: 34px, raised fill, accent focus ring. */
export const inputClass =
  'h-[34px] rounded-[8px] border-border bg-panel-2 px-3 text-[13px] text-fg shadow-none placeholder:text-faint focus-visible:border-brand-border focus-visible:ring-3 focus-visible:ring-brand/15 md:text-[13px] dark:bg-panel-2';

export function TextInput({
  mono,
  className,
  ...props
}: ComponentProps<typeof Input> & { mono?: boolean }) {
  return (
    <Input className={cn(inputClass, mono && 'mono text-xs md:text-xs', className)} {...props} />
  );
}

export function TextArea({
  mono,
  className,
  ...props
}: ComponentProps<typeof Textarea> & { mono?: boolean }) {
  return (
    <Textarea
      className={cn(
        inputClass,
        'h-auto min-h-20 py-2.5',
        mono && 'mono text-xs md:text-xs',
        className,
      )}
      {...props}
    />
  );
}

/** A native `<select>` styled like the inputs (keyboard + mobile pickers for free). */
export function SelectInput({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        inputClass,
        'w-full min-w-0 border outline-none [&>option]:bg-panel-2 [&>option]:text-fg',
        className,
      )}
      {...props}
    />
  );
}

/** A search field with the magnifier inside. */
export function SearchInput({
  className,
  wrapperClassName,
  ...props
}: ComponentProps<typeof Input> & { wrapperClassName?: string }) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
      <Input className={cn(inputClass, 'pl-8', className)} {...props} />
    </div>
  );
}

/** A labelled form field: label, control, optional hint. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3.5', className)}>
      <label
        htmlFor={htmlFor}
        className="mb-[5px] block text-[11px] font-medium tracking-[0.02em] text-dim"
      >
        {label}
      </label>
      {children}
      {hint && <div className="mt-1 text-[10.5px] text-faint">{hint}</div>}
    </div>
  );
}

/** A checkbox with its label (the whole row is clickable). */
export function CheckboxRow({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'group flex cursor-pointer items-center gap-[9px] py-[7px]',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 cursor-pointer accent-(--agora-accent)"
      />
      <span className="text-[12.5px] text-dim group-hover:text-fg">{label}</span>
    </label>
  );
}

// ─── Text bits ───────────────────────────────────────────────────────────────

/** An inline mono chip (ids, IPs, URIs). */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'mono rounded-md border border-border bg-panel-2 px-2 py-0.5 text-[11.5px] break-all text-dim',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A one-time secret, shown once (client secret, token, recovery link). */
export function SecretBox({ label, children }: { label?: ReactNode; children: ReactNode }) {
  return (
    <div className="mono my-2 rounded-[8px] border border-brand-border bg-panel-2 px-4 py-3 text-xs break-all text-brand">
      {label && (
        <small className="mb-1.5 block font-sans text-[10.5px] tracking-[0.06em] text-faint uppercase">
          {label}
        </small>
      )}
      {children}
    </div>
  );
}

/** An inline error / notice box (not a region failure: those use the kit's RegionError). */
export function Notice({
  tone = 'bad',
  children,
  className,
}: {
  tone?: 'bad' | 'warn' | 'info';
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    bad: 'border-bad/25 bg-bad/10 text-bad',
    warn: 'border-warn/25 bg-warn/10 text-warn',
    info: 'border-info/25 bg-info/10 text-info',
  } as const;
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cn('rounded-lg border px-4 py-3 text-xs', tones[tone], className)}
    >
      {children}
    </div>
  );
}

/**
 * A head-less card (authkit `.panel` with no header): a list table, an empty state or rows of
 * settings that need the card surface without a title. Titled content uses the kit's `Panel`.
 */
export function Surface({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'agora-surface agora-rise overflow-hidden rounded-lg border border-border',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** A thin rule between blocks. */
export function Separator({ className }: { className?: string }) {
  return <div className={cn('my-4 h-px bg-border', className)} />;
}

/** A small CAPS heading inside a drawer or a form. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'mb-2 text-[10px] font-semibold tracking-[0.12em] text-faint uppercase',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ─── Settings rows ───────────────────────────────────────────────────────────

export function SettingsSection({
  title,
  description,
  icon,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="mb-1 flex items-center gap-2.5 border-b border-border pb-2.5">
        {icon}
        <div>
          <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
          {description && <p className="mt-px text-[11px] text-faint">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export function SettingsRow({
  name,
  badge,
  description,
  children,
}: {
  name: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start justify-between gap-3 border-b border-border py-3 last:border-0 sm:flex-row sm:gap-5">
      <div className="min-w-0 flex-1">
        <div className="mono text-xs font-medium text-fg">
          {name}
          {badge && (
            <span className="mono ml-1.5 rounded-sm border border-border bg-hover px-1.5 py-px text-[9.5px] text-faint">
              {badge}
            </span>
          )}
        </div>
        {description && <div className="mt-0.5 text-[11px] text-faint">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

// ─── Tables ──────────────────────────────────────────────────────────────────

/**
 * authkit's list table on the shadcn `Table`: CAPS faint header, 12.5px muted cells, hover rows.
 * Pass the header cells as `head` and `<Row>`s as children.
 */
export function AdminTable({
  head,
  children,
  label,
  className,
}: {
  head: ReactNode[];
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <Table className={cn('text-[12.5px]', className)} aria-label={label}>
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          {head.map((h, i) => (
            <TableHead
              // biome-ignore lint/suspicious/noArrayIndexKey: static header, never reordered
              key={i}
              className="h-auto px-3 py-2 text-[10px] font-semibold tracking-[0.12em] text-faint uppercase"
            >
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

/** A table row; clickable (pointer, Enter) when `onClick` is given. */
export function Row({
  onClick,
  children,
  className,
}: {
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TableRow
      className={cn('border-border hover:bg-hover', onClick && 'cursor-pointer', className)}
      {...(onClick
        ? {
            onClick,
            tabIndex: 0,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) onClick();
            },
          }
        : {})}
    >
      {children}
    </TableRow>
  );
}

/** A body cell. `strong` renders the primary value in the text colour. */
export function Cell({
  children,
  className,
  strong,
  onClick,
  colSpan,
}: {
  children?: ReactNode;
  className?: string;
  strong?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  colSpan?: number;
}) {
  return (
    <td
      data-slot="table-cell"
      colSpan={colSpan}
      onClick={onClick}
      className={cn(
        'px-3 py-2.5 align-middle whitespace-nowrap text-dim',
        strong && 'font-medium text-fg',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** A bare `<tbody>`-less wrapper, for code that already renders kit table parts. */
export { TableBody };

// ─── Buttons / avatar ────────────────────────────────────────────────────────

/**
 * authkit's `.btn-danger`: an ordinary outline button that turns red on hover. Pass to a kit
 * `<Button variant="outline" className={dangerButtonClass}>`.
 */
export const dangerButtonClass =
  'hover:border-bad/40 hover:bg-bad/10 hover:text-bad aria-expanded:text-bad';

/** Initials in an accent-soft circle (user rows, member lists, drawer headers). */
export function InitialsAvatar({
  text,
  size = 28,
  className,
}: {
  text: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full border border-brand-border bg-brand-soft font-semibold text-brand',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.37)) }}
    >
      {text}
    </span>
  );
}
