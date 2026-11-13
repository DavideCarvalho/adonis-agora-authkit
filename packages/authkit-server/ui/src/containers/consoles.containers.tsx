import { useMemo } from 'react';
import { Panel } from '../agora-kit/blocks/panel';
import { ConsoleTile, consoleAccent } from '../agora-kit/icons';
import { useConsoles } from '../agora-kit/shell/console-switcher';
import { readShellConfig } from '../agora-kit/shell-config';
import { CONFIG_ELEMENT_ID } from '../lib/config';

/** Overview "Consoles" grid: the other `@adonis-agora` consoles this viewer may open. Hidden when none. */
export function ConsolesContainer() {
  const switcher = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID).switcher, []);
  const consoles = useConsoles(switcher);
  if (consoles.length === 0) return null;
  return (
    <section aria-labelledby="consoles-heading">
      <Panel title={<span id="consoles-heading">Consoles</span>}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
          {consoles.map((console) => (
            <a
              key={console.id}
              href={console.href}
              className="flex items-center gap-3 rounded-md border border-border p-3 text-fg no-underline transition-colors outline-none hover:border-line-strong hover:bg-panel-2 focus-visible:border-line-strong focus-visible:bg-panel-2"
            >
              <ConsoleTile
                icon={console.icon}
                accent={consoleAccent(console.id, console.icon)}
                size={36}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] font-semibold">{console.title}</span>
                <span className="mono truncate text-[10.5px] text-faint">{console.href}</span>
              </span>
            </a>
          ))}
        </div>
      </Panel>
    </section>
  );
}
