export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="nodal-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3ddc97" />
          <stop offset="1" stopColor="#7aa2f7" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#nodal-g)" />
      <path d="M14 42 H24 L30 22 L36 42 L42 22 H50" fill="none" stroke="#0f1320" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="14" cy="42" r="4.5" fill="#0f1320" />
      <circle cx="50" cy="22" r="4.5" fill="#0f1320" />
    </svg>
  );
}
