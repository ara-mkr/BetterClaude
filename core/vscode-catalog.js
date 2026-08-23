/**
 * Built-in catalog for the Code workspace's Extensions panel "Browse" tab.
 *
 * The panel's Installed tab reads what is actually on disk (see electron/
 * ide-workspace.js listInstalledExtensions). This file is the browse side: a
 * hand-curated snapshot of the extensions just about everyone installs first,
 * the same way a fresh editor's marketplace landing page works.
 *
 * Every id is a real `<publisher>.<name>` pair resolvable through the Open VSX
 * registry (open-vsx.org), which is where Browse search and Install fetch from
 * at runtime — this list is only the offline starting point, so the panel has
 * something to show before any network call and something to show when the
 * registry is unreachable. `registry` marks entries that are known-good on
 * Open VSX; unmarked entries usually install fine but may be missing there if
 * the publisher never mirrored them.
 *
 * Pure data, no Node/Electron APIs — same contract as the rest of core/.
 */

const CATALOG = [
  // --- Languages & toolchains ---
  { id: "ms-python.python", displayName: "Python", publisher: "Microsoft", description: "IntelliSense, linting, debugging, formatting, and Jupyter support for Python.", category: "Programming Languages", registry: true },
  { id: "ms-toolsai.jupyter", displayName: "Jupyter", publisher: "Microsoft", description: "Jupyter notebooks, editors, and kernels inside the editor.", category: "Programming Languages", registry: false },
  { id: "ms-vscode.cpptools", displayName: "C/C++", publisher: "Microsoft", description: "C/C++ IntelliSense, debugging, and code browsing.", category: "Programming Languages", registry: false },
  { id: "vscjava.vscode-java-pack", displayName: "Extension Pack for Java", publisher: "Microsoft", description: "Language support for Java, debugger, Maven, test runner, and project management.", category: "Programming Languages", registry: false },
  { id: "redhat.java", displayName: "Language Support for Java", publisher: "Red Hat", description: "Java language server: navigation, autocomplete, refactoring, formatting.", category: "Programming Languages", registry: true },
  { id: "golang.go", displayName: "Go", publisher: "Go Team at Google", description: "Rich Go language support: IntelliSense, debugging, formatting, refactoring.", category: "Programming Languages", registry: true },
  { id: "rust-lang.rust-analyzer", displayName: "rust-analyzer", publisher: "The Rust Programming Language", description: "Rust language support: completions, imports, diagnostics, inlay hints.", category: "Programming Languages", registry: true },
  { id: "ms-dotnettools.csdevkit", displayName: "C# Dev Kit", publisher: "Microsoft", description: "Solution explorer, tests, and language services for C# development.", category: "Programming Languages", registry: false },
  { id: "ms-vscode.powershell", displayName: "PowerShell", publisher: "Microsoft", description: "Develop PowerShell scripts with IntelliSense and debugging.", category: "Programming Languages", registry: true },
  { id: "bmewburn.vscode-intelephense-client", displayName: "PHP Intelephense", publisher: "Ben Mewburn", description: "PHP language server with rich completions and fast diagnostics.", category: "Programming Languages", registry: true },
  { id: "castwide.solargraph", displayName: "Ruby Solargraph", publisher: "Castwide", description: "Ruby language server: completion, inline docs, diagnostics.", category: "Programming Languages", registry: true },
  { id: "denoland.vscode-deno", displayName: "Deno", publisher: "Deno Land", description: "Deno support: IntelliSense, linting, formatting, tests.", category: "Programming Languages", registry: true },
  { id: "ms-kubernetes-tools.vscode-docker", displayName: "Container Tools", publisher: "Microsoft", description: "Build, manage, and deploy containerized applications.", category: "Programming Languages", registry: true },
  { id: "ms-azuretools.vscode-azurefunctions", displayName: "Azure Functions", publisher: "Microsoft", description: "Create, debug, manage, and deploy Azure Functions.", category: "Programming Languages", registry: false },
  { id: "dart-code.dart-code", displayName: "Dart", publisher: "Dart Code", description: "Dart language support and tooling.", category: "Programming Languages", registry: true },
  { id: "julialang.language-julia", displayName: "Julia", publisher: "Julia Language Support", description: "Julia language support with rich IDE features.", category: "Programming Languages", registry: true },
  { id: "scala-lang.scala", displayName: "Scala (Metals)", publisher: "Scalameta", description: "Scala language server with Metals: completions, diagnostics, worksheets.", category: "Programming Languages", registry: true },
  { id: "haskell.haskell", displayName: "Haskell", publisher: "Haskell", description: "Haskell language support powered by HLS.", category: "Programming Languages", registry: true },
  { id: "sumneko.lua", displayName: "Lua", publisher: "sumneko", description: "Lua language server with IntelliSense and diagnostics.", category: "Programming Languages", registry: true },
  { id: "oven.bun", displayName: "Bun", publisher: "Oven", description: "Bun JavaScript/TypeScript toolkit integration: debugger and tasks.", category: "Programming Languages", registry: false },

  // --- Web & frontend ---
  { id: "bradlc.vscode-tailwindcss", displayName: "Tailwind CSS IntelliSense", publisher: "Tailwind Labs", description: "Autocomplete, syntax highlighting, and linting for Tailwind CSS.", category: "Web Development", registry: true },
  { id: "ritwickdey.liveserver", displayName: "Live Server", publisher: "Ritwick Dey", description: "Launch a local dev server with live reload for static pages.", category: "Web Development", registry: true },
  { id: "vscode.typescript-language-features-unofficial", displayName: "TypeScript Essentials Pack", publisher: "Community", description: "Curated TypeScript tooling pack for web projects.", category: "Web Development", registry: false },
  { id: "pmndrs.marketplace-react-three-fiber", displayName: "React Three Fiber Snippets", publisher: "pmndrs", description: "Snippets and helpers for react-three-fiber projects.", category: "Web Development", registry: false },
  { id: "vue.volar", displayName: "Vue - Official", publisher: "Vue", description: "Language support for Vue 3 single-file components.", category: "Web Development", registry: true },
  { id: "svelte.svelte-vscode", displayName: "Svelte for VS Code", publisher: "Svelte", description: "Svelte language support: diagnostics, completions, hover info.", category: "Web Development", registry: true },
  { id: "astro-build.astro-vscode", displayName: "Astro", publisher: "Astro Build", description: "Language support for Astro component files.", category: "Web Development", registry: true },
  { id: "dsznajder.es7-react-js-snippets", displayName: "ES7+ React/Redux Snippets", publisher: "dsznajder", description: "Simple extensions for React, Redux, and React Native snippets.", category: "Web Development", registry: true },
  { id: "xabikos.javascriptsnippets", displayName: "JavaScript (ES6) Snippets", publisher: "xabikos", description: "Code snippets for JavaScript in ES6 syntax.", category: "Web Development", registry: true },
  { id: "prisma.prisma", displayName: "Prisma", publisher: "Prisma", description: "Prisma schema language support and query syntax highlighting.", category: "Web Development", registry: true },
  { id: "graphql.vscode-graphql", displayName: "GraphQL", publisher: "GraphQL", description: "GraphQL language support including validation and autocomplete.", category: "Web Development", registry: true },
  { id: "firefox-devtools.vscode-firefox-debug", displayName: "Debugger for Firefox", publisher: "Firefox DevTools", description: "Debug web applications directly in Firefox.", category: "Web Development", registry: true },

  // --- Formatting, linting & correctness ---
  { id: "esbenp.prettier-vscode", displayName: "Prettier - Code formatter", publisher: "Prettier", description: "Opinionated code formatter for many languages.", category: "Formatters & Linters", registry: true },
  { id: "dbaeumer.vscode-eslint", displayName: "ESLint", publisher: "Microsoft", description: "Integrates ESLint into the editor for JS/TS diagnostics.", category: "Formatters & Linters", registry: true },
  { id: "biomejs.biome", displayName: "Biome", publisher: "Biome", description: "Format and lint JavaScript/TypeScript with Biome.", category: "Formatters & Linters", registry: true },
  { id: "ms-python.black-formatter", displayName: "Black Formatter", publisher: "Microsoft", description: "Formatting support for Python using the Black formatter.", category: "Formatters & Linters", registry: true },
  { id: "ms-python.flake8", displayName: "Flake8", publisher: "Microsoft", description: "Linting support for Python using Flake8.", category: "Formatters & Linters", registry: true },
  { id: "usernamehw.errorlens", displayName: "Error Lens", publisher: "Alexander", description: "Show diagnostics inline next to the code they refer to.", category: "Formatters & Linters", registry: true },
  { id: "streetsidesoftware.code-spell-checker", displayName: "Code Spell Checker", publisher: "Street Side Software", description: "A basic spell checker for identifiers, strings, and comments.", category: "Formatters & Linters", registry: true },
  { id: "editorconfig.editorconfig", displayName: "EditorConfig", publisher: "EditorConfig", description: "Attempts to override user settings with settings from .editorconfig.", category: "Formatters & Linters", registry: true },
  { id: "charliermarsh.ruff", displayName: "Ruff", publisher: "Charliermarsh", description: "Fast Python linter and formatter, implemented in Rust.", category: "Formatters & Linters", registry: true },

  // --- Git & source control ---
  { id: "eamodio.gitlens", displayName: "GitLens — Git supercharged", publisher: "GitKraken", description: "Blame annotations, history, and rich repository insights.", category: "Source Control", registry: true },
  { id: "mhutchie.git-graph", displayName: "Git Graph", publisher: "mhutchie", description: "View a commit graph and perform common git actions from it.", category: "Source Control", registry: true },
  { id: "donjayamanne.githistory", displayName: "Git History", publisher: "Don Jayamanne", description: "View git log, file history, compare branches and commits.", category: "Source Control", registry: true },
  { id: "github.vscode-pull-request-github", displayName: "GitHub Pull Requests", publisher: "GitHub", description: "Review and manage GitHub pull requests and issues in the editor.", category: "Source Control", registry: true },
  { id: "vscode.git-base", displayName: "Git Base", publisher: "Microsoft", description: "Shared git language and template support used by git UIs.", category: "Source Control", registry: false },
  { id: "gitlab.gitlab-workflow", displayName: "GitLab Workflow", publisher: "GitLab", description: "Merge requests, issues, pipelines, and snippets from GitLab.", category: "Source Control", registry: true },
  { id: "codeium.gitkraken-icon-theme", displayName: "GitKraken Icons", publisher: "GitKraken", description: "File and folder icons themed around GitKraken's visual language.", category: "Source Control", registry: false },

  // --- Appearance: icon & color themes ---
  { id: "pkief.material-icon-theme", displayName: "Material Icon Theme", publisher: "Philipp Kief", description: "Material Design icons for files and folders.", category: "Themes & Icons", registry: true },
  { id: "vscode-icons-team.vscode-icons", displayName: "vscode-icons", publisher: "VSCode Icons Team", description: "Icons for Visual Studio Code.", category: "Themes & Icons", registry: true },
  { id: "dracula-theme.theme-dracula", displayName: "Dracula Official", publisher: "Dracula Theme", description: "Official Dracula theme — dark, purple-forward palette.", category: "Themes & Icons", registry: true },
  { id: "zhuangtongfa.material-theme", displayName: "One Monokai Theme", publisher: "zhuangtongfa", description: "A hybrid of One Dark and Monokai.", category: "Themes & Icons", registry: true },
  { id: "sainnhe.gruvbox-material", displayName: "Gruvbox Material", publisher: "sainnhe", description: "Gruvbox-flavored theme with a material palette.", category: "Themes & Icons", registry: true },
  { id: "arcticicestudio.nord-visual-studio-code", displayName: "Nord", publisher: "Arctic Ice Studio", description: "An arctic, north-bluish clean and elegant theme.", category: "Themes & Icons", registry: true },
  { id: "akamud.vscode-theme-onedark", displayName: "One Dark Pro", publisher: "binaryify", description: "Atom's One Dark theme for the editor.", category: "Themes & Icons", registry: false },
  { id: "teabyii.ayu", displayName: "Ayu", publisher: "teabyii", description: "A simple theme with bright colors in three variants.", category: "Themes & Icons", registry: true },
  { id: "equinusocio.vsc-material-theme", displayName: "Material Theme", publisher: "Equinusocio", description: "The most epic theme, Material Design inspired.", category: "Themes & Icons", registry: true },
  { id: "monokai.theme-monokai-pro-vscode", displayName: "Monokai Pro", publisher: "Monokai", description: "Professional Monokai theme with carefully tuned colors.", category: "Themes & Icons", registry: false },

  // --- Productivity & editing quality-of-life ---
  { id: "christian-kohler.path-intellisense", displayName: "Path Intellisense", publisher: "Christian Kohler", description: "Autocompletes filenames as you type import paths.", category: "Productivity", registry: true },
  { id: "formulahendry.auto-rename-tag", displayName: "Auto Rename Tag", publisher: "Jun Han", description: "Automatically rename paired HTML/XML tags.", category: "Productivity", registry: true },
  { id: "naumovs.color-highlight", displayName: "color-highlight", publisher: "naumovs", description: "Highlight web colors right in the editor.", category: "Productivity", registry: true },
  { id: "oderwat.indent-rainbow", displayName: "indent-rainbow", publisher: "oderwat", description: "Colorizes indentation levels so nesting is visible at a glance.", category: "Productivity", registry: true },
  { id: "wayou.vscode-todo-highlight", displayName: "TODO Highlight", publisher: "wayou", description: "Highlights TODO/FIXME comments everywhere they appear.", category: "Productivity", registry: true },
  { id: "alefragnani.project-manager", displayName: "Project Manager", publisher: "Alefragnani", description: "Switch between project folders easily from one place.", category: "Productivity", registry: true },
  { id: "gruntfuggly.todo-tree", displayName: "Todo Tree", publisher: "Gruntfuggly", description: "Shows a tree of all TODO/FIXME tags in the workspace.", category: "Productivity", registry: true },
  { id: "wix.vscode-import-cost", displayName: "Import Cost", publisher: "Wix", description: "Displays the imported package size inline as you type.", category: "Productivity", registry: true },
  { id: "steoates.autoimport", displayName: "Auto Import", publisher: "steoates", description: "Automatically finds, parses, and provides code actions for missing imports.", category: "Productivity", registry: true },
  { id: "vincaslt.highlight-matching-tag", displayName: "Highlight Matching Tag", publisher: "vincaslt", description: "Highlights matching opening/closing tags, with breadcrumbs.", category: "Productivity", registry: true },
  { id: "kisstkondoros.typelens", displayName: "TypeLens", publisher: "kisstkondoros", description: "Shows reference counts above classes, interfaces, and methods.", category: "Productivity", registry: true },
  { id: "chrmarti.regex", displayName: "Regex Preview Test", publisher: "chrmarti", description: "Test regular expressions live against sample text.", category: "Productivity", registry: true },
  { id: "qcz.text-power-tools", displayName: "Text Power Tools", publisher: "qcz", description: "Filters, sorting, conversions, and other text utilities.", category: "Productivity", registry: true },

  // --- Markdown, docs & writing ---
  { id: "yzhang.markdown-all-in-one", displayName: "Markdown All in One", publisher: "Yu Zhang", description: "Shortcuts, TOC, preview, and editing helpers for Markdown.", category: "Docs & Writing", registry: true },
  { id: "davidanson.vscode-markdownlint", displayName: "markdownlint", publisher: "David Anson", description: "Markdown linting and style checking with quick fixes.", category: "Docs & Writing", registry: true },
  { id: "shd101wyy.markdown-preview-enhanced", displayName: "Markdown Preview Enhanced", publisher: "Yiyi Wang", description: "Markdown preview with diagrams, math, and export options.", category: "Docs & Writing", registry: true },
  { id: "bierner.markdown-emoji", displayName: "Markdown Emoji", publisher: "Matt Bierner", description: "Adds :emoji: syntax support to Markdown preview.", category: "Docs & Writing", registry: true },
  { id: "bierner.markdown-preview-github-styles", displayName: "Markdown Preview GitHub Styling", publisher: "Matt Bierner", description: "Changes the built-in Markdown preview to match GitHub styling.", category: "Docs & Writing", registry: true },
  { id: "streetsidesoftware.code-spell-checker-german", displayName: "German Spell Checker", publisher: "Street Side Software", description: "German dictionary for the base spell checker.", category: "Docs & Writing", registry: true },

  // --- Testing & QA ---
  { id: "hbenl.vscode-test-explorer", displayName: "Test Explorer UI", publisher: "Holger Benl", description: "Tree view of tests with run/debug actions.", category: "Testing", registry: true },
  { id: "orta.vscode-jest", displayName: "Jest", publisher: "Orta Therox", description: "Run and debug Jest tests with inline failure decorations.", category: "Testing", registry: true },
  { id: "firsttris.vscode-jest-runner", displayName: "Jest Runner", publisher: "firsttris", description: "Run and debug individual Jest test blocks.", category: "Testing", registry: true },
  { id: "ms-playwright.playwright", displayName: "Playwright Test for VSCode", publisher: "Playwright", description: "Record, run, and debug Playwright end-to-end tests.", category: "Testing", registry: false },
  { id: "vitest.explorer", displayName: "Vitest", publisher: "Vitest", description: "Run and debug Vitest tests from the sidebar.", category: "Testing", registry: true },
  { id: "humao.rest-client", displayName: "REST Client", publisher: "Huachao Mao", description: "Send HTTP requests and view responses from .http files.", category: "Testing", registry: true },

  // --- Data & config formats ---
  { id: "redhat.vscode-yaml", displayName: "YAML", publisher: "Red Hat", description: "YAML language support with schema validation and autocompletion.", category: "Data & Config", registry: true },
  { id: "redhat.vscode-xml", displayName: "XML", publisher: "Red Hat", description: "XML language support with validation and formatting.", category: "Data & Config", registry: true },
  { id: "mikestead.dotenv", displayName: "DotENV", publisher: "Mike Stead", description: "Syntax highlighting for .env files.", category: "Data & Config", registry: true },
  { id: "mechatroner.rainbow-csv", displayName: "Rainbow CSV", publisher: "mechatroner", description: "Column-colorized CSV/TSV editing with queries.", category: "Data & Config", registry: true },
  { id: "janisdd.vscode-edit-csv", displayName: "Edit csv", publisher: "janisdd", description: "Edit CSV files in a spreadsheet-like table view.", category: "Data & Config", registry: true },
  { id: "tomoki1207.pdf", displayName: "vscode-pdf", publisher: "tomoki1207", description: "Preview PDF files inside the editor.", category: "Data & Config", registry: true },
  { id: "eamodio.tokenize-text", displayName: "Tokenize Text", publisher: "eamodio", description: "Text tokenization helpers for plain prose files.", category: "Data & Config", registry: false },

  // --- Remote, containers & infrastructure ---
  { id: "ms-vscode.remote-repositories", displayName: "Remote Repositories", publisher: "Microsoft", description: "Browse and edit GitHub repositories without cloning.", category: "Remote & Infra", registry: false },
  { id: "ms-vscode-remote.remote-containers", displayName: "Dev Containers", publisher: "Microsoft", description: "Open any folder inside a container and use it as a full-featured dev environment.", category: "Remote & Infra", registry: false },
  { id: "hashicorp.terraform", displayName: "Terraform", publisher: "HashiCorp", description: "Terraform HCL language support with validation and formatting.", category: "Remote & Infra", registry: true },
  { id: "ms-kubernetes-tools.vscode-kubernetes-tools", displayName: "Kubernetes", publisher: "Microsoft", description: "Cluster browsing, manifests, and kubectl integration.", category: "Remote & Infra", registry: true },
  { id: "amazonwebservices.aws-toolkit-vscode", displayName: "AWS Toolkit", publisher: "Amazon Web Services", description: "Browse, develop against AWS resources and Lambda functions.", category: "Remote & Infra", registry: true },
  { id: "ms-azuretools.vscode-azureresourcegroups", displayName: "Azure Resources", publisher: "Microsoft", description: "Browse and manage Azure resources.", category: "Remote & Infra", registry: false },

  // --- AI assistants & pair programmers ---
  { id: "github.copilot", displayName: "GitHub Copilot", publisher: "GitHub", description: "AI pair programmer that suggests whole lines or functions.", category: "AI Assistants", registry: false },
  { id: "saoudrizwan.claude-dev", displayName: "Cline", publisher: "Saoud Rizwan", description: "Autonomous coding agent that edits files and runs commands with your permission.", category: "AI Assistants", registry: true },
  { id: "continue.continue", displayName: "Continue", publisher: "Continue", description: "Open-source AI code assistant you can point at any model.", category: "AI Assistants", registry: true },
  { id: "codeium.codeium", displayName: "Codeium", publisher: "Codeium", description: "Free AI-powered autocomplete and chat for dozens of languages.", category: "AI Assistants", registry: true },
  { id: "tabnine.tabnine-vscode", displayName: "Tabnine AI Autocomplete", publisher: "Tabnine", description: "AI assistant providing whole-line and full-function completions.", category: "AI Assistants", registry: true },
  { id: "sourcegraph.cody-ai", displayName: "Cody AI", publisher: "Sourcegraph", description: "AI coding assistant with codebase-aware answers.", category: "AI Assistants", registry: true },

  // --- Keymaps & migration packs ---
  { id: "ms-vscode.notepadplusplus-keybindings", displayName: "Notepad++ Keymap", publisher: "Microsoft", description: "Popular Notepad++ keyboard shortcuts ported over.", category: "Keymaps", registry: true },
  { id: "ms-vscode.sublime-keybindings", displayName: "Sublime Text Keymap", publisher: "Microsoft", description: "Popular Sublime Text keyboard shortcuts ported over.", category: "Keymaps", registry: true },
  { id: "ms-vscode.atom-keybindings", displayName: "Atom Keymap", publisher: "Microsoft", description: "Popular Atom keyboard shortcuts ported over.", category: "Keymaps", registry: true },
  { id: "vscodevim.vim", displayName: "Vim", publisher: "vscodevim", description: "Modal editing with Vim keybindings, registers, and macros.", category: "Keymaps", registry: true },
  { id: "kaiwood.center-editor-window", displayName: "Center Editor Window", publisher: "kaiwood", description: "Keeps the active line vertically centered like some Vim setups.", category: "Keymaps", registry: true },

  // --- Fun & misc ---
  { id: "hoovercj.vscode-power-mode", displayName: "Power Mode", publisher: "hoovercj", description: "Screen shake, particle bursts, and combo counters while typing.", category: "Fun", registry: true },
  { id: "wayou.vscode-pomodoro-timer", displayName: "Pomodoro Timer", publisher: "wayou", description: "A simple pomodoro timer living in the status bar.", category: "Fun", registry: true },
  { id: "sleistner.codesnap", displayName: "CodeSnap", publisher: "adpyke", description: "Take beautiful screenshots of your code.", category: "Fun", registry: true },
];

module.exports = { CATALOG };
