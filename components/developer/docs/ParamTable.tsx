// components/developer/docs/ParamTable.tsx
import type { V2Param } from "@/lib/api-v2/docs/registry"
import { RichText } from "./RichText"

/** Parameter table (name, type, required, description). Scrolls horizontally inside its own box on narrow screens. */
export function ParamTable({ params }: { params: V2Param[] }) {
  if (params.length === 0) return null
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="bg-muted/60 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-semibold">Name</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Type</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Required</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Description</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {params.map((p) => (
            <tr key={p.name} className="align-top">
              <td className="whitespace-nowrap px-4 py-3 font-mono text-[13px] font-semibold text-foreground">{p.name}</td>
              <td className="whitespace-nowrap px-4 py-3 font-mono text-[12.5px] text-muted-foreground">{p.type}</td>
              <td className="whitespace-nowrap px-4 py-3">
                {p.required ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">Required</span>
                ) : (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Optional</span>
                )}
              </td>
              <td className="px-4 py-3 leading-6 text-muted-foreground">
                <RichText text={p.description} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
