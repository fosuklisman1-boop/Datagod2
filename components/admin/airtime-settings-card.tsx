"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Smartphone, ChevronRight, Settings } from "lucide-react"
import Link from "next/link"

export default function AirtimeSettingsCard() {
  return (
    <Card className="mt-6 border-indigo-100 bg-indigo-50/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-indigo-900">
          <Smartphone className="w-5 h-5" />
          Airtime & Network Configuration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600">
          Manage airtime fees for customers and dealers, set transaction limits, and toggle network availability (MTN, Telecel, AT).
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/admin/airtime/settings" className="flex-1 min-w-[200px]">
            <Button className="w-full flex items-center justify-between bg-indigo-600 hover:bg-indigo-700 h-11">
              <span className="flex items-center gap-2">
                <Settings className="w-4 h-4" />
                Configure Airtime
              </span>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </Link>
          <Link href="/admin/airtime" className="flex-1 min-w-[200px]">
            <Button variant="outline" className="w-full flex items-center justify-between border-indigo-200 text-indigo-700 hover:bg-indigo-50 h-11">
              View Airtime Orders
              <ChevronRight className="w-4 h-4 ml-1 opacity-50" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
