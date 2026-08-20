/**
 * Demo-data seed for documentation screenshots. Populates a rich, believable
 * dataset for a fictional KDP author ("Ellis Marlowe") into a SCRATCH database
 * only — never the developer's real database.
 *
 * Usage (from the repo root):
 *
 *   docker exec amazon-king-db psql -U postgres -c "CREATE DATABASE amazon_king_demo"
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/amazon_king_demo \
 *     pnpm exec tsx scripts/seed-demo-data.ts
 *
 * The script applies pending migrations first, then wipes every domain table
 * (schema_migrations is kept) and reseeds, so it is idempotent and re-runnable.
 * Data generation is deterministic (seeded PRNG), so re-runs produce the same
 * numbers up to the rolling 60-day date window, which always ends yesterday.
 *
 * Sign in with the seeded email author@example.com via the dev magic-link flow
 * (start the API with OWNER_EMAIL=author@example.com or an empty OWNER_EMAIL,
 * since the repo .env locks logins to a different address).
 */
import { createPool, migrate } from "@amazon-king/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
// Hard safety rail: this script truncates every domain table. Refuse to run
// against anything but the dedicated scratch database.
if (!/\/amazon_king_demo(\?|$)/.test(databaseUrl)) {
  console.error(
    `Refusing to seed: DATABASE_URL must point at the scratch database ` +
      `"amazon_king_demo" (got ${databaseUrl.replace(/\/\/[^@]*@/, "//***@")})`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so re-runs produce identical numbers.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260820);

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const micros = (n: number) => Math.round(n * 1_000_000);

// Cover URLs must be absolute — the books contract validates `coverImageUrl`
// as a URL. The files are served by the web dev server from
// apps/web/public/demo-covers/, so point at the origin used for screenshots.
const webOrigin = process.env.DEMO_WEB_ORIGIN ?? "http://localhost:5174";

// ---------------------------------------------------------------------------
// Dates: 60 full days ending yesterday (UTC).
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;
const todayUtc = new Date(
  Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  ),
);
const yesterday = new Date(todayUtc.getTime() - DAY_MS);
const DAYS = 60;
const WINDOW30_START_INDEX = DAYS - 30;

