import React from 'react';
import { useConsoles } from '../components/ConsoleSwitcher';
import { ConsoleIcon } from '../components/console-switcher-icons';

/** Overview "Consoles" grid: the other `@adonis-agora` consoles this viewer may open. Hidden when none. */
export function ConsolesContainer() {
  const consoles = useConsoles();
  if (consoles.length === 0) return null;
  return (
    <section className="panel consoles-panel" aria-labelledby="consoles-heading">
      <div className="panel-head">
        <h3 id="consoles-heading">Consoles</h3>
      </div>
      <div className="panel-body console-grid">
        {consoles.map((console) => (
          <a key={console.id} className="console-card" href={console.href}>
            <span className="console-card-icon">
              <ConsoleIcon icon={console.icon} size={20} />
            </span>
            <span className="console-card-text">
              <span className="console-card-title">{console.title}</span>
              <span className="console-card-path">{console.href}</span>
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
