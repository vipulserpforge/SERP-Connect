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

/**
 * Validation sentences the connection forms may pass back through the address bar. A page address can be crafted by anyone,
 * so only these exact sentence shapes are ever shown: anything else is dropped and the page falls back to its own fixed text.
 */
const KNOWN_FORM_MESSAGES: RegExp[] = [
  /^Each Clarity dimension can be used only once per request\.$/,
  /^Clarity allows at most \d{1,2} dimensions per request\.$/,
  /^Unsupported Clarity dimension\(s\): [A-Za-z/, ]{1,80}\.(?: .{0,200})?$/,
  /^Give the connection a name of 2-60 characters \(letters, numbers, spaces and \. _ & \( \) ' -\)\.$/,
  /^That API key is already connected under another name\. Remove the other connection first\.$/,
  /^That token is already connected under another name\. Remove the other connection first\.$/,
  /^That does not look like a Bing Webmaster API key\. It is a string of letters and numbers \(usually 32 characters\)\. Copy it again from Bing Webmaster Tools\.$/,
  /^That does not look like a Clarity API token\. Copy the whole token from Clarity \(Settings → Data Export\) without spaces\.$/,
  /^You can connect up to \d{1,3} (?:Bing accounts|Clarity projects)\. Remove one first\.$/,
];

export function knownFormMessage(text: unknown): string | undefined {
  if (typeof text !== "string" || text.length > 300) return undefined;
  return KNOWN_FORM_MESSAGES.some((re) => re.test(text)) ? text : undefined;
}
