import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  recommendationStateSchema,
  recommendationTypeSchema,
} from "@amazon-king/contracts";
import { AppLayout } from "./components/layout";
import { LoginPage } from "./routes/login";
import { ConnectPage } from "./routes/connect";
import { OverviewPage } from "./routes/overview";
import { RecommendationsPage } from "./routes/recommendations";
import { RecommendationDetailPage } from "./routes/recommendation-detail";
import { CampaignsPage } from "./routes/campaigns";
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

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
});

const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  validateSearch: (
    search: Record<string, unknown>,
  ): { days?: number; country?: string } => {
    const days = Number(search.days);
    const country =
      typeof search.country === "string" && /^[A-Za-z]{2}$/.test(search.country)
        ? search.country.toUpperCase()
        : undefined;
    return {
      ...(Number.isFinite(days) && days > 0 ? { days } : {}),
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

const campaignDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/campaigns/$id",
  validateSearch: (search: Record<string, unknown>): { days?: number } => {
    const days = Number(search.days);
    return {
      ...(Number.isFinite(days) && days > 0 ? { days } : {}),
    };
  },
  component: CampaignDetailPage,
});

const searchTermsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/search-terms",
  validateSearch: (search: Record<string, unknown>): { book?: string } => ({
    ...(typeof search.book === "string" && search.book !== ""
      ? { book: search.book }
      : {}),
  }),
  component: SearchTermsPage,
});

const searchTermDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/search-terms/$term",
  validateSearch: (
    search: Record<string, unknown>,
  ): { days?: number; book?: string } => {
    const days = Number(search.days);
    return {
      ...(Number.isFinite(days) && days > 0 ? { days } : {}),
      ...(typeof search.book === "string" && search.book !== ""
        ? { book: search.book }
        : {}),
    };
  },
  component: SearchTermDetailPage,
});

const changesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/changes",
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
    campaignDetailRoute,
    searchTermsRoute,
    searchTermDetailRoute,
    changesRoute,
    connectRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
