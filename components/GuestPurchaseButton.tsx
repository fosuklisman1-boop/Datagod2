"use client"

import { useEffect, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

interface GuestPurchaseButtonProps {
    variant?: 'primary' | 'secondary' | 'outline'
    className?: string
}

const CACHE_KEY = "dg_guest_config"

function getCached(): { url: string | null, text: string } | null {
    if (typeof window === "undefined") return null
    const raw = sessionStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : null
}

export default function GuestPurchaseButton({ variant = 'outline', className = '' }: GuestPurchaseButtonProps) {
    const [config, setConfig] = useState<{ url: string | null, text: string }>(
        () => getCached() ?? { url: null, text: 'Buy as Guest' }
    )
    const [loading, setLoading] = useState<boolean>(() => getCached() === null)

    useEffect(() => {
        if (!loading) return
        fetch('/api/support-config')
            .then(r => r.json())
            .then(data => {
                const next = {
                    url: data.guestPurchaseUrl ?? null,
                    text: data.guestPurchaseButtonText || 'Buy as Guest'
                }
                setConfig(next)
                sessionStorage.setItem(CACHE_KEY, JSON.stringify(next))
            })
            .catch(() => {})
            .finally(() => setLoading(false))
    }, [])

    if (loading) {
        return <Skeleton className={`h-11 rounded-md ${className}`} />
    }

    if (!config.url) return null

    const buttonStyles = {
        primary: 'bg-primary hover:bg-primary/90 text-white',
        secondary: 'bg-gray-600 hover:bg-gray-700 text-white',
        outline: 'border-2 border-primary text-primary hover:bg-primary/5'
    }

    return (
        <a
            href={config.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center justify-center px-6 py-3 rounded-lg font-semibold transition-colors ${buttonStyles[variant]} ${className}`}
        >
            {config.text}
        </a>
    )
}
