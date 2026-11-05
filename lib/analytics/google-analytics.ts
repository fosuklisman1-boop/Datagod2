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

declare global {
  interface Window {
    __dgGaSignUp?: (method: string, done: () => void) => void
  }
}

/**
 * Reports a completed sign-up. Resolves when sent or after a short timeout, so
 * callers can await it before navigating. Never rejects: analytics must never
 * affect sign-up. Does nothing where the tag isn't rendered (shops, previews).
 */
export function trackSignUp(method: "email" | "google"): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof window === "undefined" || !window.__dgGaSignUp) return resolve()
      window.__dgGaSignUp(method, () => resolve())
    } catch {
      resolve()
    }
  })
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
 *
 * __dgGaSignUp is the one exception on private pages, so Google Ads can count
 * sign-ups: it opens collection for a single event with the query string
 * removed, then closes it again. It sends no page view.
 */
export function gaBootstrapScript(): string {
  return `(function(){
var id=${JSON.stringify(GA_MEASUREMENT_ID)};
var excluded=${JSON.stringify(EXCLUDED_PREFIXES)};
var loaded=false;
function blocked(p){return excluded.some(function(e){return p===e||p.indexOf(e+'/')===0})}
function load(config){
loaded=true;
window.gtag('js',new Date());
if(config){window.gtag('config',id,config)}else{window.gtag('config',id)}
var s=document.createElement('script');
s.async=true;
s.src='https://www.googletagmanager.com/gtag/js?id='+id;
document.head.appendChild(s);
}
window.dataLayer=window.dataLayer||[];
window.gtag=function(){window.dataLayer.push(arguments)};
window.__dgGaSync=function(p){
var off=blocked(p);
window['ga-disable-'+id]=off;
if(off||loaded)return;
load();
};
window.__dgGaSignUp=function(method,done){
var finished=false;
function finish(){
if(finished)return;
finished=true;
window['ga-disable-'+id]=blocked(location.pathname);
done();
}
window['ga-disable-'+id]=false;
if(!loaded)load({send_page_view:false});
window.gtag('event','sign_up',{method:method,page_location:location.origin+location.pathname,event_callback:finish,event_timeout:1500});
setTimeout(finish,1500);
};
window.__dgGaSync(location.pathname);
})();`
}
