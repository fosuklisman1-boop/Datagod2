"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useThreadForm } from "@/hooks/use-thread-form"
import { SUPPORT_CATEGORIES } from "@/lib/support-validation"
import { ThreadFormFields } from "./thread-form-fields"

const CATEGORY_LABELS: Record<(typeof SUPPORT_CATEGORIES)[number], string> = {
  order: "An order",
  payment: "A payment",
  account: "My account",
  other: "Something else",
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** A complaint not tied to a specific order. */
export function NewComplaintDialog({ open, onOpenChange }: Props) {
  const form = useThreadForm(open, () => onOpenChange(false))
  const [subject, setSubject] = useState("")
  const [category, setCategory] = useState<string>("other")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New complaint</DialogTitle>
          <DialogDescription>Tell us what happened and support will reply in this chat.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-subject">Subject</Label>
            <Input id="new-subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>What is it about?</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORT_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ThreadFormFields form={form} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.submitting}>
            Cancel
          </Button>
          <Button
            disabled={form.submitting || subject.trim().length < 3}
            onClick={() => {
              void form.submit({ kind: "general", subject: subject.trim(), category }, [subject])
            }}
          >
            {form.submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send complaint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
