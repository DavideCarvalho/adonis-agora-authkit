import {
  type AdminClient,
  authkitKeys,
  type CreateClientInput,
  useAuthkitClient,
  useCreateClientMutationOptions,
  useSetClientDisabledMutationOptions,
  useUpdateClientMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { XIcon } from '../agora-kit/icons';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
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
import { useToast } from '../lib/toast';

const GRANT_TYPES = ['authorization_code', 'refresh_token', 'client_credentials', 'implicit'];
const AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'none'];

interface FormState {
  /** `app`: a regular OAuth client. `serviceTenant`: client_credentials + partition claim. */
  kind: 'app' | 'serviceTenant';
  partition: string;
  /** Comma- or space-separated. */
  capabilities: string;
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
}

function parseCapabilities(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function defaultForm(): FormState {
  return {
    kind: 'app',
    partition: '',
    capabilities: '',
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
  };
}

export function Clients() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const authkitClient = useAuthkitClient();
  const clientsCount = useClientsCount();

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
      capabilities: (c.serviceTenant?.capabilities ?? []).join(', '),
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
              serviceTenant: {
                partition: formData.partition.trim(),
                capabilities: parseCapabilities(formData.capabilities),
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
          serviceTenant: {
            partition: formData.partition.trim(),
            capabilities: parseCapabilities(formData.capabilities),
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

      {!editClient && (
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
          <Field label="Capabilities (optional, comma-separated)" htmlFor="client-capabilities">
            <TextInput
              id="client-capabilities"
              mono
              value={formData.capabilities}
              onChange={(e) => setFormData((f) => ({ ...f, capabilities: e.target.value }))}
              placeholder="reports, billing"
            />
          </Field>
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
            partition and capabilities as claims.
          </div>
        </>
      ) : (
        <>
          <Field label="Grant Types">
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1.5">
              {GRANT_TYPES.map((g) => (
                <CheckboxRow
                  key={g}
                  className="py-1"
                  checked={formData.grantTypes.includes(g)}
                  onChange={() => toggleGrant(g)}
                  label={<span className="mono">{g}</span>}
                />
              ))}
            </div>
          </Field>

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
      <ClientsListContainer
        onEdit={openEdit}
        onDelete={handleDelete}
        onRegenerate={handleRegenerate}
        onToggleDisabled={handleToggleDisabled}
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
