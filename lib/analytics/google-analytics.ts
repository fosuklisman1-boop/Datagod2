import { isMainSiteHost } from "@/lib/seo/main-site-host"

export const GA_MEASUREMENT_ID = "G-2K4DGTV07P"

/**
 * Never measured: their URLs can carry reset tokens, order ids and payment
 * references, and Google's terms forbid sending personal data. Shop paths are
 * resellers' stores, not Datagod's own traffic.
 */
const EXCLUDED_PREFIXES = ["/admin", "/auth", "/dashboard", "/shop", "/api"] as const

/**
 * The exceptions inside /auth, so Google Ads can count sign-ups. GA runs here
 * from page load (a sign-up event sent after a cold load of gtag.js would often
 * be lost), with the reported URL trimmed to the path plus ad tags.
 */
const SIGNUP_PATHS = ["/auth/signup", "/auth/complete-profile"] as const

/** Query keys kept on sign-up pages: ad-click ids and campaign tags only. */
const KEPT_QUERY_KEYS = ["gclid", "gbraid", "wbraid", "dclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const

export function isGaPathAllowed(pathname: string): boolean {
  if ((SIGNUP_PATHS as readonly string[]).includes(pathname)) return true
  return !EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * False for Supabase's look-alike success when the email is already registered
 * (no error, empty `identities`), so it isn't counted as a new sign-up.
 */
export function shouldReportSignUp(user: { identities?: unknown[] | null } | null | undefined): boolean {
  if (!user) return false
  return !(Array.isArray(user.identities) && user.identities.length === 0)
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
 * On the sign-up pages the first page view reports a trimmed URL.
 */
export function gaBootstrapScript(): string {
  return `(function(){
var id=${JSON.stringify(GA_MEASUREMENT_ID)};
var excluded=${JSON.stringify(EXCLUDED_PREFIXES)};
var signup=${JSON.stringify(SIGNUP_PATHS)};
var kept=${JSON.stringify(KEPT_QUERY_KEYS)};
var loaded=false;
function isSignup(p){return signup.indexOf(p)!==-1}
function blocked(p){return !isSignup(p)&&excluded.some(function(e){return p===e||p.indexOf(e+'/')===0})}
function trimmed(){
var q=[];
try{var sp=new URLSearchParams(location.search);kept.forEach(function(k){var v=sp.get(k);if(v)q.push(k+'='+encodeURIComponent(v))})}catch(e){}
return location.origin+location.pathname+(q.length?'?'+q.join('&'):'');
}
window.dataLayer=window.dataLayer||[];
window.gtag=function(){window.dataLayer.push(arguments)};
window.__dgGaSync=function(p){
var off=blocked(p);
window['ga-disable-'+id]=off;
if(off||loaded)return;
loaded=true;
window.gtag('js',new Date());
if(isSignup(p)){window.gtag('config',id,{page_location:trimmed()})}else{window.gtag('config',id)}
var s=document.createElement('script');
s.async=true;
s.src='https://www.googletagmanager.com/gtag/js?id='+id;
document.head.appendChild(s);
};
window.__dgGaSignUp=function(method,done){
var finished=false;
function finish(){if(finished)return;finished=true;done()}
setTimeout(finish,2000);
if(!loaded||!isSignup(location.pathname))return finish();
window.gtag('event','sign_up',{method:method,page_location:trimmed(),event_callback:finish,event_timeout:2000});
};
window.__dgGaSync(location.pathname);
})();`
}
