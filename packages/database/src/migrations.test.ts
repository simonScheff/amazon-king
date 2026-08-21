import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadMigrations, MIGRATIONS_DIR } from "./migrate.js";

// Pure sanity checks on the SQL migration files — no database required.

describe("migration files", () => {
  it("loads the real migrations directory in order", async () => {
    const files = await loadMigrations();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]!.version).toBe("0001");
    for (const [index, file] of files.entries()) {
      expect(file.version).toBe(String(index + 1).padStart(4, "0"));
      expect(file.filename).toMatch(/^\d{4}_.+\.sql$/);
      expect(file.sql.trim().length).toBeGreaterThan(0);
      expect(file.sql.trimEnd().endsWith(";")).toBe(true);
    }
  });

  it("initial migration creates schema tables mentioned in plan §7", async () => {
    const [first] = await loadMigrations();
    for (const table of [
      "users",
      "workspaces",
      "workspace_members",
      "amazon_connections",
      "amazon_profiles",
      "sessions",
      "login_tokens",
      "oauth_states",
      "books",
      "book_profile_links",
      "book_economics",
      "campaigns",
      "ad_groups",
      "ads",
      "targets",
      "entity_change_history",
      "campaign_metrics_daily",
      "target_metrics_daily",
      "search_term_metrics_daily",
      "advertised_product_metrics_daily",
      "placement_metrics_daily",
      "sync_runs",
      "report_jobs",
      "job_queue",
      "recommendations",
      "recommendation_evidence",
      "change_sets",
      "change_actions",
      "audit_events",
    ]) {
      expect(first!.sql).toContain(`create table ${table}`);
    }
  });

  it("adds storage for synced negative keywords", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find(
      (file) => file.filename === "0004_negative_keywords.sql",
    );
    expect(migration?.sql).toContain("create table negative_keywords");
  });

  it("adds storage for synced negative ASIN targets", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find(
      (file) => file.filename === "0012_negative_targets.sql",
    );
    expect(migration?.sql).toContain("create table negative_targets");
    expect(migration?.sql).toContain("expression_asin");
  });

  it("uniques a marketplace ASIN to one book per profile", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find(
      (file) => file.filename === "0013_book_profile_link_asin_unique.sql",
    );
    expect(migration?.sql).toContain("idx_book_profile_links_profile_asin");
    expect(migration?.sql).toContain("(profile_id, marketplace_asin)");
  });

  it("adds the fx_rates table and the workspace display currency", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find(
      (file) => file.filename === "0014_fx_rates.sql",
    );
    expect(migration?.sql).toContain("create table fx_rates");
    expect(migration?.sql).toContain(
      "primary key (rate_date, base_currency, quote_currency)",
    );
    expect(migration?.sql).toContain("check (rate > 0)");
    expect(migration?.sql).toContain("alter table workspaces");
    expect(migration?.sql).toContain(
      "display_currency char(3) not null default 'USD'",
    );
  });

  it("allows campaign-creation change sets and create actions", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find(
      (file) => file.filename === "0005_campaign_creation.sql",
    );
    expect(migration?.sql).toContain("'campaign_creation'");
    for (const actionType of [
      "create_campaign",
      "create_ad_group",
      "create_product_ad",
      "create_keyword",
    ]) {
      expect(migration?.sql).toContain(`'${actionType}'`);
    }
  });

  const tempDirs: string[] = [];
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeDir(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "migrations-"));
    tempDirs.push(dir);
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(join(dir, name), sql);
    }
    return dir;
  }

  it("rejects a numbering gap", async () => {
    const dir = await makeDir({
      "0001_a.sql": "select 1;",
      "0003_b.sql": "select 1;",
    });
    await expect(loadMigrations(dir)).rejects.toThrow(/numbering gap/);
  });

  it("rejects an invalid filename", async () => {
    const dir = await makeDir({ "initial.sql": "select 1;" });
    await expect(loadMigrations(dir)).rejects.toThrow(
      /Invalid migration filename/,
    );
  });

  it("rejects an empty migration file", async () => {
    const dir = await makeDir({ "0001_a.sql": "  \n" });
    await expect(loadMigrations(dir)).rejects.toThrow(/empty/);
  });

  it("ignores non-sql files", async () => {
    const dir = await makeDir({
      "0001_a.sql": "select 1;",
      "notes.txt": "hello",
    });
    const files = await loadMigrations(dir);
    expect(files.map((f) => f.filename)).toEqual(["0001_a.sql"]);
  });

  it("MIGRATIONS_DIR points at the package migrations directory", async () => {
    expect(MIGRATIONS_DIR).toMatch(/packages\/database\/migrations\/?$/);
  });
});
