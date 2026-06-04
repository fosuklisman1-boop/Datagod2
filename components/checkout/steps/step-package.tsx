'use client'

import React, { useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Loader2, Zap, Database } from 'lucide-react'

export interface Package {
  id: string
  name: string
  description?: string
  amount: number
  validity_days?: number
  package_type: 'airtime' | 'data'
  network_id: string
}

interface StepPackageProps {
  packages: Package[]
  selectedPackageId?: string
  onSelect: (pkg: Package) => void
  networkName?: string
  isLoading?: boolean
  canProceed?: boolean
}

const getPackageIcon = (type: 'airtime' | 'data') => {
  return type === 'data' ? (
    <Database className="h-5 w-5 text-blue-500" />
  ) : (
    <Zap className="h-5 w-5 text-yellow-500" />
  )
}

const formatAmount = (amount: number) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'GHS',
    minimumFractionDigits: 0,
  }).format(amount)
}

export const StepPackage: React.FC<StepPackageProps> = ({
  packages,
  selectedPackageId,
  onSelect,
  networkName,
  isLoading = false,
  canProceed = false,
}) => {
  const groupedPackages = useMemo(() => {
    return packages.reduce(
      (acc, pkg) => {
        if (!acc[pkg.package_type]) {
          acc[pkg.package_type] = []
        }
        acc[pkg.package_type].push(pkg)
        return acc
      },
      { airtime: [] as Package[], data: [] as Package[] }
    )
  }, [packages])

  const selectedPackage = packages.find((p) => p.id === selectedPackageId)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Select Package</h2>
        <p className="text-sm text-gray-600">
          {networkName && `Choose a package for ${networkName}`}
        </p>
      </div>

      <RadioGroup value={selectedPackageId || ''} onValueChange={(id) => {
        const pkg = packages.find((p) => p.id === id)
        if (pkg) onSelect(pkg)
      }}>
        <div className="space-y-4">
          {/* Data Packages */}
          {groupedPackages.data.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <Database className="h-5 w-5 text-blue-500" />
                Data Packages
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {groupedPackages.data.map((pkg) => (
                  <div key={pkg.id} className="relative">
                    <RadioGroupItem
                      value={pkg.id}
                      id={`package-${pkg.id}`}
                      className="sr-only"
                    />
                    <Label htmlFor={`package-${pkg.id}`} className="cursor-pointer">
                      <Card
                        className={`h-full transition-all duration-200 cursor-pointer border-2 ${
                          selectedPackageId === pkg.id
                            ? 'border-primary shadow-lg'
                            : 'border-gray-200 hover:border-primary/50'
                        }`}
                      >
                        <CardContent className="pt-4 pb-4">
                          <div className="space-y-3">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <h4 className="font-semibold text-sm">{pkg.name}</h4>
                                {pkg.description && (
                                  <p className="text-xs text-gray-600 mt-1">{pkg.description}</p>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center justify-between pt-2 border-t">
                              <span className="text-sm font-bold text-primary">
                                {formatAmount(pkg.amount)}
                              </span>
                              {pkg.validity_days && (
                                <Badge variant="secondary" className="text-xs">
                                  {pkg.validity_days}d
                                </Badge>
                              )}
                            </div>

                            {selectedPackageId === pkg.id && (
                              <div className="flex items-center justify-center gap-1 text-xs font-medium text-primary pt-2 border-t">
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
            </div>
          )}

          {/* Airtime Packages */}
          {groupedPackages.airtime.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <Zap className="h-5 w-5 text-yellow-500" />
                Airtime
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {groupedPackages.airtime.map((pkg) => (
                  <div key={pkg.id} className="relative">
                    <RadioGroupItem
                      value={pkg.id}
                      id={`package-${pkg.id}`}
                      className="sr-only"
                    />
                    <Label htmlFor={`package-${pkg.id}`} className="cursor-pointer">
                      <Card
                        className={`h-full transition-all duration-200 cursor-pointer border-2 ${
                          selectedPackageId === pkg.id
                            ? 'border-primary shadow-lg'
                            : 'border-gray-200 hover:border-primary/50'
                        }`}
                      >
                        <CardContent className="pt-4 pb-4">
                          <div className="space-y-3">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <h4 className="font-semibold text-sm">{pkg.name}</h4>
                                {pkg.description && (
                                  <p className="text-xs text-gray-600 mt-1">{pkg.description}</p>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center justify-between pt-2 border-t">
                              <span className="text-sm font-bold text-primary">
                                {formatAmount(pkg.amount)}
                              </span>
                              {pkg.validity_days && (
                                <Badge variant="secondary" className="text-xs">
                                  {pkg.validity_days}d
                                </Badge>
                              )}
                            </div>

                            {selectedPackageId === pkg.id && (
                              <div className="flex items-center justify-center gap-1 text-xs font-medium text-primary pt-2 border-t">
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
            </div>
          )}
        </div>
      </RadioGroup>

      {packages.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="pt-12 pb-12 text-center">
            <Database className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-sm text-gray-500">No packages available for this network</p>
          </CardContent>
        </Card>
      )}

      {/* Package Preview */}
      {selectedPackage && (
        <Card className="bg-primary/5 border-primary/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Selected Package</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{selectedPackage.name}</span>
              <Badge>{selectedPackage.package_type}</Badge>
            </div>
            <div className="flex items-center justify-between pt-2 border-t">
              <span className="text-sm text-gray-600">Total Amount</span>
              <span className="text-lg font-bold text-primary">
                {formatAmount(selectedPackage.amount)}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2 pt-4">
        <Button variant="outline">Back</Button>
        <Button
          onClick={() => {
            const selected = packages.find((p) => p.id === selectedPackageId)
            if (selected) onSelect(selected)
          }}
          disabled={!selectedPackageId || isLoading || !canProceed}
          className="ml-auto"
        >
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Continue to Details
        </Button>
      </div>
    </div>
  )
}
