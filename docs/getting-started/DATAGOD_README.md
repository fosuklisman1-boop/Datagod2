# DATAGOD - Complete Replica Application

## Project Overview

DATAGOD is a complete replica of the Dakazina Business Consult dashboard, rebranded as "DATAGOD" - a comprehensive data hub solution for purchasing data packages, managing wallets, tracking orders, and more.

## ✅ Features Implemented

### 1. **Authentication System**
- ✅ Login Page with username/email and password
- ✅ Signup Page with form validation
- ✅ Forgot Password Page with OTP verification flow
- ✅ Session management using localStorage
- ✅ Password reset functionality

### 2. **Dashboard Layout**
- ✅ Responsive sidebar navigation with all menu items
- ✅ Header with notifications, dark mode toggle, shopping cart, and user profile
- ✅ Gradient branding (Blue to Purple)
- ✅ Mobile-responsive design

### 3. **Dashboard Pages**

#### Dashboard Home
- ✅ Stats cards (Total Orders, Completed, Processing, Failed)
- ✅ Quick action buttons
- ✅ Recent activity feed
- ✅ Overview of account status

#### Data Packages
- ✅ Grid and List view toggle
- ✅ Network filtering (All, AT - iShare, TELECEL, MTN, AT - BigTime)
- ✅ Search functionality
- ✅ Package cards with pricing and features
- ✅ "Buy Now" buttons
- ✅ Results counter

#### My Orders
- ✅ Stats cards (Total, Completed, Processing, Failed)
- ✅ Advanced filters (Network, Status, Date Range)
- ✅ Orders table with pagination
- ✅ Order details display
- ✅ Action buttons

#### AFA Orders
- ✅ MTN AFA registration tracking
- ✅ Stats cards (Total, Pending, Processing, Delivered, Cancelled)
- ✅ AFA orders table with details
- ✅ Order code and transaction code display
- ✅ Status badges

#### Wallet
- ✅ Balance display card with gradient background
- ✅ Add Funds and Withdraw buttons
- ✅ Stats cards (Total Credited, Total Spent, Available Balance)
- ✅ Transaction history table
- ✅ Transaction type badges (Credit/Debit)

