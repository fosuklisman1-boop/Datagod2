'use client'

import React, { useMemo } from 'react'
import Image from 'next/image'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Loader2, Network } from 'lucide-react'

export interface Network {
  id: string
  name: string
  slug: string
  logo_url?: string
  description?: string
}

interface StepSelectorProps {
  networks: Network[]
  selectedNetworkId?: string
  onSelect: (network: Network) => void
  isLoading?: boolean
  canProceed?: boolean
}

const getNetworkColor = (slug: string): string => {
  const colors: Record<string, string> = {
    'mtn-ghana': 'border-yellow-400 hover:border-yellow-500 bg-yellow-50/30',
    'vodafone-ghana': 'border-red-400 hover:border-red-500 bg-red-50/30',
    'airtel-tigo': 'border-green-400 hover:border-green-500 bg-green-50/30',
    'at-mobile': 'border-blue-400 hover:border-blue-500 bg-blue-50/30',
  }
  return colors[slug] || 'border-gray-300 hover:border-gray-400 bg-gray-50/30'
}

export const StepSelector: React.FC<StepSelectorProps> = ({
  networks,
  selectedNetworkId,
  onSelect,
  isLoading = false,
  canProceed = false,
}) => {
  const networksByGroup = useMemo(() => {
    return networks.reduce(
      (acc, network) => {
        acc[network.slug] = network
        return acc
      },
      {} as Record<string, Network>
    )
  }, [networks])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Select Mobile Network</h2>
        <p className="text-sm text-gray-600">
          Choose the mobile network you want to purchase airtime or data from
        </p>
      </div>

      <RadioGroup value={selectedNetworkId || ''} onValueChange={(id) => {
        const network = networks.find((n) => n.id === id)
        if (network) onSelect(network)
      }}>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {networks.map((network) => (
            <div key={network.id} className="relative">
              <RadioGroupItem
                value={network.id}
                id={`network-${network.id}`}
                className="sr-only"
              />
              <Label htmlFor={`network-${network.id}`} className="cursor-pointer">
                <Card
                  className={`h-full transition-all duration-200 cursor-pointer border-2 ${
                    selectedNetworkId === network.id
                      ? 'border-primary shadow-lg'
                      : getNetworkColor(network.slug)
                  }`}
                >
                  <CardContent className="pt-6 pb-4">
                    <div className="space-y-4 text-center">
                      {network.logo_url && (
                        <div className="relative h-16 w-full flex items-center justify-center">
                          <Image
                            src={network.logo_url}
                            alt={network.name}
                            width={64}
                            height={64}
                            className="object-contain"
                            priority
                          />
                        </div>
                      )}
                      <div>
                        <h3 className="font-semibold text-sm">{network.name}</h3>
                        {network.description && (
                          <p className="text-xs text-gray-600 mt-1">{network.description}</p>
                        )}
                      </div>
                      {selectedNetworkId === network.id && (
                        <div className="flex items-center justify-center gap-1 text-xs font-medium text-primary">
                          <span className="h-2 w-2 rounded-full bg-primary"></span>
                          Selected
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Label>
            </div>
          ))}
        </div>
      </RadioGroup>

      {networks.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="pt-12 pb-12 text-center">
            <Network className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-sm text-gray-500">No networks available</p>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2 pt-4">
        <Button
          onClick={() => {
            const selected = networks.find((n) => n.id === selectedNetworkId)
            if (selected) onSelect(selected)
          }}
          disabled={!selectedNetworkId || isLoading || !canProceed}
          className="ml-auto"
        >
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Continue to Packages
        </Button>
      </div>
    </div>
  )
}
