import type { AuditEventEntry } from '@adonis-agora/authkit-react';
import { parseAsString, useQueryState } from 'nuqs';
import React, { useState } from 'react';
import { AuditEventDetailContainer, AuditTableContainer } from '../containers/audit.containers';

const EVENT_TYPES = [
  '',
  'login.success',
  'login.failed',
  'login.mfa_required',
  'logout',
  'register',
  'password_reset',
  'settings.updated',
  'client.created',
  'client.deleted',
  'account.disabled',
  'account.enabled',
];

export function Audit() {
  // Estado de rota (URL): cursor e filtro de tipo via nuqs.
  const [after, setAfter] = useQueryState('after', parseAsString);
  const [before, setBefore] = useQueryState('before', parseAsString);
  const [typeFilter, setTypeFilter] = useQueryState('type', parseAsString.withDefault(''));
  // `selected` carrega o objeto inteiro do evento (não é deep-link) — fica local.
  const [selected, setSelected] = useState<AuditEventEntry | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  if (unavailable) {
    return (
      <div>
        <div className="page-title" style={{ marginBottom: 8 }}>
          Audit Log
        </div>
        <div className="error-box">
          Audit log is not configured. Add an audit sink to your AuthKit config.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header-row">
        <div>
          <div className="page-title">Audit Log</div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="panel" style={{ marginBottom: 0 }}>
        <div className="panel-head">
          <select
            className="input"
            style={{ width: 240 }}
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setAfter(null);
              setBefore(null);
            }}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t || 'All event types'}
              </option>
            ))}
          </select>
        </div>
      </div>

      <AuditTableContainer
        typeFilter={typeFilter}
        cursor={{ ...(after ? { after } : {}), ...(before ? { before } : {}) }}
        onCursor={(c) => {
          setAfter(c.after ?? null);
          setBefore(c.before ?? null);
        }}
        selected={selected}
        onSelect={setSelected}
        onUnavailable={() => setUnavailable(true)}
      />

      {selected && (
        <div style={{ marginTop: 12 }}>
          <AuditEventDetailContainer event={selected} onClose={() => setSelected(null)} />
        </div>
      )}
    </div>
  );
}
