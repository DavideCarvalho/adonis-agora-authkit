import {
  authkitKeys,
  useRemoveSettingMutationOptions,
  useSetSettingMutationOptions,
  useSettingsQueryOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { QueryBoundary } from '../components/QueryBoundary';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../lib/toast';

// ── Setting meta types ────────────────────────────────────────────────────────
//
// Cada seção = UMA setting real de `auth_settings` (settingKey ∈ SETTING_KEYS). O
// valor da setting é um OBJETO estruturado; cada campo (`field`) é um controle que
// lê/escreve `value[field]`. Salvar mescla os campos e faz PUT do objeto inteiro.

export interface SettingFieldMeta {
  /** Campo dentro do objeto da setting (ex.: `enabled`, `password`, `graceDays`). */
  field: string;
  label: string;
  description: string;
  type: 'boolean' | 'number' | 'string';
  defaultValue?: unknown;
}

export interface SettingSection {
  title: string;
  description: string;
  /** Key REAL da setting em `auth_settings` (SETTING_KEYS). Trava por config usa esta key. */
  settingKey: string;
  fields: SettingFieldMeta[];
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SettingsSectionSkeleton({ rowCount = 4 }: { rowCount?: number }) {
  return (
    <div
      style={{
        background: 'var(--bg2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
      }}
    >
      {Array.from({ length: rowCount }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '14px 16px',
            borderBottom: i < rowCount - 1 ? '1px solid var(--line)' : undefined,
            gap: 16,
          }}
        >
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Skeleton width="40%" height={13} />
            <Skeleton width="70%" height={11} />
          </div>
          <Skeleton width={44} height={24} borderRadius={12} />
        </div>
      ))}
    </div>
  );
}

// ── Lock badge (setting travada via defineConfig) ─────────────────────────────

