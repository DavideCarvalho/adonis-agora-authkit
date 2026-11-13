/** The admin console's 16px stroke nav glyphs (unchanged from the pre-kit sidebar). */

const svg = (children: React.ReactNode) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    {children}
  </svg>
);

export const OverviewIcon = () =>
  svg(
    <>
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.5" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.5" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.5" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1.5" />
    </>,
  );

export const AuditIcon = () => svg(<path d="M2.5 4h11M2.5 8h7M2.5 12h5" strokeLinecap="round" />);

export const UsersIcon = () =>
  svg(
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M2 13c0-2.76 2.69-5 6-5s6 2.24 6 5" strokeLinecap="round" />
    </>,
  );

export const SessionsIcon = () =>
  svg(
    <>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 3.5V2.5M10.5 3.5V2.5" strokeLinecap="round" />
      <circle cx="8" cy="8.5" r="2" />
    </>,
  );

export const RolesIcon = () =>
  svg(
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 5v3l2 2" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  );

export const OrgsIcon = () =>
  svg(
    <>
      <rect x="6" y="1.5" width="4" height="4" rx="1" />
      <rect x="1.5" y="10.5" width="4" height="4" rx="1" />
      <rect x="10.5" y="10.5" width="4" height="4" rx="1" />
      <path d="M8 5.5v2.5M8 8H4M8 8h4M4 10.5V8M12 10.5V8" strokeLinecap="round" />
    </>,
  );

export const ClientsIcon = () =>
  svg(
    <>
      <path d="M7 2.5H3.5a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1V9" strokeLinecap="round" />
      <path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  );

export const AgentsIcon = () =>
  svg(
    <>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2.5V5M6 9h.01M10 9h.01M1.5 9v1.5M14.5 9v1.5" strokeLinecap="round" />
    </>,
  );

export const KeysIcon = () =>
  svg(
    <>
      <circle cx="5" cy="8" r="3" />
      <path d="M8 8h6.5M12.5 8v2.5M10.5 8v2" strokeLinecap="round" />
    </>,
  );

export const SettingsIcon = () =>
  svg(
    <>
      <circle cx="8" cy="8" r="2" />
      <path
        d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M3.05 12.95l1.42-1.42M11.53 4.47l1.42-1.42"
        strokeLinecap="round"
      />
    </>,
  );

/** The AuthKit mark: a check in a ring, in `currentColor`. */
export const AuthkitMark = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" />
    <path d="M5 8l2.5 2.5L11 5.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
