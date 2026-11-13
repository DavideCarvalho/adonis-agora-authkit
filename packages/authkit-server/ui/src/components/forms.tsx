import { type ReactNode, useState } from 'react';
import { XIcon } from '../agora-kit/icons';
import { cn } from '../agora-kit/lib/utils';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { TextInput } from './primitives';

/** Linha de campo com label + hint à esquerda e controle à direita. */
export function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex-1">
        <div className="text-xs font-medium text-fg">{label}</div>
        {hint && <div className="text-[11px] text-faint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** Switch on/off acessível (role="switch"). */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-[38px] shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        checked ? 'border-primary bg-primary' : 'border-line-strong bg-panel-3',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 size-3.5 rounded-full transition-transform',
          checked ? 'translate-x-[18px] bg-white' : 'bg-faint',
        )}
      />
    </button>
  );
}

/** Editor de chips: lista de strings com remover + adicionar. */
export function ChipsEditor({
  values,
  onChange,
  locked = [],
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  locked?: string[];
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const v = draft.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setDraft('');
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <Badge key={v} variant="neutral">
            {v}
            {!locked.includes(v) && (
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="leading-none text-inherit hover:text-fg [&_svg]:size-2.5"
                aria-label={`Remove ${v}`}
              >
                <XIcon />
              </button>
            )}
          </Badge>
        ))}
      </div>
      <div className="flex gap-1.5">
        <TextInput
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder ?? 'add…'}
          className="max-w-40"
        />
        <Button type="button" variant="ghost" size="sm" className="h-[34px]" onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}
