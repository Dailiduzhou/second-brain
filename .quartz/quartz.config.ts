import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"

/**
 * Quartz 4 configuration for this vault.
 *
 * This file is copied to the root of the pinned Quartz checkout by
 * `scripts/quartz.sh` (local) and by the deploy workflow (CI), because Quartz
 * only reads `quartz.config.ts` from its own working directory.
 *
 * See https://quartz.jzhao.xyz/configuration for the full option reference.
 */
const config: QuartzConfig = {
  configuration: {
    pageTitle: "second-brain",
    pageTitleSuffix: "",
    enableSPA: true,
    enablePopovers: true,
    analytics: null,
    locale: "zh-CN",
    baseUrl: "dailiduzhou.github.io/second-brain",
    // The site root is served by a redirect generated from the alias declared
    // in `Index Page.md`; Quartz still warns that `index.md` is missing, which
    // is expected because the vault keeps its hub page at that name.
    //
    // Paths here are relative to the vault root (the Quartz content directory).
    // Dot directories (.obsidian, .github, .quartz, .quartz-framework) are not
    // globbed by Quartz at all; these patterns cover non-public files.
    ignorePatterns: [
      "AGENTS.md",
      "README.md",
      "private",
      "private/**",
      "source",
      "source/**",
      "templates",
      "templates/**",
      "**/.trash/**",
      "**/node_modules/**",
    ],
    defaultDateType: "modified",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        header: "Schibsted Grotesk",
        body: "Source Sans Pro",
        code: "IBM Plex Mono",
      },
      colors: {
        lightMode: {
          light: "#faf8f8",
          lightgray: "#e5e5e5",
          gray: "#b8b8b8",
          darkgray: "#4e4e4e",
          dark: "#2b2b2b",
          secondary: "#284b63",
          tertiary: "#84a59d",
          highlight: "rgba(143, 159, 169, 0.15)",
          textHighlight: "#fff23688",
        },
        darkMode: {
          light: "#161618",
          lightgray: "#393639",
          gray: "#646464",
          darkgray: "#d4d4d4",
          dark: "#ebebec",
          secondary: "#7b97aa",
          tertiary: "#84a59d",
          highlight: "rgba(143, 159, 169, 0.15)",
          textHighlight: "#b3aa0288",
        },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        // The content directory is the vault repo itself, so git history gives
        // real created/modified dates instead of checkout timestamps.
        priority: ["frontmatter", "git", "filesystem"],
      }),
      Plugin.SyntaxHighlighting({
        theme: {
          light: "github-light",
          dark: "github-dark",
        },
        keepBackground: false,
      }),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: "katex" }),
    ],
    // `RemoveDrafts` drops every note whose frontmatter has `draft: true`, which
    // is how sensitive notes are kept out of the published site.
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({
        enableSiteMap: true,
        enableRSS: true,
      }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.Favicon(),
      Plugin.NotFoundPage(),
      // CustomOgImages renders one image per note; it roughly triples build time.
      Plugin.CustomOgImages(),
    ],
  },
}

export default config
