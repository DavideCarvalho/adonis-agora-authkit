import type { AuditEventEntry } from '@adonis-agora/authkit-react';
import { parseAsString, useQueryState } from 'nuqs';
import { useState } from 'react';
import { PageHeader, Toolbar } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Notice, SelectInput } from '../components/primitives';
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
      <PageBody>
        <PageHeader title="Audit Log" />
        <Notice>Audit log is not configured. Add an audit sink to your AuthKit config.</Notice>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <PageHeader title="Audit Log" />

      {/* Filter bar */}
      <Toolbar label="Audit filters">
        <SelectInput
          aria-label="Event type"
          className="w-full sm:w-60"
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
        </SelectInput>
      </Toolbar>

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

      {selected && <AuditEventDetailContainer event={selected} onClose={() => setSelected(null)} />}
    </PageBody>
  );
}
