import React, { useState } from 'react';

/** Linha de campo com label + hint à esquerda e controle à direita. */
export function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: 'var(--faint)' }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** Switch on/off acessível (role="switch"). */
export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        width: 36,
        height: 20,
        borderRadius: 999,
        border: 'none',
        cursor: 'pointer',
        background: checked ? 'var(--accent)' : 'var(--line)',
        transition: 'background 0.15s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.15s',
        }}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {values.map((v) => (
          <span
            key={v}
            className="badge badge-muted"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            {v}
            {!locked.includes(v) && (
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'inherit',
                  padding: 0,
                  lineHeight: 1,
                }}
                aria-label={`Remove ${v}`}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder ?? 'add…'}
          style={{ maxWidth: 160 }}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
