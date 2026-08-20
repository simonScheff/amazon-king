import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./settings";

const mocks = vi.hoisted(() => ({
  books: [] as unknown[],
  candidates: [] as unknown[],
  search: {} as { tab?: string },
  navigate: vi.fn(),
  mapBook: vi.fn(),
  linkMarkets: vi.fn(),
  saveEconomics: vi.fn(),
  saveCover: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
}));

vi.mock("../api/endpoints", () => ({
  useAuditEvents: () => ({ isPending: false, error: null, data: [] }),
  useBooks: () => ({ isPending: false, error: null, data: mocks.books }),
  useEnqueueSync: () => ({ isPending: false, mutate: mocks.mutation }),
  useMapAdvertisedBook: () => ({
    isPending: false,
    mutate: mocks.mapBook,
  }),
  useLinkBookToMarkets: () => ({
    isPending: false,
    mutate: mocks.linkMarkets,
  }),
  useProfiles: () => ({
    isPending: false,
    error: null,
    data: [
      {
        profileId: "profile-us",
        region: "NA",
        countryCode: "US",
        currencyCode: "USD",
        enabled: true,
      },
      {
        profileId: "profile-ca",
        region: "NA",
        countryCode: "CA",
        currencyCode: "CAD",
        enabled: true,
      },
      {
        profileId: "profile-uk",
        region: "EU",
        countryCode: "GB",
        currencyCode: "GBP",
        enabled: true,
      },
      {
        profileId: "profile-au",
        region: "FE",
        countryCode: "AU",
        currencyCode: "AUD",
        enabled: true,
      },
    ],
  }),
  useSaveBookEconomics: () => ({
    isPending: false,
    mutate: mocks.saveEconomics,
  }),
  useSaveBookCover: () => ({
    isPending: false,
    mutate: mocks.saveCover,
  }),
  useUnmappedAdvertisedProducts: () => ({
    isPending: false,
    error: null,
    data: mocks.candidates,
  }),
  useUpdateProfile: () => ({ isPending: false, mutate: mocks.mutation }),
}));

