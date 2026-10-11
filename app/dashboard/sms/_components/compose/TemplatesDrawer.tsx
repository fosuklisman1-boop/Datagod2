import { Copy, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { TenantTemplate } from "./types"

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  templates: TenantTemplate[]
  busy: boolean
  onLoad: (t: TenantTemplate) => void
  onDelete: (id: string) => void
}

export function TemplatesDrawer({ open, onOpenChange, templates, busy, onLoad, onDelete }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2"><Copy className="h-4 w-4 text-primary" /> Message Templates</SheetTitle>
          <SheetDescription>Tap a template to load it into your message.</SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          {templates.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No templates yet. Write a message, then choose <span className="font-medium">Save as template</span>.
            </p>
          ) : (
            <ul className="divide-y">
              {templates.map((tpl) => (
                <li key={tpl.id} className="flex items-center justify-between gap-3 py-2">
                  <button type="button" onClick={() => onLoad(tpl)} className="min-w-0 flex-1 text-left">
                    <p className="font-medium">{tpl.name}</p>
                    <p className="truncate text-sm text-muted-foreground">{tpl.body}</p>
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => onDelete(tpl.id)} disabled={busy} className="text-destructive hover:text-destructive" aria-label={`Delete ${tpl.name}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
