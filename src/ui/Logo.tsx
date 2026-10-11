export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="nodal-g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ecd29a" />
          <stop offset="1" stopColor="#b08234" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#100e0b" />
      <rect x="2.75" y="2.75" width="58.5" height="58.5" rx="15.25" fill="none" stroke="url(#nodal-g)" strokeOpacity="0.6" strokeWidth="1.5" />
      <path d="M14 42 H24 L30 22 L36 42 L42 22 H50" fill="none" stroke="url(#nodal-g)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="14" cy="42" r="4.5" fill="url(#nodal-g)" />
      <circle cx="50" cy="22" r="4.5" fill="url(#nodal-g)" />
    </svg>
  );
}