#### Transactions
- ✅ Stats cards (Total Transactions, Today's Income/Expenses/Refunds)
- ✅ Advanced filters (Type, Source, Date Range)
- ✅ Detailed transactions table
- ✅ Balance tracking (Before/After)
- ✅ Status indicators

#### Profile
- ✅ User profile header with avatar
- ✅ Personal information section
- ✅ Account information display
- ✅ Account statistics
- ✅ API keys management
- ✅ Security settings
- ✅ Edit and change password buttons

#### My Complaints
- ✅ Stats cards (Total, Pending, Resolved, Rejected)
- ✅ Complaints table
- ✅ Export options (Copy, CSV, Excel, PDF, Print)
- ✅ Search functionality
- ✅ Submit complaint button

### 4. **Design & Styling**
- ✅ Gradient color scheme (Blue #1E40AF to Purple)
- ✅ Dark mode support with theme toggle
- ✅ Responsive grid layouts
- ✅ Card-based UI components
- ✅ Smooth transitions and hover effects
- ✅ Professional typography
- ✅ Consistent spacing and padding

### 5. **UI Components Used**
- ✅ shadcn/ui components (Button, Card, Input, Badge, etc.)
- ✅ Lucide React icons
- ✅ Next.js 15 with App Router
- ✅ Tailwind CSS for styling
- ✅ React hooks for state management
- ✅ next-themes for dark mode

## 🚀 Technology Stack

- **Framework**: Next.js 15.5.6 with Turbopack
- **UI Library**: shadcn/ui
- **Styling**: Tailwind CSS
- **Icons**: Lucide React
- **Theme**: next-themes (Dark mode support)
- **State Management**: React hooks + localStorage
- **Language**: TypeScript

## 📁 Project Structure

```
datagod-app/
├── app/
│   ├── page.tsx                 # Home page
│   ├── layout.tsx               # Root layout
│   ├── auth/
│   │   ├── layout.tsx
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   └── forgot-password/page.tsx
│   └── dashboard/
│       ├── layout.tsx
│       ├── page.tsx             # Dashboard home
│       ├── data-packages/page.tsx
│       ├── my-orders/page.tsx
│       ├── afa-orders/page.tsx
│       ├── wallet/page.tsx
│       ├── transactions/page.tsx
│       ├── profile/page.tsx
│       └── complaints/page.tsx
├── components/
│   ├── layout/
│   │   ├── sidebar.tsx
│   │   ├── header.tsx
│   │   └── dashboard-layout.tsx
│   └── ui/                      # shadcn/ui components
├── lib/
│   └── utils.ts
├── public/
├── styles/
│   └── globals.css
└── package.json
```

## 🎨 Color Scheme

- **Primary Blue**: #1E40AF
- **Secondary Purple**: #9333EA
- **Accent Green**: #16A34A
- **Background**: White/Light Gray
- **Dark Mode**: Dark gray/black backgrounds

## 🔐 Authentication Flow

1. **Login**: Username/Email + Password
2. **Signup**: First Name, Last Name, Email, Username, Password
3. **Forgot Password**: Email → OTP → New Password
4. **Session**: Stored in localStorage

## 📊 Sample Data

The application includes sample data for:
- Data packages from 4 networks
- Order statistics
- Transaction history
- Wallet balance and transactions
- User profile information
- AFA order details

## 🌙 Dark Mode

- Toggle button in header
- Automatic theme switching
- Persistent theme preference
- All pages support dark mode

## 📱 Responsive Design

- Mobile-first approach
- Breakpoints: sm, md, lg
- Sidebar collapses on mobile
- Touch-friendly buttons and inputs
- Optimized table layouts

## 🚀 Getting Started

### Installation

```bash
cd /home/code/datagod-app
npm install
```

### Development

```bash
npm run dev
```

The application will be available at `http://localhost:3001`

### Build

```bash
npm run build
npm start
```

## 📝 Test Credentials

- **Username**: testuser
- **Password**: password123

Or create a new account using the signup page.

## ✨ Key Features

1. **Multi-Network Support**: Browse packages from AT - iShare, TELECEL, MTN, AT - BigTime
2. **Wallet Management**: Add funds, track balance, view transaction history
3. **Order Tracking**: Monitor order status, view order details
4. **AFA Registration**: Track MTN AFA registrations
5. **Transaction History**: Detailed financial tracking
6. **User Profile**: Manage account information and API keys
7. **Complaint System**: Submit and track complaints
8. **Export Options**: Export data in multiple formats
9. **Dark Mode**: Full dark mode support
10. **Responsive Design**: Works on all devices

## 🎯 Pages Summary

| Page | Route | Features |
|------|-------|----------|
| Home | `/` | Landing page with features |
| Login | `/auth/login` | User authentication |
| Signup | `/auth/signup` | Account creation |
| Forgot Password | `/auth/forgot-password` | Password reset |
| Dashboard | `/dashboard` | Overview and stats |
| Data Packages | `/dashboard/data-packages` | Browse and filter packages |
| My Orders | `/dashboard/my-orders` | Order management |
| AFA Orders | `/dashboard/afa-orders` | AFA registration tracking |
| Wallet | `/dashboard/wallet` | Balance and transactions |
| Transactions | `/dashboard/transactions` | Financial history |
| Profile | `/dashboard/profile` | User information |
| Complaints | `/dashboard/complaints` | Complaint management |

## 🔄 Navigation

- **Sidebar**: Main navigation menu
- **Header**: Quick access to notifications, theme, cart, and profile
- **Breadcrumbs**: Page context (can be added)
- **Links**: Internal navigation throughout the app

## 📦 Dependencies

- next@15.5.6
- react@19.0.0-rc
- react-dom@19.0.0-rc
- @radix-ui/react-slot
- class-variance-authority
- clsx
- lucide-react
- next-themes
- tailwind-css
- typescript

## 🎓 Learning Resources

This project demonstrates:
- Next.js 15 App Router
- Server and Client Components
- Responsive Design with Tailwind CSS
- Component Composition
- State Management with React Hooks
- Dark Mode Implementation
- Form Handling and Validation
- Navigation and Routing

## 📄 License

This is a replica project created for educational purposes.

## 🤝 Support

For issues or questions, please refer to the original Dakazina Business Consult documentation or contact support.

---

**DATAGOD** - Your Data Hub Solution
Built with ❤️ using Next.js and shadcn/ui
