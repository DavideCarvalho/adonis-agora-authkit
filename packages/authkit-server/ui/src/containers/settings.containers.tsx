import {
  authkitKeys,
  useRemoveSettingMutationOptions,
  useSetSettingMutationOptions,
  useSettingsQueryOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../agora-kit/lib/utils';
import { Button } from '../agora-kit/ui/button';
import { Toggle } from '../components/forms';
import { SelectInput, SettingsRow, TextInput } from '../components/primitives';
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
  /** `select`: um valor de `options`. `list`: lista de strings, editada separada por vírgula. */
  type: 'boolean' | 'number' | 'string' | 'select' | 'list';
  /** Opções do `select` (valor gravado + rótulo mostrado). */
  options?: Array<{ value: string; label: string }>;
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
    <div className="overflow-hidden rounded-lg border border-border bg-panel-2" aria-hidden>
      {Array.from({ length: rowCount }, (_, i) => `row-${i}`).map((key) => (
        <div
          key={key}
          className="flex items-center justify-between gap-4 border-b border-border px-4 py-3.5 last:border-0"
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton width="40%" height={13} />
            <Skeleton width="70%" height={11} />
          </div>
          <Skeleton width={44} height={24} borderRadius={12} />
        </div>
      ))}
    </div>
  );
}

// ── Badges ────────────────────────────────────────────────────────────────────

/** authkit's small square `.settings-badge`, in a tone. */
function SectionBadge({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'brand' | 'warn';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    neutral: 'border-border bg-hover text-faint',
    brand: 'border-brand-border bg-brand-soft text-brand',
    warn: 'border-warn/30 bg-warn/10 text-warn',
  } as const;
  return (
    <span
      title={title}
      className={cn(
        'mono inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[9.5px] font-normal',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Lock badge (setting travada via defineConfig). */
function ConfigLockBadge() {
  return (
    <SectionBadge
      tone="brand"
      title="Definido via defineConfig() — gerenciado no código, não editável aqui"
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
    </SectionBadge>
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
    <section className="mb-6">
      <div className="mb-1 flex flex-col items-start justify-between gap-2.5 border-b border-border pb-2.5 sm:flex-row sm:items-center">
        <div>
          <h3 className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-fg">
            {section.title}
            {locked && <ConfigLockBadge />}
            {!locked && !isDefault && <SectionBadge>custom</SectionBadge>}
            {dirty && !locked && <SectionBadge tone="warn">unsaved</SectionBadge>}
          </h3>
          <p className="mt-0.5 text-[11px] text-faint">{section.description}</p>
          {locked && (
            <p className="mt-1 text-xs text-brand">
              Travado no <code className="mono">defineConfig()</code> — o config tem prioridade
              sobre o runtime. Remova de lá para editar por aqui.
            </p>
          )}
          <div className="mono mt-0.5 text-[10.5px] text-faint">{section.settingKey}</div>
        </div>
        {!locked && (
          <div className="flex shrink-0 items-center gap-2">
            {dirty && (
              <Button size="sm" disabled={saving} onClick={save}>
                {saving ? 'Salvando…' : 'Salvar'}
              </Button>
            )}
            {!isDefault && !dirty && (
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={reset}
                title="Voltar ao default"
                aria-label="Voltar ao default"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M2 8a6 6 0 016-6 6 6 0 014.24 1.76L14 5" strokeLinecap="round" />
                  <path d="M14 2v3h-3" strokeLinecap="round" />
                </svg>
              </Button>
            )}
          </div>
        )}
      </div>

      <QueryBoundary
        label={section.title}
        isLoading={isLoading}
        error={displayError}
        onRetry={refetch}
        skeleton={<SettingsSectionSkeleton rowCount={section.fields.length} />}
      >
        <div
          className={cn(
            'agora-surface agora-rise overflow-hidden rounded-lg border border-border px-4',
            locked && 'opacity-85',
          )}
        >
          {section.fields.map((f) => {
            const val = fieldValue(f);
            return (
              <SettingsRow key={f.field} name={f.label} description={f.description}>
                {f.type === 'boolean' ? (
                  <Toggle
                    label={f.label}
                    checked={Boolean(val)}
                    disabled={locked}
                    onChange={(v) => setField(f, v)}
                  />
                ) : f.type === 'select' ? (
                  <SelectInput
                    aria-label={f.label}
                    className="w-full sm:w-[220px]"
                    value={String(val ?? f.defaultValue ?? '')}
                    disabled={locked}
                    onChange={(e) => setField(f, e.target.value)}
                  >
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </SelectInput>
                ) : f.type === 'list' ? (
                  <TextInput
                    mono
                    aria-label={f.label}
                    className="w-full sm:w-[220px]"
                    placeholder="ADMIN, COORDINATOR"
                    value={(Array.isArray(val) ? val : []).join(', ')}
                    disabled={locked}
                    onChange={(e) =>
                      setField(
                        f,
                        e.target.value
                          .split(',')
                          .map((item) => item.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                ) : f.type === 'number' ? (
                  <TextInput
                    mono
                    aria-label={f.label}
                    type="number"
                    className="w-[90px] text-right"
                    value={String(val ?? f.defaultValue ?? 0)}
                    disabled={locked}
                    onChange={(e) => setField(f, Number(e.target.value))}
                  />
                ) : (
                  <TextInput
                    aria-label={f.label}
                    className="w-full sm:w-[220px]"
                    value={String(val ?? f.defaultValue ?? '')}
                    disabled={locked}
                    onChange={(e) => setField(f, e.target.value)}
                  />
                )}
              </SettingsRow>
            );
          })}
        </div>
      </QueryBoundary>
    </section>
  );
}
