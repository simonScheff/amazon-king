import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./settings";

const mocks = vi.hoisted(() => ({
  books: [] as unknown[],
  candidates: [] as unknown[],
  mapBook: vi.fn(),
  saveEconomics: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("../api/endpoints", () => ({
  useAuditEvents: () => ({ isPending: false, error: null, data: [] }),
  useBooks: () => ({ isPending: false, error: null, data: mocks.books }),
  useEnqueueSync: () => ({ isPending: false, mutate: mocks.mutation }),
  useMapAdvertisedBook: () => ({
    isPending: false,
    mutate: mocks.mapBook,
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
  useUnmappedAdvertisedProducts: () => ({
    isPending: false,
    error: null,
    data: mocks.candidates,
  }),
  useUpdateProfile: () => ({ isPending: false, mutate: mocks.mutation }),
}));

describe("SettingsPage book mapping", () => {
  beforeEach(() => {
    mocks.mapBook.mockReset();
    mocks.saveEconomics.mockReset();
    mocks.mutation.mockReset();
    mocks.books = [];
    mocks.candidates = [];
  });

  it("groups an ASIN across profiles and submits confirmed book metadata", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Save United States" }));

    expect(mocks.saveEconomics).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-us",
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
});
