import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { decideRoute } from "@serp/auth";
import { loadWebEnv } from "@serp/contracts";

/**
 * Refreshes the Supabase session cookies and enforces the route policy.
 * Pages and actions still verify the user themselves; this is the first gate, not the only one.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const env = loadWebEnv();
  let response = NextResponse.next({ request });
  let signedIn = env.AUTH_MODE === "mock";

  // No Supabase auth cookie means no session, so public pages and first-time visitors skip the Auth server round trip.
  const hasSessionCookie = request.cookies.getAll().some((c) => c.name.startsWith("sb-") && c.name.includes("-auth-token"));

  if (env.AUTH_MODE === "supabase" && hasSessionCookie) {
    const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        },
      },
    });
    try {
      const { data, error } = await supabase.auth.getUser();
      signedIn = !error && !!data.user;
    } catch {
      signedIn = false; // Auth server unreachable: fail closed.
    }
  }

  const decision = decideRoute(request.nextUrl.pathname, signedIn, request.nextUrl.search);
  if (decision.action === "redirect") {
    const redirect = NextResponse.redirect(new URL(decision.to, request.url));
    // Carry refreshed session cookies onto the redirect.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  response.headers.set("cache-control", "private, no-store");
  return response;
}
