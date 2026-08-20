import type {
  MetricWindow,
  RecommendationCampaign,
} from "@amazon-king/contracts";
import { Link } from "@tanstack/react-router";

/**
 * Name a campaign and open its page. Findings carry the Amazon campaign id in
 * `recommendation.campaign`, which is the key `/campaigns/$id` expects — the
 * internal `campaignId` on the same payload is a database row id and links
 * nowhere.
 */
export function CampaignLink({
  campaign,
  days = 30,
  className = "",
}: {
  campaign: RecommendationCampaign;
  days?: MetricWindow;
  className?: string;
}) {
  return (
    <Link
      to="/campaigns/$id"
      params={{ id: campaign.campaignId }}
      search={{ days }}
      aria-label={`Open campaign ${campaign.name}`}
      className={`group inline-flex items-baseline gap-1.5 rounded-sm text-sky-400 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${className}`}
    >
      <span className="font-medium">{campaign.name}</span>
      <span className="font-mono text-xs text-zinc-500 group-hover:text-sky-400">
        {campaign.campaignId}
      </span>
    </Link>
  );
}
