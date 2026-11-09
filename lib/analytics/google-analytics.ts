import { isMainSiteHost } from "@/lib/seo/main-site-host"

export const GA_MEASUREMENT_ID = "G-2K4DGTV07P"

/**
 * Never measured: their URLs can carry reset tokens, order ids and payment
 * references, and Google's terms forbid sending personal data. Shop paths are
 * resellers' stores, not Datagod's own traffic.
 */
const EXCLUDED_PREFIXES = ["/admin", "/auth", "/dashboard", "/shop", "/api"] as const

export function isGaPathAllowed(pathname: string): boolean {
  return !EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/** Production main site only: no shops, custom domains, previews or local dev. */
export function shouldLoadGa(input: {
  host: string | null
  vercelEnv: string | undefined
  rootDomain?: string
}): boolean {
  if (input.vercelEnv !== "production" || !input.host) return false
  return isMainSiteHost(input.host, input.rootDomain)
}

/**
 * Inline script for the root layout. Same setup as Google's snippet, except
 * gtag.js is added only once a visitor is on an allowed page, so Google's code
 * never runs on a private page opened directly. `ga-disable-<id>` is Google's
 * documented switch for stopping collection after a client-side navigation.
 */
export function gaBootstrapScript(): string {
  return `(function(){
var id=${JSON.stringify(GA_MEASUREMENT_ID)};
var excluded=${JSON.stringify(EXCLUDED_PREFIXES)};
var loaded=false;
function blocked(p){return excluded.some(function(e){return p===e||p.indexOf(e+'/')===0})}
window.dataLayer=window.dataLayer||[];
window.gtag=function(){window.dataLayer.push(arguments)};
window.__dgGaSync=function(p){
var off=blocked(p);
window['ga-disable-'+id]=off;
if(off||loaded)return;
loaded=true;
window.gtag('js',new Date());
window.gtag('config',id);
var s=document.createElement('script');
s.async=true;
s.src='https://www.googletagmanager.com/gtag/js?id='+id;
document.head.appendChild(s);
};
window.__dgGaSync(location.pathname);
})();`
}
