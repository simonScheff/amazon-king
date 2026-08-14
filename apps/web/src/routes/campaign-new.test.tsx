import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { campaignCreationCreateSchema } from "@amazon-king/contracts";
import { CampaignNewPage } from "./campaign-new";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  mutate: vi.fn(),
  search: {} as Record<string, unknown>,
  profiles: [
    {
      profileId: "profile-us",
      region: "NA",
      countryCode: "US",
      currencyCode: "USD",
      enabled: true,
      writeEnabled: true,
    },
    {
      profileId: "profile-de",
      region: "EU",
      countryCode: "DE",
      currencyCode: "EUR",
      enabled: true,
      writeEnabled: false,
    },
    {
      profileId: "profile-fr",
      region: "EU",
      countryCode: "FR",
      currencyCode: "EUR",
      enabled: false,
      writeEnabled: false,
    },
  ] as unknown[],
  books: [
    {
      id: "book-1",
      title: "Everywhere Book",
      format: "paperback",
      marketplaceAsins: [
        { profileId: "profile-us", asin: "B0US000001" },
        { profileId: "profile-de", asin: "B0DE000001" },
      ],
    },
    {
      id: "book-2",
      title: "US Only Book",
      format: "ebook",
      marketplaceAsins: [{ profileId: "profile-us", asin: "B0US000002" }],
    },
  ] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
}));

vi.mock("../api/endpoints", () => ({
  useProfiles: () => ({
    isPending: false,
    error: null,
    data: mocks.profiles,
  }),
  useBooks: () => ({ isPending: false, error: null, data: mocks.books }),
  useCreateCampaignDrafts: () => ({
    isPending: false,
    error: null,
    mutate: mocks.mutate,
  }),
}));

