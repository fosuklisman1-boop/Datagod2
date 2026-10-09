"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { Zap, Download, Apple, Bot, Laptop, Share } from "lucide-react"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { isPageHidden } from "@/lib/custom-domains"
import { usePwaInstall } from "@/hooks/use-pwa-install"

interface SupportConfig {
  whatsapp?: string
  guestPurchaseUrl?: string | null
  guestPurchaseButtonText?: string
}

interface CommunityLinks {
  join_community_link?: string
  join_group_link?: string
  /** Main DATAGOD WhatsApp bot, international digits (233…). "" = unset. */
  whatsapp_bot_number?: string
}

// Claymorphism: no utility shadows here — they'd override the clay-* box-shadows
// (Tailwind v3 emits utilities after the components layer).
const pill = "flex h-14 w-full items-center justify-center gap-2 rounded-full px-6 text-base font-semibold transition-all active:translate-y-0.5"
const PILL = {
  primary: `${pill} clay-btn bg-[#1b388b] text-primary-foreground hover:bg-[#1b388b]/90`,
  muted: `${pill} clay-sm bg-[#dfe7fb] text-foreground dark:bg-[#1e2740]`,
  outline: `${pill} clay-sm text-foreground`,
  accentOutline: `${pill} clay-sm text-[#1b388b] dark:text-foreground`,
  success: `${pill} clay-btn bg-success text-success-foreground hover:bg-success/90`,
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mb-5 text-sm font-bold uppercase tracking-[0.3em] text-[#1b388b]">{children}</p>
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="font-display text-4xl font-black leading-[1.05] tracking-tight text-foreground sm:text-5xl">{children}</h2>
}

function Body({ children }: { children: ReactNode }) {
  return <p className="mt-6 text-lg leading-relaxed text-muted-foreground">{children}</p>
}

// "DATAGOD" -> DATA + GOD; "Clings Hub" -> Clings + Hub; other single words stay one color.
function splitWordmark(name: string): [string, string] {
  const trimmed = name.trim()
  const space = trimmed.indexOf(" ")
  if (space > 0) return [trimmed.slice(0, space), trimmed.slice(space)]
  if (trimmed.toUpperCase() === "DATAGOD") return [trimmed.slice(0, 4), trimmed.slice(4)]
  return [trimmed, ""]
}

export function HeroCarousel() {
  const domainBranding = useDomainBranding()
  const siteName = domainBranding.siteName || "DATAGOD"
  // DATAGOD's own logo on the main site; a custom domain without its own logo
  // gets the neutral placeholder, never DATAGOD branding.
  const logoSrc = domainBranding.logoUrl || (domainBranding.siteName ? null : "/icons/icon-512x512.png")
  const [wordA, wordB] = splitWordmark(siteName)
  const guestHidden = isPageHidden("guest_purchase", domainBranding.hiddenPages)
  const communityHidden = isPageHidden("join_channel", domainBranding.hiddenPages)

  const [support, setSupport] = useState<SupportConfig>({})
  const [links, setLinks] = useState<CommunityLinks>({})
  const { mode: installMode, promptInstall } = usePwaInstall()
  const [showInstallGuide, setShowInstallGuide] = useState(false)

  useEffect(() => {
    fetch("/api/support-config").then((r) => (r.ok ? r.json() : {})).then(setSupport).catch(() => {})
    fetch("/api/app-settings").then((r) => (r.ok ? r.json() : {})).then(setLinks).catch(() => {})
  }, [])

  const guestUrl = !guestHidden ? support.guestPurchaseUrl : null
  const wordmark = (
    <>
      {wordA}
      {wordB && <span className="text-[#1b388b]">{wordB}</span>}
    </>
  )

  const onDownloadApp = async () => {
    if (installMode === "android" && (await promptInstall())) return
    setShowInstallGuide((v) => !v)
  }

  const slides: ReactNode[] = [
    <div key="welcome">
      <Eyebrow>Welcome to</Eyebrow>
      <Heading>{wordmark}</Heading>
      <Body>Ghana&apos;s all-in-one platform for mobile data, airtime, AFA, Results Checkers, bulk SMS and business growth. Instant delivery, always.</Body>
      <div className="mt-10 space-y-4">
        <Link href="/auth/login" className={PILL.primary}>Sign In</Link>
        <Link href="/auth/signup" className={PILL.muted}>Create Account</Link>
        {guestUrl && (
          <a href={guestUrl} target="_blank" rel="noopener noreferrer" className={PILL.outline}>
            {support.guestPurchaseButtonText || "Buy as Guest"}
          </a>
        )}
        {installMode !== "installed" && (
          <>
            <button type="button" onClick={onDownloadApp} className={PILL.accentOutline}>
              <Download className="h-5 w-5 text-[#1b388b]" /> Download App
              <span className="ml-2 flex items-center gap-1.5 text-muted-foreground">
                <Apple className="h-4 w-4" /><Bot className="h-4 w-4" /><Laptop className="h-4 w-4" />
              </span>
            </button>
            {showInstallGuide && (
              <div className="rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                {installMode === "ios" ? (
                  <p>In Safari, tap <Share className="inline h-4 w-4 text-[#1b388b]" /> <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</p>
                ) : (
                  <p>Open your browser menu (⋮) and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>,

    <div key="data">
      <Eyebrow>Data Bundles</Eyebrow>
      <Heading>Instant data for MTN, Telecel &amp; AT</Heading>
      <Body>Affordable bundles on every network — including AT iShare and BigTime — delivered in seconds, straight from your wallet.</Body>
      <div className="mt-10 space-y-4">
        <Link href="/auth/signup" className={PILL.primary}>Buy Data</Link>
        {guestUrl && (
          <a href={guestUrl} target="_blank" rel="noopener noreferrer" className={PILL.outline}>Buy as Guest</a>
        )}
      </div>
    </div>,

    <div key="airtime">
      <Eyebrow>Airtime Top-Up</Eyebrow>
      <Heading>Top up airtime on any network</Heading>
      <Body>Send airtime to any MTN, Telecel or AT number in seconds — for yourself or your customers.</Body>
      <div className="mt-10 space-y-4">
        <Link href="/auth/signup" className={PILL.primary}>Buy Airtime</Link>
        {guestUrl && (
          <a href={guestUrl} target="_blank" rel="noopener noreferrer" className={PILL.outline}>Buy as Guest</a>
        )}
      </div>
    </div>,

    <div key="results">
      <Eyebrow>Results Checker</Eyebrow>
      <Heading>WASSCE, BECE &amp; NovDec results</Heading>
      <Body>Buy checker vouchers delivered instantly — or, if you don&apos;t have one, let us check your results for you and send them by email and WhatsApp.</Body>
      <div className="mt-10 space-y-4">
        <Link href="/results-checker" className={PILL.primary}>Get a Checker Voucher</Link>
        <Link href="/auth/signup" className={PILL.outline}>Check My Results For Me</Link>
      </div>
    </div>,

    <div key="afa">
      <Eyebrow>AFA Registration</Eyebrow>
      <Heading>Register AFA numbers without the queue</Heading>
      <Body>Register MTN AFA / iShare numbers for yourself or your community straight from your dashboard — no paperwork, no waiting in line.</Body>
      <div className="mt-10 space-y-4">
        <Link href="/auth/signup" className={PILL.primary}>Register Now</Link>
      </div>
    </div>,

    <div key="sms">
      <Eyebrow>Bulk SMS</Eyebrow>
      <Heading>Send SMS to your customers at scale</Heading>
      <Body>OTPs, alerts and campaigns from your own approved sender ID — with an address book, reusable templates and delivery reports.</Body>
      <div className="mt-10 space-y-4">
        <Link href="/auth/signup" className={PILL.primary}>Start Sending</Link>
      </div>
    </div>,

    <div key="shop">
      <Eyebrow>Reseller Shops</Eyebrow>
      <Heading>Create your own branded storefront in minutes</Heading>
      <Body>Your name, your logo, your prices. Share one link and start earning a profit on every data, airtime and voucher sale — your customers don&apos;t even need an account.</Body>
      <div className="mt-10 space-y-4">
        <Link href="/auth/signup" className={PILL.primary}>Open Your Shop</Link>
        {guestUrl && (
          <a href={guestUrl} target="_blank" rel="noopener noreferrer" className={PILL.outline}>View a Live Shop</a>
        )}
      </div>
    </div>,

    <div key="subagents">
      <Eyebrow>Sub-Agent Program</Eyebrow>
      <Heading>Grow a network of sellers under you</Heading>
      <Body>Invite sub-agents with a link. They get their own storefront and set their own prices on top of yours — and you earn on every sale they make.</Body>
      <div className="mt-10 space-y-4">
        <Link href="/auth/signup" className={PILL.primary}>Start Recruiting</Link>
      </div>
    </div>,

    <div key="channels">
      <Eyebrow>USSD &amp; WhatsApp</Eyebrow>
      <Heading>Order without the website</Heading>
      <Body>Chat with the DATAGOD bot on WhatsApp to buy data, airtime and results checkers — no app to install. Prefer USSD? Dial in from any phone, no internet needed.</Body>
      <div className="mt-10 space-y-4">
        {links.whatsapp_bot_number && (
          <a
            href={`https://wa.me/${links.whatsapp_bot_number}?text=${encodeURIComponent("Hi, I'd like to buy data")}`}
            target="_blank" rel="noopener noreferrer" className={PILL.success}
          >
            Order on WhatsApp
          </a>
        )}
        <Link href="/whatsapp" className={PILL.outline}>How It Works</Link>
      </div>
    </div>,

    <div key="api">
      <Eyebrow>Developer API</Eyebrow>
      <Heading>Automate purchases from your own website or app</Heading>
      <Body>A simple REST API for data bundles, airtime, AFA, results checkers and SMS — get your API key from the dashboard and start building.</Body>
      <div className="mt-10 space-y-4">
        <Link href="/auth/signup" className={PILL.primary}>Get Started</Link>
        <Link href="/dashboard/developer" className={PILL.outline}>View Docs</Link>
      </div>
    </div>,

    <div key="help">
      <Eyebrow>Support &amp; Resources</Eyebrow>
      <Heading>Help &amp; Live Community</Heading>
      <Body>Get direct support, track your complaints, and connect with other resellers inside our community.</Body>
      <div className="mt-10 space-y-4">
        {support.whatsapp && (
          <a href={support.whatsapp} target="_blank" rel="noopener noreferrer" className={PILL.success}>Contact Support</a>
        )}
        {!communityHidden && links.join_group_link && (
          <a href={links.join_group_link} target="_blank" rel="noopener noreferrer" className={PILL.primary}>Join Community Group</a>
        )}
        {!communityHidden && links.join_community_link && (
          <a href={links.join_community_link} target="_blank" rel="noopener noreferrer" className={PILL.outline}>Follow Channel</a>
        )}
      </div>
    </div>,
  ]

  // Same scroll-snap mechanics as components/shop/StorefrontServicesCarousel.tsx;
  // auto-advance stops for good once the visitor touches the carousel, so it
  // never yanks a slide away mid-tap.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const [userInteracted, setUserInteracted] = useState(false)

  const scrollTo = (i: number) => {
    const el = scrollRef.current
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" })
    setIndex(i)
  }

  useEffect(() => {
    if (userInteracted) return
    const id = setInterval(() => {
      setIndex((i) => {
        const next = (i + 1) % slides.length
        const el = scrollRef.current
        if (el) el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" })
        return next
      })
    }, 3000)
    return () => clearInterval(id)
  }, [userInteracted, slides.length])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el || el.clientWidth === 0) return
    setIndex(Math.round(el.scrollLeft / el.clientWidth))
  }

  return (
    <section className="relative overflow-hidden px-4 pb-14 pt-10 sm:pt-14">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-24 top-40 h-96 w-96 rounded-full bg-amber-200/50 blur-3xl" />
        <div className="absolute right-[-6rem] top-24 h-96 w-96 rounded-full bg-blue-300/40 blur-3xl" />
        <div className="absolute bottom-0 left-1/4 h-96 w-96 rounded-full bg-violet-300/40 blur-3xl" />
      </div>

      <div className="mx-auto max-w-xl lg:max-w-2xl">
        <div className="text-center">
          <div className="mx-auto grid h-28 w-28 place-items-center clay-sm">
            {logoSrc ? (
              <img src={logoSrc} alt={`${siteName} logo`} className="h-24 w-24 rounded-full object-cover" />
            ) : (
              <div aria-hidden className="h-16 w-16 rounded-2xl bg-gradient-to-br from-[#1b388b] to-brand-accent" />
            )}
          </div>
          <p className="mt-6 font-display text-3xl font-black tracking-tight text-foreground">{wordmark}</p>
          <span className="mt-6 inline-flex items-center gap-2 clay-sm px-5 py-2.5 text-base font-medium text-foreground">
            <Zap className="h-5 w-5 text-[#1b388b]" /> Ultra Fast Instant Delivery
          </span>
        </div>

        <div
          className="mt-8 clay rounded-[2.5rem]"
          onPointerDown={() => setUserInteracted(true)}
          onFocusCapture={() => setUserInteracted(true)}
        >
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex snap-x snap-mandatory overflow-x-auto [&::-webkit-scrollbar]:hidden"
            style={{ scrollbarWidth: "none" }}
          >
            {slides.map((slide, i) => (
              <div key={i} className="w-full shrink-0 snap-center p-7 sm:p-10">
                {slide}
              </div>
            ))}
          </div>
          <div className="mx-7 flex items-center justify-between border-t border-[#1b388b]/10 py-6 sm:mx-10">
            <div className="flex flex-wrap items-center gap-2">
              {slides.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`Go to slide ${i + 1}`}
                  onClick={() => { setUserInteracted(true); scrollTo(i) }}
                  className={`h-2.5 rounded-full transition-all ${i === index ? "w-8 bg-[#1b388b] shadow-[0_3px_8px_rgba(27,56,139,0.35)]" : "w-2.5 clay-inset"}`}
                />
              ))}
            </div>
            <span className="text-lg font-semibold tabular-nums tracking-wide text-muted-foreground">
              {String(index + 1).padStart(2, "0")} / {String(slides.length).padStart(2, "0")}
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}
