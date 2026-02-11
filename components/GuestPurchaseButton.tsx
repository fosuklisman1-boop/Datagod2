"use client"

import { useEffect, useState } from 'react'

interface GuestPurchaseButtonProps {
    variant?: 'primary' | 'secondary' | 'outline'
    className?: string
}

export default function GuestPurchaseButton({ variant = 'outline', className = '' }: GuestPurchaseButtonProps) {
    const [config, setConfig] = useState<{ url: string | null, text: string }>({ url: null, text: 'Buy as Guest' })
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetchConfig()
    }, [])

    const fetchConfig = async () => {
        try {
            const response = await fetch('/api/support-config')
            const data = await response.json()

            setConfig({
                url: data.guestPurchaseUrl,
                text: data.guestPurchaseButtonText || 'Buy as Guest'
            })
        } catch (error) {
            console.error('Failed to fetch guest purchase config:', error)
        } finally {
            setLoading(false)
        }
    }

    // Don't render if no URL is configured or still loading
    if (loading || !config.url) {
        return null
    }

    const buttonStyles = {
        primary: 'bg-blue-600 hover:bg-blue-700 text-white',
        secondary: 'bg-gray-600 hover:bg-gray-700 text-white',
        outline: 'border-2 border-blue-600 text-blue-600 hover:bg-blue-50'
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
