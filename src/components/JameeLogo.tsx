import type { CSSProperties } from 'react';

export interface JameeLogoProps {
  className?: string | undefined;
  size?: number;
}

export function JameeLogo({ className, size = 44 }: JameeLogoProps): React.JSX.Element {
  const style: CSSProperties = { width: size, height: size };

  return (
    <span className={className} style={style} aria-hidden="true">
      <svg viewBox="0 0 40 40" focusable="false">
        <path d="M32.7 6.8C21.3 6.2 12.1 11 9.2 20.7c-1.3 4.6.3 9 3.7 11.8 2.8-8.7 8.3-15 16.5-19-6.9 5.4-11.2 11.7-12.7 19.1 5.7.8 10.7-1.7 13.3-6.4 3.2-5.5 3-12.7 2.7-19.4Z" />
        <path d="M9.4 25.3c-2.8-1.4-4.7-3.8-5.7-7.2 3.1-.2 5.7.5 7.7 2" />
      </svg>
    </span>
  );
}
