import React from 'react'

interface ManaLogoProps {
  size?: number
  className?: string
}

export const ManaLogo: React.FC<ManaLogoProps> = ({ size = 24, className }) => {
  return (
    <img
      src="/mana-eagle.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={['mana-logo-emblem', className].filter(Boolean).join(' ')}
      style={{ objectFit: 'contain' }}
    />
  )
}
