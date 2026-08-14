import { useState, type FormEvent } from "react";
import { useLogin } from "../api/endpoints";
import { ApiError } from "../api/client";
import { Button } from "../components/ui/button";
import { Card, CardBody } from "../components/ui/card";
import { Input } from "../components/ui/input";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [invalidToken, setInvalidToken] = useState(
    () =>
      new URLSearchParams(window.location.search).get("error") ===
      "invalid_token",
  );
  const login = useLogin();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setInvalidToken(false);
    login.mutate({ email }, { onSuccess: () => setSent(true) });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <Card className="w-full max-w-sm shadow-[0_16px_40px_rgba(0,0,0,0.5),0_0_32px_rgba(109,40,217,0.12)]">
        <CardBody className="p-8">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-600 text-sm font-bold text-white shadow-sm"
            >
              AK
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-100">
              Amazon King
            </h1>
          </div>
          <p className="mt-1.5 text-sm text-zinc-500">
            Ads optimizer for KDP authors
          </p>
          {invalidToken && !sent && (
            <p role="alert" className="mt-4 text-sm text-amber-300">
              This sign-in link is invalid, expired, or already used. Request a
              new link below.
            </p>
          )}
          {sent ? (
            <div className="mt-4 space-y-3">
              {login.data?.devLoginUrl ? (
                <div role="status" className="space-y-2 text-sm">
                  <p className="text-amber-300">
                    Email delivery is not configured for this local app.
                  </p>
                  <a
                    href={login.data.devLoginUrl}
                    className="inline-flex font-medium text-sky-400 underline underline-offset-2 hover:text-sky-300"
                  >
                    Continue sign-in
                  </a>
                  <p className="text-xs text-zinc-500">
                    This link is single-use and expires in 15 minutes.
                  </p>
                </div>
              ) : (
                <p role="status" className="text-sm text-emerald-300">
                  Check your inbox — we sent a sign-in link to{" "}
                  <span className="font-medium">{email}</span>.
                </p>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  login.reset();
                  setInvalidToken(false);
                  setSent(false);
                }}
              >
                Send another link
              </Button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
              <label htmlFor="email" className="text-sm text-zinc-300">
                Email
              </label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
              {login.error && (
                <p role="alert" className="text-sm text-red-300">
                  {login.error instanceof ApiError
                    ? login.error.message
                    : "Sign-in failed. Try again."}
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={login.isPending}
              >
                {login.isPending ? "Sending…" : "Email me a sign-in link"}
              </Button>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
