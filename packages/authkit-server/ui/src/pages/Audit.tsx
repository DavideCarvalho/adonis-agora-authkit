import type { AuditEventEntry } from '@adonis-agora/authkit-react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import { useState } from 'react';
import { AUDIT_EVENT_TYPES } from '../../../src/audit/audit_sink';
import { ComboMultiSelect } from '../agora-kit/blocks/combo-field';
import { PageHeader, Toolbar } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Notice } from '../components/primitives';
import { AuditEventDetailContainer, AuditTableContainer } from '../containers/audit.containers';

/** Every type the server emits (the server's own list, so it never drifts). */
const EVENT_TYPES: readonly string[] = AUDIT_EVENT_TYPES;

export function Audit() {
  // Estado de rota (URL): cursor e filtro de tipo via nuqs.
  const [after, setAfter] = useQueryState('after', parseAsString);
  const [before, setBefore] = useQueryState('before', parseAsString);
  // `?type=a,b` — several event types (the API's `filter[type]` takes a list).
  const [typeFilter, setTypeFilter] = useQueryState(
    'type',
    parseAsArrayOf(parseAsString).withDefault([]),
  );
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
        <ComboMultiSelect
          aria-label="Event type"
          className="w-full sm:w-80"
          options={EVENT_TYPES}
          value={typeFilter}
          creatable
          placeholder="All event types"
          onValueChange={(types) => {
            setTypeFilter(types.length ? types : null);
            setAfter(null);
            setBefore(null);
          }}
        />
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
