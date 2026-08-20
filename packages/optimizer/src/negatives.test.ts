import { describe, expect, it } from "vitest";
import {
  blockedCampaignIds,
  keywordSpecsFromNegativeTargets,
  matchesNegative,
  type NegativeKeywordSpec,
} from "./negatives.js";

function negative(
  overrides: Partial<NegativeKeywordSpec> = {},
): NegativeKeywordSpec {
  return {
    campaignId: "camp-1",
    adGroupId: null,
    keywordText: "tractor colouring book",
    matchType: "NEGATIVE_EXACT",
    state: "ENABLED",
    ...overrides,
  };
}

describe("matchesNegative", () => {
  it("matches an exact negative on the identical term", () => {
    expect(matchesNegative("tractor colouring book", negative())).toBe(true);
  });

  it("ignores casing and surrounding or repeated whitespace", () => {
    expect(matchesNegative("  Tractor   Colouring Book ", negative())).toBe(
      true,
    );
  });

  it("accepts every Amazon spelling of the match type", () => {
    for (const matchType of [
      "NEGATIVE_EXACT",
      "negativeExact",
      "negative_exact",
      "exact",
      "EXACT",
    ]) {
      expect(
        matchesNegative("tractor colouring book", negative({ matchType })),
      ).toBe(true);
    }
  });

  it("does not let an exact negative block a longer term", () => {
    expect(matchesNegative("big tractor colouring book", negative())).toBe(
      false,
    );
  });

  it("blocks any term containing a phrase negative in order", () => {
    const phrase = negative({
      keywordText: "colouring book",
      matchType: "NEGATIVE_PHRASE",
    });
    expect(matchesNegative("tractor colouring book", phrase)).toBe(true);
    expect(matchesNegative("colouring book for kids", phrase)).toBe(true);
    expect(matchesNegative("book colouring tractor", phrase)).toBe(false);
  });

  it("does not treat a phrase negative as a substring match", () => {
    const phrase = negative({
      keywordText: "colour",
      matchType: "negativePhrase",
    });
    expect(matchesNegative("colouring book", phrase)).toBe(false);
    expect(matchesNegative("colour book", phrase)).toBe(true);
  });

  it("ignores negatives that are not enabled", () => {
    for (const state of ["PAUSED", "ARCHIVED", "archived"]) {
      expect(
        matchesNegative("tractor colouring book", negative({ state })),
      ).toBe(false);
    }
  });

  it("ignores unknown match types and empty terms", () => {
    expect(
      matchesNegative(
        "tractor colouring book",
        negative({ matchType: "negativeBroad" }),
      ),
    ).toBe(false);
    expect(matchesNegative("   ", negative({ keywordText: "" }))).toBe(false);
  });
});

describe("blockedCampaignIds", () => {
  const term = "tractor colouring book";

  it("blocks a campaign that has a campaign-level negative", () => {
    const blocked = blockedCampaignIds(
      term,
      [negative({ campaignId: "camp-2" })],
      new Map([
        ["camp-1", new Set(["ag-1"])],
        ["camp-2", new Set(["ag-2"])],
      ]),
    );
    expect([...blocked]).toEqual(["camp-2"]);
  });

  it("blocks a campaign only when every serving ad group is negated", () => {
    const servingAdGroups = new Map([
      ["camp-1", new Set(["ag-1", "ag-2"])],
    ]) as ReadonlyMap<string, ReadonlySet<string>>;
    expect(
      blockedCampaignIds(
        term,
        [negative({ campaignId: "camp-1", adGroupId: "ag-1" })],
        servingAdGroups,
      ).size,
    ).toBe(0);
    expect([
      ...blockedCampaignIds(
        term,
        [
          negative({ campaignId: "camp-1", adGroupId: "ag-1" }),
          negative({ campaignId: "camp-1", adGroupId: "ag-2" }),
        ],
        servingAdGroups,
      ),
    ]).toEqual(["camp-1"]);
  });

  it("cannot block a campaign with unknown serving ad groups at ad-group level", () => {
    expect(
      blockedCampaignIds(
        term,
        [negative({ campaignId: "camp-1", adGroupId: "ag-1" })],
        new Map([["camp-1", new Set<string>()]]),
      ).size,
    ).toBe(0);
  });

  it("ignores negatives that do not match the term", () => {
    expect(
      blockedCampaignIds(
        term,
        [negative({ keywordText: "dinosaur colouring book" })],
        new Map([["camp-1", new Set(["ag-1"])]]),
      ).size,
    ).toBe(0);
  });
});

describe("keywordSpecsFromNegativeTargets", () => {
  it("blocks an ASIN shopper term with a campaign-level negative target", () => {
    const specs = keywordSpecsFromNegativeTargets([
      {
        campaignId: "camp-1",
        adGroupId: null,
        asin: "B0CRHVCT1T",
        state: "ENABLED",
      },
    ]);
    expect(
      blockedCampaignIds(
        "b0crhvct1t",
        specs,
        new Map([["camp-1", new Set(["ag-1"])]]),
      ),
    ).toEqual(new Set(["camp-1"]));
  });

  it("ignores paused negative targets", () => {
    expect(
      blockedCampaignIds(
        "b0crhvct1t",
        keywordSpecsFromNegativeTargets([
          {
            campaignId: "camp-1",
            adGroupId: null,
            asin: "B0CRHVCT1T",
            state: "PAUSED",
          },
        ]),
        new Map([["camp-1", new Set(["ag-1"])]]),
      ).size,
    ).toBe(0);
  });
});