function ConfigLockBadge() {
  return (
    <span
      className="settings-badge"
      title="Definido via defineConfig() — gerenciado no código, não editável aqui"
      style={{
        background: 'var(--accent-soft, rgba(99,102,241,0.12))',
        color: 'var(--accent, #6366f1)',
        borderColor: 'rgba(99,102,241,0.3)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <svg
        viewBox="0 0 16 16"
        width="10"
        height="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden
      >
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5 7V5a3 3 0 016 0v2" strokeLinecap="round" />
      </svg>
      definido via config
    </span>
  );
}

// ── SettingsSectionContainer ──────────────────────────────────────────────────

interface SettingsSectionContainerProps {
  section: SettingSection;
  onUnavailable: () => void;
}

type SettingObject = Record<string, unknown>;

export function SettingsSectionContainer({
  section,
  onUnavailable,
}: SettingsSectionContainerProps) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [checkedUnavailable, setCheckedUnavailable] = useState(false);
  const [local, setLocal] = useState<SettingObject | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    ...useSettingsQueryOptions(),
    retry: (failureCount, err: unknown) => {
      if (
        err &&
        typeof err === 'object' &&
        'status' in err &&
        (err as { status: number }).status === 404
      ) {
        if (!checkedUnavailable) {
          setCheckedUnavailable(true);
          onUnavailable();
        }
        return false;
      }
      return failureCount < 1;
    },
  });

  const settings = data?.data ?? [];
  // Keys travadas via defineConfig — config vence e a edição pela UI fica bloqueada.
  const lockedKeys: string[] = (data as { locked?: string[] } | undefined)?.locked ?? [];
  const locked = lockedKeys.includes(section.settingKey);
  const stored = settings.find((s) => s.key === section.settingKey);
  const isDefault = !stored;

  // Valor efetivo do objeto: local (editado) → stored → {} (defaults por campo).
  const storedObject: SettingObject =
    stored &&
    typeof stored.value === 'object' &&
    stored.value !== null &&
    !Array.isArray(stored.value)
      ? (stored.value as SettingObject)
      : {};
  const obj: SettingObject = local ?? storedObject;

  // Reinicia o estado local quando os dados carregam/mudam.
  useEffect(() => {
    setLocal(null);
    setDirty(false);
  }, [data]);

  const setSettingMutation = useMutation(useSetSettingMutationOptions());
  const removeSettingMutation = useMutation(useRemoveSettingMutationOptions());

  function fieldValue(f: SettingFieldMeta): unknown {
    return f.field in obj ? obj[f.field] : f.defaultValue;
  }

  function setField(f: SettingFieldMeta, value: unknown) {
    setLocal((prev) => ({ ...(prev ?? storedObject), [f.field]: value }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      // Mescla os defaults dos campos ausentes para gravar um objeto completo e explícito.
      const value: SettingObject = { ...obj };
      for (const f of section.fields) if (!(f.field in value)) value[f.field] = f.defaultValue;
      await setSettingMutation.mutateAsync({ key: section.settingKey, value });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.settings() });
      setDirty(false);
      toast.success(`Salvo: ${section.settingKey}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    try {
      await removeSettingMutation.mutateAsync(section.settingKey);
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.settings() });
      setLocal(null);
      setDirty(false);
      toast.success(`Voltou ao default: ${section.settingKey}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const isNotFound =
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: number }).status === 404;
  const displayError = error && !isNotFound ? error : undefined;

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <div>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {section.title}
            {locked && <ConfigLockBadge />}
            {!locked && !isDefault && <span className="settings-badge">custom</span>}
            {dirty && !locked && (
              <span
                className="settings-badge"
                style={{
                  background: 'var(--amber-soft)',
                  color: 'var(--amber)',
                  borderColor: 'rgba(255,180,84,0.3)',
                }}
              >
                unsaved
              </span>
            )}
          </h3>
          <p style={{ marginTop: 2 }}>{section.description}</p>
          {locked && (
            <p style={{ marginTop: 4, color: 'var(--accent, #6366f1)', fontSize: 12 }}>
              Travado no <code>defineConfig()</code> — o config tem prioridade sobre o runtime.
              Remova de lá para editar por aqui.
            </p>
          )}
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--faint)',
              fontFamily: 'var(--mono)',
              marginTop: 2,
            }}
          >
            {section.settingKey}
          </div>
        </div>
        {!locked && (
          <div className="settings-control" style={{ gap: 8 }}>
            {dirty && (
              <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
                {saving ? <span className="spinner sm" /> : 'Salvar'}
              </button>
            )}
            {!isDefault && !dirty && (
              <button
                className="btn btn-ghost btn-sm"
                disabled={saving}
                onClick={reset}
                title="Voltar ao default"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M2 8a6 6 0 016-6 6 6 0 014.24 1.76L14 5" strokeLinecap="round" />
                  <path d="M14 2v3h-3" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      <QueryBoundary
        isLoading={isLoading}
        error={displayError}
        onRetry={refetch}
        skeleton={<SettingsSectionSkeleton rowCount={section.fields.length} />}
      >
        <div className="panel">
          <div className="panel-body" style={{ padding: 0 }}>
            {section.fields.map((f) => {
              const val = fieldValue(f);
              return (
                <div
                  key={f.field}
                  className="settings-row"
                  style={locked ? { opacity: 0.85 } : undefined}
                >
                  <div className="settings-info">
                    <div className="settings-key">{f.label}</div>
                    <div className="settings-desc">{f.description}</div>
                  </div>
                  <div className="settings-control">
                    {f.type === 'boolean' ? (
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={Boolean(val)}
                          disabled={locked}
                          onChange={(e) => setField(f, e.target.checked)}
                        />
                        <div className="toggle-track" />
                        <div className="toggle-thumb" />
                      </label>
                    ) : f.type === 'number' ? (
                      <input
                        className="input input-mono"
                        type="number"
                        style={{ width: 90, textAlign: 'right' }}
                        value={String(val ?? f.defaultValue ?? 0)}
                        disabled={locked}
                        onChange={(e) => setField(f, Number(e.target.value))}
                      />
                    ) : (
                      <input
                        className="input"
                        style={{ width: 220 }}
                        value={String(val ?? f.defaultValue ?? '')}
                        disabled={locked}
                        onChange={(e) => setField(f, e.target.value)}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </QueryBoundary>
    </div>
  );
}
