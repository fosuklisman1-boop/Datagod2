"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, Copy, Download, Printer } from "lucide-react"

export default function ComplaintsPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">My Complaints</h1>
          <p className="text-gray-600 mt-1">Track and manage your complaint submissions</p>
        </div>

        {/* Header Banner */}
        <Card className="bg-gradient-to-r from-orange-500 to-red-600 text-white border-0">
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <AlertCircle className="w-8 h-8 flex-shrink-0 mt-1" />
              <div>
                <h2 className="text-xl font-bold">My Complaints</h2>
                <p className="text-orange-100 mt-1">
                  Track and manage your complaint submissions
                </p>
                <p className="text-orange-100 mt-2">
                  Monitor the status of your complaints and view responses from our support team.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Complaints</CardTitle>
              <AlertCircle className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
              <p className="text-xs text-gray-600">All time</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <AlertCircle className="h-4 w-4 text-yellow-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
              <p className="text-xs text-gray-600">Awaiting response</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Resolved</CardTitle>
              <AlertCircle className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
              <p className="text-xs text-gray-600">Completed</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Rejected</CardTitle>
              <AlertCircle className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
              <p className="text-xs text-gray-600">Not approved</p>
            </CardContent>
          </Card>
        </div>

        {/* Complaints Table */}
        <Card>
          <CardHeader>
            <CardTitle>Complaints List</CardTitle>
            <CardDescription>Your complaint submissions and responses</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Export Options */}
            <div className="flex flex-wrap gap-2 pb-4 border-b">
              <Button size="sm" variant="outline" className="gap-2">
                <Copy className="w-4 h-4" />
                Copy
              </Button>
              <Button size="sm" variant="outline" className="gap-2">
                <Download className="w-4 h-4" />
                CSV
              </Button>
              <Button size="sm" variant="outline" className="gap-2">
                <Download className="w-4 h-4" />
                Excel
              </Button>
              <Button size="sm" variant="outline" className="gap-2">
                <Download className="w-4 h-4" />
                PDF
              </Button>
              <Button size="sm" variant="outline" className="gap-2">
                <Printer className="w-4 h-4" />
                Print
              </Button>
              <div className="ml-auto">
                <input
                  type="text"
                  placeholder="Search complaints..."
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Ticket Number</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Order Details</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Description</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Date Submitted</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Response</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                      No data available in table
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex justify-between items-center pt-4">
              <p className="text-sm text-gray-600">Showing 0 to 0 of 0 complaints</p>
              <div className="flex gap-2">
                <Button variant="outline" disabled>Previous</Button>
                <Button variant="outline" disabled>Next</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Submit Complaint Button */}
        <div className="flex justify-center">
          <Button className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 px-8">
            Submit New Complaint
          </Button>
        </div>
      </div>
    </DashboardLayout>
  )
}
