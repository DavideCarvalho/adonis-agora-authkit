import { useQuery } from '@tanstack/react-query';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getConfig } from '../lib/config';
import { type ConsoleLink, getJson, moveIndex, parseConsoles } from '../lib/console_switcher';
import { ConsoleIcon } from './console-switcher-icons';

/**
 * The other `@adonis-agora` consoles this viewer may open. Asked once per page life, and only when
 * the shell announced other consoles (`switcher` in the config block).
 */
export function useConsoles(): ConsoleLink[] {
  const endpoint = getConfig().switcher?.endpoint;
  const { data } = useQuery({
    queryKey: ['agora-consoles', endpoint],
    queryFn: async ({ signal }) => parseConsoles(await getJson(endpoint!, signal)),
    enabled: typeof endpoint === 'string',
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return data ?? [];
}

/**
 * The sidebar brand. With other consoles to open it becomes the switcher: a menu button listing this
 * console first (checked, not a link) and then the others.
 */
export function ConsoleSwitcher({ brand }: { brand: React.ReactNode }) {
  const consoles = useConsoles();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open, close]);

  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus();
  }, [open, active]);

  if (consoles.length === 0) {
    return (
      <div className="brand" data-agora-switcher="">
        {brand}
      </div>
    );
  }

  const openMenu = () => {
    setOpen(true);
    setActive(0);
  };

  const onButtonKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
    }
  };

  const onMenuKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    const next = moveIndex(active, event.key, consoles.length);
    if (next !== active) {
      event.preventDefault();
      setActive(next);
    }
  };

  return (
    <div className="brand switcher" data-agora-switcher="" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="switcher-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onButtonKey}
      >
        {brand}
        <svg
          className="switcher-chevron"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          id={menuId}
          className="switcher-menu"
          role="menu"
          aria-label="Consoles"
          onKeyDown={onMenuKey}
        >
          <div className="switcher-item current" role="none">
            <ConsoleIcon icon="identity" />
            <span className="switcher-title">Identity</span>
            <span className="switcher-package">@adonis-agora/authkit-server</span>
            <svg
              className="switcher-check"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-label="Current console"
              role="img"
            >
              <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          {consoles.map((console, index) => (
            <a
              key={console.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              className="switcher-item"
              role="menuitem"
              tabIndex={index === active ? 0 : -1}
              href={console.href}
              onFocus={() => setActive(index)}
            >
              <ConsoleIcon icon={console.icon} />
              <span className="switcher-title">{console.title}</span>
              {console.package && <span className="switcher-package">{console.package}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
