import {
  createRootRoute,
  createRoute,
  createRouter,
  retainSearchParams,
  stringifySearchWith,
} from "@tanstack/react-router";
import {
  recommendationStateSchema,
  recommendationTypeSchema,
  type MetricWindow,
} from "@amazon-king/contracts";
import { AppLayout } from "./components/layout";
import { parseDaysSearch } from "./lib/timeframe";
import { LoginPage } from "./routes/login";
import { ConnectPage } from "./routes/connect";
import { OverviewPage } from "./routes/overview";
import { RecommendationsPage } from "./routes/recommendations";
import { RecommendationDetailPage } from "./routes/recommendation-detail";
import { CampaignsPage } from "./routes/campaigns";
import { CampaignNewPage } from "./routes/campaign-new";
import { CampaignDetailPage } from "./routes/campaign-detail";
import { SearchTermsPage } from "./routes/search-terms";
import { SearchTermDetailPage } from "./routes/search-term-detail";
import { ChangesPage } from "./routes/changes";
import { SettingsPage } from "./routes/settings";

const rootRoute = createRootRoute();

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

/**
 * Global product filter: the `books` search param is a comma-separated list of
 * external book ids (`?books=3,7`). Validated once here on the layout route so
 * every child inherits it. Accepts the raw comma string, an already-validated
 * array (which is what retention passes back in), and the number JSON-parsing
 * produces for a bare numeric id (`?books=3`).
 */
function validateAppSearch(search: Record<string, unknown>): {
  books?: string[];
} {
  const raw = search.books;
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === "string" || typeof raw === "number"
      ? String(raw).split(",")
      : [];
  const books = entries
    .map((id) => String(id).trim())
    .filter((id) => id !== "");
  return books.length > 0 ? { books } : {};
}

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  validateSearch: validateAppSearch,
  // This router version resets search params on navigation unless told
  // otherwise; retain the product filter across all app routes.
  search: { middlewares: [retainSearchParams(["books"])] },
  component: AppLayout,
});

const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  validateSearch: (
    search: Record<string, unknown>,
  ): { days?: MetricWindow; country?: string } => {
    const days = parseDaysSearch(search.days);
    const country =
      typeof search.country === "string" && /^[A-Za-z]{2}$/.test(search.country)
        ? search.country.toUpperCase()
        : undefined;
    return {
      ...(days !== undefined ? { days } : {}),
      ...(country ? { country } : {}),
    };
  },
  component: OverviewPage,
});

const recommendationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/recommendations",
  validateSearch: (
    search: Record<string, unknown>,
  ): { type?: string; state?: string } => {
    const type = recommendationTypeSchema.safeParse(search.type);
    const state = recommendationStateSchema.safeParse(search.state);
    return {
      ...(type.success ? { type: type.data } : {}),
      ...(state.success ? { state: state.data } : {}),
    };
  },
  component: RecommendationsPage,
});

const recommendationDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/recommendations/$id",
  component: RecommendationDetailPage,
});

const campaignsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/campaigns",
  component: CampaignsPage,
});

const campaignNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/campaigns/new",
  // Optional prefill from the cannibalization resolution screen: the term to
  // advertise, its market, and the finding the new campaign resolves.
  validateSearch: (
    search: Record<string, unknown>,
  ): { recommendationId?: string; searchTerm?: string; country?: string } => {
    const country =
      typeof search.country === "string"
        ? search.country.trim().toUpperCase()
        : undefined;
    return {
      ...(typeof search.recommendationId === "string" &&
      search.recommendationId !== ""
        ? { recommendationId: search.recommendationId }
        : {}),
      ...(typeof search.searchTerm === "string" && search.searchTerm !== ""
        ? { searchTerm: search.searchTerm }
        : {}),
      ...(country !== undefined && /^[A-Z]{2}$/.test(country)
        ? { country }
        : {}),
    };
  },
  component: CampaignNewPage,
});

const campaignDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/campaigns/$id",
  validateSearch: (
    search: Record<string, unknown>,
  ): { days?: MetricWindow } => {
    const days = parseDaysSearch(search.days);
    return {
      ...(days !== undefined ? { days } : {}),
    };
  },
  component: CampaignDetailPage,
});

const searchTermsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/search-terms",
  validateSearch: (search: Record<string, unknown>): { country?: string } => {
    const country =
      typeof search.country === "string"
        ? search.country.trim().toUpperCase()
        : undefined;
    return {
      ...(country !== undefined && /^[A-Z]{2}$/.test(country)
        ? { country }
        : {}),
    };
  },
  component: SearchTermsPage,
});

const searchTermDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/search-terms/$term",
  validateSearch: (
    search: Record<string, unknown>,
  ): { days?: MetricWindow; country?: string } => {
    const days = parseDaysSearch(search.days);
    const country =
      typeof search.country === "string"
        ? search.country.trim().toUpperCase()
        : undefined;
    return {
      ...(days !== undefined ? { days } : {}),
      ...(country !== undefined && /^[A-Z]{2}$/.test(country)
        ? { country }
        : {}),
    };
  },
  component: SearchTermDetailPage,
});

const changesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/changes",
  // `?apply=<change set id>` is the pending apply a re-auth magic link carries
  // back, so the page reopens that set's confirmation instead of making the
  // user find it again. Accepts the number JSON parsing produces for a bare
  // numeric id.
  validateSearch: (search: Record<string, unknown>): { apply?: string } => {
    const apply =
      typeof search.apply === "string" || typeof search.apply === "number"
        ? String(search.apply).trim()
        : "";
    return apply !== "" ? { apply } : {};
  },
  component: ChangesPage,
});

const connectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/connect",
  component: ConnectPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    overviewRoute,
    recommendationsRoute,
    recommendationDetailRoute,
    campaignsRoute,
    campaignNewRoute,
    campaignDetailRoute,
    searchTermsRoute,
    searchTermDetailRoute,
    changesRoute,
    connectRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  // Keep the product filter's URL form (`?books=3,7`) stable: the validated
  // value is a string array, which the default serializer would JSON-encode.
  stringifySearch: stringifySearchWith(
    (value) =>
      Array.isArray(value) && value.every((item) => typeof item === "string")
        ? value.join(",")
        : JSON.stringify(value),
    JSON.parse,
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