describe("SettingsPage book mapping", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.mapBook.mockReset();
    mocks.linkMarkets.mockReset();
    mocks.saveEconomics.mockReset();
    mocks.saveCover.mockReset();
    mocks.mutation.mockReset();
    mocks.navigate.mockReset();
    mocks.books = [];
    mocks.candidates = [];
    mocks.search = { tab: "books" };
  });

  it("groups an ASIN across profiles and submits confirmed book metadata", () => {
    mocks.search = { tab: "asins" };
    mocks.candidates = [
      {
        profileId: "profile-us",
        asin: "B012345678",
        countryCode: "US",
        currencyCode: "USD",
        adCount: 2,
      },
      {
        profileId: "profile-ca",
        asin: "B012345678",
        countryCode: "CA",
        currencyCode: "CAD",
        adCount: 3,
      },
    ];
    render(<SettingsPage />);

    expect(
      screen.getByText("New advertised ASINs to identify"),
    ).toBeInTheDocument();
    expect(screen.getByText("US (USD) · CA (CAD) · 5 ads")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Book title"), {
      target: { value: "My Coloring Book" },
    });
    fireEvent.change(screen.getByLabelText("Format"), {
      target: { value: "hardcover" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add book" }));

    expect(mocks.mapBook).toHaveBeenCalledWith(
      {
        profileIds: ["profile-us", "profile-ca"],
        asin: "B012345678",
        title: "My Coloring Book",
        format: "hardcover",
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("shows every linked country and prefills saved Canada economics", () => {
    mocks.books = [
      {
        id: "book-1",
        asin: "B012345678",
        title: "My Coloring Book",
        format: "paperback",
        status: "active",
        profileIds: ["profile-us", "profile-ca", "profile-uk", "profile-au"],
        economics: [
          {
            profileId: "profile-ca",
            effectiveFrom: "2026-08-13",
            currency: "CAD",
            listPrice: "14.2100",
            estimatedRoyaltyPerSale: "5.0000",
            targetAcos: null,
            goalMode: "balanced",
            maxSpendWithoutSale: null,
            maxBid: null,
            maxDailyBudget: null,
            notes: "",
          },
        ],
      },
    ];
    render(<SettingsPage />);

    expect(screen.getByText("Your books")).toBeInTheDocument();
    expect(screen.getByText("1 of 4 countries configured")).toBeInTheDocument();
    expect(screen.getByLabelText("Canada list price")).toHaveValue("14.21");
    expect(screen.getByLabelText("Canada net royalty per sale")).toHaveValue(
      "5",
    );
    expect(
      screen.getByRole("button", { name: "Update Canada" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save United States" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save Australia" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save United Kingdom" }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("United States list price"), {
      target: { value: "12.99" },
    });
    fireEvent.change(
      screen.getByLabelText("United States net royalty per sale"),
      { target: { value: "4.25" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "United States economics details" }),
    );
    fireEvent.change(
      screen.getByLabelText("United States economics effective from"),
      { target: { value: "2026-08-07" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save United States" }));

    expect(mocks.saveEconomics).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-us",
        effectiveFrom: "2026-08-07",
        currency: "USD",
        listPrice: "12.99",
        estimatedRoyaltyPerSale: "4.25",
        targetAcos: null,
        goalMode: "balanced",
      }),
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("saves and clears a book cover image URL", () => {
    mocks.books = [
      {
        id: "book-1",
        asin: "B012345678",
        title: "My Coloring Book",
        format: "paperback",
        status: "active",
        coverImageUrl: "https://example.com/cover.jpg",
        profileIds: ["profile-us"],
        economics: [],
      },
    ];
    render(<SettingsPage />);

    const coverInput = screen.getByLabelText(
      "My Coloring Book cover image URL",
    );
    expect(coverInput).toHaveValue("https://example.com/cover.jpg");
    expect(screen.getByAltText("My Coloring Book cover")).toHaveAttribute(
      "src",
      "https://example.com/cover.jpg",
    );

    fireEvent.change(coverInput, {
      target: { value: "https://example.com/new-cover.jpg" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save cover" }));
    expect(mocks.saveCover).toHaveBeenCalledWith(
      { coverImageUrl: "https://example.com/new-cover.jpg" },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );

    fireEvent.change(coverInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cover" }));
    expect(mocks.saveCover).toHaveBeenLastCalledWith(
      { coverImageUrl: null },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("links an unmapped market with the catalog ASIN prefilled", () => {
    mocks.books = [
      {
        id: "book-1",
        asin: "B0CV4BRP1G",
        title: "Monster Truck Coloring Book",
        format: "paperback",
        status: "active",
        profileIds: ["profile-us"],
        marketplaceAsins: [{ profileId: "profile-us", asin: "B0CV4BRP1G" }],
        economics: [],
      },
    ];
    render(<SettingsPage />);

    fireEvent.click(screen.getByText("Link another market (3)"));
    expect(screen.getByText(/already for sale/i)).toBeInTheDocument();
    const ukAsin = screen.getByLabelText(
      "Monster Truck Coloring Book United Kingdom marketplace ASIN",
    );
    expect(ukAsin).toHaveValue("B0CV4BRP1G");
    fireEvent.click(
      screen.getByRole("button", { name: "Add to United Kingdom" }),
    );
    expect(mocks.linkMarkets).toHaveBeenCalledWith(
      {
        bookId: "book-1",
        profileIds: ["profile-uk"],
        asin: "B0CV4BRP1G",
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("switches sections through the tab bar and the URL", () => {
    mocks.search = {};
    render(<SettingsPage />);

    // Default tab is the profiles table.
    expect(
      screen.getByText("Profiles: sync & write access"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Your books")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Audit log" }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { tab: "audit" },
      replace: true,
    });
  });

  it("badges the tabs with outstanding setup work", () => {
    mocks.search = {};
    mocks.books = [
      {
        id: "book-1",
        asin: "B012345678",
        title: "My Coloring Book",
        format: "paperback",
        status: "active",
        profileIds: ["profile-us", "profile-ca"],
        economics: [],
      },
    ];
    mocks.candidates = [
      {
        profileId: "profile-us",
        asin: "B0NEWASIN1",
        countryCode: "US",
        currencyCode: "USD",
        adCount: 1,
      },
    ];
    render(<SettingsPage />);

    expect(
      screen.getByRole("button", { name: "Books & economics 0 of 2" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New ASINs 1" }),
    ).toBeInTheDocument();
  });
});
