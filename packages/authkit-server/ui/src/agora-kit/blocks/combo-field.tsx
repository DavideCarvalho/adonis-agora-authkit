import * as React from 'react';
import { normalizeSearchText } from '../shell/console-search';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from '../ui/combobox';

/**
 * Select and multiselect with autocomplete, for fields whose values come from a known list
 * (tenants, apps, queues, statuses, roles…). Values are plain strings; `options` gives each one
 * a label and an optional hint. Filtering is accent- and case-insensitive over label, value and
 * hint. With `creatable`, a value that is not in the list can still be typed and picked (for lists
 * that may be incomplete, e.g. the last N distinct names). For server-side search, pass
 * `onQueryChange` and feed the matches back through `options` (set `loading` meanwhile).
 */
export interface ComboOption {
  value: string;
  label?: string | undefined;
  hint?: string | undefined;
  disabled?: boolean | undefined;
}

interface ComboCommon {
  options: readonly (ComboOption | string)[];
  placeholder?: string | undefined;
  /** Shown when nothing matches. */
  emptyText?: string | undefined;
  /** Shown instead of `emptyText` while options load. */
  loading?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Accept values outside `options`: the typed text is offered as its own item. */
  creatable?: boolean | undefined;
  /** Label of the typed-text item; receives the text. */
  createLabel?: ((text: string) => string) | undefined;
  /**
   * `options` are already the server's matches for the typed text: show them all instead of
   * filtering them again here (a server may match on fields the label doesn't show).
   */
  serverFiltered?: boolean | undefined;
  /** Called with the typed text, for server-side search. */
  onQueryChange?: ((query: string) => void) | undefined;
  id?: string | undefined;
  name?: string | undefined;
  className?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
}

export interface ComboSelectProps extends ComboCommon {
  value: string | null;
  onValueChange: (value: string | null) => void;
  /** Show a clear button when a value is set. Default true. */
  clearable?: boolean | undefined;
}

export interface ComboMultiSelectProps extends ComboCommon {
  value: readonly string[];
  onValueChange: (value: string[]) => void;
}

/** Closing reasons that mean the user left the field (not Escape, not a pick). */
const LEAVE_REASONS = new Set(['outside-press', 'focus-out']);

const defaultCreateLabel = (text: string) => `Use “${text}”`;

/** Normalizes `options` and indexes them by value. */
function useOptionIndex(options: ComboCommon['options']) {
  return React.useMemo(() => {
    const list: ComboOption[] = options.map((o) => (typeof o === 'string' ? { value: o } : o));
    const byValue = new Map(list.map((o) => [o.value, o]));
    return { list, byValue };
  }, [options]);
}

/** True when every word of `query` appears in the option's label, value or hint. */
export function comboMatches(option: ComboOption, query: string): boolean {
  const q = normalizeSearchText(query);
  if (q === '') return true;
  const haystack = normalizeSearchText(
    [option.label ?? '', option.value, option.hint ?? ''].join(' '),
  );
  return q.split(' ').every((word) => haystack.includes(word));
}

/**
 * The item values to show: the matching options, plus the typed text when `creatable` and it is
 * not already an option. `selected` values missing from `options` stay pickable (so a value set
 * from the URL still renders and can be removed).
 */
export function comboItems(
  list: readonly ComboOption[],
  query: string,
  {
    creatable = false,
    selected = [],
    serverFiltered = false,
  }: {
    creatable?: boolean | undefined;
    selected?: readonly string[] | undefined;
    /** `list` already holds the server's matches for `query`: show them all, unfiltered. */
    serverFiltered?: boolean | undefined;
  } = {},
): string[] {
  const known = new Set(list.map((o) => o.value));
  const extra = selected.filter((v) => !known.has(v)).map((value) => ({ value }));
  const items = [...list, ...extra]
    .filter((o) => (serverFiltered && known.has(o.value)) || comboMatches(o, query))
    .map((o) => o.value);
  const typed = query.trim();
  if (creatable && typed !== '' && !known.has(typed) && !items.includes(typed)) items.push(typed);
  return items;
}

/**
 * Every pickable value, for Base UI's `items` (the matches go in `filteredItems`). Its identity
 * must only change when the set changes: Base UI resets the input to the selected label whenever
 * `items` changes identity, which would wipe what the user is typing. The typed-text item of
 * `creatable` lives only in `filteredItems` for the same reason.
 */
