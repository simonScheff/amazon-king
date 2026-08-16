import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const hostname = "https://simonscheff.github.io/amazon-king/";

export default withMermaid(
  defineConfig({
    title: "Amazon King",
    titleTemplate: ":title · Amazon King Docs",
    description:
      "Self-hosted Amazon Ads optimizer for KDP authors. Deterministic recommendations with evidence, human approval on every write.",
    base: "/amazon-king/",
    cleanUrls: true,
    lastUpdated: true,
    ignoreDeadLinks: false,

    sitemap: {
      hostname,
    },

    head: [
      ["link", { rel: "icon", type: "image/svg+xml", href: "/amazon-king/logo.svg" }],
      ["meta", { name: "theme-color", content: "#7c3aed" }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:site_name", content: "Amazon King Docs" }],
      ["meta", { property: "og:image", content: `${hostname}og-image.png` }],
      [
        "meta",
        {
          property: "og:description",
          content:
            "Self-hosted Amazon Ads optimizer for KDP authors — deterministic recommendations, human-approved writes, your own infrastructure.",
        },
      ],
      ["meta", { name: "twitter:card", content: "summary" }],
    ],

    markdown: {
      theme: { light: "github-light", dark: "github-dark" },
      lineNumbers: false,
    },

    mermaid: {
      theme: "default",
    },

    themeConfig: {
      logo: { src: "/logo.svg", alt: "Amazon King" },
      siteTitle: "Amazon King",

      nav: [
        { text: "Guide", link: "/guide/what-is-amazon-king", activeMatch: "/guide/" },
        { text: "Architecture", link: "/architecture/overview", activeMatch: "/architecture/" },
        { text: "Reference", link: "/reference/api", activeMatch: "/reference/" },
        { text: "Examples", link: "/examples/api-workflows", activeMatch: "/examples/" },
        {
          text: "GitHub",
          link: "https://github.com/simonScheff/amazon-king",
        },
      ],

      sidebar: [
        {
          text: "Introduction",
          items: [
            { text: "What is Amazon King?", link: "/guide/what-is-amazon-king" },
            { text: "Key concepts", link: "/guide/key-concepts" },
          ],
        },
        {
          text: "Getting started",
          items: [
            { text: "Installation", link: "/guide/installation" },
            { text: "Quickstart: first sync", link: "/guide/quickstart" },
          ],
        },
        {
          text: "Guides",
          items: [
            { text: "Connecting Amazon Ads", link: "/guide/connecting-amazon" },
            { text: "Configuration", link: "/guide/configuration" },
            { text: "Book economics", link: "/guide/book-economics" },
            { text: "Reviewing recommendations", link: "/guide/recommendations" },
            { text: "Applying & rolling back changes", link: "/guide/applying-changes" },
            { text: "Campaign tools", link: "/guide/campaign-tools" },
            { text: "Self-hosting in production", link: "/guide/self-hosting" },
            { text: "Operations runbook", link: "/guide/operations" },
          ],
        },
        {
          text: "Architecture",
          items: [
            { text: "System overview", link: "/architecture/overview" },
            { text: "Data pipeline", link: "/architecture/data-pipeline" },
            { text: "Security model", link: "/architecture/security" },
            { text: "Data model", link: "/architecture/data-model" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "HTTP API", link: "/reference/api" },
            { text: "Environment variables", link: "/reference/environment-variables" },
            { text: "Optimization rules", link: "/reference/optimization-rules" },
            { text: "Error codes", link: "/reference/errors" },
            { text: "Commands", link: "/reference/commands" },
          ],
        },
        {
          text: "Examples",
          items: [{ text: "API workflows", link: "/examples/api-workflows" }],
        },
        {
          text: "Help",
          items: [
            { text: "Troubleshooting", link: "/troubleshooting" },
            { text: "FAQ", link: "/faq" },
            { text: "Contributing", link: "/contributing" },
          ],
        },
      ],

      search: {
        provider: "local",
      },

      editLink: {
        pattern: "https://github.com/simonScheff/amazon-king/edit/main/website/:path",
        text: "Edit this page on GitHub",
      },

      socialLinks: [{ icon: "github", link: "https://github.com/simonScheff/amazon-king" }],

      footer: {
        message:
          "Independent open-source project — not affiliated with or endorsed by Amazon. Released under the Apache License 2.0.",
        copyright: "Copyright © Amazon King contributors",
      },

      outline: {
        level: [2, 3],
        label: "On this page",
      },

      docFooter: {
        prev: "Previous",
        next: "Next",
      },
    },
  }),
);
