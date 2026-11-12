"use client"

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useThreadForm } from "@/hooks/use-thread-form"
import { ThreadFormFields } from "./thread-form-fields"

export interface ReportProblemOrder {
  /** "none" = order type that cannot be linked; the subject names the order instead. */
  kind: "order" | "shop_order" | "none"
  id: string | null
  reference: string | null
  subject?: string
  summary: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: ReportProblemOrder
}

export function ReportProblemDialog({ open, onOpenChange, order }: Props) {
  const form = useThreadForm(open, () => onOpenChange(false))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Report a problem</DialogTitle>
          <DialogDescription>{order.summary}</DialogDescription>
        </DialogHeader>
        <ThreadFormFields form={form} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.submitting}>
            Cancel
          </Button>
          <Button
            disabled={form.submitting}
            onClick={() => form.submit({
                kind: order.kind,
                id: order.id ?? undefined,
                reference: order.reference,
                subject: order.subject,
              })}
          >
            {form.submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send complaint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