function useAllItems(list: readonly ComboOption[], selected: readonly string[]): string[] {
  const known = comboItems(list, '', { selected });
  const key = known.join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` captures the content of `known`
  return React.useMemo(() => known, [key]);
}

/**
 * The typed text, controlled here rather than by Base UI: it rewrites the input to the selected
 * label (reason `none`) whenever `items` changes, which would wipe the query each time
 * server-side results arrive. Every other reason (typing, clearing, picking) is kept.
 *
 * `dirty` is true only between the user typing and the next programmatic write (a pick, Escape,
 * a value from outside). It lives in a ref, written synchronously, so "commit the typed text on
 * leave" never depends on render timing: Escape then blur, or blur then close, commit at most once.
 */
function useComboQuery(onQueryChange?: (q: string) => void) {
  const [query, setQueryState] = React.useState('');
  const queryRef = React.useRef('');
  const dirtyRef = React.useRef(false);
  const setQuery = React.useCallback((text: string) => {
    queryRef.current = text;
    dirtyRef.current = false;
    setQueryState(text);
  }, []);
  const onInputValueChange = React.useCallback(
    (text: string, details: { reason: string }) => {
      if (details.reason === 'none') return;
      queryRef.current = text;
      dirtyRef.current = details.reason === 'input-change';
      setQueryState(text);
      onQueryChange?.(text);
    },
    [onQueryChange],
  );
  /** The typed text if the user typed since the last programmatic write; marks it consumed. */
  const takeTyped = React.useCallback((): string | undefined => {
    if (!dirtyRef.current) return undefined;
    dirtyRef.current = false;
    return queryRef.current;
  }, []);
  const isTyping = React.useCallback(() => dirtyRef.current, []);
  return { query, setQuery, onInputValueChange, takeTyped, isTyping };
}

function ComboItemBody({
  value,
  option,
  created,
  createLabel,
}: {
  value: string;
  option: ComboOption | undefined;
  created: boolean;
  createLabel: (text: string) => string;
}) {
  if (created) return <span className="truncate italic">{createLabel(value)}</span>;
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="truncate">{option?.label ?? value}</span>
      {option?.hint ? (
        <span className="ml-auto shrink-0 truncate font-mono text-xs text-muted-foreground">
          {option.hint}
        </span>
      ) : null}
    </span>
  );
}

function ComboListBody({
  byValue,
  creatable,
  selected,
  query,
  loading,
  emptyText,
  createLabel,
}: {
  byValue: Map<string, ComboOption>;
  creatable: boolean;
  /** Selected values: never rendered as the typed-text item. */
  selected: ReadonlySet<string>;
  query: string;
  loading?: boolean | undefined;
  emptyText: string;
  createLabel: (text: string) => string;
}) {
  return (
    <>
      <ComboboxEmpty>{loading ? 'Loading…' : emptyText}</ComboboxEmpty>
      <ComboboxList>
        {(value: string) => {
          const option = byValue.get(value);
          // Only the typed-text item reads "Use …"; a selected value missing from `options`
          // shows as itself.
          const created =
            creatable && option === undefined && value === query.trim() && !selected.has(value);
          return (
            <ComboboxItem key={value} value={value} disabled={option?.disabled}>
              <ComboItemBody
                value={value}
                option={option}
                created={created}
                createLabel={createLabel}
              />
            </ComboboxItem>
          );
        }}
      </ComboboxList>
    </>
  );
}

/** Single-value select with autocomplete. */
export function ComboSelect({
  options,
  value,
  onValueChange,
  placeholder = 'Select…',
  emptyText = 'No matches',
  loading,
  disabled,
  creatable,
  createLabel = defaultCreateLabel,
  onQueryChange,
  serverFiltered,
  clearable = true,
  id,
  name,
  className,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
}: ComboSelectProps) {
  const { list, byValue } = useOptionIndex(options);
  const { query, setQuery, onInputValueChange, takeTyped, isTyping } = useComboQuery(onQueryChange);
  const labelOf = React.useCallback((v: string) => byValue.get(v)?.label ?? v, [byValue]);
  // The input shows the selected label: on mount, when the value changes from outside (a URL,
  // a reset), when its label arrives with late options, and when the popup closes unpicked.
  const selectedLabel = value === null ? '' : labelOf(value);
  // A label that only changed (late options) never overwrites what the user is typing; a new
  // value always wins.
  const lastValue = React.useRef(value);
  React.useEffect(() => {
    const valueChanged = lastValue.current !== value;
    lastValue.current = value;
    if (!valueChanged && isTyping()) return;
    setQuery(selectedLabel);
  }, [value, selectedLabel, setQuery, isTyping]);
  // With `creatable`, leaving the field keeps what was typed, like the text input it replaces:
  // the text becomes the value (empty text clears it when `clearable`).
  const commitTyped = () => {
    if (!creatable) return false;
    const pending = takeTyped();
    if (pending === undefined) return false;
    const typed = pending.trim();
    if (typed === selectedLabel.trim()) return false;
    if (typed === '') {
      if (!clearable) return false;
      onValueChange(null);
      return true;
    }
    // Same matching as the filter (accents, case, spacing), so "e-mails" picks the "E-mails"
    // option instead of creating a near-duplicate value.
    const norm = normalizeSearchText(typed);
    const known =
      list.find((o) => o.value === typed) ??
      list.find(
        (o) => normalizeSearchText(o.value) === norm || normalizeSearchText(o.label ?? '') === norm,
      );
    onValueChange(known ? known.value : typed);
    return true;
  };
  // Base UI fills the input with the selected label; filtering by that text would hide every
  // other option on reopen, so a query equal to the current label counts as "no query".
  const effective = value !== null && query === labelOf(value) ? '' : query;
  const selectedList = value === null ? [] : [value];
  const items = comboItems(list, effective, {
    creatable,
    selected: selectedList,
    serverFiltered,
  });
  const all = useAllItems(list, selectedList);

  return (
    <Combobox<string>
      items={all}
      filteredItems={items}
      value={value}
      onValueChange={(next) => {
        onValueChange(next ?? null);
        setQuery(next ? labelOf(next) : '');
      }}
      inputValue={query}
      onInputValueChange={onInputValueChange}
      itemToStringLabel={labelOf}
      onOpenChange={(open, details) => {
        if (open) return;
        if (LEAVE_REASONS.has(details.reason) && commitTyped()) return;
        setQuery(selectedLabel);
      }}
      disabled={disabled}
      name={name}
      autoHighlight
    >
      <ComboboxInput
        onBlur={() => {
          commitTyped();
        }}
        id={id}
        className={className}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        showClear={clearable && value !== null && !disabled}
        showTrigger
      />
      <ComboboxContent>
        <ComboListBody
          byValue={byValue}
          creatable={creatable === true}
          selected={new Set(selectedList)}
          query={effective}
          loading={loading}
          emptyText={emptyText}
          createLabel={createLabel}
        />
      </ComboboxContent>
    </Combobox>
  );
}

/** Multi-value select with autocomplete; the picked values show as removable chips. */
export function ComboMultiSelect({
  options,
  value,
  onValueChange,
  placeholder = 'Select…',
  emptyText = 'No matches',
  loading,
  disabled,
  creatable,
  createLabel = defaultCreateLabel,
  onQueryChange,
  serverFiltered,
  id,
  name,
  className,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
}: ComboMultiSelectProps) {
  const anchor = useComboboxAnchor();
  const { list, byValue } = useOptionIndex(options);
  const { query, setQuery, onInputValueChange } = useComboQuery(onQueryChange);
  const labelOf = React.useCallback((v: string) => byValue.get(v)?.label ?? v, [byValue]);
  const items = comboItems(list, query, {
    creatable,
    selected: value,
    serverFiltered,
  });
  const all = useAllItems(list, value);
  // Keyed by content: a caller passing a fresh array each render must not change identity.
  const selectedKey = value.join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `selectedKey` captures `value`
  const selected = React.useMemo(() => [...value], [selectedKey]);

  return (
    <Combobox<string, true>
      multiple
      items={all}
      filteredItems={items}
      value={selected}
      onValueChange={(next) => {
        onValueChange([...next]);
        setQuery('');
      }}
      inputValue={query}
      onInputValueChange={onInputValueChange}
      itemToStringLabel={labelOf}
      disabled={disabled}
      name={name}
      autoHighlight
    >
      <ComboboxChips ref={anchor} className={className} data-disabled={disabled || undefined}>
        <ComboboxValue>
          {(picked: string[]) =>
            picked.map((v) => (
              <ComboboxChip key={v} aria-label={labelOf(v)}>
                {labelOf(v)}
              </ComboboxChip>
            ))
          }
        </ComboboxValue>
        <ComboboxChipsInput
          id={id}
          placeholder={value.length === 0 ? placeholder : undefined}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboListBody
          byValue={byValue}
          creatable={creatable === true}
          selected={new Set(value)}
          query={query}
          loading={loading}
          emptyText={emptyText}
          createLabel={createLabel}
        />
      </ComboboxContent>
    </Combobox>
  );
}
