/** True when switching tabs should be cancelled: dirty edits and the admin did not confirm leaving. */
export function shouldBlockTabSwitch(dirty: boolean, current: string, next: string, confirmLeave: () => boolean): boolean {
  if (next === current || !dirty) return false
  return !confirmLeave()
}
