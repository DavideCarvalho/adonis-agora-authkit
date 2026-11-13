import {
  authkitKeys,
  useRemoveSettingMutationOptions,
  useSetSettingMutationOptions,
  useSettingsQueryOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { cn } from '../agora-kit/lib/utils';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { ChipsEditor, FieldRow, Toggle } from '../components/forms';
import { SectionLabel, TextInput } from '../components/primitives';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../lib/toast';

/**
 * Keys de settings que fazem sentido por organização.
 * As demais (bot_protection, lockout, rate_limit, etc.) são GLOBAIS
 * e permanecem somente na página global de Settings.
 */
const ORG_SCOPABLE_KEYS = ['organizations_policy', 'roles_catalog'] as const;

type OrgScopableKey = (typeof ORG_SCOPABLE_KEYS)[number];

const ORG_SETTING_LABELS: Record<OrgScopableKey, { en: string; pt: string }> = {
  organizations_policy: {
    en: 'Organizations policy',
    pt: 'Política de organizações',
  },
  roles_catalog: {
    en: 'Roles catalog',
    pt: 'Catálogo de papéis',
  },
};

// ── Valores tipados + normalização na borda ──────────────────────────────────
// Os settings chegam do servidor como JSON sem shape garantido. Normalizamos
// UMA vez aqui (defaults aplicados) e o resto do módulo trabalha 100% tipado.

/** Roles de organização oferecidos nos selects (espelha o default da lib). */
export const DEFAULT_ORG_ROLES = ['owner', 'admin', 'member'];

export interface OrgPolicyValue {
  allowSelfCreate: boolean;
  invitationTtlHours: number;
  roles: string[];
}

export interface RoleCatalogEntry {
  name: string;
  description?: string;
}

export interface RolesCatalogValue {
  roles: RoleCatalogEntry[];
}

function normalizeOrgPolicy(value: unknown): OrgPolicyValue {
  const v = (value ?? {}) as Partial<OrgPolicyValue>;
  return {
    allowSelfCreate: Boolean(v.allowSelfCreate),
    invitationTtlHours: Number(v.invitationTtlHours) || 168,
    roles: Array.isArray(v.roles) && v.roles.length ? v.roles.map(String) : DEFAULT_ORG_ROLES,
  };
}

function normalizeRolesCatalog(value: unknown): RolesCatalogValue {
  const v = (value ?? {}) as Partial<RolesCatalogValue>;
  const roles =
    Array.isArray(v.roles) && v.roles.length
      ? v.roles
      : [{ name: 'ADMIN', description: 'Full access to the admin console' }];
  return {
    roles: roles.map((r) => ({
      name: String(r.name),
      description: r.description ? String(r.description) : undefined,
    })),
  };
}

// ── OrgSettingsSection ────────────────────────────────────────────────────────

export function OrgSettingsSection({ orgId }: { orgId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data: orgSettings, isLoading } = useQuery({
    ...useSettingsQueryOptions(orgId),
    retry: false,
  });
  const { data: globalSettings } = useQuery({ ...useSettingsQueryOptions(null), retry: false });

  const setMutation = useMutation(useSetSettingMutationOptions(orgId));
  const removeMutation = useMutation(useRemoveSettingMutationOptions(orgId));

  const [editingKey, setEditingKey] = useState<OrgScopableKey | null>(null);

  const orgEntries = orgSettings?.data ?? [];
  const globalEntries = globalSettings?.data ?? [];

  function getOrgEntry(key: OrgScopableKey) {
    return orgEntries.find((e) => e.key === key) ?? null;
  }
  function getGlobalEntry(key: OrgScopableKey) {
    return globalEntries.find((e) => e.key === key) ?? null;
  }

  async function handleSave(key: OrgScopableKey, value: unknown) {
    try {
      await setMutation.mutateAsync({ key, value });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.settings(orgId) });
      toast.success('Setting saved for this organization');
      setEditingKey(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save setting');
    }
  }

  async function handleRemove(key: OrgScopableKey) {
    try {
      await removeMutation.mutateAsync(key);
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.settings(orgId) });
      toast.success('Organization setting removed (falls back to global)');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove setting');
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2.5 border-t border-border pt-4" aria-hidden>
        <Skeleton width={150} height={10} />
        <Skeleton height={52} />
        <Skeleton height={52} />
      </div>
    );
  }

  return (
    <div className="border-t border-border pt-4">
      <SectionLabel className="mb-3 text-[10.5px]">Organization Settings</SectionLabel>

      <div className="flex flex-col gap-2.5">
        {ORG_SCOPABLE_KEYS.map((key) => {
          const orgEntry = getOrgEntry(key);
          const globalEntry = getGlobalEntry(key);
          const label = ORG_SETTING_LABELS[key];

          // Badge: from org > from global > default
          const sourceBadge = orgEntry
            ? { text: 'from org', className: 'border-brand-border text-brand' }
            : globalEntry
              ? { text: 'from global', className: 'border-dim/50 text-dim' }
              : { text: 'default', className: 'border-faint/50 text-faint' };

          const isEditing = editingKey === key;
          /** Valor herdado que pré-popula o form quando não há override da org. */
          const inherited: unknown = orgEntry?.value ?? globalEntry?.value ?? null;

          return (
            <div key={key} className="rounded-md border border-border bg-panel-2 px-3 py-2.5">
              <div className={cn('flex flex-wrap items-center gap-2', isEditing && 'mb-2.5')}>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-fg">{label.en}</div>
                  <div className="text-[11px] text-dim">{label.pt}</div>
                </div>
                <span
                  className={cn(
                    'rounded-sm border bg-transparent px-1.5 py-0.5 text-[10px] font-semibold',
                    sourceBadge.className,
                  )}
                >
                  {sourceBadge.text}
                </span>
                {!isEditing && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditingKey(key)}>
                      {orgEntry ? 'Edit' : 'Override'}
                    </Button>
                    {orgEntry && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemove(key)}
                        disabled={removeMutation.isPending}
                        className="text-bad hover:text-bad"
                        title="Remove org override (falls back to global)"
                      >
                        Reset
                      </Button>
                    )}
                  </>
                )}
              </div>

              {key === 'organizations_policy' &&
                (isEditing ? (
                  <OrgPolicyForm
                    initial={normalizeOrgPolicy(inherited)}
                    saving={setMutation.isPending}
                    onSave={(value) => handleSave(key, value)}
                    onCancel={() => setEditingKey(null)}
                  />
                ) : (
                  <OrgPolicySummary value={normalizeOrgPolicy(inherited)} />
                ))}
              {key === 'roles_catalog' &&
                (isEditing ? (
                  <RolesCatalogForm
                    initial={normalizeRolesCatalog(inherited)}
                    saving={setMutation.isPending}
                    onSave={(value) => handleSave(key, value)}
                    onCancel={() => setEditingKey(null)}
                  />
                ) : (
                  <RolesCatalogSummary value={normalizeRolesCatalog(inherited)} />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Summaries (leitura do valor efetivo, fora do modo de edição) ─────────────

function OrgPolicySummary({ value }: { value: OrgPolicyValue }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <Badge variant="neutral">self-create: {value.allowSelfCreate ? 'on' : 'off'}</Badge>
      <Badge variant="neutral">invite TTL: {value.invitationTtlHours}h</Badge>
      {value.roles.map((r) => (
        <Badge key={r} variant="neutral">
          {r}
        </Badge>
      ))}
    </div>
  );
}

function RolesCatalogSummary({ value }: { value: RolesCatalogValue }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {value.roles.map((r) => (
        <Badge key={r.name} variant="neutral" title={r.description ?? ''}>
          {r.name}
        </Badge>
      ))}
    </div>
  );
}

// ── Setting forms (estruturados — nada de JSON cru) ──────────────────────────

function OrgPolicyForm({
  initial,
  saving,
  onSave,
  onCancel,
}: {
  initial: OrgPolicyValue;
  saving: boolean;
  onSave: (value: OrgPolicyValue) => void;
  onCancel: () => void;
}) {
  const [allowSelfCreate, setAllowSelfCreate] = useState(initial.allowSelfCreate);
  const [ttlHours, setTtlHours] = useState(initial.invitationTtlHours);
  const [roles, setRoles] = useState(initial.roles);

  return (
    <div className="flex flex-col gap-3">
      <FieldRow label="Allow self-create" hint="Members can create their own organizations">
        <Toggle checked={allowSelfCreate} onChange={setAllowSelfCreate} label="Allow self-create" />
      </FieldRow>
      <FieldRow label="Invitation TTL" hint="Hours before a pending invitation expires">
        <div className="flex items-center gap-1.5">
          <TextInput
            type="number"
            min={1}
            value={ttlHours}
            onChange={(e) => setTtlHours(Number(e.target.value))}
            aria-label="Invitation TTL (hours)"
            className="w-20"
          />
          <span className="text-[11px] text-faint">h</span>
        </div>
      </FieldRow>
      <div>
        <div className="mb-1.5 text-xs font-medium text-fg">Organization roles</div>
        {/* `owner` é invariante do domínio: sempre preservado. */}
        <ChipsEditor
          values={roles}
          onChange={setRoles}
          locked={['owner']}
          placeholder="new role…"
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={() => onSave({ allowSelfCreate, invitationTtlHours: ttlHours, roles })}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RolesCatalogForm({
  initial,
  saving,
  onSave,
  onCancel,
}: {
  initial: RolesCatalogValue;
  saving: boolean;
  onSave: (value: RolesCatalogValue) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState(
    initial.roles.map((r) => ({ name: r.name, description: r.description ?? '' })),
  );
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  function addRow() {
    const name = newName.trim().toUpperCase();
    if (!name || rows.some((r) => r.name === name)) return;
    setRows([...rows, { name, description: newDesc.trim() }]);
    setNewName('');
    setNewDesc('');
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <div key={row.name} className="flex items-center gap-1.5">
          <Badge variant="neutral" className="min-w-[70px]">
            {row.name}
          </Badge>
          <TextInput
            value={row.description}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)))
            }
            placeholder="description…"
            aria-label={`${row.name} description`}
            className="flex-1"
          />
          {/* ADMIN é o gate do console — o backend o garante de qualquer forma. */}
          {row.name !== 'ADMIN' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-bad hover:text-bad"
              aria-label={`Remove ${row.name}`}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              ×
            </Button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-1.5">
        <TextInput
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addRow();
            }
          }}
          placeholder="ROLE_NAME"
          aria-label="New role name"
          className="w-[130px]"
        />
        <TextInput
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addRow();
            }
          }}
          placeholder="description…"
          aria-label="New role description"
          className="min-w-[140px] flex-1"
        />
        <Button type="button" variant="ghost" size="sm" className="h-[34px]" onClick={addRow}>
          Add
        </Button>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={() =>
            onSave({
              roles: rows.map((r) => ({ name: r.name, description: r.description || undefined })),
            })
          }
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
