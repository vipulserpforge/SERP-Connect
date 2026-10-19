import { signInAction } from "@/app/actions";
import { AuthForm } from "@/app/auth-form";
import { safeNextPath } from "@serp/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { error, notice, next } = await searchParams;
  return <AuthForm mode="login" action={signInAction} error={error} notice={notice} next={safeNextPath(next)} />;
}
