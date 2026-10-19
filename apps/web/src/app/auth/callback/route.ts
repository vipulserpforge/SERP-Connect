import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@serp/auth";
import { getEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const OTP_TYPES = ["email", "signup", "recovery", "magiclink", "invite", "email_change"] as const;
type OtpType = (typeof OTP_TYPES)[number];

/**
 * Completes email-confirmation links. Two shapes:
 * - `token_hash` + `type` (recommended email template): verified server-side, works even when the link is
 *   opened in a different browser or app than the one used to sign up.
 * - `code` (PKCE): needs the code-verifier cookie from the browser that signed up.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  const tokenHash = searchParams.get("token_hash");
  const type = OTP_TYPES.find((t) => t === searchParams.get("type")) as OtpType | undefined;

  if (getEnv().AUTH_MODE === "supabase") {
    if (tokenHash && type) {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      if (!error) return NextResponse.redirect(new URL(next, origin));
    } else if (code) {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(new URL(next, origin));
    }
  }
  return NextResponse.redirect(new URL("/login?error=callback_failed", origin));
}
