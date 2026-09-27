export type StatusPillVariant = 'success' | 'warning' | 'danger'

export function statusPillClasses(variant: StatusPillVariant): string {
  switch (variant) {
    case 'success':
      return 'bg-success/10 text-success border border-success/30'
    case 'warning':
      return 'bg-warning/10 text-warning border border-warning/30'
    case 'danger':
      return 'bg-destructive/10 text-destructive border border-destructive/30'
  }
}
