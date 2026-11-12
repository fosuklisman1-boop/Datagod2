import Image from "next/image"

/** The DATAGOD logo: the 318KB 512px PWA icon, only ever shown at 32-96px. */
export const DEFAULT_LOGO = "/icons/icon-512x512.png"

/**
 * The DATAGOD logo goes through next/image, which serves it resized (and as
 * AVIF/WebP). A custom domain's own logo is an arbitrary remote URL that
 * next/image isn't configured for, so it stays a plain <img>.
 */
export function BrandLogo({
  src,
  alt,
  size,
  className,
  priority,
}: {
  src: string
  alt: string
  size: number
  className?: string
  priority?: boolean
}) {
  if (src === DEFAULT_LOGO) {
    return <Image src={src} alt={alt} width={size} height={size} className={className} priority={priority} />
  }
  // eslint-disable-next-line @next/next/no-img-element -- remote custom-domain logo
  return <img src={src} alt={alt} width={size} height={size} className={className} />
}
