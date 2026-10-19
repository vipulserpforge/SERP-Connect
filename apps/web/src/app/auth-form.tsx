import Link from "next/link";
import { AUTH_ERRORS, AUTH_NOTICES, isAuthErrorCode, isAuthNoticeCode } from "@serp/auth";
import { signInWithGoogleAction } from "@/app/actions";

interface Props {
  mode: "login" | "signup";
  action: (formData: FormData) => Promise<void>;
  error?: string;
  notice?: string;
  next?: string;
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}

/** Server-rendered form: works without JS. Messages come from a fixed allowlist keyed by code. */
export function AuthForm({ mode, action, error, notice, next }: Props) {
  const isLogin = mode === "login";
  return (
    <main className="mx-auto flex max-w-md flex-col px-5 py-14 sm:py-20">
      <div className="card !p-8">
        <h1 className="text-3xl font-medium">
          {isLogin ? (
            <>
              Welcome <span className="accent">back</span>
            </>
          ) : (
            <>
              Create your <span className="accent">account</span>
            </>
          )}
        </h1>
        <p className="muted mt-2 text-sm">
          {isLogin ? "Sign in to manage your connections." : "Free to start. Connect Search Console and GA4 afterwards."}
        </p>
        {isAuthNoticeCode(notice) && (
          <p role="status" className="mt-5 rounded-xl bg-emerald-100 px-3.5 py-2.5 text-sm text-emerald-900">
            {AUTH_NOTICES[notice]}
          </p>
        )}
        {isAuthErrorCode(error) && (
          <p role="alert" className="mt-5 rounded-xl bg-red-100 px-3.5 py-2.5 text-sm text-red-900">
            {AUTH_ERRORS[error]}
          </p>
        )}

        {/* DOM order keeps the email form first (stable for tests); `order` shows Google on top. */}
        <div className="mt-6 flex flex-col">
          <form action={action} className="order-3 space-y-4">
            {next && <input type="hidden" name="next" value={next} />}
            <label className="block text-sm">
              Email
              <input name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@company.com" className="field" />
            </label>
            <label className="block text-sm">
              Password
              <input
                name="password"
                type="password"
                autoComplete={isLogin ? "current-password" : "new-password"}
                required
                minLength={8}
                maxLength={72}
                placeholder={isLogin ? "Your password" : "At least 8 characters"}
                className="field"
              />
            </label>
            <button className="btn-primary w-full">{isLogin ? "Sign in" : "Sign up"}</button>
          </form>
          <p className="muted order-2 my-5 flex items-center gap-3 text-xs">
            <span className="h-px flex-1" style={{ background: "var(--line)" }} />
            or use email
            <span className="h-px flex-1" style={{ background: "var(--line)" }} />
          </p>
          <form action={signInWithGoogleAction} className="order-1">
            <button className="btn-ghost w-full !py-3">
              <GoogleMark />
              Continue with Google
            </button>
          </form>
        </div>
      </div>
      <p className="muted mt-6 text-center text-sm">
        {isLogin ? "New here? " : "Already registered? "}
        <Link href={isLogin ? "/signup" : "/login"} className="underline" style={{ color: "var(--teal)" }}>
          {isLogin ? "Create an account" : "Sign in"}
        </Link>
      </p>
    </main>
  );
}
