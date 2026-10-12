import type { PersonalAgentEntry } from '@adonis-agora/authkit-react';
import { parseAsInteger, useQueryState } from 'nuqs';
import React, { useState } from 'react';
import {
  PersonalAgentConnectionsContainer,
  PersonalAgentsContainer,
} from '../containers/personal_agents.containers';

export function PersonalAgents() {
  const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1));
  const [agent, setAgent] = useState<PersonalAgentEntry | null>(null);

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Personal agents</div>
        <div className="page-sub">
          AI agents (PACT, Poppy) acting for your users: who is connected, and which agents may
          connect. Allow and block add to <code>defineConfig</code> and apply right away.
        </div>
      </div>
      <PersonalAgentsContainer
        onShowConnections={(a) => {
          setAgent(a);
          void setPage(null);
        }}
      />
      <PersonalAgentConnectionsContainer
        agent={agent}
        onClearAgent={() => {
          setAgent(null);
          void setPage(null);
        }}
        page={page}
        onPage={(p) => void setPage(p)}
      />
    </div>
  );
}
