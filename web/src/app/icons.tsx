// Icons from the design handoff (Lucide paths, stroke 1.75). Decorative: always aria-hidden.
import type { ReactNode } from "react";

type P = { s?: 12 | 14 | 16 | 18 | 20 | 24; className?: string; style?: React.CSSProperties };
const mk = (paths: ReactNode, strokeWidth?: number) =>
  function Icon({ s = 16, className, style }: P) {
    return (
      <svg className={`i${s !== 16 ? ` s${s}` : ""}${className ? ` ${className}` : ""}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ ...(strokeWidth ? { strokeWidth } : {}), ...style }}>
        {paths}
      </svg>
    );
  };

export const ICheck = mk(<path d="M20 6 9 17l-5-5" />, 2.4);
export const ICopy = mk(
  <>
    <rect width="14" height="14" x="8" y="8" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>,
);
export const IUp = mk(
  <>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </>,
  2.2,
);
export const IInfo = mk(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </>,
);
export const IEdit = mk(
  <>
    <path d="M21.17 6.81a1 1 0 0 0-3.99-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
    <path d="m15 5 4 4" />
  </>,
);
export const IPlus = mk(
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>,
);
export const IChev = mk(<path d="m9 18 6-6-6-6" />);
export const IDown = mk(<path d="m6 9 6 6 6-6" />);
export const IMore = mk(
  <>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </>,
);
export const IFlame = mk(
  <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />,
);
export const ITerm = mk(
  <>
    <path d="m4 17 6-6-6-6" />
    <path d="M12 19h8" />
  </>,
);
export const IRefresh = mk(
  <>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </>,
);
export const IKey = mk(
  <>
    <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
    <path d="m21 2-9.6 9.6" />
    <circle cx="7.5" cy="15.5" r="5.5" />
  </>,
);
export const IClock = mk(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </>,
);
export const IAlert = mk(
  <>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </>,
);
export const IWifi = mk(
  <>
    <path d="M12 20h.01" />
    <path d="M8.5 16.43a5 5 0 0 1 7 0" />
    <path d="M5 12.86a10 10 0 0 1 5.17-2.69" />
    <path d="M19 12.86a10 10 0 0 0-2-1.55" />
    <path d="M2 8.82a15 15 0 0 1 4.18-2.65" />
    <path d="M22 8.82a15 15 0 0 0-11.29-3.76" />
    <path d="m2 2 20 20" />
  </>,
);
export const IFolder = mk(<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />);
export const IDl = mk(
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </>,
);
export const IPower = mk(
  <>
    <path d="M12 2v10" />
    <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
  </>,
);
export const IUndo = mk(
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </>,
);
// lucide rotate-ccw
export const IRetry = mk(
  <>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </>,
);
export const IBranch = mk(
  <>
    <line x1="6" x2="6" y1="3" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </>,
);
export const IPlate = mk(
  <>
    <circle cx="12" cy="14" r="7" />
    <circle cx="12" cy="14" r="3.5" />
    <path d="M5 21h14" />
  </>,
);
export const IShape = mk(
  <>
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <path d="M14 6.5h4a2 2 0 0 1 2 2V10" />
    <path d="M10 17.5H6a2 2 0 0 1-2-2V14" />
  </>,
);
export const IX = mk(
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
);
export const ISq = mk(<rect width="10" height="10" x="7" y="7" rx="2" fill="currentColor" stroke="none" />);
export const ISpark = mk(
  <>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
  </>,
  2,
);
export const ISun = mk(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2m-7.07-2.93 1.41-1.41M17.66 6.34l1.41-1.41M2 12h2m16 0h2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41" />
  </>,
);
export const IMoon = mk(<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />);
export const ISwap = mk(
  <>
    <path d="m16 3 4 4-4 4" />
    <path d="M20 7H4" />
    <path d="m8 21-4-4 4-4" />
    <path d="M4 17h16" />
  </>,
);

export function Mark({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6 16 14 6M11 19l7-9" />
    </svg>
  );
}
/** Plug: "Use in your editor" (v1.2 item 1). */
export const IPlug = mk(<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5" />);
export const IMsg = mk(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);
export const IUser = mk(
  <>
    <circle cx="12" cy="8" r="5" />
    <path d="M20 21a8 8 0 0 0-16 0" />
  </>,
);
export const IMax = mk(
  <>
    <path d="M15 3h6v6" />
    <path d="M9 21H3v-6" />
    <path d="m21 3-7 7" />
    <path d="m3 21 7-7" />
  </>,
);
export const IMinus = mk(<path d="M5 12h14" />);
// Item 6 (Activity): Lucide circle-help, file-text, workflow, check-check, file-diff, activity, arrow-up-right, circle-alert.
export const IHelp = mk(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </>,
);
export const IFile = mk(
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </>,
);
export const IFlow = mk(
  <>
    <rect width="8" height="8" x="3" y="3" rx="2" />
    <path d="M7 11v4a2 2 0 0 0 2 2h4" />
    <rect width="8" height="8" x="13" y="13" rx="2" />
  </>,
);
export const ICheck2 = mk(
  <>
    <path d="M18 6 7 17l-5-5" />
    <path d="m22 10-7.5 7.5L13 16" />
  </>,
);
export const IFileDiff = mk(
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M9 10h6" />
    <path d="M12 13V7" />
    <path d="M9 17h6" />
  </>,
);
export const IActivity = mk(<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />);
export const IOut = mk(
  <>
    <path d="M7 7h10v10" />
    <path d="M7 17 17 7" />
  </>,
);
export const ICircleAlert = mk(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4" />
    <path d="M12 16h.01" />
  </>,
);
