import type { ButtonHTMLAttributes } from 'react'

import styles from './Button.module.css'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'secondary' | 'quiet'
}

export function Button({ className = '', variant = 'primary', type = 'button', ...props }: ButtonProps) {
  return <button className={`${styles.button} ${styles[variant]} ${className}`} type={type} {...props} />
}
