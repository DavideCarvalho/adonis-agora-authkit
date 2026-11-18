import {
  type AdminClient,
  authkitKeys,
  type CreateClientInput,
  useAuthkitClient,
  useCreateClientMutationOptions,
  useRevokeClientMutationOptions,
  useSetClientDisabledMutationOptions,
  useUpdateClientMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import type React from 'react';
import { useState } from 'react';
import { ComboSelect } from '../agora-kit/blocks/combo-field';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { XIcon } from '../agora-kit/icons';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { type CapabilityGroup, CapabilityPicker } from '../components/CapabilityPicker';
import { Modal } from '../components/Modal';
import {
  CheckboxRow,
  dangerButtonClass,
  Field,
  Notice,
  SecretBox,
  SelectInput,
  TextInput,
} from '../components/primitives';
import { ClientsListContainer, useClientsCount } from '../containers/clients.containers';
import { getConfig } from '../lib/config';
import { useToast } from '../lib/toast';

/** The grants the server accepts (`implicit` is refused). Label shown, value sent. */
const GRANT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'authorization_code', label: 'authorization_code' },
  { value: 'refresh_token', label: 'refresh_token' },
  { value: 'client_credentials', label: 'client_credentials' },
  { value: 'urn:ietf:params:oauth:grant-type:token-exchange', label: 'token-exchange' },
];
/** The scopes the IdP issues; any other one can still be typed. */
const KNOWN_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'roles'];
/** One OAuth scope token (RFC 6749 §3.3), same rule as the server. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
const AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'none'];

interface FormState {
  /** `app`: a regular OAuth client. `serviceTenant`: client_credentials + partition claim. */
  kind: 'app' | 'serviceTenant';
  partition: string;
  capabilities: string[];
  /** The `environment` claim; empty for none. */
  environment: string;
  /** Apps it may call, each with the capabilities its tokens for that app carry. */
  apps: AppGrantRow[];
  clientIdOverride: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  applicationType: 'web' | 'native';
  backchannelLogoutUri: string;
  backchannelLogoutSessionRequired: boolean;
  clientName: string;
  logoUri: string;
  /** The scopes it may ask for; empty = any. */
  scopes: string[];
}

interface AppGrantRow {
  name: string;
  capabilities: string[];
}

/** Rows → the `apps` map the API takes (blank names dropped, a repeated name merged). */
function appsOf(rows: AppGrantRow[]): Record<string, string[]> {
  const apps: Record<string, string[]> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    apps[name] = [...new Set([...(apps[name] ?? []), ...row.capabilities])];
  }
  return apps;
}

function rowsOf(apps: Record<string, string[]> | undefined): AppGrantRow[] {
  return Object.entries(apps ?? {}).map(([name, capabilities]) => ({
    name,
    capabilities: [...capabilities],
  }));
}

/** The capabilities each service-tenant resource declares (`serviceTenants.resources`). */
function declaredCapabilityGroups(): CapabilityGroup[] {
  return (getConfig().serviceTenants?.resources ?? [])
    .filter((r) => r.capabilities.length > 0)
    .map((r) => ({ label: r.indicator, capabilities: r.capabilities }));
}

function defaultForm(): FormState {
  return {
    kind: 'app',
    partition: '',
    capabilities: [],
    environment: '',
    apps: [],
    clientIdOverride: '',
    redirectUris: [],
    postLogoutRedirectUris: [],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_basic',
    applicationType: 'web',
    backchannelLogoutUri: '',
    backchannelLogoutSessionRequired: false,
    clientName: '',
    logoUri: '',
    scopes: [],
  };
}

