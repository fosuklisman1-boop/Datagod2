"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, ArrowRight, type LucideIcon } from "lucide-react"

export interface StorefrontCarouselSlide {
  key: string
  badge: string
  title: string
  description: string
  cta: string
  icon: LucideIcon
  gradient: string
  onClick: () => void
}

interface Props {
  slides: StorefrontCarouselSlide[]
}

// Same real carousel mechanics as the logged-in dashboard's promo carousel
// (app/dashboard/page.tsx PROMO_SERVICES track): horizontally-scrollable
// snap track, auto-advance every 5s, manual swipe stays in sync, dot
// indicators + arrow buttons. Extracted here so the storefront can reuse it
// with its own slide content instead of duplicating the mechanics inline.
export function StorefrontServicesCarousel({ slides }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)

  const scrollTo = (i: number) => {
    const el = scrollRef.current
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" })
    setIndex(i)
  }

  useEffect(() => {
    if (slides.length <= 1) return
    const interval = setInterval(() => {
      setIndex((i) => {
        const next = (i + 1) % slides.length
        const el = scrollRef.current
        if (el) el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" })
        return next
      })
    }, 5000)
    return () => clearInterval(interval)
  }, [slides.length])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el || el.clientWidth === 0) return
    setIndex(Math.round(el.scrollLeft / el.clientWidth))
  }

  if (slides.length === 0) return null

  return (
    <div>
      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex overflow-x-auto snap-x snap-mandatory scroll-smooth rounded-2xl [&::-webkit-scrollbar]:hidden"
          style={{ scrollbarWidth: "none" }}
        >
          {slides.map((slide) => (
            <button
              key={slide.key}
              onClick={slide.onClick}
              className={`relative block w-full shrink-0 snap-start overflow-hidden rounded-2xl bg-gradient-to-br ${slide.gradient} p-5 pr-28 text-left sm:pr-36`}
            >
              <span className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
              <span className="pointer-events-none absolute -bottom-10 left-16 h-28 w-28 rounded-full bg-white/5 blur-xl" />
              <span className="absolute right-12 top-1/2 flex h-16 w-16 -translate-y-1/2 items-center justify-center rounded-2xl border border-white/20 bg-white/15 text-white sm:right-16 sm:h-20 sm:w-20">
                <slide.icon className="h-7 w-7 sm:h-9 sm:w-9" />
              </span>
              <span className="relative inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-white">
                <slide.icon className="h-3.5 w-3.5" /> {slide.badge}
              </span>
              <p className="relative mt-4 text-lg font-bold text-white">{slide.title}</p>
              <p className="relative mt-1 max-w-md text-sm text-white/80">{slide.description}</p>
              <span className="relative mt-4 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-bold text-foreground">
                {slide.cta} <ArrowRight className="h-3.5 w-3.5" />
              </span>
            </button>
          ))}
        </div>

        {slides.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous service"
              onClick={() => scrollTo((index - 1 + slides.length) % slides.length)}
              className="absolute left-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/25 text-white hover:bg-black/40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Next service"
              onClick={() => scrollTo((index + 1) % slides.length)}
              className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/25 text-white hover:bg-black/40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
      {slides.length > 1 && (
        <div className="-mt-3 flex justify-center gap-1.5">
          {slides.map((slide, i) => (
            <button
              key={slide.key}
              aria-label={`Show ${slide.title}`}
              onClick={() => scrollTo(i)}
              className={`h-1.5 rounded-full transition-all ${i === index ? "w-5 bg-foreground/70" : "w-1.5 bg-muted-foreground/30"}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
