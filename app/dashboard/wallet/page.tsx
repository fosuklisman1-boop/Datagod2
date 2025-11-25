"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Wallet, Plus, Minus, TrendingUp, TrendingDown } from "lucide-react"

export default function WalletPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Wallet</h1>
          <p className="text-gray-600 mt-1">Manage your account balance and funds</p>
        </div>

        {/* Balance Card */}
        <Card className="bg-gradient-to-r from-blue-600 to-purple-600 text-white border-0">
          <CardHeader>
            <CardTitle className="text-white">Current Balance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-blue-100 text-sm">Available Balance</p>
                <p className="text-4xl font-bold">GHS 569.63</p>
              </div>
              <Wallet className="w-16 h-16 text-blue-100 opacity-50" />
            </div>
            <div className="flex gap-4">
              <Button className="bg-white text-blue-600 hover:bg-gray-100 flex-1">
                <Plus className="w-4 h-4 mr-2" />
                Add Funds
              </Button>
              <Button variant="outline" className="border-white text-white hover:bg-white/20 flex-1">
                <Minus className="w-4 h-4 mr-2" />
                Withdraw
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Credited</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS 1,000.00</div>
              <p className="text-xs text-gray-600">All deposits</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Spent</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS 430.37</div>
              <p className="text-xs text-gray-600">All purchases</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Available Balance</CardTitle>
              <Wallet className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS 569.63</div>
              <p className="text-xs text-gray-600">Ready to use</p>
            </CardContent>
          </Card>
        </div>

        {/* Transaction History */}
        <Card>
          <CardHeader>
            <CardTitle>Transaction History</CardTitle>
            <CardDescription>Your recent wallet transactions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Date</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Description</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Amount</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Type</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm">Nov 25, 2025</td>
                    <td className="px-6 py-4 text-sm">Wallet Top Up</td>
                    <td className="px-6 py-4 text-sm font-semibold text-green-600">+GHS 1,000.00</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-green-100 text-green-800">Credit</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold">GHS 1,000.00</td>
                  </tr>
                  <tr className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm">Nov 24, 2025</td>
                    <td className="px-6 py-4 text-sm">Data Purchase - MTN 5GB</td>
                    <td className="px-6 py-4 text-sm font-semibold text-red-600">-GHS 19.50</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-red-100 text-red-800">Debit</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold">GHS 980.50</td>
                  </tr>
                  <tr className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm">Nov 23, 2025</td>
                    <td className="px-6 py-4 text-sm">Data Purchase - TELECEL 10GB</td>
                    <td className="px-6 py-4 text-sm font-semibold text-red-600">-GHS 45.00</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-red-100 text-red-800">Debit</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold">GHS 1,025.50</td>
                  </tr>
                  <tr className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm">Nov 22, 2025</td>
                    <td className="px-6 py-4 text-sm">Data Purchase - AT iShare 2GB</td>
                    <td className="px-6 py-4 text-sm font-semibold text-red-600">-GHS 7.50</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-red-100 text-red-800">Debit</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold">GHS 1,070.50</td>
                  </tr>
                  <tr className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm">Nov 21, 2025</td>
                    <td className="px-6 py-4 text-sm">Data Purchase - MTN 1GB</td>
                    <td className="px-6 py-4 text-sm font-semibold text-red-600">-GHS 4.50</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-red-100 text-red-800">Debit</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold">GHS 1,078.00</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex justify-between items-center">
              <p className="text-sm text-gray-600">Showing 5 of 5 transactions</p>
              <div className="flex gap-2">
                <Button variant="outline" disabled>Previous</Button>
                <Button variant="outline" disabled>Next</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