export function Clients() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const authkitClient = useAuthkitClient();
  const clientsCount = useClientsCount();
  // `?type=mcp` (the Settings card links here): only the MCP clients that registered themselves.
  const [filter, setFilter] = useQueryState('type', parseAsStringLiteral(['mcp'] as const));
  const revokeMutation = useMutation(useRevokeClientMutationOptions());

  const [createOpen, setCreateOpen] = useState(false);
  const [editClient, setEditClient] = useState<AdminClient | null>(null);
  const [createdSecret, setCreatedSecret] = useState<{ clientId: string; secret: string } | null>(
    null,
  );
  const [formData, setFormData] = useState<FormState>(defaultForm());
  const [redirectInput, setRedirectInput] = useState('');
  const [logoutInput, setLogoutInput] = useState('');

  const createMutation = useMutation(useCreateClientMutationOptions());
  const updateMutation = useMutation(useUpdateClientMutationOptions(editClient?.clientId ?? ''));
  const disableMutation = useMutation(useSetClientDisabledMutationOptions());

  function openCreate() {
    setFormData(defaultForm());
    setRedirectInput('');
    setLogoutInput('');
    setCreateOpen(true);
  }

  function openEdit(c: AdminClient) {
    setFormData({
      kind: c.serviceTenant ? 'serviceTenant' : 'app',
      partition: c.serviceTenant?.partition ?? '',
      capabilities: [...(c.serviceTenant?.capabilities ?? [])],
      environment: c.serviceTenant?.environment ?? '',
      apps: rowsOf(c.serviceTenant?.apps),
      clientIdOverride: '',
      redirectUris: [...c.redirectUris],
      postLogoutRedirectUris: [...c.postLogoutRedirectUris],
      grantTypes: [...c.grantTypes],
      tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
      applicationType: c.applicationType ?? 'web',
      backchannelLogoutUri: c.backchannelLogoutUri ?? '',
      backchannelLogoutSessionRequired: c.backchannelLogoutSessionRequired,
      clientName: c.clientName ?? '',
      logoUri: c.logoUri ?? '',
      scopes: c.scope ? c.scope.split(' ').filter(Boolean) : [],
    });
    setRedirectInput('');
    setLogoutInput('');
    setEditClient(c);
  }

  function addUri(type: 'redirect' | 'logout') {
    const val = type === 'redirect' ? redirectInput.trim() : logoutInput.trim();
    if (!val) return;
    if (type === 'redirect') {
      setFormData((f) => ({ ...f, redirectUris: [...f.redirectUris, val] }));
      setRedirectInput('');
    } else {
      setFormData((f) => ({ ...f, postLogoutRedirectUris: [...f.postLogoutRedirectUris, val] }));
      setLogoutInput('');
    }
  }

  function removeUri(type: 'redirect' | 'logout', idx: number) {
    if (type === 'redirect') {
      setFormData((f) => ({ ...f, redirectUris: f.redirectUris.filter((_, i) => i !== idx) }));
    } else {
      setFormData((f) => ({
        ...f,
        postLogoutRedirectUris: f.postLogoutRedirectUris.filter((_, i) => i !== idx),
      }));
    }
  }

  function toggleGrant(g: string) {
    setFormData((f) => ({
      ...f,
      grantTypes: f.grantTypes.includes(g)
        ? f.grantTypes.filter((x) => x !== g)
        : [...f.grantTypes, g],
    }));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      const input: CreateClientInput =
        formData.kind === 'serviceTenant'
          ? {
              clientId: formData.clientIdOverride || undefined,
              grantTypes: ['client_credentials'],
              tokenEndpointAuthMethod: 'client_secret_basic',
              clientName: formData.clientName.trim() || undefined,
              ...(formData.scopes.length ? { scopes: formData.scopes } : {}),
              serviceTenant: {
                partition: formData.partition.trim(),
                capabilities: formData.capabilities,
                ...(formData.environment.trim()
                  ? { environment: formData.environment.trim() }
                  : {}),
                apps: appsOf(formData.apps),
              },
            }
          : {
              clientId: formData.clientIdOverride || undefined,
              redirectUris: formData.redirectUris,
              postLogoutRedirectUris: formData.postLogoutRedirectUris,
              grantTypes: formData.grantTypes,
              tokenEndpointAuthMethod: formData.tokenEndpointAuthMethod,
              applicationType: formData.applicationType,
              backchannelLogoutUri: formData.backchannelLogoutUri || undefined,
              backchannelLogoutSessionRequired: formData.backchannelLogoutSessionRequired,
              clientName: formData.clientName.trim() || undefined,
              logoUri: formData.logoUri.trim() || undefined,
              ...(formData.scopes.length ? { scopes: formData.scopes } : {}),
            };
      const r = await createMutation.mutateAsync(input);
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.clients() });
      setCreateOpen(false);
      if (r.clientSecret) {
        setCreatedSecret({ clientId: r.clientId, secret: r.clientSecret });
      } else {
        toast.success(`Client ${r.clientId} created`);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!editClient) return;
    try {
      if (formData.kind === 'serviceTenant') {
        await updateMutation.mutateAsync({
          clientName: formData.clientName.trim() || null,
          scopes: formData.scopes.length ? formData.scopes : null,
          serviceTenant: {
            partition: formData.partition.trim(),
            capabilities: formData.capabilities,
            environment: formData.environment.trim() || null,
            apps: appsOf(formData.apps),
          },
        });
        queryClient.invalidateQueries({ queryKey: authkitKeys.admin.clients() });
        toast.success('Client updated');
        setEditClient(null);
        return;
      }
      await updateMutation.mutateAsync({
        redirectUris: formData.redirectUris,
        postLogoutRedirectUris: formData.postLogoutRedirectUris,
        grantTypes: formData.grantTypes,
        tokenEndpointAuthMethod: formData.tokenEndpointAuthMethod,
        applicationType: formData.applicationType,
        // An emptied field clears the URI on the server.
        backchannelLogoutUri: formData.backchannelLogoutUri.trim() || null,
        backchannelLogoutSessionRequired: formData.backchannelLogoutSessionRequired,
        clientName: formData.clientName.trim() || null,
        logoUri: formData.logoUri.trim() || null,
        // Empty = lift the restriction (any scope).
        scopes: formData.scopes.length ? formData.scopes : null,
      });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.clients() });
      toast.success('Client updated');
      setEditClient(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(c: AdminClient) {
    if (!confirm(`Delete client ${c.clientId}?`)) return;
    try {
      await authkitClient.admin.clients.remove(c.clientId);
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.clients() });
      toast.success('Client deleted');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleDisabled(c: AdminClient) {
    const disable = !c.disabled;
    if (
      disable &&
      !confirm(
        `Disable ${c.clientId}? It gets no new tokens from now on; tokens already issued expire on their own.`,
      )
    ) {
      return;
    }
    try {
      await disableMutation.mutateAsync({ id: c.clientId, disabled: disable });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.clients() });
      toast.success(disable ? `Client ${c.clientId} disabled` : `Client ${c.clientId} enabled`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRevoke(c: AdminClient) {
    if (
      !confirm(
        `Revoke ${c.clientId}? It is disabled and its grants and tokens are cut in every account.`,
      )
    ) {
      return;
    }
    try {
      const r = await revokeMutation.mutateAsync(c.clientId);
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.clients() });
      toast.success(`Client ${c.clientId} revoked (${r.grants} grants cut)`);
    } catch (err: unknown) {
      if ((err as { code?: string } | null)?.code === 'sudo_required') {
        const back = window.location.pathname + window.location.search;
        window.location.href = `${getConfig().endpoints.confirm ?? '/account/confirm'}?return_to=${encodeURIComponent(back)}`;
        return;
      }
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRegenerate(c: AdminClient) {
    if (!confirm(`Regenerate secret for ${c.clientId}? Existing secret will stop working.`)) return;
    try {
      const r = await authkitClient.admin.clients.regenerateSecret(c.clientId);
      if (r.clientSecret) {
        setCreatedSecret({ clientId: r.clientId, secret: r.clientSecret });
      } else {
        toast.info('No secret returned (public client)');
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  /** A list of URIs (read-only rows with a remove button) plus an input to add one. */
  const UriList = ({
    id,
    type,
    uris,
    value,
    onValue,
    placeholder,
  }: {
    id: string;
    type: 'redirect' | 'logout';
    uris: string[];
    value: string;
    onValue: (v: string) => void;
    placeholder: string;
  }) => (
    <>
      {uris.map((uri, i) => (
        <div key={i} className="mb-1 flex gap-1.5">
          <TextInput mono value={uri} readOnly className="flex-1" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={`h-[34px] ${dangerButtonClass}`}
            aria-label={`Remove ${uri}`}
            onClick={() => removeUri(type, i)}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <div className="flex gap-1.5">
        <TextInput
          id={id}
          mono
          value={value}
          onChange={(e) => onValue(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addUri(type);
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-[34px]"
          onClick={() => addUri(type)}
        >
          Add
        </Button>
      </div>
    </>
  );

  const ClientForm = () => (
    <form onSubmit={editClient ? handleUpdate : handleCreate}>
      {!editClient && (
        <Field label="Client ID (optional — auto-generated if blank)" htmlFor="client-id">
          <TextInput
            id="client-id"
            mono
            value={formData.clientIdOverride}
            onChange={(e) => setFormData((f) => ({ ...f, clientIdOverride: e.target.value }))}
            placeholder="my-app (auto if blank)"
          />
        </Field>
      )}

      {!editClient && getConfig().serviceTenants && (
        <Field label="Kind" htmlFor="client-kind">
          <SelectInput
            id="client-kind"
            value={formData.kind}
            onChange={(e) =>
              setFormData((f) => ({
                ...f,
                kind: e.target.value === 'serviceTenant' ? 'serviceTenant' : 'app',
              }))
            }
          >
            <option value="app">Application (sign-in, APIs)</option>
            <option value="serviceTenant">Service tenant (client_credentials + partition)</option>
          </SelectInput>
        </Field>
      )}

      {formData.kind === 'serviceTenant' ? (
        <>
          <Field label="Partition" htmlFor="client-partition">
            <TextInput
              id="client-partition"
              mono
              value={formData.partition}
              onChange={(e) => setFormData((f) => ({ ...f, partition: e.target.value }))}
              placeholder="acme"
              required
            />
          </Field>
          <Field label="Capabilities (optional)" htmlFor="client-capabilities">
            <CapabilityPicker
              id="client-capabilities"
              value={formData.capabilities}
              onChange={(capabilities) => setFormData((f) => ({ ...f, capabilities }))}
              groups={declaredCapabilityGroups()}
            />
          </Field>
          <Field label="Environment (optional)" htmlFor="client-environment">
            <TextInput
              id="client-environment"
              mono
              value={formData.environment}
              onChange={(e) => setFormData((f) => ({ ...f, environment: e.target.value }))}
              placeholder="production"
            />
          </Field>
          {getConfig().serviceTenants?.apps === true && (
            <AppGrantsEditor
              rows={formData.apps}
              onChange={(apps) => setFormData((f) => ({ ...f, apps }))}
            />
          )}
          <ScopesField formData={formData} setFormData={setFormData} />
          <Field label="Name" htmlFor="client-name">
            <TextInput
              id="client-name"
              value={formData.clientName}
              onChange={(e) => setFormData((f) => ({ ...f, clientName: e.target.value }))}
              placeholder="Acme worker"
            />
          </Field>
          <div className="text-xs text-faint">
            Confidential client with only the client_credentials grant. Its tokens carry the
            partition, capabilities and environment as claims. For each app it can call it gets
            tokens for urn:agora:app:&lt;name&gt; carrying that app's capabilities.
          </div>
        </>
      ) : (
        <>
          <Field label="Grant Types">
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1.5">
              {GRANT_TYPES.map((g) => (
                <CheckboxRow
                  key={g.value}
                  className="py-1"
                  checked={formData.grantTypes.includes(g.value)}
                  onChange={() => toggleGrant(g.value)}
                  label={<span className="mono">{g.label}</span>}
                />
              ))}
            </div>
          </Field>

          <ScopesField formData={formData} setFormData={setFormData} />

          <Field label="Application Type" htmlFor="client-app-type">
            <SelectInput
              id="client-app-type"
              value={formData.applicationType}
              onChange={(e) => {
                const applicationType = e.target.value === 'native' ? 'native' : 'web';
                // Native apps (RFC 8252) are always public clients: no secret.
                setFormData((f) => ({
                  ...f,
                  applicationType,
                  tokenEndpointAuthMethod:
                    applicationType === 'native' ? 'none' : f.tokenEndpointAuthMethod,
                }));
              }}
            >
              <option value="web">web</option>
              <option value="native">native (mobile / desktop app)</option>
            </SelectInput>
          </Field>

          <Field label="Token Endpoint Auth Method" htmlFor="client-auth-method">
            <SelectInput
              id="client-auth-method"
              value={formData.tokenEndpointAuthMethod}
              disabled={formData.applicationType === 'native'}
              onChange={(e) =>
                setFormData((f) => ({ ...f, tokenEndpointAuthMethod: e.target.value }))
              }
            >
              {AUTH_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field label="Redirect URIs" htmlFor="client-redirect-input">
            <UriList
              id="client-redirect-input"
              type="redirect"
              uris={formData.redirectUris}
              value={redirectInput}
              onValue={setRedirectInput}
              placeholder={
                formData.applicationType === 'native'
                  ? 'com.example.app:/oauth or http://127.0.0.1/callback'
                  : 'https://app.example.com/callback'
              }
            />
          </Field>

          <Field label="Post-Logout Redirect URIs" htmlFor="client-logout-input">
            <UriList
              id="client-logout-input"
              type="logout"
              uris={formData.postLogoutRedirectUris}
              value={logoutInput}
              onValue={setLogoutInput}
              placeholder="https://app.example.com/logged-out"
            />
          </Field>

          <Field label="Name" htmlFor="client-name">
            <TextInput
              id="client-name"
              value={formData.clientName}
              onChange={(e) => setFormData((f) => ({ ...f, clientName: e.target.value }))}
              placeholder="Shown on consent and authorized-app screens"
            />
          </Field>

          <Field label="Logo URL" htmlFor="client-logo">
            <TextInput
              id="client-logo"
              mono
              value={formData.logoUri}
              onChange={(e) => setFormData((f) => ({ ...f, logoUri: e.target.value }))}
              placeholder="https://app.example.com/logo.png"
            />
          </Field>

          <Field label="Backchannel Logout URI" htmlFor="client-backchannel">
            <TextInput
              id="client-backchannel"
              mono
              value={formData.backchannelLogoutUri}
              onChange={(e) => setFormData((f) => ({ ...f, backchannelLogoutUri: e.target.value }))}
              placeholder="https://app.example.com/backchannel-logout"
            />
          </Field>

          <CheckboxRow
            checked={formData.backchannelLogoutSessionRequired}
            onChange={(checked) =>
              setFormData((f) => ({ ...f, backchannelLogoutSessionRequired: checked }))
            }
            label="Require session ID in backchannel logout"
          />
        </>
      )}
    </form>
  );

  return (
    <PageBody>
      <PageHeader
        title="OAuth Clients"
        description={`${clientsCount} clients`}
        actions={
          <Button onClick={openCreate}>
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M8 2v12M2 8h12" strokeLinecap="round" />
            </svg>
            New Client
          </Button>
        }
      />

      {/* Clients list container */}
      {filter === 'mcp' && (
        <Notice tone="info" className="mb-3 flex items-center justify-between gap-3">
          <span>Showing only MCP clients (registered through dynamic registration).</span>
          <Button variant="outline" size="sm" onClick={() => void setFilter(null)}>
            Show all
          </Button>
        </Notice>
      )}
      <ClientsListContainer
        onEdit={openEdit}
        onDelete={handleDelete}
        onRegenerate={handleRegenerate}
        onToggleDisabled={handleToggleDisabled}
        onRevoke={handleRevoke}
        filter={filter}
      />

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New OAuth Client"
        large
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating…' : 'Create Client'}
            </Button>
          </>
        }
      >
        <ClientForm />
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editClient}
        onClose={() => setEditClient(null)}
        title={`Edit — ${editClient?.clientId}`}
        large
        footer={
          <>
            <Button variant="outline" onClick={() => setEditClient(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving…' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <ClientForm />
      </Modal>

      {/* Secret shown once */}
      <Modal
        open={!!createdSecret}
        onClose={() => setCreatedSecret(null)}
        title="Client Secret — Save Now"
        footer={<Button onClick={() => setCreatedSecret(null)}>I've saved it</Button>}
      >
        <Notice tone="warn">This secret will not be shown again. Copy it now.</Notice>
        <div className="mt-3">
          <SecretBox label="Client ID">{createdSecret?.clientId}</SecretBox>
        </div>
        <SecretBox label="Client Secret">{createdSecret?.secret}</SecretBox>
        <Button
          variant="outline"
          size="sm"
          className="mt-1"
          onClick={() => navigator.clipboard.writeText(createdSecret?.secret ?? '')}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <rect x="5" y="5" width="9" height="9" rx="1.5" />
            <path
              d="M3.5 11H3a1.5 1.5 0 01-1.5-1.5V3A1.5 1.5 0 013 1.5h6.5A1.5 1.5 0 0111 3v.5"
              strokeLinecap="round"
            />
          </svg>
          Copy secret
        </Button>
      </Modal>
    </PageBody>
  );
}

/** One app's published catalog: what it accepts from the other apps. */
interface AppCatalog {
  app: string;
  capabilities: string[];
  updatedAt: string;
}

/** The catalogs the apps published (`GET {api}/apps/catalog`); `[]` until they load or on error. */
function useAppCatalogs(): { catalogs: AppCatalog[]; loading: boolean } {
  const client = useAuthkitClient();
  const query = useQuery({
    queryKey: ['authkit', 'admin', 'apps', 'catalog'],
    queryFn: () =>
      client.request<{ apps: AppCatalog[] }>('GET', `${getConfig().endpoints.api}/apps/catalog`),
    staleTime: 60_000,
    retry: false,
  });
  return { catalogs: query.data?.apps ?? [], loading: query.isLoading };
}

/** "Apps it can call": one row per app, each with the capabilities its tokens for that app carry. */
function AppGrantsEditor({
  rows,
  onChange,
}: {
  rows: AppGrantRow[];
  onChange: (rows: AppGrantRow[]) => void;
}) {
  const set = (i: number, row: AppGrantRow) => onChange(rows.map((r, j) => (j === i ? row : r)));
  const { catalogs, loading } = useAppCatalogs();
  const appOptions = catalogs.map((c) => ({ value: c.app }));
  const groupsFor = (app: string): CapabilityGroup[] => {
    const catalog = catalogs.find((c) => c.app === app);
    return catalog && catalog.capabilities.length > 0
      ? [{ label: `What ${app} accepts`, capabilities: catalog.capabilities }]
      : [];
  };
  return (
    <Field label="Apps it can call (optional)">
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
            <div className="flex items-center gap-2">
              <ComboSelect
                aria-label="App name"
                options={appOptions}
                value={row.name || null}
                onValueChange={(name) => set(i, { ...row, name: name ?? '' })}
                creatable
                loading={loading}
                placeholder="billing"
                emptyText="No app has published a catalog"
                className="flex-1 font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${row.name || 'app'}`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                <XIcon />
              </Button>
            </div>
            <CapabilityPicker
              value={row.capabilities}
              onChange={(capabilities) => set(i, { ...row, capabilities })}
              groups={groupsFor(row.name)}
              placeholder="Capabilities on this app (optional)…"
            />
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => onChange([...rows, { name: '', capabilities: [] }])}
        >
          + Add app
        </Button>
        <div className="text-[11px] text-faint">
          It gets tokens for urn:agora:app:&lt;name&gt; to call that app; the capabilities go in
          those tokens. Without any, the token only says who is calling. The apps and their
          capabilities listed here are the ones each app published; any other can be typed.
        </div>
      </div>
    </Field>
  );
}

/** "Allowed scopes": empty = any scope of the IdP. */
function ScopesField({
  formData,
  setFormData,
}: {
  formData: FormState;
  setFormData: React.Dispatch<React.SetStateAction<FormState>>;
}) {
  return (
    <Field label="Allowed scopes (empty = any)" htmlFor="client-scopes">
      <CapabilityPicker
        id="client-scopes"
        value={formData.scopes}
        onChange={(scopes) => setFormData((f) => ({ ...f, scopes }))}
        groups={[{ label: 'Scopes', capabilities: KNOWN_SCOPES }]}
        placeholder="Search or type a scope…"
        pattern={SCOPE_TOKEN}
        patternHint="No spaces, quotes or backslashes."
      />
    </Field>
  );
}
