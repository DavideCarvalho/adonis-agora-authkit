import { useId, useMemo, useState } from 'react';
import { XIcon } from '../agora-kit/icons';
import { Badge } from '../agora-kit/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../agora-kit/ui/command';

/** Same rule as the server (`CAPABILITY_PATTERN`). */
const CAPABILITY = /^[A-Za-z0-9*][A-Za-z0-9._:*/-]{0,127}$/;

export interface CapabilityGroup {
  /** Heading, e.g. the resource indicator `urn:agora:payments`. */
  label: string;
  capabilities: string[];
}

/**
 * Multi-select of capabilities: chips for the chosen ones, a search over the ones the
 * resources declare, and any other value typed in (patterns such as `crypto:decrypt:subject_*`
 * are not in a list). Enter adds what is typed.
 */
export function CapabilityPicker({
  id,
  value,
  onChange,
  groups,
  placeholder = 'Search or type a capability…',
  pattern = CAPABILITY,
  patternHint = 'Letters, digits, ".", "_", ":", "*", "/" and "-" only.',
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  groups: CapabilityGroup[];
  placeholder?: string;
  /** What a typed value must match. Default: the capability rule. */
  pattern?: RegExp;
  patternHint?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const listId = useId();
  const typed = query.trim();
  const known = useMemo(() => new Set(groups.flatMap((g) => g.capabilities)), [groups]);
  const canAddTyped = typed !== '' && !value.includes(typed) && !known.has(typed);
  const typedValid = pattern.test(typed);

  function add(cap: string) {
    if (!cap || value.includes(cap)) return;
    onChange([...value, cap]);
    setQuery('');
  }

  function remove(cap: string) {
    onChange(value.filter((c) => c !== cap));
  }

  const visibleGroups = groups
    .map((g) => ({ ...g, capabilities: g.capabilities.filter((c) => !value.includes(c)) }))
    .filter((g) => g.capabilities.length > 0);

  return (
    // Runs after cmdk's own handler: an Enter cmdk did not take (no highlighted item) adds
    // what is typed, and Enter never submits the surrounding form.
    <div
      className="flex flex-col gap-1.5"
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        const handled = e.defaultPrevented;
        e.preventDefault();
        if (!handled && typed !== '' && typedValid) add(typed);
      }}
    >
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="capability-chips">
          {value.map((cap) => (
            <Badge key={cap} variant="neutral" className="font-mono">
              {cap}
              <button
                type="button"
                onClick={() => remove(cap)}
                className="leading-none text-inherit hover:text-fg [&_svg]:size-2.5"
                aria-label={`Remove ${cap}`}
              >
                <XIcon />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Command
        className="rounded-lg! border border-line bg-panel-2 p-0"
        // Typed values are kept, so cmdk only filters the suggestions.
        loop
      >
        <CommandInput
          id={id}
          value={query}
          onValueChange={setQuery}
          placeholder={placeholder}
          aria-controls={listId}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Backspace' && query === '' && value.length > 0) {
              remove(value[value.length - 1]!);
            }
          }}
          className="font-mono"
        />
        {open && (
          <CommandList id={listId} className="max-h-56">
            {canAddTyped && typedValid && (
              <CommandGroup>
                <CommandItem
                  value={`add:${typed}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onSelect={() => add(typed)}
                >
                  Add <span className="font-mono">{typed}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {canAddTyped && !typedValid && (
              <div className="px-3 py-2 text-xs text-danger">{patternHint}</div>
            )}
            {visibleGroups.map((g) => (
              <CommandGroup key={g.label} heading={g.label}>
                {g.capabilities.map((cap) => (
                  <CommandItem
                    key={cap}
                    value={cap}
                    onMouseDown={(e) => e.preventDefault()}
                    onSelect={() => add(cap)}
                    className="font-mono"
                  >
                    {cap}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <CommandEmpty className="py-3 text-xs text-faint">
              {visibleGroups.length === 0
                ? 'No declared capabilities. Type one and press Enter.'
                : 'No match. Press Enter to add what you typed.'}
            </CommandEmpty>
          </CommandList>
        )}
      </Command>
    </div>
  );
}
