import { useState } from "react";
import type { AmazonProfile } from "@amazon-king/contracts";
import {
  useAmazonDisconnect,
  useAmazonStart,
  useAmazonStatus,
  useProfiles,
  useUpdateProfile,
} from "../api/endpoints";
import { useToast } from "../components/toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { formatDateTime } from "../lib/format";

const statusTone = {
  connected: "success",
  reconnect_required: "warning",
  disconnected: "neutral",
} as const;

function ProfileRow({ profile }: { profile: AmazonProfile }) {
  const update = useUpdateProfile(profile.profileId);
  const toast = useToast();
  return (
    <tr>
      <Td className="font-mono text-xs">{profile.profileId}</Td>
      <Td>{profile.region}</Td>
      <Td>{profile.countryCode}</Td>
      <Td>{profile.currencyCode}</Td>
      <Td>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-sky-500"
            checked={profile.enabled}
            disabled={update.isPending}
            onChange={(e) =>
              update.mutate(
                { enabled: e.target.checked },
                {
                  onError: (err) =>
                    toast(`Could not update profile: ${err.message}`, "error"),
                },
              )
            }
          />
          {profile.enabled ? "Enabled" : "Disabled"}
        </label>
      </Td>
    </tr>
  );
}

export function ConnectPage() {
  const status = useAmazonStatus();
  const profiles = useProfiles();
  const start = useAmazonStart();
  const disconnect = useAmazonDisconnect();
  const toast = useToast();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-lg font-semibold text-zinc-100">Amazon connection</h1>

      <Card>
        <CardHeader title="Connection status" />
        {status.isPending ? (
          <Loading />
        ) : status.error ? (
          <ErrorState error={status.error} />
        ) : (
          <CardBody className="flex flex-wrap items-center gap-3">
            <Badge tone={statusTone[status.data.status]}>
              {status.data.status.replace("_", " ")}
            </Badge>
            {status.data.grantedAt && (
              <span className="text-sm text-zinc-500">
                Authorized {formatDateTime(status.data.grantedAt)}
              </span>
            )}
            {status.data.lastErrorCode && (
              <span className="text-sm text-red-300">
                Last error: {status.data.lastErrorCode}
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <Button
                variant="primary"
                disabled={start.isPending}
                onClick={() =>
                  start.mutate(undefined, {
                    onSuccess: (data) => {
                      window.location.assign(data.url);
                    },
                    onError: (err) =>
                      toast(
                        `Could not start connection: ${err.message}`,
                        "error",
                      ),
                  })
                }
              >
                {start.isPending ? "Starting…" : "Connect Amazon Ads"}
              </Button>
              {status.data.status !== "disconnected" && (
                <Button
                  variant="danger"
                  onClick={() => setConfirmDisconnect(true)}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader title="Discovered profiles" />
        {profiles.isPending ? (
          <Loading />
        ) : profiles.error ? (
          <ErrorState error={profiles.error} />
        ) : profiles.data.length === 0 ? (
          <EmptyState>
            No profiles discovered yet. Connect Amazon Ads to discover your
            marketplaces.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Profile</Th>
                <Th>Region</Th>
                <Th>Country</Th>
                <Th>Currency</Th>
                <Th>Sync enabled</Th>
              </tr>
            </thead>
            <tbody>
              {profiles.data.map((p) => (
                <ProfileRow key={p.profileId} profile={p} />
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Dialog
        open={confirmDisconnect}
        title="Disconnect Amazon Ads?"
        confirmLabel="Disconnect"
        confirmVariant="danger"
        busy={disconnect.isPending}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => {
              setConfirmDisconnect(false);
              toast("Amazon Ads disconnected");
            },
            onError: (err) =>
              toast(`Disconnect failed: ${err.message}`, "error"),
          })
        }
      >
        This stops all data syncs and disables any pending writes. You can
        reconnect at any time.
      </Dialog>
    </div>
  );
}
