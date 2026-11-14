import type * as React from 'react';
import type { ReactNode, SVGProps } from 'react';

/**
 * The kit's icons: 16×16 stroke glyphs in currentColor (nav + chrome), and the 24×24 console
 * glyphs the switcher/search use. No icon dependency. Consoles may add their own nav icons in
 * their own files; anything here is shared by every console.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function stroke(paths: ReactNode, label?: string) {
  // biome-ignore lint/correctness/noComponentHookFactories: a static icon table built once at module load, no hooks inside
  return function Icon({ size = 16, ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 16 16"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={label ? undefined : true}
        role={label ? 'img' : undefined}
        aria-label={label}
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

/* ── Chrome ─────────────────────────────────────────────────────────────────────────────────── */
export const SearchIcon = stroke(
  <>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </>,
);
export const MenuIcon = stroke(<path d="M2.5 4h11M2.5 8h11M2.5 12h11" />);
export const XIcon = stroke(<path d="M4 4l8 8M12 4l-8 8" />);
export const ChevronUpIcon = stroke(<path d="M4 10l4-4 4 4" />);
export const PanelLeftIcon = stroke(
  <>
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
    <path d="M6 2.5v11" />
  </>,
);
export const MoreHorizontalIcon = stroke(
  <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.4} />,
);
export const ChevronDownIcon = stroke(<path d="M4 6l4 4 4-4" />);
export const ChevronLeftIcon = stroke(<path d="M10 4 6 8l4 4" />);
export const ChevronRightIcon = stroke(<path d="m6 4 4 4-4 4" />);
export const CheckIcon = stroke(<path d="M3.5 8.5l3 3 6-7" />);
export const SunIcon = stroke(
  <>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
  </>,
);
export const MoonIcon = stroke(<path d="M13.5 9A6 6 0 116.5 2.5a4.5 4.5 0 007 6.5z" />);
export const SignOutIcon = stroke(
  <>
    <path d="M10 11l4-3.5L10 4" />
    <path d="M14 7.5H5" />
    <path d="M6 3H3a1 1 0 00-1 1v7a1 1 0 001 1h3" />
  </>,
);
export const AlertIcon = stroke(
  <>
    <path d="M8 2 1.5 13.5h13z" />
    <path d="M8 6.5v3M8 11.5h.01" />
  </>,
);
export const RefreshIcon = stroke(
  <>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.5 2.5v3h-3" />
  </>,
);
export const InboxIcon = stroke(
  <>
    <path d="M2 9.5 4 3h8l2 6.5V13H2z" />
    <path d="M2 9.5h3.5l1 1.5h3l1-1.5H14" />
  </>,
);
export const FilterIcon = stroke(<path d="M2 3h12l-4.5 5.5V13l-3-1.5v-3z" />);

/* ── Common nav glyphs (a console picks from these or draws its own) ──────────────────────────── */
export const GridIcon = stroke(
  <>
    <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.5" />
    <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.5" />
    <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.5" />
    <rect x="9" y="9" width="5.5" height="5.5" rx="1.5" />
  </>,
);
export const ListIcon = stroke(<path d="M2.5 4h11M2.5 8h7M2.5 12h5" />);
export const ActivityIcon = stroke(<path d="M1.5 8h3l2-5 3 10 2-5h3" />);
export const ServerIcon = stroke(
  <>
    <rect x="2" y="2" width="12" height="5" rx="1.2" />
    <rect x="2" y="9" width="12" height="5" rx="1.2" />
    <path d="M4.5 4.5h.01M4.5 11.5h.01" />
  </>,
);
export const ClockIcon = stroke(
  <>
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 4.5V8l2.5 1.5" />
  </>,
);
export const FlowIcon = stroke(
  <>
    <rect x="1.5" y="2" width="4.5" height="4.5" rx="1.2" />
    <rect x="10" y="9.5" width="4.5" height="4.5" rx="1.2" />
    <path d="M6 4.25h3a1.5 1.5 0 0 1 1.5 1.5V9.5" />
  </>,
);
export const UsersIcon = stroke(
  <>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M2 13c0-2.76 2.69-5 6-5s6 2.24 6 5" />
  </>,
);
export const SettingsIcon = stroke(
  <>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M3.05 12.95l1.42-1.42M11.53 4.47l1.42-1.42" />
  </>,
);

