/**
 * Created/updated dates as every console list and detail shows them: a short date, the full
 * timestamp on hover, and `—` when the value is unknown (rows older than the field).
 */

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `20 Nov 2026` in the viewer's locale, or `—`. */
export function shortDate(value: string | null | undefined): string {
  const date = parse(value);
  return date
    ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';
}

/** A short date with the full timestamp in its `title`. */
export function DateText({ value }: { value: string | null | undefined }) {
  const date = parse(value);
  if (!date) return <span className="text-faint">—</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()} className="whitespace-nowrap">
      {shortDate(value)}
    </time>
  );
}

/** "Created … · Updated …" for a detail header. */
export function Timestamps({
  createdAt,
  updatedAt,
}: {
  createdAt: string | null | undefined;
  updatedAt: string | null | undefined;
}) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint">
      <div className="flex gap-1">
        <dt>Created</dt>
        <dd className="text-dim">
          <DateText value={createdAt} />
        </dd>
      </div>
      <div className="flex gap-1">
        <dt>Updated</dt>
        <dd className="text-dim">
          <DateText value={updatedAt} />
        </dd>
      </div>
    </dl>
  );
}
