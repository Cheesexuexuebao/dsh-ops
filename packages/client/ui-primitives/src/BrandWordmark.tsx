// 运维智能体 brand wordmark: node-ring mark + Chinese product name.
// Ink rides currentColor.

import type { IconProps } from './icons/props.ts'

/**
 * Render the ops-agent brand wordmark.
 * @param props.size - height in px (default 24; width keeps ~5.5:1).
 * @param props.className - extra class for layout placement.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={(size * 148) / 24}
      height={size}
      className={className}
      viewBox="0 0 148 24"
      fill="none"
      aria-hidden="true"
    >
      <g transform="translate(0,0)">
        <path
          d="M7.2 9.2C8.6 6.8 11 5.4 13.6 5.6"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          opacity="0.55"
        />
        <path
          d="M16.8 9.4C18.4 11.2 18.8 13.8 17.6 16.1"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          opacity="0.55"
        />
        <path
          d="M14.8 18.2C12.2 19.4 9.1 18.8 7.2 16.6"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          opacity="0.55"
        />
        <rect x="4" y="8.5" width="5" height="5" rx="1.4" fill="currentColor" />
        <rect x="14.5" y="4" width="5" height="5" rx="1.4" fill="currentColor" />
        <rect x="12.5" y="15" width="5" height="5" rx="1.4" fill="currentColor" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" opacity="0.85" />
      </g>
      <text
        x="30"
        y="16.5"
        fill="currentColor"
        fontFamily="'IBM Plex Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif"
        fontSize="13"
        fontWeight="600"
        letterSpacing="0.04em"
      >
        运维智能体
      </text>
    </svg>
  )
}
