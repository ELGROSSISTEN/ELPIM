import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Public routes that never require authentication
const PUBLIC_PREFIXES = ['/login', '/register', '/onboarding', '/privacy', '/invitations', '/auth', '/_next', '/favicon'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const isPublic = PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  const authed = request.cookies.get('elpim_authed')?.value === '1';

  // Redirect logged-in users away from login/register
  if (authed && (pathname.startsWith('/login') || pathname.startsWith('/register'))) {
    const dashUrl = request.nextUrl.clone();
    dashUrl.pathname = '/dashboard/products';
    dashUrl.search = '';
    return NextResponse.redirect(dashUrl);
  }

  if (isPublic) {
    return NextResponse.next();
  }

  // elpim_authed is a presence-flag cookie set by the client on login.
  // The actual JWT stays in localStorage; this cookie only signals "a session exists"
  // so the edge can gate protected routes without exposing the token server-side.

  if (!authed) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on every route except static files and Next.js internals
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
