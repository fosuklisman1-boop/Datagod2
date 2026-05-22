const BASE_URL =
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.datagod.store';

async function fetchWithAuth(path: string, options: RequestInit = {}) {
    const token =
        typeof window !== 'undefined'
            ? (localStorage.getItem('datagod_access_token') ?? '')
            : '';

    const headers: HeadersInit = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...((options.headers as Record<string, string>) ?? {}),
    };

    const response = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers,
    });

    if (!response.ok) {
        const error = await response
            .json()
            .catch(() => ({ message: 'An unknown error occurred' }));
        throw new Error(error.message || response.statusText);
    }

    return response.json();
}

export type OrderData = {
    packageId: string;
    phoneNumber: string;
    network: string;
    amount: number;
};

// Endpoints for native mobile/desktop wrappers calling the web backend
export const mobileApi = {
    getPackages: () => fetchWithAuth('/api/shop/packages'),
    getOrders: () => fetchWithAuth('/api/orders/history'),
    createOrder: (orderData: OrderData) =>
        fetchWithAuth('/api/orders/create', {
            method: 'POST',
            body: JSON.stringify(orderData),
        }),
    getWalletBalance: () => fetchWithAuth('/api/wallet/balance'),
};