export const DocumentIcon = stroke(
  <>
    <path d="M9.5 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z" />
    <path d="M9.5 1.5v3h3M6 8.5h4M6 11h2.5" />
  </>,
);

/* ── Console glyphs (switcher + search). Same keys as the `agora.consoles` registry. ──────────── */
export type ConsoleIconKey =
  | 'workflow'
  | 'telescope'
  | 'media'
  | 'payments'
  | 'agent'
  | 'identity'
  | 'flags'
  | 'cms'
  | 'generic';

const CONSOLE_PATHS: Record<ConsoleIconKey, ReactNode> = {
  workflow: (
    <>
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 7h4a2 2 0 0 1 2 2v5" />
    </>
  ),
  telescope: (
    <>
      <path d="m4 14 13-6 2 4-13 6z" />
      <path d="m10 16 2 5M14 15l-2 6M17 8l1-3 3 1-1 3" />
    </>
  ),
  media: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 16-5-5-9 9" />
    </>
  ),
  payments: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19M6.5 15h4" />
    </>
  ),
  agent: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 8V4M9 13h.01M15 13h.01M9.5 16.5h5" />
      <circle cx="12" cy="3.5" r="0.5" />
    </>
  ),
  identity: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z" />
      <circle cx="12" cy="10" r="2.5" />
      <path d="M8 16a4.5 4.5 0 0 1 8 0" />
    </>
  ),
  flags: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </>
  ),
  cms: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  generic: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
};

export const CONSOLE_ICON_KEYS = Object.keys(CONSOLE_PATHS) as ConsoleIconKey[];

/** An unknown icon key renders as `generic`. */
export function consoleIconKey(value: unknown): ConsoleIconKey {
  return CONSOLE_ICON_KEYS.includes(value as ConsoleIconKey)
    ? (value as ConsoleIconKey)
    : 'generic';
}

export function ConsoleIcon({
  icon,
  className,
  size = 16,
}: {
  icon: ConsoleIconKey;
  className?: string;
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      data-icon={icon}
    >
      {CONSOLE_PATHS[icon] ?? CONSOLE_PATHS.generic}
    </svg>
  );
}

/**
 * Each console's accent (CONSOLE-SHELL-SPEC), so the switcher and ⌘K can show every console in its
 * own colour. Keyed by registry id, with the icon key as a fallback for ids this copy doesn't know.
 */
export const CONSOLE_ACCENTS: Record<string, string> = {
  authkit: '#625fff',
  durable: '#a3e635',
  telescope: '#e879f9',
  payments: '#22d3ee',
  media: '#fbbf24',
  agent: '#fb7185',
  flags: '#34d399',
  cms: '#fb923c',
};

const ACCENT_BY_ICON: Partial<Record<ConsoleIconKey, string>> = {
  identity: '#625fff',
  workflow: '#a3e635',
  telescope: '#e879f9',
  payments: '#22d3ee',
  media: '#fbbf24',
  agent: '#fb7185',
  flags: '#34d399',
  cms: '#fb923c',
};

/** A console's accent by registry id, else by icon key, else `undefined` (neutral tile). */
export function consoleAccent(id: string | undefined, icon: ConsoleIconKey): string | undefined {
  return (id ? CONSOLE_ACCENTS[id] : undefined) ?? ACCENT_BY_ICON[icon];
}

/** The console glyph on a soft tile in that console's accent (`accent` omitted → neutral). */
export function ConsoleTile({
  icon,
  accent,
  size = 26,
  className,
}: {
  icon: ConsoleIconKey;
  accent?: string | undefined;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`agora-tile${className ? ` ${className}` : ''}`}
      style={
        {
          width: size,
          height: size,
          ...(accent ? { '--agora-tile': accent } : {}),
        } as React.CSSProperties
      }
      data-accent={accent}
    >
      <ConsoleIcon icon={icon} size={Math.round(size * 0.58)} />
    </span>
  );
}
