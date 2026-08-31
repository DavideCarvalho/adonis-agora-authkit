import {
  type AdminClient,
  authkitKeys,
  type CreateClientInput,
  useAuthkitClient,
  useCreateClientMutationOptions,
  useUpdateClientMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Modal } from '../components/Modal';
import { ClientsListContainer, useClientsCount } from '../containers/clients.containers';
import { useToast } from '../lib/toast';

const GRANT_TYPES = ['authorization_code', 'refresh_token', 'client_credentials', 'implicit'];
const AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'none'];

interface FormState {
  clientIdOverride: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  backchannelLogoutUri: string;
  backchannelLogoutSessionRequired: boolean;
}

function defaultForm(): FormState {
  return {
    clientIdOverride: '',
    redirectUris: [],
    postLogoutRedirectUris: [],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_basic',
    backchannelLogoutUri: '',
    backchannelLogoutSessionRequired: false,
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

  function openCreate() {
    setFormData(defaultForm());
    setRedirectInput('');
    setLogoutInput('');
    setCreateOpen(true);
  }

  function openEdit(c: AdminClient) {
    setFormData({
      clientIdOverride: '',
      redirectUris: [...c.redirectUris],
      postLogoutRedirectUris: [...c.postLogoutRedirectUris],
      grantTypes: [...c.grants],
      tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
      backchannelLogoutUri: c.backchannelLogoutUri ?? '',
      backchannelLogoutSessionRequired: c.backchannelLogoutSessionRequired,
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
      const input: CreateClientInput = {
        clientId: formData.clientIdOverride || undefined,
        redirectUris: formData.redirectUris,
        postLogoutRedirectUris: formData.postLogoutRedirectUris,
        grantTypes: formData.grantTypes,
        tokenEndpointAuthMethod: formData.tokenEndpointAuthMethod,
        backchannelLogoutUri: formData.backchannelLogoutUri || undefined,
        backchannelLogoutSessionRequired: formData.backchannelLogoutSessionRequired,
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
      await updateMutation.mutateAsync({
        redirectUris: formData.redirectUris,
        postLogoutRedirectUris: formData.postLogoutRedirectUris,
        grantTypes: formData.grantTypes,
        tokenEndpointAuthMethod: formData.tokenEndpointAuthMethod,
        backchannelLogoutUri: formData.backchannelLogoutUri || undefined,
        backchannelLogoutSessionRequired: formData.backchannelLogoutSessionRequired,
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

  const ClientForm = () => (
    <form onSubmit={editClient ? handleUpdate : handleCreate}>
      {!editClient && (
        <div className="field">
          <label>Client ID (optional — auto-generated if blank)</label>
          <input
            className="input input-mono"
            value={formData.clientIdOverride}
            onChange={(e) => setFormData((f) => ({ ...f, clientIdOverride: e.target.value }))}
            placeholder="my-app (auto if blank)"
          />
        </div>
      )}

      <div className="field">
        <label>Grant Types</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {GRANT_TYPES.map((g) => (
            <label key={g} className="checkbox-row" style={{ padding: '4px 0' }}>
              <input
                type="checkbox"
                checked={formData.grantTypes.includes(g)}
                onChange={() => toggleGrant(g)}
              />
              <span className="chk-label mono">{g}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Token Endpoint Auth Method</label>
        <select
          className="input"
          value={formData.tokenEndpointAuthMethod}
          onChange={(e) => setFormData((f) => ({ ...f, tokenEndpointAuthMethod: e.target.value }))}
        >
          {AUTH_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Redirect URIs</label>
        {formData.redirectUris.map((uri, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <input className="input input-mono" value={uri} readOnly style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => removeUri('redirect', i)}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="input input-mono"
            value={redirectInput}
            onChange={(e) => setRedirectInput(e.target.value)}
            placeholder="https://app.example.com/callback"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addUri('redirect');
              }
            }}
          />
          <button type="button" className="btn btn-sm" onClick={() => addUri('redirect')}>
            Add
          </button>
        </div>
      </div>

      <div className="field">
        <label>Post-Logout Redirect URIs</label>
        {formData.postLogoutRedirectUris.map((uri, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <input className="input input-mono" value={uri} readOnly style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => removeUri('logout', i)}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="input input-mono"
            value={logoutInput}
            onChange={(e) => setLogoutInput(e.target.value)}
            placeholder="https://app.example.com/logged-out"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addUri('logout');
              }
            }}
          />
          <button type="button" className="btn btn-sm" onClick={() => addUri('logout')}>
            Add
          </button>
        </div>
      </div>

      <div className="field">
        <label>Backchannel Logout URI</label>
        <input
          className="input input-mono"
          value={formData.backchannelLogoutUri}
          onChange={(e) => setFormData((f) => ({ ...f, backchannelLogoutUri: e.target.value }))}
          placeholder="https://app.example.com/backchannel-logout"
        />
      </div>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={formData.backchannelLogoutSessionRequired}
          onChange={(e) =>
            setFormData((f) => ({ ...f, backchannelLogoutSessionRequired: e.target.checked }))
          }
        />
        <span className="chk-label">Require session ID in backchannel logout</span>
      </label>
    </form>
  );

  return (
    <div>
      <div className="page-header-row">
        <div>
          <div className="page-title">OAuth Clients</div>
          <div className="page-sub">{clientsCount} dynamic clients</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openCreate}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 2v12M2 8h12" strokeLinecap="round" />
            </svg>
            New Client
          </button>
        </div>
      </div>

      {/* Clients list container */}
      <ClientsListContainer
        onEdit={openEdit}
        onDelete={handleDelete}
        onRegenerate={handleRegenerate}
      />

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New OAuth Client"
        large
        footer={
          <>
            <button className="btn" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleCreate}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? <span className="spinner sm" /> : 'Create Client'}
            </button>
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
            <button className="btn" onClick={() => setEditClient(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleUpdate}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? <span className="spinner sm" /> : 'Save Changes'}
            </button>
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
        footer={
          <button className="btn btn-primary" onClick={() => setCreatedSecret(null)}>
            I've saved it
          </button>
        }
      >
        <div
          className="error-box"
          style={{
            background: 'var(--amber-soft)',
            borderColor: 'rgba(255,180,84,0.3)',
            color: 'var(--amber)',
          }}
        >
          This secret will not be shown again. Copy it now.
        </div>
        <div className="secret-box" style={{ marginTop: 12 }}>
          <small>Client ID</small>
          {createdSecret?.clientId}
        </div>
        <div className="secret-box">
          <small>Client Secret</small>
          {createdSecret?.secret}
        </div>
        <button
          className="btn btn-sm"
          style={{ marginTop: 4 }}
          onClick={() => navigator.clipboard.writeText(createdSecret?.secret ?? '')}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
            <rect x="5" y="5" width="9" height="9" rx="1.5" />
            <path
              d="M3.5 11H3a1.5 1.5 0 01-1.5-1.5V3A1.5 1.5 0 013 1.5h6.5A1.5 1.5 0 0111 3v.5"
              strokeLinecap="round"
            />
          </svg>
          Copy secret
        </button>
      </Modal>
    </div>
  );
}
