import { useState } from "react";
import { useLogin, useSession } from "../api/endpoints";
import { isStandalone } from "../lib/install";
import { PasteLoginLink } from "./paste-login-link";
import { Dialog } from "./ui/dialog";

interface ReauthDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Same-origin path to land on after verify. Defaults to the current
   * location; pass a path carrying the blocked action (e.g.
   * `/changes?apply=52`) so the page can offer it again on arrival.
   */
  next?: string;
  /**
   * Called when the session was refreshed without leaving the page (the
   * installed-app paste flow), so the caller can re-run the action it was
   * blocked on. The dialog closes first either way.
   */
  onReauthenticated?: () => void;
}

/**
 * Shown when a spend-changing action fails with REAUTH_REQUIRED (the API
 * requires a sign-in from the last 15 minutes, plan §13). Sends a magic link
 * with one click — the email comes from the live session, no typing — and the
 * link carries `next`, so verify lands the user back where they were with the
 * blocked action ready to confirm again.
 *
 * In the installed app the link cannot land here (iOS opens it in the browser,
 * whose cookies the installed app never sees), so the link is pasted back in
 * instead. Nothing navigates in that flow, so the blocked action is re-run
 * directly through `onReauthenticated`.
 */
export function ReauthDialog({
  open,
  onClose,
  next,
  onReauthenticated,
}: ReauthDialogProps) {
  const session = useSession();
  const login = useLogin();
  const [installed] = useState(isStandalone);
  const email = session.data?.email;

  function sendLink() {
    if (!email) return;
    login.mutate({
      email,
      next: next ?? window.location.pathname + window.location.search,
    });
  }

  function onSignedIn() {
    onClose();
    onReauthenticated?.();
  }

  return (
    <Dialog
      open={open}
      title="Confirm it's you"
      confirmLabel="Email me a sign-in link"
      busy={login.isPending}
      onConfirm={login.isSuccess || !email ? undefined : sendLink}
      onClose={onClose}
    >
      {login.isSuccess ? (
        login.data?.devLoginUrl ? (
          <div className="space-y-2">
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
              This link is single-use and expires in 15 minutes. It brings you
              right back to this page.
            </p>
          </div>
        ) : (
          <p role="status" className="text-emerald-300">
            Check your inbox — we sent a sign-in link to{" "}
            <span className="font-medium">{email}</span>.{" "}
            {installed
              ? "Copy the link and paste it below."
              : "It brings you right back to this page."}
          </p>
        )
      ) : (
        <div className="space-y-2">
          <p>
            This action writes to your Amazon Ads account, so it needs a sign-in
            from the last 15 minutes.
          </p>
          <p className="text-zinc-400">
            We&apos;ll email a single-use sign-in link to{" "}
            <span className="font-medium text-zinc-200">
              {email ?? "your address"}
            </span>
            . Clicking it signs you in and brings you back here with this action
            ready to confirm.
          </p>
        </div>
      )}
      {login.isSuccess && installed && (
        <div className="mt-4 border-t border-zinc-800 pt-4">
          <PasteLoginLink onSignedIn={onSignedIn} />
        </div>
      )}
      {login.error && (
        <p role="alert" className="mt-3 text-sm text-red-300">
          {login.error.message}
        </p>
      )}
    </Dialog>
  );
}
