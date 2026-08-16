import { useLogin, useSession } from "../api/endpoints";
import { Dialog } from "./ui/dialog";

interface ReauthDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Shown when a spend-changing action fails with REAUTH_REQUIRED (the API
 * requires a sign-in from the last 15 minutes, plan §13). Sends a magic link
 * with one click — the email comes from the live session, no typing — and the
 * link carries the current path as `next`, so verify lands the user right
 * back here to retry the action.
 */
export function ReauthDialog({ open, onClose }: ReauthDialogProps) {
  const session = useSession();
  const login = useLogin();
  const email = session.data?.email;

  function sendLink() {
    if (!email) return;
    login.mutate({
      email,
      next: window.location.pathname + window.location.search,
    });
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
            <span className="font-medium">{email}</span>. It brings you right
            back to this page.
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
            . Clicking it signs you in and returns you here to retry the action.
          </p>
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
