export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const TOKEN_KEY = 'epim_token';
const ACTIVE_SHOP_KEY = 'epim_active_shop_id';

export const getToken = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return localStorage.getItem(TOKEN_KEY);
};

const AUTH_COOKIE = 'epim_authed';

const setCookie = (name: string, value: string, days = 365): void => {
  if (typeof document === 'undefined') return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
};

const deleteCookie = (name: string): void => {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax`;
};

export const setToken = (token: string): void => {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(TOKEN_KEY, token);
  setCookie(AUTH_COOKIE, '1');
};

export const getActiveShopId = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return localStorage.getItem(ACTIVE_SHOP_KEY);
};

export const setActiveShopId = (shopId: string): void => {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(ACTIVE_SHOP_KEY, shopId);
};

export const clearSession = (): void => {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACTIVE_SHOP_KEY);
  deleteCookie(AUTH_COOKIE);
};
export const apiFetch = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const token = getToken();
  const activeShopId = getActiveShopId();
  const hasBody = typeof init.body !== 'undefined';
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(activeShopId ? { 'X-EPIM-Shop-Id': activeShopId } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 401 && typeof window !== 'undefined') {
    const onLoginPage = window.location.pathname.startsWith('/login');

    // Prevent login-page loops, but always return to login from protected pages.
    if (!onLoginPage) {
      clearSession();
      window.location.href = '/login';
      return new Promise<T>(() => {});
    }
  }

  if (response.status === 402 && typeof window !== 'undefined') {
    const path = window.location.pathname;
    const exempt = path.startsWith('/login') || path.startsWith('/onboarding') || path.startsWith('/settings/shops') || path.startsWith('/settings/integrations');
    if (!exempt) {
      window.location.href = '/onboarding?subscription=required';
      return new Promise<T>(() => {});
    }
  }

  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      message = parsed.error ?? parsed.message ?? body;
    } catch { /* use raw body */ }
    throw new Error(message);
  }
  return (await response.json()) as T;
};
