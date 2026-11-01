// "Powered by DATAGOD" footer for storefronts on <shop>.datagod.store only
// (page.tsx gates it with showsPoweredByFooter; custom domains are
// white-labelled). No hooks, so both the server summary and the client
// storefront can render it.
const MAIN_SITE = "https://www.datagod.store"

export function PoweredByFooter() {
  return (
    <footer className="max-w-7xl mx-auto px-4 pt-4 pb-8 text-center text-xs text-muted-foreground">
      Powered by{" "}
      <a href={`${MAIN_SITE}/`} className="font-semibold text-foreground hover:text-[var(--shop-accent)] hover:underline">
        DATAGOD
      </a>
      {" · "}
      <a href={`${MAIN_SITE}/join`} className="font-semibold text-foreground hover:text-[var(--shop-accent)] hover:underline">
        Start your own data shop
      </a>
    </footer>
  )
}
