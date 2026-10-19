import { z } from "zod";

// Pure, framework-free helpers shared by the web app's auth flow (and unit-tested here).

/** bcrypt, which Supabase uses, ignores bytes past 72, so longer passwords are rejected up front. */
export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, "Password must be at least 8 characters.").max(72),
});
export type Credentials = z.infer<typeof credentialsSchema>;

export const AUTH_NOTICES = {
  check_email: "Check your email to confirm your account, then sign in.",
  signed_out: "You have been signed out.",
} as const;

export const AUTH_ERRORS = {
  invalid_input: "Enter a valid email and a password of 8 to 72 characters.",
  invalid_credentials: "Email or password is incorrect.",
  weak_password: "That password is too weak. Choose a longer, less common one.",
  signup_failed: "We could not create the account. Try again or sign in.",
  email_rejected: "That email address was not accepted. Use a real, working email address (example and test domains are not allowed).",
  email_not_deliverable: "We cannot send a confirmation email to that address yet. Please contact support or use a different address.",
  rate_limited: "Too many attempts. Please wait a minute and try again.",
  callback_failed: "That sign-in link is invalid or has expired.",
  unavailable: "Authentication is temporarily unavailable.",
} as const;

export type AuthNoticeCode = keyof typeof AUTH_NOTICES;
export type AuthErrorCode = keyof typeof AUTH_ERRORS;

export const isAuthErrorCode = (v: unknown): v is AuthErrorCode => typeof v === "string" && v in AUTH_ERRORS;
export const isAuthNoticeCode = (v: unknown): v is AuthNoticeCode => typeof v === "string" && v in AUTH_NOTICES;

/** Only same-origin absolute paths are allowed as post-login targets (blocks open redirects). */
export function safeNextPath(next: unknown, fallback = "/dashboard"): string {
  if (typeof next !== "string" || !next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}

export const PROTECTED_PREFIXES = ["/dashboard", "/oauth"] as const;
export const GUEST_ONLY_PATHS = ["/login", "/signup"] as const;

const matchesPrefix = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export type RouteDecision = { action: "allow" } | { action: "redirect"; to: string };

/** Pure routing policy used by the Next.js proxy: protect the dashboard, bounce signed-in users off auth pages. */
export function decideRoute(pathname: string, signedIn: boolean, search = ""): RouteDecision {
  if (!signedIn && PROTECTED_PREFIXES.some((p) => matchesPrefix(pathname, p))) {
    // The query string travels too: the OAuth consent page needs its `authorization_id` after sign-in.
    return { action: "redirect", to: `/login?next=${encodeURIComponent(pathname + search)}` };
  }
  if (signedIn && GUEST_ONLY_PATHS.some((p) => pathname === p)) {
    return { action: "redirect", to: "/dashboard" };
  }
  return { action: "allow" };
}

/** Maps a Supabase Auth error code to a safe, non-enumerating error code for the UI. */
export function mapSignUpError(code: string | undefined): AuthErrorCode {
  if (code === "weak_password") return "weak_password";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit") return "rate_limited";
  // These describe the address typed in, not whether an account exists, so they do not allow account enumeration.
  if (code === "email_address_invalid") return "email_rejected";
  if (code === "email_address_not_authorized") return "email_not_deliverable";
  return "signup_failed";
}

export function mapSignInError(code: string | undefined): AuthErrorCode {
  if (code === "over_request_rate_limit") return "rate_limited";
  return "invalid_credentials";
}