function dayAt(index: number): Date {
  return new Date(yesterday.getTime() - (DAYS - 1 - index) * DAY_MS);
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const windowStart = isoDay(dayAt(WINDOW30_START_INDEX));
const windowEnd = isoDay(dayAt(DAYS - 1));

// ---------------------------------------------------------------------------
// Fictional catalog.
// ---------------------------------------------------------------------------
const PEN_NAME = "Ellis Marlowe";
const EMAIL = "author@example.com";

const profileDefs = [
  {
    key: "us",
    profileId: "1743652901847563",
    accountId: "ENTITY2H8FK3N9US",
    region: "NA",
    countryCode: "US",
    currency: "USD",
    timezone: "America/Los_Angeles",
    writeEnabled: true,
  },
  {
    key: "uk",
    profileId: "2384657102938475",
    accountId: "ENTITY7QKM42W8GB",
    region: "EU",
    countryCode: "GB",
    currency: "GBP",
    timezone: "Europe/London",
    writeEnabled: false,
  },
  {
    key: "de",
    profileId: "3129847561029384",
    accountId: "ENTITY5ZXTV61EDE",
    region: "EU",
    countryCode: "DE",
    currency: "EUR",
    timezone: "Europe/Berlin",
    writeEnabled: false,
  },
  {
    key: "ca",
    profileId: "4093827561029384",
    accountId: "ENTITY9ASDGF43CA",
    region: "NA",
    countryCode: "CA",
    currency: "CAD",
    timezone: "America/Toronto",
    writeEnabled: false,
  },
] as const;

const bookDefs = [
  {
    key: "emberfall",
    title: "Emberfall",
    format: "kindle",
    asin: "B0EMBRFALL",
    cover: `${webOrigin}/demo-covers/emberfall.svg`,
  },
  {
    key: "saltRoad",
    title: "The Salt Road",
    format: "kindle",
    asin: "B0SALTR0AD",
    cover: `${webOrigin}/demo-covers/salt-road.svg`,
  },
  {
    key: "quietHarbor",
    title: "Quiet Harbor",
    format: "paperback",
    asin: "B0QUIETHBR",
    cover: `${webOrigin}/demo-covers/quiet-harbor.svg`,
  },
  {
    key: "nightjar",
    title: "Nightjar",
    format: "kindle",
    asin: "B0NIGHTJAR",
    cover: `${webOrigin}/demo-covers/nightjar.svg`,
  },
] as const;

/** book key → profile key → economics (currency matches the profile). */
const economicsDefs: Record<
  string,
  Record<
    string,
    {
      listPrice: number;
      royalty: number;
      targetAcos: number;
      goalMode: "profit" | "balanced" | "launch" | "visibility";
      maxBid: number;
      maxDailyBudget: number;
      maxSpendWithoutSale: number;
    }
  >
> = {
  emberfall: {
    us: {
      listPrice: 4.99,
      royalty: 3.42,
      targetAcos: 0.35,
      goalMode: "profit",
      maxBid: 1.5,
      maxDailyBudget: 40,
      maxSpendWithoutSale: 12,
    },
    uk: {
      listPrice: 3.99,
      royalty: 2.72,
      targetAcos: 0.35,
      goalMode: "balanced",
      maxBid: 1.2,
      maxDailyBudget: 30,
      maxSpendWithoutSale: 10,
    },
    de: {
      listPrice: 4.49,
      royalty: 3.08,
      targetAcos: 0.38,
      goalMode: "balanced",
      maxBid: 1.2,
      maxDailyBudget: 30,
      maxSpendWithoutSale: 10,
    },
  },
  saltRoad: {
    us: {
      listPrice: 5.99,
      royalty: 4.12,
      targetAcos: 0.4,
      goalMode: "balanced",
      maxBid: 1.3,
      maxDailyBudget: 25,
      maxSpendWithoutSale: 14,
    },
    uk: {
      listPrice: 4.99,
      royalty: 3.42,
      targetAcos: 0.4,
      goalMode: "balanced",
      maxBid: 1.1,
      maxDailyBudget: 20,
      maxSpendWithoutSale: 12,
    },
  },
  quietHarbor: {
    us: {
      listPrice: 14.99,
      royalty: 4.49,
      targetAcos: 0.3,
      goalMode: "profit",
      maxBid: 0.9,
      maxDailyBudget: 15,
      maxSpendWithoutSale: 8,
    },
  },
  nightjar: {
    us: {
      listPrice: 3.99,
      royalty: 2.72,
      targetAcos: 0.32,
      goalMode: "visibility",
      maxBid: 1.0,
      maxDailyBudget: 20,
      maxSpendWithoutSale: 9,
    },
    de: {
      listPrice: 3.99,
      royalty: 2.72,
      targetAcos: 0.32,
      goalMode: "visibility",
      maxBid: 1.0,
      maxDailyBudget: 20,
      maxSpendWithoutSale: 9,
    },
    ca: {
      listPrice: 4.99,
      royalty: 3.42,
      targetAcos: 0.45,
      goalMode: "launch",
      maxBid: 1.4,
      maxDailyBudget: 25,
      maxSpendWithoutSale: 15,
    },
  },
};

interface TermDef {
  term: string;
  share: number;
  /** Never attribute orders to this term (wasteful/zero-sale stories). */
  zeroSales?: boolean;
}
interface TargetDef {
  key: string;
  kind: "keyword" | "product";
  /** Stored expression JSON (mirrors structure-sync shapes). */
  expression: unknown;
  matchType: string | null;
  bid: number;
  share: number;
  terms: TermDef[];
}
interface CampaignDef {
  key: string;
  profileKey: keyof typeof profileCountry;
  bookKey: string;
  name: string;
  targetingType: "AUTO" | "MANUAL";
  state: "enabled" | "paused";
  dailyBudget: number;
  /** When paused, only the first `activeDays` days carry metrics. */
  activeDays: number;
  imp: number;
  ctr: number;
  cpc: number;
  cvr: number;
  aov: number;
  targets: TargetDef[];
}

const profileCountry = { us: 1, uk: 1, de: 1, ca: 1 } as const;

const kw = (
  key: string,
  text: string,
  matchType: "EXACT" | "BROAD" | "PHRASE",
  bid: number,
  share: number,
  terms: TermDef[],
): TargetDef => ({
  key,
  kind: "keyword",
  expression: { type: "keyword", value: text },
  matchType,
  bid,
  share,
  terms,
});
const autoTarget = (
  key: string,
  amazonType: string,
  bid: number,
  share: number,
  terms: TermDef[],
): TargetDef => ({
  key,
  kind: "product",
  expression: [{ type: amazonType }],
  matchType: null,
  bid,
  share,
  terms,
});
const asinTarget = (
  key: string,
  asin: string,
  bid: number,
  share: number,
  terms: TermDef[],
): TargetDef => ({
  key,
  kind: "product",
  expression: [{ type: "asinSameAs", values: [asin] }],
  matchType: null,
  bid,
  share,
  terms,
});

const campaignDefs: CampaignDef[] = [
  {
    key: "emberAutoUs",
    profileKey: "us",
    bookKey: "emberfall",
    name: "Emberfall — Auto — US",
    targetingType: "AUTO",
    state: "enabled",
    dailyBudget: 15,
    activeDays: DAYS,
    imp: 2400,
    ctr: 0.0045,
    cpc: 0.36,
    cvr: 0.16,
    aov: 4.99,
    targets: [
      autoTarget("closeMatch", "CLOSE_MATCH", 0.42, 0.45, [
        { term: "dragon rider fantasy", share: 0.3 },
        { term: "epic fantasy books", share: 0.25 },
        { term: "emberfall book", share: 0.2 },
        { term: "kindle fantasy deals", share: 0.25 },
      ]),
      autoTarget("looseMatch", "LOOSE_MATCH", 0.35, 0.35, [
        { term: "fantasy adventure novels", share: 0.5 },
        { term: "books like fourth wing", share: 0.5 },
      ]),
      asinTarget("compAsin", "B0CMPDRGN01", 0.4, 0.2, [
        { term: "B0CMPDRGN01", share: 1 },
      ]),
    ],
  },
  {
    key: "emberExactUs",
    profileKey: "us",
    bookKey: "emberfall",
    name: "Emberfall — Exact — US",
    targetingType: "MANUAL",
    state: "enabled",
    dailyBudget: 25,
    activeDays: DAYS,
    imp: 1800,
    ctr: 0.006,
    cpc: 0.52,
    cvr: 0.22,
    aov: 4.99,
    targets: [
      kw("dragonRiderBooks", "dragon rider books", "EXACT", 0.52, 0.35, [
        { term: "dragon rider books", share: 1 },
      ]),
      kw("dragonRiderFantasy", "dragon rider fantasy", "EXACT", 0.55, 0.3, [
        { term: "dragon rider fantasy", share: 1 },
      ]),
      kw("epicFantasyKindle", "epic fantasy kindle", "EXACT", 0.52, 0.25, [
        { term: "epic fantasy kindle", share: 1 },
      ]),
      asinTarget("compAsin", "B0CMPDRGN01", 0.48, 0.1, [
        { term: "B0CMPDRGN01", share: 1 },
      ]),
    ],
  },
  {
    key: "saltBroadUs",
    profileKey: "us",
    bookKey: "saltRoad",
    name: "The Salt Road — Broad — US",
    targetingType: "MANUAL",
    state: "enabled",
    dailyBudget: 12,
    activeDays: DAYS,
    imp: 3200,
    ctr: 0.005,
    cpc: 0.61,
    cvr: 0.02,
    aov: 5.99,
    targets: [
      kw("romanceBestsellers", "romance bestsellers", "BROAD", 0.85, 0.5, [
        { term: "romance bestsellers", share: 0.4 },
        { term: "free romance books", share: 0.35, zeroSales: true },
        { term: "romance kindle unlimited", share: 0.25 },
      ]),
      kw("desertRomance", "desert romance novel", "BROAD", 0.62, 0.3, [
        { term: "desert romance novel", share: 0.7 },
        { term: "love story books", share: 0.3, zeroSales: true },
      ]),
      asinTarget("compAsin", "B0CMPRMA2C2", 0.58, 0.2, [
        { term: "B0CMPRMA2C2", share: 1 },
      ]),
    ],
  },
  {
    key: "quietAutoUs",
    profileKey: "us",
    bookKey: "quietHarbor",
    name: "Quiet Harbor — Auto — US",
    targetingType: "AUTO",
    state: "enabled",
    dailyBudget: 10,
    activeDays: DAYS,
    imp: 5000,
    ctr: 0.008,
    cpc: 0.44,
    cvr: 0,
    aov: 14.99,
    targets: [
      autoTarget("closeMatch", "CLOSE_MATCH", 0.5, 0.5, [
        { term: "coastal fiction paperback", share: 0.4, zeroSales: true },
        { term: "quiet harbor book", share: 0.3, zeroSales: true },
        { term: "small town novels", share: 0.3, zeroSales: true },
      ]),
      autoTarget("looseMatch", "LOOSE_MATCH", 0.38, 0.3, [
        { term: "beach reads paperback", share: 0.6, zeroSales: true },
        { term: "lighthouse gifts", share: 0.4, zeroSales: true },
      ]),
      autoTarget("substitutes", "SUBSTITUTES", 0.45, 0.2, [
        { term: "nicholas sparks paperback", share: 1, zeroSales: true },
      ]),
    ],
  },
  {
    key: "nightjarExactUs",
    profileKey: "us",
    bookKey: "nightjar",
    name: "Nightjar — Exact — US",
    targetingType: "MANUAL",
    state: "paused",
    dailyBudget: 8,
    activeDays: 48, // paused ~12 days ago; no metrics since
    imp: 900,
    ctr: 0.004,
    cpc: 0.4,
    cvr: 0.1,
    aov: 3.99,
    targets: [
      kw("psychThriller", "psychological thriller kindle", "EXACT", 0.44, 0.6, [
        { term: "psychological thriller kindle", share: 1 },
      ]),
      kw("nightjarBook", "nightjar book", "EXACT", 0.38, 0.4, [
        { term: "nightjar book", share: 1 },
      ]),
    ],
  },
  {
    key: "emberAutoUk",
    profileKey: "uk",
    bookKey: "emberfall",
    name: "Emberfall — Auto — UK",
    targetingType: "AUTO",
    state: "enabled",
    dailyBudget: 12,
    activeDays: DAYS,
    imp: 1100,
    ctr: 0.0042,
    cpc: 0.29,
    cvr: 0.15,
    aov: 3.99,
    targets: [
      autoTarget("closeMatch", "CLOSE_MATCH", 0.33, 0.6, [
        { term: "dragon fantasy books", share: 0.6 },
        { term: "epic fantasy kindle uk", share: 0.4 },
      ]),
      autoTarget("looseMatch", "LOOSE_MATCH", 0.26, 0.4, [
        { term: "fantasy novels for adults", share: 1 },
      ]),
    ],
  },
  {
    key: "emberExactDe",
    profileKey: "de",
    bookKey: "emberfall",
    name: "Emberfall — Exact — DE",
    targetingType: "MANUAL",
    state: "enabled",
    dailyBudget: 15,
    activeDays: DAYS,
    imp: 700,
    ctr: 0.0038,
    cpc: 0.31,
    cvr: 0.12,
    aov: 4.49,
    targets: [
      kw("drachenFantasy", "drachen fantasy roman", "EXACT", 0.36, 0.6, [
        { term: "drachen fantasy roman", share: 1 },
      ]),
      kw("epischeFantasy", "epische fantasy bücher", "EXACT", 0.33, 0.395, [
        { term: "epische fantasy bücher", share: 1 },
      ]),
      kw("drachenreiter", "drachenreiter roman", "EXACT", 0.31, 0.005, [
        { term: "drachenreiter roman", share: 1 },
      ]),
    ],
  },
  {
    key: "nightjarAutoCa",
    profileKey: "ca",
    bookKey: "nightjar",
    name: "Nightjar — Auto — CA",
    targetingType: "AUTO",
    state: "enabled",
    dailyBudget: 10,
    activeDays: DAYS,
    imp: 500,
    ctr: 0.004,
    cpc: 0.33,
    cvr: 0.08,
    aov: 4.99,
    targets: [
      autoTarget("closeMatch", "CLOSE_MATCH", 0.37, 0.7, [
        { term: "thriller books kindle", share: 1 },
      ]),
      autoTarget("looseMatch", "LOOSE_MATCH", 0.29, 0.3, [
        { term: "crime novels canada", share: 1 },
      ]),
    ],
  },
];

// Amazon id sequences (long numeric strings, like the real API).
let idSeq = 100000000000;
const nextAmazonId = () => String(490000000000000 + idSeq++ * 7);

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const pool = createPool(databaseUrl);

try {
  const applied = await migrate(pool);
  console.log(
    applied.length === 0
      ? "Migrations: database already up to date."
      : `Migrations applied: ${applied.join(", ")}`,
  );

  console.log("Wiping existing domain data…");
  await pool.query(`
    truncate table
      audit_events,
      change_actions,
      change_sets,
      campaign_bid_policies,
      recommendation_evidence,
      recommendation_dismissals,
      recommendations,
      placement_metrics_daily,
      advertised_product_metrics_daily,
      search_term_metrics_daily,
      target_metrics_daily,
      campaign_metrics_daily,
      negative_targets,
      negative_keywords,
      entity_change_history,
      targets,
      ads,
      ad_groups,
      campaigns,
      book_economics,
      book_profile_links,
      books,
      report_jobs,
      sync_runs,
      job_queue,
      amazon_profiles,
      amazon_connections,
      oauth_states,
      login_tokens,
      sessions,
      workspace_members,
      users,
      workspaces
    restart identity cascade
  `);

  /** Multi-row INSERT helper (batches of 200 rows). */
  async function batchInsert(
    table: string,
    columns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void> {
    const size = 200;
    for (let i = 0; i < rows.length; i += size) {
      const batch = rows.slice(i, i + size);
      const params: unknown[] = [];
      const tuples = batch.map(
        (row, r) =>
          `(${row.map((_, c) => `$${r * row.length + c + 1}`).join(", ")})`,
      );
      for (const row of batch) params.push(...row);
      await pool.query(
        `insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}`,
        params,
      );
    }
  }

  /** Single-row INSERT … RETURNING id. */
  async function insertReturningId(
    table: string,
    values: Record<string, unknown>,
  ): Promise<string> {
    const columns = Object.keys(values);
    const result = await pool.query<{ id: string }>(
      `insert into ${table} (${columns.join(", ")}) values (${columns
        .map((_, i) => `$${i + 1}`)
        .join(", ")}) returning id`,
      columns.map((c) => values[c]),
    );
    return result.rows[0]!.id;
  }

  // --- Identity -------------------------------------------------------------
  const userId = await insertReturningId("users", { email: EMAIL });
  const workspaceId = await insertReturningId("workspaces", {
    name: `${PEN_NAME} — KDP`,
    timezone: "America/New_York",
  });
  await pool.query(
    `insert into workspace_members (workspace_id, user_id, role)
     values ($1, $2, 'owner')`,
    [workspaceId, userId],
  );

  // --- Amazon connection + profiles ------------------------------------------
  const connectionId = await insertReturningId("amazon_connections", {
    workspace_id: workspaceId,
    // Arbitrary non-null ciphertext stand-in; nothing decrypts it because no
    // sync runs against this database.
    encrypted_refresh_token: Buffer.from(
      "demo-encrypted-refresh-token-not-real",
      "utf8",
    ),
    encryption_key_version: 1,
    status: "connected",
    granted_at: new Date(Date.now() - 45 * DAY_MS).toISOString(),
  });

  const profilePk: Record<string, string> = {};
  for (const p of profileDefs) {
    profilePk[p.key] = await insertReturningId("amazon_profiles", {
      connection_id: connectionId,
      profile_id: p.profileId,
      account_id: p.accountId,
      region: p.region,
      country_code: p.countryCode,
      currency_code: p.currency,
      timezone: p.timezone,
      account_type: "seller",
      enabled: true,
      write_enabled: p.writeEnabled,
    });
  }

  // --- Books, marketplace links, economics ------------------------------------
  const bookPk: Record<string, string> = {};
  for (const b of bookDefs) {
    bookPk[b.key] = await insertReturningId("books", {
      workspace_id: workspaceId,
      asin: b.asin,
      title: b.title,
      format: b.format,
      status: "active",
      cover_json: JSON.stringify({ imageUrl: b.cover }),
    });
  }
  for (const [bookKey, perProfile] of Object.entries(economicsDefs)) {
    const asin = bookDefs.find((b) => b.key === bookKey)!.asin;
    for (const [pKey, eco] of Object.entries(perProfile)) {
      const profile = profileDefs.find((p) => p.key === pKey)!;
      await pool.query(
        `insert into book_profile_links (book_id, profile_id, marketplace_asin, enabled)
         values ($1, $2, $3, true)`,
        [bookPk[bookKey], profilePk[pKey], asin],
      );
      await pool.query(
        `insert into book_economics
           (book_id, profile_id, effective_from, currency, list_price,
            estimated_royalty_per_sale, target_acos, goal_mode,
            max_spend_without_sale, max_bid, max_daily_budget, notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          bookPk[bookKey],
          profilePk[pKey],
          "2025-01-01",
          profile.currency,
          eco.listPrice,
          eco.royalty,
          eco.targetAcos,
          eco.goalMode,
          eco.maxSpendWithoutSale,
          eco.maxBid,
          eco.maxDailyBudget,
          `KDP royalty estimate for ${profile.countryCode} (${PEN_NAME} catalog).`,
        ],
      );
    }
  }

  // --- Campaign structure ------------------------------------------------------
  const campaignPk: Record<string, string> = {};
  const campaignAmazonId: Record<string, string> = {};
  const adGroupPk: Record<string, string> = {};
  const adGroupAmazonId: Record<string, string> = {};
  const adAmazonId: Record<string, string> = {};
  const targetPk: Record<string, string> = {}; // `${campaignKey}:${targetKey}`
  const targetAmazonId: Record<string, string> = {};
  const sourceUpdatedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();

  for (const c of campaignDefs) {
    const amazonId = nextAmazonId();
    campaignAmazonId[c.key] = amazonId;
    campaignPk[c.key] = await insertReturningId("campaigns", {
      profile_id: profilePk[c.profileKey],
      amazon_campaign_id: amazonId,
      name: c.name,
      state: c.state,
      targeting_type: c.targetingType,
      daily_budget: c.dailyBudget,
      start_date: isoDay(new Date(yesterday.getTime() - 200 * DAY_MS)),
      source_updated_at: sourceUpdatedAt,
    });
    const agAmazonId = nextAmazonId();
    adGroupAmazonId[c.key] = agAmazonId;
    adGroupPk[c.key] = await insertReturningId("ad_groups", {
      profile_id: profilePk[c.profileKey],
      campaign_id: campaignPk[c.key],
      amazon_ad_group_id: agAmazonId,
      name: `${bookDefs.find((b) => b.key === c.bookKey)!.title} — Ad Group`,
      state: c.state === "paused" ? "paused" : "enabled",
      default_bid: round4(c.cpc),
      source_updated_at: sourceUpdatedAt,
    });
    const adId = nextAmazonId();
    adAmazonId[c.key] = adId;
    const book = bookDefs.find((b) => b.key === c.bookKey)!;
    await pool.query(
      `insert into ads (profile_id, ad_group_id, amazon_ad_id, asin, state, source_updated_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        profilePk[c.profileKey],
        adGroupPk[c.key],
        adId,
        book.asin,
        "enabled",
        sourceUpdatedAt,
      ],
    );
    for (const t of c.targets) {
      const tAmazonId = nextAmazonId();
      targetAmazonId[`${c.key}:${t.key}`] = tAmazonId;
      targetPk[`${c.key}:${t.key}`] = await insertReturningId("targets", {
        profile_id: profilePk[c.profileKey],
        campaign_id: campaignPk[c.key],
        ad_group_id: adGroupPk[c.key],
        amazon_target_id: tAmazonId,
        target_kind: t.kind,
        expression: JSON.stringify(t.expression),
        match_type: t.matchType,
        bid: t.bid,
        state: c.state === "paused" ? "paused" : "enabled",
        source_updated_at: sourceUpdatedAt,
      });
    }
  }

  // --- Negative keywords / targets (current Amazon state mirror) --------------
  const negativeVampireRomanceId = nextAmazonId();
  await batchInsert(
    "negative_keywords",
    [
      "profile_id",
      "campaign_id",
      "ad_group_id",
      "amazon_negative_keyword_id",
      "keyword_text",
      "match_type",
      "state",
      "source_updated_at",
    ],
    [
      [
        profilePk.us,
        campaignPk.emberAutoUs,
        null,
        negativeVampireRomanceId,
        "vampire romance",
        "NEGATIVE_EXACT",
        "enabled",
        sourceUpdatedAt,
      ],
      [
        profilePk.us,
        campaignPk.emberAutoUs,
        null,
        nextAmazonId(),
        "free download",
        "NEGATIVE_EXACT",
        "enabled",
        sourceUpdatedAt,
      ],
      [
        profilePk.us,
        campaignPk.emberAutoUs,
        adGroupPk.emberAutoUs,
        nextAmazonId(),
        "audiobook",
        "NEGATIVE_PHRASE",
        "enabled",
        sourceUpdatedAt,
      ],
      [
        profilePk.us,
        campaignPk.saltBroadUs,
        null,
        nextAmazonId(),
        "pdf",
        "NEGATIVE_EXACT",
        "enabled",
        sourceUpdatedAt,
      ],
      [
        profilePk.us,
        campaignPk.quietAutoUs,
        adGroupPk.quietAutoUs,
        nextAmazonId(),
        "coloring book",
        "NEGATIVE_EXACT",
        "enabled",
        sourceUpdatedAt,
      ],
    ],
  );
  await batchInsert(
    "negative_targets",
    [
      "profile_id",
      "campaign_id",
      "ad_group_id",
      "amazon_negative_target_id",
      "expression_asin",
      "state",
      "source_updated_at",
    ],
    [
      [
        profilePk.us,
        campaignPk.emberExactUs,
        null,
        nextAmazonId(),
        "B08RIVAL99",
        "enabled",
        sourceUpdatedAt,
      ],
      [
        profilePk.uk,
        campaignPk.emberAutoUk,
        adGroupPk.emberAutoUk,
        nextAmazonId(),
        "B07COMPUK77",
        "enabled",
        sourceUpdatedAt,
      ],
    ],
  );

  // --- 60 days of metrics -------------------------------------------------------
  console.log("Generating 60 days of metrics…");
  const campaignRows: unknown[][] = [];
  const targetRows: unknown[][] = [];
  const termRows: unknown[][] = [];
  const adProductRows: unknown[][] = [];
  const placementRows: unknown[][] = [];

  interface Accumulator {
    impressions: number;
    clicks: number;
    cost: number;
    sales: number;
    orders: number;
    units: number;
  }
  const newAcc = (): Accumulator => ({
    impressions: 0,
    clicks: 0,
    cost: 0,
    sales: 0,
    orders: 0,
    units: 0,
  });
  const addTo = (acc: Accumulator, m: Accumulator) => {
    acc.impressions += m.impressions;
    acc.clicks += m.clicks;
    acc.cost += m.cost;
    acc.sales += m.sales;
    acc.orders += m.orders;
    acc.units += m.units;
  };
  /** 30-day accumulators for recommendation evidence. */
  const campaignAcc30: Record<string, Accumulator> = {};
  const targetAcc30: Record<string, Accumulator> = {};
  const termAcc30: Record<string, Record<string, Accumulator>> = {};

  const PLACEMENTS: readonly [string, number][] = [
    ["PLACEMENT_TOP", 0.5],
    ["PLACEMENT_REST_OF_SEARCH", 0.35],
    ["PLACEMENT_PRODUCT_PAGE", 0.15],
  ];

  for (const c of campaignDefs) {
    const profile = profileDefs.find((p) => p.key === c.profileKey)!;
    campaignAcc30[c.key] = newAcc();
    termAcc30[c.key] = {};
    for (let day = 0; day < c.activeDays; day++) {
      const date = isoDay(dayAt(day));
      const in30 = day >= WINDOW30_START_INDEX;
      const dayTotals = newAcc();

      for (const t of c.targets) {
        const tKey = `${c.key}:${t.key}`;
        targetAcc30[tKey] ??= newAcc();
        const tImp = Math.round(c.imp * t.share * (0.8 + 0.4 * rand()));
        const tClicks = Math.min(
          tImp,
          Math.round(tImp * c.ctr * (0.85 + 0.3 * rand())),
        );
        const tCost = round4(tClicks * c.cpc * (0.9 + 0.2 * rand()));
        const expected = tClicks * c.cvr;
        const tOrders = Math.floor(expected) + (rand() < expected % 1 ? 1 : 0);
        const tUnits = tOrders + (tOrders > 0 && rand() < 0.25 ? 1 : 0);
        const tSales = round4(tOrders * c.aov);
        const tMetrics: Accumulator = {
          impressions: tImp,
          clicks: tClicks,
          cost: tCost,
          sales: tSales,
          orders: tOrders,
          units: tUnits,
        };
        addTo(dayTotals, tMetrics);
        if (in30) addTo(targetAcc30[tKey], tMetrics);
        targetRows.push([
          profilePk[c.profileKey],
          campaignAmazonId[c.key],
          adGroupAmazonId[c.key],
          targetAmazonId[tKey],
          date,
          tImp,
          tClicks,
          tCost,
          tSales,
          tOrders,
          tOrders,
          tSales,
          tOrders,
          tSales,
          profile.currency,
          tUnits,
          tUnits,
          tUnits,
        ]);

        for (const term of t.terms) {
          const imp = Math.round(tImp * term.share);
          const clicks = Math.min(imp, Math.round(tClicks * term.share));
          const cost = round4(tCost * term.share);
          const orders = term.zeroSales
            ? 0
            : Math.min(clicks, Math.round(tOrders * term.share));
          const units = orders + (orders > 0 && rand() < 0.2 ? 1 : 0);
          const sales = round4(orders * c.aov);
          if (imp === 0 && clicks === 0) continue;
          termRows.push([
            profilePk[c.profileKey],
            campaignAmazonId[c.key],
            adGroupAmazonId[c.key],
            targetAmazonId[tKey],
            term.term,
            date,
            imp,
            clicks,
            cost,
            sales,
            orders,
            orders,
            sales,
            orders,
            sales,
            profile.currency,
            units,
            units,
            units,
          ]);
          if (in30) {
            termAcc30[c.key]![term.term] ??= newAcc();
            addTo(termAcc30[c.key]![term.term]!, {
              impressions: imp,
              clicks,
              cost,
              sales,
              orders,
              units,
            });
          }
        }
      }

      if (in30) addTo(campaignAcc30[c.key]!, dayTotals);
      const base = [
        profilePk[c.profileKey],
        campaignAmazonId[c.key],
        date,
        dayTotals.impressions,
        dayTotals.clicks,
        round4(dayTotals.cost),
        round4(dayTotals.sales),
        dayTotals.orders,
        dayTotals.orders,
        round4(dayTotals.sales),
        dayTotals.orders,
        round4(dayTotals.sales),
        profile.currency,
        dayTotals.units,
        dayTotals.units,
        dayTotals.units,
      ];
      campaignRows.push(base);
      adProductRows.push([
        profilePk[c.profileKey],
        campaignAmazonId[c.key],
        adGroupAmazonId[c.key],
        adAmazonId[c.key],
        ...base.slice(2),
      ]);
      for (const [placement, weight] of PLACEMENTS) {
        const pImp = Math.round(dayTotals.impressions * weight);
        const pClicks = Math.round(dayTotals.clicks * weight);
        const pOrders = Math.round(dayTotals.orders * weight);
        const pUnits = Math.round(dayTotals.units * weight);
        placementRows.push([
          profilePk[c.profileKey],
          campaignAmazonId[c.key],
          placement,
          date,
          pImp,
          pClicks,
          round4(dayTotals.cost * weight),
          round4(dayTotals.sales * weight),
          pOrders,
          pOrders,
          round4(dayTotals.sales * weight),
          pOrders,
          round4(dayTotals.sales * weight),
          profile.currency,
          pUnits,
          pUnits,
          pUnits,
        ]);
      }
    }
  }

  const METRIC_COLUMNS = [
    "profile_id",
    "campaign_id",
    "metric_date",
    "impressions",
    "clicks",
    "cost",
    "sales",
    "orders",
    "purchases7d",
    "sales7d",
    "purchases14d",
    "sales14d",
    "currency",
    "units",
    "units_sold_clicks7d",
    "units_sold_clicks14d",
  ] as const;
  await batchInsert("campaign_metrics_daily", METRIC_COLUMNS, campaignRows);
  await batchInsert(
    "target_metrics_daily",
    [
      "profile_id",
      "campaign_id",
      "ad_group_id",
      "target_id",
      "metric_date",
      "impressions",
      "clicks",
      "cost",
      "sales",
      "orders",
      "purchases7d",
      "sales7d",
      "purchases14d",
      "sales14d",
      "currency",
      "units",
      "units_sold_clicks7d",
      "units_sold_clicks14d",
    ],
    targetRows,
  );
  await batchInsert(
    "search_term_metrics_daily",
    [
      "profile_id",
      "campaign_id",
      "ad_group_id",
      "target_id",
      "search_term",
      "metric_date",
      "impressions",
      "clicks",
      "cost",
      "sales",
      "orders",
      "purchases7d",
      "sales7d",
      "purchases14d",
      "sales14d",
      "currency",
      "units",
      "units_sold_clicks7d",
      "units_sold_clicks14d",
    ],
    termRows,
  );
  await batchInsert(
    "advertised_product_metrics_daily",
    [
      "profile_id",
      "campaign_id",
      "ad_group_id",
      "ad_id",
      "metric_date",
      "impressions",
      "clicks",
      "cost",
      "sales",
      "orders",
      "purchases7d",
      "sales7d",
      "purchases14d",
      "sales14d",
      "currency",
      "units",
      "units_sold_clicks7d",
      "units_sold_clicks14d",
    ],
    adProductRows,
  );
  await batchInsert(
    "placement_metrics_daily",
    [
      "profile_id",
      "campaign_id",
      "placement",
      "metric_date",
      "impressions",
      "clicks",
      "cost",
      "sales",
      "orders",
      "purchases7d",
      "sales7d",
      "purchases14d",
      "sales14d",
      "currency",
      "units",
      "units_sold_clicks7d",
      "units_sold_clicks14d",
    ],
    placementRows,
  );
  console.log(
    `Inserted metrics: ${campaignRows.length} campaign, ${targetRows.length} target, ` +
      `${termRows.length} search-term, ${adProductRows.length} ad-product, ${placementRows.length} placement rows.`,
  );

  // --- Sync runs (fresh, so sync health is green) ------------------------------
  const syncRows: unknown[][] = [];
  for (const p of profileDefs) {
    syncRows.push([
      profilePk[p.key],
      "structure",
      "complete",
      new Date(Date.now() - 3.2 * 3_600_000).toISOString(),
      new Date(Date.now() - 3 * 3_600_000).toISOString(),
      null,
    ]);
    syncRows.push([
      profilePk[p.key],
      "metrics",
      "complete",
      new Date(Date.now() - 2.2 * 3_600_000).toISOString(),
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
      null,
    ]);
  }
  syncRows.push([
    profilePk.us,
    "metrics",
    "complete",
    new Date(Date.now() - 10 * DAY_MS).toISOString(),
    new Date(Date.now() - 10 * DAY_MS + 240_000).toISOString(),
    null,
  ]);
  syncRows.push([
    profilePk.us,
    "backfill",
    "complete",
    new Date(Date.now() - 44 * DAY_MS).toISOString(),
    new Date(Date.now() - 44 * DAY_MS + 600_000).toISOString(),
    null,
  ]);
  await batchInsert(
    "sync_runs",
    ["profile_id", "kind", "status", "started_at", "finished_at", "error"],
    syncRows,
  );

  // --- Recommendations -----------------------------------------------------------
  const window = { start: windowStart, end: windowEnd };
  const freshness = new Date(yesterday.getTime() + 23 * 3_600_000);
  const pendingExpiry = new Date(Date.now() + 6 * DAY_MS);

  interface RecDef {
    profileKey: string;
    type: string;
    campaignKey?: string;
    targetKey?: string;
    searchTerm?: string;
    priority: number;
    currentValue?: string;
    proposedValue?: string;
    rationale: string;
    confidence: number;
    state: "pending" | "approved" | "expired" | "applied";
    ruleVersion: string;
    expiresAt: Date;
    createdDaysAgo: number;
    evidence: unknown;
  }

  const cannAuto = termAcc30.emberAutoUs!["dragon rider fantasy"]!;
  const cannExact = termAcc30.emberExactUs!["dragon rider fantasy"]!;
  const cannTotalMicros = micros(cannAuto.cost + cannExact.cost);
  const conv = campaignAcc30.quietAutoUs!;
  const wasteful = termAcc30.saltBroadUs!["free romance books"]!;
  const expensive = targetAcc30["saltBroadUs:romanceBestsellers"]!;
  const profitable = targetAcc30["emberExactUs:dragonRiderBooks"]!;
  const harvest = termAcc30.emberAutoUs!["emberfall book"]!;
  const lowImp = targetAcc30["emberExactDe:drachenreiter"]!;
  const emberExactAcc = campaignAcc30.emberExactUs!;

  const recDefs: RecDef[] = [
    {
      profileKey: "us",
      type: "cannibalization_conflict",
      searchTerm: "dragon rider fantasy",
      priority: 2,
      rationale:
        `Search term "dragon rider fantasy" is targeted in 2 campaigns ` +
        `(${campaignAmazonId.emberAutoUs}, ${campaignAmazonId.emberExactUs}), ` +
        `spending a combined $${(cannTotalMicros / 1e6).toFixed(2)} over the ` +
        `window. Overlapping campaigns bid against each other; consider ` +
        `consolidating the term into one campaign or separating intent ` +
        `(e.g. discovery vs exact). Human review required.`,
      confidence: 0.9,
      state: "pending",
      ruleVersion: "cannibalization_conflict@2",
      expiresAt: pendingExpiry,
      createdDaysAgo: 1,
      evidence: {
        searchTerm: "dragon rider fantasy",
        campaigns: [
          {
            campaignId: campaignPk.emberAutoUs,
            orders: cannAuto.orders,
            costMicros: micros(cannAuto.cost),
          },
          {
            campaignId: campaignPk.emberExactUs,
            orders: cannExact.orders,
            costMicros: micros(cannExact.cost),
          },
        ],
        excludedCampaigns: [],
        minCampaigns: 2,
        totalCostMicros: cannTotalMicros,
        window,
        ruleVersion: "cannibalization_conflict@2",
      },
    },
    {
      profileKey: "us",
      type: "high_ctr_poor_conversion",
      campaignKey: "quietAutoUs",
      priority: 2,
      rationale:
        `The ad gets clicked (CTR ${((conv.clicks / conv.impressions) * 100).toFixed(2)}% over ` +
        `${conv.impressions} impressions) but converts at only 0.00%, spending ` +
        `$${conv.cost.toFixed(2)} for 0 order(s). Shoppers interested enough ` +
        `to click do not buy: review the cover, price, subtitle, listing copy, ` +
        `and audience match. The Ads API cannot fix the KDP listing — no ` +
        `automatic change is proposed.`,
      confidence: 0.95,
      state: "pending",
      ruleVersion: "high_ctr_poor_conversion@1",
      expiresAt: pendingExpiry,
      createdDaysAgo: 1,
      evidence: {
        campaignId: campaignPk.quietAutoUs,
        targetId: null,
        impressions: conv.impressions,
        clicks: conv.clicks,
        orders: 0,
        costMicros: micros(conv.cost),
        ctr: conv.clicks / conv.impressions,
        cvr: 0,
        minCtr: 0.003,
        minImpressions: 1000,
        maxCvr: 0.01,
        window,
        ruleVersion: "high_ctr_poor_conversion@1",
      },
    },
    {
      profileKey: "us",
      type: "wasteful_search_term",
      campaignKey: "saltBroadUs",
      searchTerm: "free romance books",
      priority: 1,
      rationale:
        `Search term "free romance books" accumulated ${wasteful.clicks} clicks and ` +
        `$${wasteful.cost.toFixed(2)} in spend over the evidence window without ` +
        `a single order. Adding it as a negative exact stops this wasted spend.`,
      confidence: 0.92,
      state: "pending",
      ruleVersion: "wasteful_search_term@2",
      expiresAt: pendingExpiry,
      createdDaysAgo: 1,
      evidence: {
        searchTerm: "free romance books",
        campaignId: campaignPk.saltBroadUs,
        clicks: wasteful.clicks,
        orders: 0,
        costMicros: micros(wasteful.cost),
        minClicks: 20,
        goalMode: "balanced",
        window,
        ruleVersion: "wasteful_search_term@2",
      },
    },
    {
      profileKey: "us",
      type: "expensive_target",
      campaignKey: "saltBroadUs",
      targetKey: "saltBroadUs:romanceBestsellers",
      priority: 1,
      currentValue: "0.85",
      proposedValue: "0.7225",
      rationale:
        `Target romance bestsellers has ${expensive.orders} order(s) but is losing money: ` +
        `observed ACoS ${(expensive.cost / Math.max(expensive.sales, 0.0001)).toFixed(2)} ` +
        `vs target 0.40. Lower the bid from $0.85 to $0.72 (clamped to at most -15%).`,
      confidence: 0.88,
      state: "pending",
      ruleVersion: "expensive_target@2",
      expiresAt: pendingExpiry,
      createdDaysAgo: 1,
      evidence: {
        targetId: targetPk["saltBroadUs:romanceBestsellers"],
        campaignId: campaignPk.saltBroadUs,
        currentBidMicros: 850_000,
        clicks: expensive.clicks,
        orders: expensive.orders,
        units: expensive.units,
        royaltyCopies: Math.max(expensive.orders, expensive.units),
        costMicros: micros(expensive.cost),
        salesMicros: micros(expensive.sales),
        observedAcos: expensive.cost / Math.max(expensive.sales, 0.0001),
        targetAcos: 0.4,
        royaltyPerSaleMicros: 4_120_000,
        profitMicros:
          Math.max(expensive.orders, expensive.units) * 4_120_000 -
          micros(expensive.cost),
        minClicks: 30,
        minOrders: 2,
        acosMultiplier: 1.2,
        window,
        ruleVersion: "expensive_target@2",
      },
    },
    {
      profileKey: "us",
      type: "profitable_target",
      campaignKey: "emberExactUs",
      targetKey: "emberExactUs:dragonRiderBooks",
      priority: 3,
      currentValue: "0.52",
      proposedValue: "0.598",
      rationale:
        `Target dragon rider books is profitable: ${profitable.orders} orders, ` +
        `observed ACoS ${(profitable.cost / Math.max(profitable.sales, 0.0001)).toFixed(2)} ` +
        `well below target 0.35. Raise the bid from $0.52 to $0.60 (clamped to ` +
        `at most +15%, capped by the break-even CPC and max bid).`,
      confidence: 0.86,
      state: "pending",
      ruleVersion: "profitable_target@2",
      expiresAt: pendingExpiry,
      createdDaysAgo: 1,
      evidence: {
        targetId: targetPk["emberExactUs:dragonRiderBooks"],
        campaignId: campaignPk.emberExactUs,
        currentBidMicros: 520_000,
        clicks: profitable.clicks,
        orders: profitable.orders,
        units: profitable.units,
        royaltyCopies: Math.max(profitable.orders, profitable.units),
        costMicros: micros(profitable.cost),
        salesMicros: micros(profitable.sales),
        observedAcos: profitable.cost / Math.max(profitable.sales, 0.0001),
        targetAcos: 0.35,
        royaltyPerSaleMicros: 3_420_000,
        profitMicros:
          Math.max(profitable.orders, profitable.units) * 3_420_000 -
          micros(profitable.cost),
        minClicks: 30,
        minOrders: 3,
        acosMultiplier: 0.8,
        window,
        ruleVersion: "profitable_target@2",
      },
    },
    {
      profileKey: "us",
      type: "search_term_harvest",
      campaignKey: "emberAutoUs",
      searchTerm: "emberfall book",
      priority: 3,
      proposedValue: "0.55",
      rationale:
        `Shoppers searching "emberfall book" ordered ${harvest.orders} times via auto ` +
        `targeting. Adding it as an exact keyword in a controlled manual campaign ` +
        `gives direct bid control; the estimated break-even CPC is 0.55.`,
      confidence: 0.81,
      state: "pending",
      ruleVersion: "search_term_harvest@1",
      expiresAt: pendingExpiry,
      createdDaysAgo: 2,
      evidence: {
        searchTerm: "emberfall book",
        sourceCampaignId: campaignPk.emberAutoUs,
        sourceTargetingType: "auto",
        clicks: harvest.clicks,
        orders: harvest.orders,
        costMicros: micros(harvest.cost),
        salesMicros: micros(harvest.sales),
        minOrders: 2,
        proposedValue: "0.55",
        window,
        ruleVersion: "search_term_harvest@1",
      },
    },
    {
      profileKey: "us",
      type: "budget_constrained_winner",
      campaignKey: "emberExactUs",
      priority: 3,
      currentValue: "25",
      proposedValue: "28.75",
      rationale:
        `Campaign Emberfall — Exact — US is profitable and hit its $25.00 daily ` +
        `budget on 11 of the last 14 days. Raise the daily budget to $28.75 ` +
        `(+15%) to capture the demand it already converts.`,
      confidence: 0.78,
      state: "pending",
      ruleVersion: "budget_constrained_winner@2",
      expiresAt: pendingExpiry,
      createdDaysAgo: 2,
      evidence: {
        campaignId: campaignPk.emberExactUs,
        dailyBudgetMicros: 25_000_000,
        dailySpendMicros: micros(emberExactAcc.cost / 30),
        constrainedDays: 11,
        minUtilization: 0.9,
        minConstrainedDays: 7,
        increasePct: 15,
        orders: emberExactAcc.orders,
        units: emberExactAcc.units,
        royaltyCopies: Math.max(emberExactAcc.orders, emberExactAcc.units),
        costMicros: micros(emberExactAcc.cost),
        royaltyPerSaleMicros: 3_420_000,
        maxDailyBudgetMicros: 40_000_000,
        window,
        ruleVersion: "budget_constrained_winner@2",
      },
    },
    {
      profileKey: "de",
      type: "low_impressions",
      campaignKey: "emberExactDe",
      targetKey: "emberExactDe:drachenreiter",
      priority: 4,
      currentValue: "0.31",
      rationale:
        `Target drachenreiter roman is active but received only ${lowImp.impressions} ` +
        `impressions over the evidence window. Review the bid, match type, ` +
        `indexing, and targeting relevance. The bid is not raised automatically ` +
        `without evidence the traffic would be relevant.`,
      confidence: 0.72,
      state: "pending",
      ruleVersion: "low_impressions@1",
      expiresAt: pendingExpiry,
      createdDaysAgo: 2,
      evidence: {
        targetId: targetPk["emberExactDe:drachenreiter"],
        campaignId: campaignPk.emberExactDe,
        state: "enabled",
        currentBidMicros: 310_000,
        impressions: lowImp.impressions,
        maxImpressions: 500,
        window,
        ruleVersion: "low_impressions@1",
      },
    },
    {
      profileKey: "us",
      type: "wasteful_search_term",
      campaignKey: "quietAutoUs",
      searchTerm: "lighthouse gifts",
      priority: 1,
      rationale:
        `Search term "lighthouse gifts" accumulated 24 clicks and $10.56 in ` +
        `spend over the evidence window without a single order. Adding it as a ` +
        `negative exact stops this wasted spend.`,
      confidence: 0.85,
      state: "approved",
      ruleVersion: "wasteful_search_term@2",
      expiresAt: pendingExpiry,
      createdDaysAgo: 2,
      evidence: {
        searchTerm: "lighthouse gifts",
        campaignId: campaignPk.quietAutoUs,
        clicks: 24,
        orders: 0,
        costMicros: 10_560_000,
        minClicks: 20,
        goalMode: "profit",
        window,
        ruleVersion: "wasteful_search_term@2",
      },
    },
    {
      profileKey: "uk",
      type: "placement_opportunity",
      campaignKey: "emberAutoUk",
      priority: 3,
      currentValue: "0",
      proposedValue: "20",
      rationale:
        `Placement PLACEMENT_TOP in Emberfall — Auto — UK converts profitably ` +
        `(observed ACoS 0.24 vs target 0.35). Add a +20% top-of-search bid ` +
        `adjustment to win more of that placement.`,
      confidence: 0.8,
      state: "approved",
      ruleVersion: "placement_opportunity@2",
      expiresAt: pendingExpiry,
      createdDaysAgo: 3,
      evidence: {
        campaignId: campaignPk.emberAutoUk,
        placement: "PLACEMENT_TOP",
        currentModifierPct: 0,
        clicks: 340,
        orders: 51,
        units: 55,
        royaltyCopies: 55,
        costMicros: 98_600_000,
        salesMicros: 410_000_000,
        observedAcos: 0.24,
        targetAcos: 0.35,
        profitMicros: 51_000_000,
        minClicks: 30,
        minOrders: 3,
        acosMultiplier: 0.8,
        adjustPct: 20,
        window,
        ruleVersion: "placement_opportunity@2",
      },
    },
    {
      profileKey: "de",
      type: "expensive_target",
      campaignKey: "emberExactDe",
      targetKey: "emberExactDe:epischeFantasy",
      priority: 1,
      currentValue: "0.33",
      proposedValue: "0.28",
      rationale:
        `Target epische fantasy bücher has 4 order(s) but is losing money: ` +
        `observed ACoS 0.51 vs target 0.38. Lower the bid from €0.33 to €0.28 ` +
        `(clamped to at most -15%).`,
      confidence: 0.84,
      state: "expired",
      ruleVersion: "expensive_target@2",
      expiresAt: new Date(Date.now() - 3 * DAY_MS),
      createdDaysAgo: 12,
      evidence: {
        targetId: targetPk["emberExactDe:epischeFantasy"],
        campaignId: campaignPk.emberExactDe,
        currentBidMicros: 330_000,
        clicks: 96,
        orders: 4,
        units: 4,
        royaltyCopies: 4,
        costMicros: 29_700_000,
        salesMicros: 58_200_000,
        observedAcos: 0.51,
        targetAcos: 0.38,
        royaltyPerSaleMicros: 3_080_000,
        profitMicros: -17_380_000,
        minClicks: 30,
        minOrders: 2,
        acosMultiplier: 1.2,
        window: {
          start: isoDay(new Date(yesterday.getTime() - 41 * DAY_MS)),
          end: isoDay(new Date(yesterday.getTime() - 12 * DAY_MS)),
        },
        ruleVersion: "expensive_target@2",
      },
    },
    {
      profileKey: "us",
      type: "low_impressions",
      campaignKey: "nightjarExactUs",
      targetKey: "nightjarExactUs:nightjarBook",
      priority: 4,
      currentValue: "0.38",
      rationale:
        `Target nightjar book is active but received only 210 impressions over ` +
        `the evidence window. Review the bid, match type, indexing, and ` +
        `targeting relevance.`,
      confidence: 0.66,
      state: "expired",
      ruleVersion: "low_impressions@1",
      expiresAt: new Date(Date.now() - 10 * DAY_MS),
      createdDaysAgo: 20,
      evidence: {
        targetId: targetPk["nightjarExactUs:nightjarBook"],
        campaignId: campaignPk.nightjarExactUs,
        state: "enabled",
        currentBidMicros: 380_000,
        impressions: 210,
        maxImpressions: 500,
        window: {
          start: isoDay(new Date(yesterday.getTime() - 49 * DAY_MS)),
          end: isoDay(new Date(yesterday.getTime() - 20 * DAY_MS)),
        },
        ruleVersion: "low_impressions@1",
      },
    },
    {
      profileKey: "us",
      type: "profitable_target",
      campaignKey: "emberExactUs",
      targetKey: "emberExactUs:epicFantasyKindle",
      priority: 3,
      currentValue: "0.45",
      proposedValue: "0.52",
      rationale:
        `Target epic fantasy kindle is profitable: 19 orders, observed ACoS 0.21 ` +
        `well below target 0.35. Raise the bid from $0.45 to $0.52 (clamped to ` +
        `at most +15%, capped by the break-even CPC and max bid).`,
      confidence: 0.87,
      state: "applied",
      ruleVersion: "profitable_target@2",
      expiresAt: pendingExpiry,
      createdDaysAgo: 21,
      evidence: {
        targetId: targetPk["emberExactUs:epicFantasyKindle"],
        campaignId: campaignPk.emberExactUs,
        currentBidMicros: 450_000,
        clicks: 240,
        orders: 19,
        units: 21,
        royaltyCopies: 21,
        costMicros: 108_000_000,
        salesMicros: 512_000_000,
        observedAcos: 0.21,
        targetAcos: 0.35,
        royaltyPerSaleMicros: 3_420_000,
        profitMicros: 71_820_000,
        minClicks: 30,
        minOrders: 3,
        acosMultiplier: 0.8,
        window: {
          start: isoDay(new Date(yesterday.getTime() - 50 * DAY_MS)),
          end: isoDay(new Date(yesterday.getTime() - 21 * DAY_MS)),
        },
        ruleVersion: "profitable_target@2",
      },
    },
    {
      profileKey: "us",
      type: "wasteful_search_term",
      campaignKey: "emberAutoUs",
      searchTerm: "vampire romance",
      priority: 1,
      rationale:
        `Search term "vampire romance" accumulated 31 clicks and $11.16 in ` +
        `spend over the evidence window without a single order. Adding it as a ` +
        `negative exact stops this wasted spend.`,
      confidence: 0.93,
      state: "applied",
      ruleVersion: "wasteful_search_term@2",
      expiresAt: pendingExpiry,
      createdDaysAgo: 14,
      evidence: {
        searchTerm: "vampire romance",
        campaignId: campaignPk.emberAutoUs,
        clicks: 31,
        orders: 0,
        costMicros: 11_160_000,
        minClicks: 20,
        goalMode: "profit",
        window: {
          start: isoDay(new Date(yesterday.getTime() - 43 * DAY_MS)),
          end: isoDay(new Date(yesterday.getTime() - 14 * DAY_MS)),
        },
        ruleVersion: "wasteful_search_term@2",
      },
    },
  ];

  const recPk: Record<number, string> = {};
  for (const [i, r] of recDefs.entries()) {
    const createdAt = new Date(Date.now() - r.createdDaysAgo * DAY_MS);
    const recId = await insertReturningId("recommendations", {
      profile_id: profilePk[r.profileKey],
      type: r.type,
      campaign_id: r.campaignKey ? campaignPk[r.campaignKey] : null,
      ad_group_id: r.campaignKey ? adGroupPk[r.campaignKey] : null,
      target_id: r.targetKey ? targetPk[r.targetKey] : null,
      search_term: r.searchTerm ?? null,
      priority: r.priority,
      evidence_window_start:
        (r.evidence as { window?: { start: string } }).window?.start ??
        windowStart,
      evidence_window_end:
        (r.evidence as { window?: { end: string } }).window?.end ?? windowEnd,
      current_value: r.currentValue ?? null,
      proposed_value: r.proposedValue ?? null,
      rationale: r.rationale,
      confidence: r.confidence,
      state: r.state,
      rule_version: r.ruleVersion,
      data_freshness_at: freshness.toISOString(),
      expires_at: r.expiresAt.toISOString(),
      created_at: createdAt.toISOString(),
    });
    recPk[i] = recId;
    await pool.query(
      `insert into recommendation_evidence (recommendation_id, inputs)
       values ($1, $2::jsonb)`,
      [recId, JSON.stringify(r.evidence)],
    );
  }
  // recPk indexes into recDefs:
  const REC = {
    cannibalization: recPk[0]!,
    conversion: recPk[1]!,
    wastefulPending: recPk[2]!,
    expensivePending: recPk[3]!,
    profitablePending: recPk[4]!,
    harvest: recPk[5]!,
    budget: recPk[6]!,
    lowImpDe: recPk[7]!,
    wastefulApproved: recPk[8]!,
    placementApproved: recPk[9]!,
    expensiveExpired: recPk[10]!,
    lowImpExpired: recPk[11]!,
    profitableApplied: recPk[12]!,
    wastefulApplied: recPk[13]!,
  };

  // --- Change sets + actions -------------------------------------------------
  const guardOk = JSON.stringify({ allowed: true, violations: [] });
  const guardKillSwitch = JSON.stringify({
    allowed: false,
    violations: [
      {
        code: "KILL_SWITCH_ENABLED",
        message: "The global kill switch is enabled; all writes are disabled.",
      },
    ],
  });

  async function insertChangeSet(
    set: {
      profileKey: string;
      status: string;
      kind: string;
      fingerprint: string;
      createdDaysAgo: number;
      appliedDaysAgo?: number;
      guardrailResult?: string;
    },
    actions: Record<string, unknown>[],
  ): Promise<string> {
    const createdAt = new Date(Date.now() - set.createdDaysAgo * DAY_MS);
    const setId = await insertReturningId("change_sets", {
      profile_id: profilePk[set.profileKey],
      creator_user_id: userId,
      status: set.status,
      kind: set.kind,
      fingerprint: set.fingerprint,
      guardrail_result: set.guardrailResult ?? null,
      created_at: createdAt.toISOString(),
      applied_at:
        set.appliedDaysAgo === undefined
          ? null
          : new Date(Date.now() - set.appliedDaysAgo * DAY_MS).toISOString(),
    });
    for (const [i, action] of actions.entries()) {
      await insertReturningId("change_actions", {
        change_set_id: setId,
        fingerprint: `${set.fingerprint}:action:${i}`,
        status: "pending",
        ...action,
      });
    }
    return setId;
  }

  // Draft recommendation set: bid changes + a negative exact (pending approval).
  await insertChangeSet(
    {
      profileKey: "us",
      status: "draft",
      kind: "recommendation",
      fingerprint: "demo-cs-draft-bids",
      createdDaysAgo: 1,
    },
    [
      {
        recommendation_id: REC.expensivePending,
        action_type: "update_bid",
        campaign_id: campaignPk.saltBroadUs,
        ad_group_id: adGroupPk.saltBroadUs,
        target_id: targetPk["saltBroadUs:romanceBestsellers"],
        before_value: 0.85,
        after_value: 0.7225,
        amazon_entity_id: targetAmazonId["saltBroadUs:romanceBestsellers"],
        entity_name: "romance bestsellers",
      },
      {
        recommendation_id: REC.profitablePending,
        action_type: "update_bid",
        campaign_id: campaignPk.emberExactUs,
        ad_group_id: adGroupPk.emberExactUs,
        target_id: targetPk["emberExactUs:dragonRiderBooks"],
        before_value: 0.52,
        after_value: 0.598,
        amazon_entity_id: targetAmazonId["emberExactUs:dragonRiderBooks"],
        entity_name: "dragon rider books",
      },
      {
        recommendation_id: REC.wastefulPending,
        action_type: "add_negative_exact",
        campaign_id: campaignPk.saltBroadUs,
        search_term: "free romance books",
        entity_name: "The Salt Road — Broad — US",
        before_state: JSON.stringify({
          scope: "campaign",
          matchType: "NEGATIVE_EXACT",
          present: false,
        }),
        after_state: JSON.stringify({
          scope: "campaign",
          matchType: "NEGATIVE_EXACT",
          present: true,
        }),
      },
    ],
  );

  // Previewed set: one bid raise, guardrails evaluated (kill switch on).
  await insertChangeSet(
    {
      profileKey: "us",
      status: "previewed",
      kind: "recommendation",
      fingerprint: "demo-cs-previewed-bid",
      createdDaysAgo: 3,
      guardrailResult: guardKillSwitch,
    },
    [
      {
        recommendation_id: REC.profitablePending,
        action_type: "update_bid",
        campaign_id: campaignPk.emberExactUs,
        ad_group_id: adGroupPk.emberExactUs,
        target_id: targetPk["emberExactUs:dragonRiderBooks"],
        before_value: 0.52,
        after_value: 0.598,
        amazon_entity_id: targetAmazonId["emberExactUs:dragonRiderBooks"],
        entity_name: "dragon rider books",
      },
    ],
  );

  // Applied (3 weeks ago): profitable bid raise, verified.
  await insertChangeSet(
    {
      profileKey: "us",
      status: "applied",
      kind: "recommendation",
      fingerprint: "demo-cs-applied-bid",
      createdDaysAgo: 21,
      appliedDaysAgo: 21,
      guardrailResult: guardOk,
    },
    [
      {
        recommendation_id: REC.profitableApplied,
        action_type: "update_bid",
        campaign_id: campaignPk.emberExactUs,
        ad_group_id: adGroupPk.emberExactUs,
        target_id: targetPk["emberExactUs:epicFantasyKindle"],
        before_value: 0.45,
        after_value: 0.52,
        amazon_entity_id: targetAmazonId["emberExactUs:epicFantasyKindle"],
        entity_name: "epic fantasy kindle",
        status: "applied",
        amazon_request: JSON.stringify({
          operation: "updateKeyword",
          keywordId: targetAmazonId["emberExactUs:epicFantasyKindle"],
          bid: 0.52,
          state: "enabled",
        }),
        amazon_response: JSON.stringify({
          code: "SUCCESS",
          keywordId: targetAmazonId["emberExactUs:epicFantasyKindle"],
        }),
        amazon_request_id: "amzn-req-9f2c1d-demo",
        verified_at: new Date(Date.now() - 21 * DAY_MS + 900_000).toISOString(),
      },
    ],
  );

  // Applied (2 weeks ago): negative exact with rollback metadata (amazon_entity_id).
  await insertChangeSet(
    {
      profileKey: "us",
      status: "applied",
      kind: "recommendation",
      fingerprint: "demo-cs-applied-negative",
      createdDaysAgo: 14,
      appliedDaysAgo: 14,
      guardrailResult: guardOk,
    },
    [
      {
        recommendation_id: REC.wastefulApplied,
        action_type: "add_negative_exact",
        campaign_id: campaignPk.emberAutoUs,
        search_term: "vampire romance",
        entity_name: "Emberfall — Auto — US",
        before_state: JSON.stringify({
          scope: "campaign",
          matchType: "NEGATIVE_EXACT",
          present: false,
        }),
        after_state: JSON.stringify({
          scope: "campaign",
          matchType: "NEGATIVE_EXACT",
          present: true,
        }),
        status: "applied",
        amazon_entity_id: negativeVampireRomanceId,
        amazon_request: JSON.stringify({
          operation: "createCampaignNegativeKeyword",
          campaignId: campaignAmazonId.emberAutoUs,
          keywordText: "vampire romance",
          matchType: "NEGATIVE_EXACT",
          state: "enabled",
        }),
        amazon_response: JSON.stringify({
          code: "SUCCESS",
          keywordId: negativeVampireRomanceId,
        }),
        amazon_request_id: "amzn-req-51ab7e-demo",
        verified_at: new Date(Date.now() - 14 * DAY_MS + 900_000).toISOString(),
      },
    ],
  );

  // Applied (12 days ago): campaign pause (campaign_update one-click action).
  await insertChangeSet(
    {
      profileKey: "us",
      status: "applied",
      kind: "campaign_update",
      fingerprint: "demo-cs-applied-pause",
      createdDaysAgo: 12,
      appliedDaysAgo: 12,
      guardrailResult: guardOk,
    },
    [
      {
        action_type: "update_campaign_state",
        campaign_id: campaignPk.nightjarExactUs,
        entity_name: "Nightjar — Exact — US",
        amazon_entity_id: campaignAmazonId.nightjarExactUs,
        before_state: JSON.stringify({ state: "enabled" }),
        after_state: JSON.stringify({ state: "paused" }),
        status: "applied",
        amazon_request: JSON.stringify({
          operation: "updateCampaign",
          campaignId: campaignAmazonId.nightjarExactUs,
          state: "paused",
        }),
        amazon_response: JSON.stringify({
          code: "SUCCESS",
          campaignId: campaignAmazonId.nightjarExactUs,
        }),
        amazon_request_id: "amzn-req-77dd02-demo",
        verified_at: new Date(Date.now() - 12 * DAY_MS + 600_000).toISOString(),
      },
    ],
  );

  // Applied (5 weeks ago): campaign rename.
  await insertChangeSet(
    {
      profileKey: "us",
      status: "applied",
      kind: "campaign_update",
      fingerprint: "demo-cs-applied-rename",
      createdDaysAgo: 35,
      appliedDaysAgo: 35,
      guardrailResult: guardOk,
    },
    [
      {
        action_type: "update_campaign_name",
        campaign_id: campaignPk.saltBroadUs,
        entity_name: "The Salt Road — Broad — US",
        amazon_entity_id: campaignAmazonId.saltBroadUs,
        before_state: JSON.stringify({ name: "Salt Road Broad US" }),
        after_state: JSON.stringify({ name: "The Salt Road — Broad — US" }),
        status: "applied",
        amazon_request: JSON.stringify({
          operation: "updateCampaign",
          campaignId: campaignAmazonId.saltBroadUs,
          name: "The Salt Road — Broad — US",
        }),
        amazon_response: JSON.stringify({
          code: "SUCCESS",
          campaignId: campaignAmazonId.saltBroadUs,
        }),
        amazon_request_id: "amzn-req-03cc91-demo",
        verified_at: new Date(Date.now() - 35 * DAY_MS + 600_000).toISOString(),
      },
    ],
  );

  // Failed (5 days ago): Amazon rejected the bid update.
  await insertChangeSet(
    {
      profileKey: "us",
      status: "failed",
      kind: "recommendation",
      fingerprint: "demo-cs-failed-bid",
      createdDaysAgo: 5,
      guardrailResult: guardOk,
    },
    [
      {
        recommendation_id: REC.expensivePending,
        action_type: "update_bid",
        campaign_id: campaignPk.saltBroadUs,
        ad_group_id: adGroupPk.saltBroadUs,
        target_id: targetPk["saltBroadUs:romanceBestsellers"],
        before_value: 0.85,
        after_value: 0.7225,
        amazon_entity_id: targetAmazonId["saltBroadUs:romanceBestsellers"],
        entity_name: "romance bestsellers",
        status: "failed",
        amazon_request: JSON.stringify({
          operation: "updateKeyword",
          keywordId: targetAmazonId["saltBroadUs:romanceBestsellers"],
          bid: 0.7225,
          state: "enabled",
        }),
        amazon_response: JSON.stringify({
          code: "RESOURCE_NOT_FOUND",
          message: "Amazon rejected the bid update",
          details: {
            Message: `keywordId ${targetAmazonId["saltBroadUs:romanceBestsellers"]} was not found in this profile`,
          },
        }),
        amazon_request_id: "amzn-req-b84f10-demo",
      },
    ],
  );

  // --- Audit events --------------------------------------------------------------
  const auditRows: [string, string, string | null, string, unknown][] = [
    [
      "integrations.amazon.connect",
      "amazon_connection",
      connectionId,
      new Date(Date.now() - 45 * DAY_MS).toISOString(),
      { profileCount: 4 },
    ],
    [
      "change_set.apply",
      "change_set",
      null,
      new Date(Date.now() - 21 * DAY_MS).toISOString(),
      { kind: "recommendation", actionCount: 1 },
    ],
    [
      "change_set.apply",
      "change_set",
      null,
      new Date(Date.now() - 14 * DAY_MS).toISOString(),
      { kind: "recommendation", actionCount: 1 },
    ],
    [
      "change_set.apply",
      "change_set",
      null,
      new Date(Date.now() - 12 * DAY_MS).toISOString(),
      { kind: "campaign_update", actionCount: 1 },
    ],
    [
      "sync.request",
      "sync_run",
      null,
      new Date(Date.now() - 3 * 3_600_000).toISOString(),
      { profileId: profileDefs[0].profileId },
    ],
    [
      "auth.sign_in",
      "session",
      null,
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
      { email: EMAIL },
    ],
  ];
  for (const [event, entityType, entityId, createdAt, details] of auditRows) {
    await pool.query(
      `insert into audit_events
         (workspace_id, actor_user_id, event, entity_type, entity_id, details, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        workspaceId,
        userId,
        event,
        entityType,
        entityId,
        JSON.stringify(details),
        createdAt,
      ],
    );
  }

  console.log("");
  console.log("Demo seed complete.");
  console.log(`  Sign-in email:        ${EMAIL}`);
  console.log(`  Workspace:            ${PEN_NAME} — KDP (id ${workspaceId})`);
  console.log(
    `  Profiles:             ${profileDefs.map((p) => p.countryCode).join(", ")}`,
  );
  console.log(
    `  Cannibalization rec:  id ${REC.cannibalization} ("dragon rider fantasy", US)`,
  );
  console.log(
    `  Conversion rec:       id ${REC.conversion} (Quiet Harbor — Auto — US)`,
  );
  console.log(
    `  Campaigns:            ${campaignDefs.length} across US/GB/DE/CA`,
  );
} finally {
  await pool.end();
}