function next() {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

function fillCampaignStep() {
  fireEvent.change(screen.getByLabelText("Campaign name"), {
    target: { value: "My Campaign" },
  });
  fireEvent.change(screen.getByLabelText("Daily budget"), {
    target: { value: "10" },
  });
}

function fillAdGroupStep() {
  fireEvent.change(screen.getByLabelText("Default bid"), {
    target: { value: "0.50" },
  });
}

describe("CampaignNewPage", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.mutate.mockReset();
    mocks.search = {};
  });

  it("requires at least one market and warns about write-disabled markets", () => {
    render(<CampaignNewPage />);

    // Disabled profiles are not listed as markets.
    expect(screen.queryByLabelText("France market")).not.toBeInTheDocument();
    // Write-disabled markets are selectable but carry a warning.
    expect(
      screen.getByText(/writes disabled — applying will be blocked/),
    ).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("United States market"));
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    fireEvent.click(screen.getByLabelText("United States market"));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("filters the book list to books covering every selected market", () => {
    render(<CampaignNewPage />);

    // US only: both books qualify.
    fireEvent.click(screen.getByLabelText("United States market"));
    next();
    fillCampaignStep();
    next();
    fillAdGroupStep();
    next();
    expect(
      screen.getByRole("option", { name: "Everywhere Book (paperback)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "US Only Book (ebook)" }),
    ).toBeInTheDocument();

    // Add Germany: only the book with a DE marketplace ASIN still qualifies.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByLabelText("Germany market"));
    next();
    next();
    next();
    expect(
      screen.getByRole("option", { name: "Everywhere Book (paperback)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "US Only Book (ebook)" }),
    ).not.toBeInTheDocument();
  });

  it("adds, edits, and removes keyword rows and requires one non-empty keyword", () => {
    render(<CampaignNewPage />);

    fireEvent.click(screen.getByLabelText("United States market"));
    next();
    fillCampaignStep();
    next();
    fillAdGroupStep();
    next();
    fireEvent.change(screen.getByLabelText("Book"), {
      target: { value: "book-1" },
    });
    next();

    // Starts with three empty rows; Next is gated on a non-empty keyword.
    expect(screen.getAllByLabelText(/Keyword \d+ text/)).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Add keyword" }));
    expect(screen.getAllByLabelText(/Keyword \d+ text/)).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Remove keyword 1" }));
    expect(screen.getAllByLabelText(/Keyword \d+ text/)).toHaveLength(3);

    fireEvent.change(screen.getByLabelText("Keyword 1 text"), {
      target: { value: "coloring book" },
    });
    expect(screen.getByLabelText("Keyword 1 text")).toHaveValue(
      "coloring book",
    );
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("submits a payload matching the campaign-creation contract", () => {
    render(<CampaignNewPage />);

    fireEvent.click(screen.getByLabelText("United States market"));
    fireEvent.click(screen.getByLabelText("Germany market"));
    next();

    fillCampaignStep();
    fireEvent.change(screen.getByLabelText("Targeting type"), {
      target: { value: "MANUAL" },
    });
    next();

    fillAdGroupStep();
    next();

    fireEvent.change(screen.getByLabelText("Book"), {
      target: { value: "book-1" },
    });
    next();

    fireEvent.change(screen.getByLabelText("Keyword 1 text"), {
      target: { value: "coloring book" },
    });
    fireEvent.change(screen.getByLabelText("Keyword 2 text"), {
      target: { value: "kids activity" },
    });
    fireEvent.change(screen.getByLabelText("Keyword 2 match type"), {
      target: { value: "PHRASE" },
    });
    fireEvent.change(screen.getByLabelText("Keyword 2 bid"), {
      target: { value: "0.75" },
    });
    next();

    // Review shows one card per selected market.
    expect(screen.getByText("United States")).toBeInTheDocument();
    expect(screen.getByText("Germany")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Create draft change sets" }),
    );

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const [payload, options] = mocks.mutate.mock.calls[0]!;
    expect(payload).toEqual({
      profileIds: ["profile-us", "profile-de"],
      campaign: {
        name: "My Campaign",
        dailyBudget: "10",
        targetingType: "MANUAL",
        startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        state: "paused",
      },
      adGroup: { name: "My Campaign ad group", defaultBid: "0.50" },
      bookId: "book-1",
      keywords: [
        { text: "coloring book", matchType: "EXACT", bid: "0.50" },
        { text: "kids activity", matchType: "PHRASE", bid: "0.75" },
      ],
    });
    expect(campaignCreationCreateSchema.safeParse(payload).success).toBe(true);
    expect(options).toEqual(
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("prefills from a cannibalization finding and links it on submit", () => {
    mocks.search = {
      recommendationId: "rec-1",
      searchTerm: "tractor colouring book",
      country: "US",
    };
    render(<CampaignNewPage />);

    // The banner explains the linked resolution and the negatives lock.
    expect(
      screen.getByText(/Resolving a cannibalization finding/),
    ).toBeInTheDocument();
    expect(screen.getByText(/never blocked everywhere/)).toBeInTheDocument();

    // Market step: the conflict's country is preselected.
    expect(screen.getByLabelText("United States market")).toBeChecked();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    next();

    // Campaign step: name and manual targeting prefilled from the term.
    expect(screen.getByLabelText("Campaign name")).toHaveValue(
      "tractor colouring book",
    );
    expect(screen.getByLabelText("Targeting type")).toHaveValue("MANUAL");
    fireEvent.change(screen.getByLabelText("Daily budget"), {
      target: { value: "10" },
    });
    next();

    fillAdGroupStep();
    next();

    fireEvent.change(screen.getByLabelText("Book"), {
      target: { value: "book-1" },
    });
    next();

    // Keywords step: the search term is the first row, exact match.
    expect(screen.getByLabelText("Keyword 1 text")).toHaveValue(
      "tractor colouring book",
    );
    expect(screen.getByLabelText("Keyword 1 match type")).toHaveValue("EXACT");
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    next();

    fireEvent.click(
      screen.getByRole("button", { name: "Create draft change sets" }),
    );

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const [payload] = mocks.mutate.mock.calls[0]!;
    expect(payload).toMatchObject({
      profileIds: ["profile-us"],
      campaign: { name: "tractor colouring book", targetingType: "MANUAL" },
      cannibalization: { recommendationId: "rec-1" },
      // The prefilled keyword inherits the ad group default bid.
      keywords: [
        { text: "tractor colouring book", matchType: "EXACT", bid: "0.50" },
      ],
    });
    expect(campaignCreationCreateSchema.safeParse(payload).success).toBe(true);
  });
});
