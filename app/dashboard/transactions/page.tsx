"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, DollarSign } from "lucide-react"

export default function TransactionsPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">My Transactions</h1>
          <p className="text-gray-600 mt-1">Track and manage your financial activities</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Transactions</CardTitle>
              <DollarSign className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">1,198</div>
              <p className="text-xs text-gray-600">All time</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Income</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS 1,000.00</div>
              <p className="text-xs text-gray-600">Credits</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Expenses</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS 0.00</div>
              <p className="text-xs text-gray-600">Debits</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Refunds</CardTitle>
              <DollarSign className="h-4 w-4 text-orange-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS 0.00</div>
              <p className="text-xs text-gray-600">Refunded</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters Card */}
        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Transaction Type</label>
                <select className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md">
                  <option>All Types</option>
                  <option>Credit</option>
                  <option>Debit</option>
                  <option>Refund</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Transaction Source</label>
                <select className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md">
                  <option>All Sources</option>
                  <option>Wallet Top Up</option>
                  <option>Data Purchase</option>
                  <option>AFA Registration</option>
                  <option>Refund</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Date Range</label>
                <select className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md">
                  <option>All Time</option>
                  <option>Today</option>
                  <option>This Week</option>
                  <option>This Month</option>
                  <option>Last 3 Months</option>
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Transactions Table */}
        <Card>
          <CardHeader>
            <CardTitle>Transactions List</CardTitle>
            <CardDescription>Your financial transaction history</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Date</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Type</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Source</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Amount</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Balance Before</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Balance After</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Order ID</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm">Nov 25, 2025</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-green-100 text-green-800">Credit</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm">Wallet Top Up</td>
                    <td className="px-6 py-4 text-sm font-semibold text-green-600">+GHS 1,000.00</td>
                    <td className="px-6 py-4 text-sm">GHS 0.00</td>
                    <td className="px-6 py-4 text-sm font-semibold">GHS 1,000.00</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-green-100 text-green-800">Completed</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm">TXN-001</td>
                    <td className="px-6 py-4 text-sm">
                      <Button size="sm" variant="outline">View</Button>
                    </td>
                  </tr>
                  <tr className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm">Nov 24, 2025</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-red-100 text-red-800">Debit</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm">Data Purchase</td>
                    <td className="px-6 py-4 text-sm font-semibold text-red-600">-GHS 19.50</td>
                    <td className="px-6 py-4 text-sm">GHS 1,000.00</td>
                    <td className="px-6 py-4 text-sm font-semibold">GHS 980.50</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-green-100 text-green-800">Completed</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm">ORD-5002</td>
                    <td className="px-6 py-4 text-sm">
                      <Button size="sm" variant="outline">View</Button>
                    </td>
                  </tr>
                  <tr className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm">Nov 23, 2025</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-red-100 text-red-800">Debit</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm">Data Purchase</td>
                    <td className="px-6 py-4 text-sm font-semibold text-red-600">-GHS 45.00</td>
                    <td className="px-6 py-4 text-sm">GHS 1,000.00</td>
                    <td className="px-6 py-4 text-sm font-semibold">GHS 955.00</td>
                    <td className="px-6 py-4 text-sm">
                      <Badge className="bg-green-100 text-green-800">Completed</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm">ORD-5001</td>
                    <td className="px-6 py-4 text-sm">
                      <Button size="sm" variant="outline">View</Button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex justify-between items-center">
              <p className="text-sm text-gray-600">Showing 3 of 1,198 transactions</p>
              <div className="flex gap-2">
                <Button variant="outline">Previous</Button>
                <Button variant="outline">Next</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
