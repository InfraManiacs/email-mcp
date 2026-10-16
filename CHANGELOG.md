# Changelog

All notable changes to this project will be documented in this file.

The format follows [Conventional Commits](https://www.conventionalcommits.org/) and is generated with [cocogitto](https://docs.cocogitto.io/).

<!-- next-header -->

## Unreleased ([3886bac..4e6910c](https://github.com/codefuturist/email-mcp/compare/3886bac..4e6910c))

#### ✨ Features

- **(alerts)** add notification setup diagnostics and AI-configurable alerts - ([34e288a](https://github.com/codefuturist/email-mcp/commit/34e288acb3a3330fd4eca0a583540ec877d9912c))
- **(alerts)** add urgency-based multi-channel notification system - ([b2425df](https://github.com/codefuturist/email-mcp/commit/b2425df6c917436e056e5cc8002ce684fc898694))
- **(cli)** add notify command for testing desktop notifications - ([687f7d2](https://github.com/codefuturist/email-mcp/commit/687f7d26449d97d56bd9d94b7e67f3b798b8e13e))
- **(cli)** add interactive MCP client installation command - ([e2369c7](https://github.com/codefuturist/email-mcp/commit/e2369c7f03df1e506b0bb11e0e5c471a0313ec6b))
- **(cli)** add interactive account CRUD and config edit commands - ([aaa8af5](https://github.com/codefuturist/email-mcp/commit/aaa8af501e7738cf049bd0b4a29ee74f0dbee3bb))
- **(hooks)** add customizable presets and static rule matching - ([138c08e](https://github.com/codefuturist/email-mcp/commit/138c08e0708f49e795e036e2245022fe060a0950))
- **(watcher)** add IMAP IDLE monitoring with AI triage - ([5ed0388](https://github.com/codefuturist/email-mcp/commit/5ed0388ccb0a781220407b3800723bf8191eb2f9))
- add AI-optimised email tools and context improvements - ([d7b01a4](https://github.com/codefuturist/email-mcp/commit/d7b01a48e57491d68ac605583ede6c1a92b2b70d))
- add provider-aware label management (ProtonMail/Gmail/IMAP keywords) - ([85609e5](https://github.com/codefuturist/email-mcp/commit/85609e5f181ea3c01ef26b4fe27a69bafb549141))
- add IMAP move/delete reliability and find_email_folder tool - ([3886bac](https://github.com/codefuturist/email-mcp/commit/3886bacc83eb8b4200f16695468e9029ade32c40))

#### 🐛 Bug Fixes

- **(cli)** add TTY guard and fix IMAP STARTTLS display - ([d9bca69](https://github.com/codefuturist/email-mcp/commit/d9bca695af07e311ec249379827c175e8dac483b))
- virtual folder detection and find_email_folder reliability - ([3c44c22](https://github.com/codefuturist/email-mcp/commit/3c44c226e7b3bf2666479e4d5761c8777d8c5e9c))

#### 📚 Documentation

- update tool count to 42 in README - ([4e6910c](https://github.com/codefuturist/email-mcp/commit/4e6910c04a8dd46efc739079c8e6aa613a7edfaf))
- add pnpm install and usage instructions - ([13c8d4b](https://github.com/codefuturist/email-mcp/commit/13c8d4bf3006fa4fb5f014eb630006a478082a23))

- - -
## [v0.6.0](https://github.com/codefuturist/email-mcp/compare/v0.2.3..v0.6.0) - 2026-10-10
#### ✨ Features
- (**account**) offer keychain storage during `account add` - ([48e863d](https://github.com/codefuturist/email-mcp/commit/48e863d293b1f8dafb77a84560920d41bc9f794f)) - Kithrian, Claude Fable 5
- (**attachments**) surface inline and unnamed parts; address attachments by part id - ([1e038c1](https://github.com/codefuturist/email-mcp/commit/1e038c18b76e2884bdcdcf3ed6e70933633e3f09)) - Kithrian, Claude Fable 5
- (**attachments**) optional auto_download setting for attachments saved by calendar actions - ([aa6a4da](https://github.com/codefuturist/email-mcp/commit/aa6a4da9253160fc843b76d5ada19148e270412f)) - Kithrian, Claude Fable 5
- (**cache**) cache ops surface — CLI status/clear/verify, health metrics, docs - ([3f9ff17](https://github.com/codefuturist/email-mcp/commit/3f9ff174fa6793fc567052ce4154eda41a00c9b3)) - Kithrian, Claude Fable 5
- (**cache**) enforce the size budget with LRU eviction and blob garbage collection - ([3e5f921](https://github.com/codefuturist/email-mcp/commit/3e5f92100681805cceafca3016f8d08128b74436)) - Kithrian, Claude Fable 5
- (**cache**) content-addressed attachment store with read-through downloads - ([358901e](https://github.com/codefuturist/email-mcp/commit/358901e5d232d80bf7207e37159e00a6402d0564)) - Kithrian, Claude Fable 5
- (**cache**) cached search and thread assembly - ([3ce4dc1](https://github.com/codefuturist/email-mcp/commit/3ce4dc1592204b99d6741dcdc28f14be403d6f05)) - Kithrian, Claude Fable 5
- (**cache**) body tier — read-through get_email, write-back persistence, and bounded backfill - ([5012971](https://github.com/codefuturist/email-mcp/commit/5012971fc1093a49a5ecdb26b374bc0c18fe116a)) - Kithrian, Claude Fable 5
- (**cache**) cached list/flags reads with STATUS-validated freshness + write-through invalidation - ([8d8111b](https://github.com/codefuturist/email-mcp/commit/8d8111bee5629ca28e9f5f07cd0304530f5204f6)) - Kithrian, Claude Fable 5
- (**cache**) schema v3 — flag columns, stable email id, references, body tier plumbing, attachment index, sync window - ([d22d4f4](https://github.com/codefuturist/email-mcp/commit/d22d4f4d8b0ed0b0d4aaa3fad3bee73dceb293ad)) - Kithrian, Claude Fable 5
- (**cache**) index attachment filenames in the local mirror and surface them in search - ([0a745e0](https://github.com/codefuturist/email-mcp/commit/0a745e0cd20cae18e5c7b85007e0cff4af4ce4f4)) - Kithrian, Claude Fable 5
- (**cli**) show bounce delivery status in the full email view - ([00bd34a](https://github.com/codefuturist/email-mcp/commit/00bd34ac4c35218794a310860b776c760855a6cd)) - Kithrian, Claude Fable 5
- (**cli**) add open command to jump to an email in the mail client - ([e7a9dd4](https://github.com/codefuturist/email-mcp/commit/e7a9dd41a8bf4c53e5df4e7cd6a27a3816277d00)) - Kithrian, Claude Fable 5
- (**cli**) email CLI --help per command, --json output, and 50MB attachment downloads - ([06fb84c](https://github.com/codefuturist/email-mcp/commit/06fb84cacf7e5f22ab60a4a5bcd1bf71215921b0)) - Kithrian
- (**cli**) read & compose email from the CLI (list/read/search/mailboxes/flag/delete/attach/reply/send) - ([6d0c105](https://github.com/codefuturist/email-mcp/commit/6d0c10597dc6d2f3f07c4ec868d2dc94ec695026)) - Kithrian
- (**cli**) update command — self-update the binary from GitHub Releases - ([150a3e3](https://github.com/codefuturist/email-mcp/commit/150a3e3f90e53254c0faefed860e250c6a18d957)) - Kithrian, Claude Fable 5
- (**errors**) explain rejected credentials instead of echoing the server - ([31d30ea](https://github.com/codefuturist/email-mcp/commit/31d30eae5b4791ac630eaa6ce4bb2e7899592961)) - Kithrian, Claude Fable 5
- (**html**) structure-aware HTML-to-text conversion - ([256b9d9](https://github.com/codefuturist/email-mcp/commit/256b9d95d35cff0232409b368638584e33d0f385)) - Kithrian, Claude Fable 5
- (**html**) structure-aware HTML-to-text conversion - ([c4bd44c](https://github.com/codefuturist/email-mcp/commit/c4bd44c662783c32623781ce944e89106614c0f8)) - Kithrian, Claude Fable 5
- (**imap**) download both text and html bodies; fix attached-message body leak - ([5b431a1](https://github.com/codefuturist/email-mcp/commit/5b431a117db315f45a2326b1f1bbe4bbd6e14e31)) - Kithrian, Claude Fable 5
- (**logs**) email-mcp logs — tail/follow/level/grep log viewer, colorized - ([0fa5628](https://github.com/codefuturist/email-mcp/commit/0fa562812abe122032881238b9c98f4d3d88d1b8)) - Kithrian
- (**release**) publish Homebrew cask to codefuturist/homebrew-tap - ([01cd6b5](https://github.com/codefuturist/email-mcp/commit/01cd6b570060321ace7bb04e4ff4180534771318)) - Kithrian, Claude Fable 5
- (**scheduler**) bound sent-email history with an age-based retention setting - ([f66f72e](https://github.com/codefuturist/email-mcp/commit/f66f72e21112be49459ebda55c133f6a0180a03e)) - Kithrian, Claude Fable 5
- (**scheduling**) deep-link reminders and events to their source email - ([97c5161](https://github.com/codefuturist/email-mcp/commit/97c516164ff947cc674226ec2ff41ab4147a9bf0)) - Kithrian, Claude Fable 5
- (**secrets**) account set-secret/migrate-secret CLI + cross-platform keychain (macOS security, Linux secret-tool) - ([cf3c472](https://github.com/codefuturist/email-mcp/commit/cf3c4728425b393c08f71c996c4a891f94c6119c)) - Kithrian
- (**secrets**) keychain/env secret indirection + 0600 config, multi-account - ([4a04de9](https://github.com/codefuturist/email-mcp/commit/4a04de93decd744e135e4626d97c9e489507db3e)) - Kithrian
- (**send**) optionally file a copy of each sent message in the Sent folder - ([5fb5457](https://github.com/codefuturist/email-mcp/commit/5fb54574cdbb78093c40057e6ed42f930880ecb8)) - Kithrian, Claude Fable 5
- (**send**) cid inline attachments and HTML templates - ([15cf54b](https://github.com/codefuturist/email-mcp/commit/15cf54b838b85521a3a18b16eee23d23ac03589e)) - Kithrian, Claude Fable 5
- (**send**) per-provider and per-account outbound attachment size limits - ([4eb25a2](https://github.com/codefuturist/email-mcp/commit/4eb25a2704390d9f7e90177a42c400a445fbb4be)) - Kithrian, Claude Fable 5
- (**send**) size-aware outbound attachments for send, reply, and forward - ([6321052](https://github.com/codefuturist/email-mcp/commit/63210525f43ce9985aab0a8754ecdab4b31cc4da)) - Kithrian
- (**server**) cross-platform daemon service (systemd --user on Linux) + server --help per subcommand - ([a3d4013](https://github.com/codefuturist/email-mcp/commit/a3d40139a5087e7bbda5e485c35e79aa3b568efd)) - Kithrian, Claude Opus 5 (1M context)
- ![BREAKING](https://img.shields.io/badge/BREAKING-red) (**smtp**) text alternative for HTML sends; readable quoted forwards - ([88c32bc](https://github.com/codefuturist/email-mcp/commit/88c32bce506386d660beba6b19e96f7551610574)) - Kithrian, Claude Fable 5
- ![BREAKING](https://img.shields.io/badge/BREAKING-red) (**tools**) default body format "text" with default length cap; shared formatter - ([283b6a1](https://github.com/codefuturist/email-mcp/commit/283b6a1ac94318d29a7df94dc2e509426ebed2ab)) - Kithrian, Claude Fable 5
#### 🐛 Bug Fixes
- (**attachments**) surface part ids so the documented download path works - ([99435d0](https://github.com/codefuturist/email-mcp/commit/99435d07179c1970653ae32b5458e197fbb7f10f)) - Kithrian, Claude Fable 5
- (**cache**) key in-memory maps by a NUL separator, not a space - ([5ffc8ff](https://github.com/codefuturist/email-mcp/commit/5ffc8ffb1573b98e9daa787e4683c5cfc743ec79)) - Kithrian, Claude Fable 5
- (**cache**) serve only a complete mirror, and close the invalidation and liveness gaps found in review - ([e78e832](https://github.com/codefuturist/email-mcp/commit/e78e832d687b86d7b0f814bc54ba69719a68b112)) - Kithrian, Claude Fable 5
- (**ci**) bump pnpm/action-setup v4 → v6, align Node 22 → 24 (#39) - ([efdb9ca](https://github.com/codefuturist/email-mcp/commit/efdb9ca8701ba445cbf3ae919a3ae8fae8e6e419)) - Colin, Claude Sonnet 4.6, Claude Sonnet 4.6, Claude Sonnet 4.6
- (**claude**) use Haiku 4.5 (Sonnet 4.6 quota exhausted on OAuth token) (#42) - ([56cd1cc](https://github.com/codefuturist/email-mcp/commit/56cd1ccc1f30291727c1dcfc98cd8a2a122b0485)) - Colin, Claude Sonnet 4.6
- (**cli**) reject unknown http flags and create the config template owner-only - ([1237d9e](https://github.com/codefuturist/email-mcp/commit/1237d9e3a1b211ca755769657ac89734046fc133)) - Kithrian, Claude Fable 5
- (**cli**) http --help booted the full server instead of printing usage - ([5a09479](https://github.com/codefuturist/email-mcp/commit/5a0947911950990f5be2eb5d17e0435d3c214b89)) - Kithrian
- (**completion**) shell completion for set-secret/migrate-secret + account-name completion, guarded against drift - ([6ea87f0](https://github.com/codefuturist/email-mcp/commit/6ea87f0436b91865f66c6b50d116e2f1363e6d9c)) - Kithrian
- (**config**) report TOML and schema errors instead of "no config found" - ([5eea537](https://github.com/codefuturist/email-mcp/commit/5eea537415e0f376b717c240693174d0348ab158)) - Kithrian, Claude Fable 5
- (**connections**) enforce IMAP STARTTLS instead of silently accepting plaintext - ([09fdf53](https://github.com/codefuturist/email-mcp/commit/09fdf53fa8a1c3deb33d0d71cae9b44835eb75d4)) - Kithrian
- (**docker**) persist state and cache so a restart keeps scheduled mail - ([8c6b609](https://github.com/codefuturist/email-mcp/commit/8c6b6093062fdf15273680b59ad6bf3182bf6b9f)) - Kithrian, Claude Fable 5
- (**drafts**) emit a conformant MIME message when saving a draft - ([dc38704](https://github.com/codefuturist/email-mcp/commit/dc38704e0b025b22406faa9fbc1128d6f7cc619f)) - Kithrian, Claude Fable 5
- (**html**) break blocks on the opening tag, not only the closing one - ([f43a394](https://github.com/codefuturist/email-mcp/commit/f43a3949ccd7d5511e78518be33b9c9d59789933)) - Kithrian, Claude Fable 5
- (**html**) harden the converter and MIME handling against review findings - ([70f9e85](https://github.com/codefuturist/email-mcp/commit/70f9e85c992fe6807094ae78d4398aece5276b72)) - Kithrian, Claude Fable 5
- (**imap**) read every text part, and unwrap format=flowed bodies - ([f9977eb](https://github.com/codefuturist/email-mcp/commit/f9977eb2d75995fde117bbc2dee55a6f19c7b6a6)) - Kithrian, Claude Fable 5
- (**imap**) retry label-strategy detection after a transient failure - ([1b0cbbd](https://github.com/codefuturist/email-mcp/commit/1b0cbbd03b25d80753e072d68735c00549348371)) - Kithrian, Claude Fable 5
- (**imap**) close out the remaining body-handling review findings - ([e48281b](https://github.com/codefuturist/email-mcp/commit/e48281b676ffa4be7811e7f13a13d18601094b37)) - Kithrian, Claude Fable 5
- (**imap**) decode RFC 2047 headers and calendar part charsets - ([ce5736d](https://github.com/codefuturist/email-mcp/commit/ce5736d816fc519442923888baf6ed3d05bab77d)) - Kithrian, Claude Fable 5
- (**oauth**) share one in-flight token refresh per account - ([d444034](https://github.com/codefuturist/email-mcp/commit/d444034194709f1da4a17804592f0329fb741acc)) - Kithrian, Claude Fable 5
- (**release**) repair the Homebrew cask and fail fast on a missing tap token - ([135a69a](https://github.com/codefuturist/email-mcp/commit/135a69a9e8fe83acd2ab81780c55e270f21879fc)) - Kithrian, Claude Fable 5
- (**release**) wait for npm propagation before MCP Registry publish - ([d460c71](https://github.com/codefuturist/email-mcp/commit/d460c711d622594eb859f2d57078ecc5f24b9903)) - Kithrian, Claude Fable 5
- (**scheduler**) claim queue entries atomically so mail cannot go out twice - ([8978dcc](https://github.com/codefuturist/email-mcp/commit/8978dccd76b38681f5d0ce295b927b3e3d9426bf)) - Kithrian, Claude Fable 5
- (**security**) contain attachment downloads to the destination directory - ([c1d0367](https://github.com/codefuturist/email-mcp/commit/c1d03674f143f38c7e52ce2619ef431d32b8b1de)) - Kithrian, Claude Fable 5
- (**send**) keep threading on scheduled sends and References on drafts - ([73aa4cc](https://github.com/codefuturist/email-mcp/commit/73aa4cc58c9d1a6bb62d04fe823b223db2c5b4d1)) - Kithrian, Claude Fable 5
- (**watcher**) persist the IDLE watermark so a restart cannot skip mail - ([c5b095b](https://github.com/codefuturist/email-mcp/commit/c5b095b7d68dc967a0d98b064ba7e505e5f18811)) - Kithrian, Claude Fable 5
- (**watcher**) authenticate IDLE with OAuth2 instead of an absent password - ([5311a2e](https://github.com/codefuturist/email-mcp/commit/5311a2ebfffab88b13ed4fc35ae29cbd6d799e26)) - Kithrian, Claude Fable 5
#### 📚 Documentation
- (**cli**) list the mail commands and logs in the top-level help - ([9d18244](https://github.com/codefuturist/email-mcp/commit/9d1824461ead7a468d7764dcac5bd425b1ff627c)) - Kithrian, Claude Fable 5
- (**readme**) document body formats, inline images, and the new read defaults - ([8bafdb9](https://github.com/codefuturist/email-mcp/commit/8bafdb97c77ec8bd4dbaa973c88a37ef19906bc3)) - Kithrian, Claude Fable 5
- (**readme**) document update command and bun-compile install from npm - ([5a14f92](https://github.com/codefuturist/email-mcp/commit/5a14f92b83a594d655a20c0bb200428cc2e7ddcc)) - Kithrian, Claude Fable 5
- correct the claims the code does not keep - ([2ab9383](https://github.com/codefuturist/email-mcp/commit/2ab9383a1e4db9c525ff796acbc8825acd299ad7)) - Kithrian, Claude Fable 5
#### Tests
- (**integration**) permanent MCP-tool-layer e2e for size-aware attachments - ([e858211](https://github.com/codefuturist/email-mcp/commit/e858211d1166b9f74f60dd9af33c7401aa596d65)) - Kithrian
- (**secrets**) stop the keychain tests depending on the host platform - ([508205a](https://github.com/codefuturist/email-mcp/commit/508205a5a3c0f5990e7007a4a08c4787126d64a6)) - Kithrian, Claude Fable 5
#### CI
- (**claude**) add Claude Code GitHub Action and review guidance (#38) - ([3485cca](https://github.com/codefuturist/email-mcp/commit/3485cca3a299a6cfb836572530f283142e8874f4)) - Colin, Claude Sonnet 4.6, Claude Sonnet 4.6, Claude Sonnet 4.6
- (**security**) pin the gate's third-party actions to immutable commits - ([c70a1ea](https://github.com/codefuturist/email-mcp/commit/c70a1ea2da752a5b1f6d31a36ea7da52611b4291)) - Kithrian, Claude Fable 5
- (**security**) pin trivy-action to a tag that exists - ([c91be4e](https://github.com/codefuturist/email-mcp/commit/c91be4e33db09c62f0974055e8447b46e21abc50)) - Kithrian, Claude Fable 5
- (**security**) add modern security scanners to the dev chain (semgrep/trivy/pnpm-audit via pnpm scan + Security workflow) - ([70cc5dd](https://github.com/codefuturist/email-mcp/commit/70cc5ddc263bfd0ce5fff3bcf59b12f725d1a741)) - Kithrian
#### ♻️ Refactoring
- (**imap**) drop dead preview extraction - ([c483804](https://github.com/codefuturist/email-mcp/commit/c483804e6784ab2f62e5fd2ae0150d98bbad9c99)) - Kithrian, Claude Fable 5
- (**imap**) extract MIME-structure walking into a pure module - ([358e761](https://github.com/codefuturist/email-mcp/commit/358e76100e56e42cc77720d1bf071327bd9830b3)) - Kithrian, Claude Fable 5
- (**tools**) route mail reads through a MailReadService facade and services-bag wiring - ([0f037ec](https://github.com/codefuturist/email-mcp/commit/0f037eca37b3c4c64c7456d90bc9dccf60158184)) - Kithrian, Claude Fable 5
#### Chores
- (**deps**) update toolchain to latest safe-stable; fix CI version drift - ([7e1cdd9](https://github.com/codefuturist/email-mcp/commit/7e1cdd92e78c6ee6dc4d44c7a432a662f29f806d)) - Kithrian, Claude Fable 5
- (**deps**) update all dependencies to latest stable; adapt to imapflow 2.3 status() returning false - ([cdec57c](https://github.com/codefuturist/email-mcp/commit/cdec57c7492cb2debe96d83f4b05b918225b5201)) - Kithrian
- (**merge**) integrate SDK v2 modernization updates - ([a94666f](https://github.com/codefuturist/email-mcp/commit/a94666f98ecc441b350a10e90695115c287e843f)) - Kithrian
- (**quality**) enable noUncheckedIndexedAccess — narrow all 162 index/optional accesses (real guards in prod, assertions in tests) - ([0a3910c](https://github.com/codefuturist/email-mcp/commit/0a3910cac30cec497ebe6158d8f1c6c5b32e6864)) - Kithrian
- (**quality**) strict TS (verbatimModuleSyntax, noImplicitOverride) + strict biome rules + knip dead-code gate + full-coverage typecheck - ([1185ec0](https://github.com/codefuturist/email-mcp/commit/1185ec0f77fccca054f1daf796bf95e6076816b4)) - Kithrian
- migrate openai-whisper and poetry from pipx to uv - ([cc44361](https://github.com/codefuturist/email-mcp/commit/cc4436159aa0923793206ceb1f8dd06cb1e52c60)) - Kithrian, Mistral Vibe

- - -

## [v0.2.3](https://github.com/codefuturist/email-mcp/compare/9a04f6513a66cb7ededb6168dc492b9681681b72..v0.2.3) - 2026-05-16
#### ✨ Features
- add Streamable HTTP transport mode - ([9a04f65](https://github.com/codefuturist/email-mcp/commit/9a04f6513a66cb7ededb6168dc492b9681681b72)) - Kithrian, Claude Sonnet 4.6
#### 🐛 Bug Fixes
- (**docker**) replace corepack with npm install for pnpm — corepack hangs in BuildKit cross-arch - ([40dbce6](https://github.com/codefuturist/email-mcp/commit/40dbce6a6dc01b186af5632a2f989a6ca29db70c)) - Kithrian, Claude Sonnet 4.6
- (**http**) call hooksService.start() on client initialized in HTTP mode - ([36eb8ca](https://github.com/codefuturist/email-mcp/commit/36eb8cab977aeb49f3da484f57a62150ad976702)) - Kithrian, Claude Sonnet 4.6

- - -

## [v0.5.1](https://github.com/codefuturist/email-mcp/compare/0449a06d7cbc5a3c11e1ec1f16add39b4eca0d17..v0.5.1) - 2026-09-26
#### ✨ Features
- (**release**) build all common platforms via GoReleaser Pro in CI - ([5b6fb56](https://github.com/codefuturist/email-mcp/commit/5b6fb56274425e849499995fcb8cc20d9c308543)) - Kithrian, Claude Fable 5
- (**release**) build provenance-attested bun binaries in CI - ([afd535c](https://github.com/codefuturist/email-mcp/commit/afd535c6cd5b823fb4efc1fa68b141ee8a51a6cf)) - Kithrian, Claude Fable 5
#### 🐛 Bug Fixes
- (**docker**) ship pnpm patch config into image build contexts - ([47961a4](https://github.com/codefuturist/email-mcp/commit/47961a40b9397725b64f8396e9b8140e0165c674)) - Kithrian, Claude Fable 5
- (**imap**) repair TLS servername fallback for npm consumers at runtime - ([70d4215](https://github.com/codefuturist/email-mcp/commit/70d4215de07920252f672923cf3cd48aad7a0189)) - Kithrian, Claude Fable 5
- (**release**) keep MCP Registry description under 100 chars - ([f41b42f](https://github.com/codefuturist/email-mcp/commit/f41b42f17e19de292415056b82f29533f0201c96)) - Kithrian, Claude Fable 5
#### Build
- (**goreleaser**) compile release binaries with the Pro bun builder - ([0449a06](https://github.com/codefuturist/email-mcp/commit/0449a06d7cbc5a3c11e1ec1f16add39b4eca0d17)) - Kithrian, Claude Fable 5
#### CI
- (**deps**) bump actions/checkout and goreleaser-action to v7 - ([4d7f38c](https://github.com/codefuturist/email-mcp/commit/4d7f38c400fb79268553f4fa7fbf6141ef16223b)) - Kithrian, Claude Fable 5
#### Chores
- (**npm**) normalize bin path via npm pkg fix - ([1056481](https://github.com/codefuturist/email-mcp/commit/1056481d37bb1720dc66fd9e3f6b935a815fd6a9)) - Kithrian, Claude Fable 5

- - -

## [v0.5.0](https://github.com/codefuturist/email-mcp/compare/98bc426dee923bfa3d4dbd874fadcad72c30eed5..v0.5.0) - 2026-09-26
#### ✨ Features
- (**cli**) shell completion for zsh, bash, and fish - ([e0c6563](https://github.com/codefuturist/email-mcp/commit/e0c6563780a1b04200c44ac6649cb0970b6a7e70)) - Kithrian, Claude Fable 5
- (**cli**) config validate — syntax, schema, typo detection, consistency - ([bf09dcc](https://github.com/codefuturist/email-mcp/commit/bf09dcc1f087279812fe307647bf8e52198becd8)) - Kithrian, Claude Fable 5
- (**server**) [settings.server] config section and launchd login item - ([98bc426](https://github.com/codefuturist/email-mcp/commit/98bc426dee923bfa3d4dbd874fadcad72c30eed5)) - Kithrian, Claude Fable 5
#### ⚡ Performance
- (**cli**) lazy-load the server graph — 3.8x faster CLI startup - ([a0f9ca6](https://github.com/codefuturist/email-mcp/commit/a0f9ca636a5b881a78c92d907c3d64a1a00b1902)) - Kithrian, Claude Fable 5
#### Build
- release binary matrix with minify and bytecode - ([7ddc0dc](https://github.com/codefuturist/email-mcp/commit/7ddc0dc5b83d0884f37bbecb8a256ffc0cbd0279)) - Kithrian, Claude Fable 5
- bun single-binary support with patched imapflow - ([7ba90a5](https://github.com/codefuturist/email-mcp/commit/7ba90a513d0c0d9e21b3f4a62f56cb3680ac4859)) - Kithrian, Claude Fable 5

- - -

## [v0.4.1](https://github.com/codefuturist/email-mcp/compare/bae1bb7d5c6f603e34166c702eccaf190c0915a0..v0.4.1) - 2026-09-26
#### Build
- (**deps**) upgrade all dependencies to latest stable - ([bae1bb7](https://github.com/codefuturist/email-mcp/commit/bae1bb7d5c6f603e34166c702eccaf190c0915a0)) - Kithrian, Claude Fable 5

- - -

## [v0.4.0](https://github.com/codefuturist/email-mcp/compare/03b3b0233e5e65b1fa30324f3859860e061b364d..v0.4.0) - 2026-09-26
#### ✨ Features
- (**cache**) add offline-capable local mirror - ([29106e8](https://github.com/codefuturist/email-mcp/commit/29106e8059fb86d9b94bfdaa4640ffdd66d994d3)) - Kithrian, Claude Opus 5 (1M context)
- (**cli**) server lifecycle commands for an always-on HTTP daemon - ([755eb39](https://github.com/codefuturist/email-mcp/commit/755eb3900bcdb7c11550a98aaf74b9671dce5711)) - Kithrian, Claude Fable 5
- (**cli**) section editor for config edit + full config show - ([17efd45](https://github.com/codefuturist/email-mcp/commit/17efd45bfa6f90208fe47ef14f4828b9d03d4080)) - Kithrian, Claude Fable 5
- (**cli**) settings field catalog - ([00d559b](https://github.com/codefuturist/email-mcp/commit/00d559bd43de94ad0f859463d2b9b0e61ff8b40f)) - Kithrian, Claude Fable 5
- (**clipboard**) add zero-dep clipboard service with concealed writes - ([dad7045](https://github.com/codefuturist/email-mcp/commit/dad70451898f85f4f097c789b4b2a70edc1c6274)) - Kithrian, Claude Fable 5
- (**config**) saveConfigValidated with backup - ([c2d0a9d](https://github.com/codefuturist/email-mcp/commit/c2d0a9d144d6531d2e70bbb5799532f9648c964d)) - Kithrian, Claude Fable 5
- (**goreleaser**) use base.yaml + monorepo config - ([45beb34](https://github.com/codefuturist/email-mcp/commit/45beb34666e227909fda75e77a8677029ddbbe79)) - Colin, Copilot
- (**notifier**) add notifyRaw for caller-controlled notifications - ([c688f60](https://github.com/codefuturist/email-mcp/commit/c688f600516ff0139a7bb3ea773f207fccab8fa2)) - Kithrian, Claude Fable 5
- (**sdk**) migrate to MCP SDK v2 and modernize tooling - ([a309a67](https://github.com/codefuturist/email-mcp/commit/a309a6704ad1cd737d087f1e7ab57bb344156e79)) - Kithrian, Claude Opus 5 (1M context)
- (**verification**) configure_verification tool with live catcher toggle - ([f9c8434](https://github.com/codefuturist/email-mcp/commit/f9c843468aaee2e2af027c9c0a1b91b69bd051da)) - Kithrian, Claude Fable 5
- (**verification**) add confirm-before-copy and open-in-browser for links - ([6cd81e2](https://github.com/codefuturist/email-mcp/commit/6cd81e2b8bb4ad454b54f099e98ea91813bf2493)) - Kithrian, Claude Fable 5
- (**verification**) expose get_verification_code and check_clipboard_setup - ([2d5b862](https://github.com/codefuturist/email-mcp/commit/2d5b8626624a6db3b77d4effa345fea2cad0036d)) - Kithrian, Claude Fable 5
- (**verification**) add ambient catcher service and scanRecent - ([20e2da8](https://github.com/codefuturist/email-mcp/commit/20e2da80e74d6cd29f6ca8f3fdd45a5296c3dce0)) - Kithrian, Claude Fable 5
- (**verification**) add one-shot dedup state with pruning - ([0f3f04f](https://github.com/codefuturist/email-mcp/commit/0f3f04f4fa4c5c3c6bfef600197502b0cb5f3fe2)) - Kithrian, Claude Fable 5
- (**verification**) add [settings.verification] config section - ([c45f354](https://github.com/codefuturist/email-mcp/commit/c45f354df3ef3c4c8ea70b994c3e906f5e9bbd61)) - Kithrian, Claude Fable 5
- (**verification**) add magic-link extractor - ([321dc80](https://github.com/codefuturist/email-mcp/commit/321dc8010b562d09dbd147391a3c1b73fd3923a5)) - Kithrian, Claude Fable 5
- (**verification**) add scored OTP code extractor - ([4862d5f](https://github.com/codefuturist/email-mcp/commit/4862d5fa6ebc6c0f0bd570d19f395d135309b739)) - Kithrian, Claude Fable 5
#### 🐛 Bug Fixes
- (**hooks**) detach only own email:new listener on stop - ([d5ace5e](https://github.com/codefuturist/email-mcp/commit/d5ace5e3a4664c962f1b21a930f0bf03eadefc38)) - Kithrian, Claude Fable 5
- (**imap**) report server rejections and stop deadlocking get_thread - ([7fe8916](https://github.com/codefuturist/email-mcp/commit/7fe8916b90fba852267894091a5e6d3ca1bf168d)) - Kithrian, Claude Opus 5 (1M context)
- (**imap**) decode message bodies instead of returning raw source - ([439a1e5](https://github.com/codefuturist/email-mcp/commit/439a1e547cc24eed91b9acfada620065ff859283)) - Kithrian, Claude Opus 5 (1M context)
- (**imap**) correct MIME and UID handling - ([5bd96af](https://github.com/codefuturist/email-mcp/commit/5bd96afdb65660e21acfd3386a11a9e81b7348f2)) - Kithrian, Claude Opus 5 (1M context)
- (**release**) stage manifests in bump commit and push v-prefixed tag - ([57905c4](https://github.com/codefuturist/email-mcp/commit/57905c4751d58f746445e2a4e0dc12bec2d74f6d)) - Kithrian, Claude Fable 5
- (**watcher,hooks**) repair flag writes and surface mailbox changes - ([606b1b5](https://github.com/codefuturist/email-mcp/commit/606b1b540c8afd582544290ec00e1ca2aa2789ee)) - Kithrian, Claude Opus 5 (1M context)
- correct goreleaser base path - ([c24dd3e](https://github.com/codefuturist/email-mcp/commit/c24dd3e56fdfa71a11ee433e8edb11afda0302c9)) - Kithrian, Copilot
- exclude lock files from biome pre-commit check - ([1e51628](https://github.com/codefuturist/email-mcp/commit/1e5162839fd007a7af0a68151f08236f2f32edaf)) - Colin, Copilot
#### 📚 Documentation
- (**config**) document interactive editor, backups, and 52 tools - ([944f9cf](https://github.com/codefuturist/email-mcp/commit/944f9cf941628b16f0d2d4e2e6db1539e8ce8979)) - Kithrian, Claude Fable 5
- (**verification**) document instant OTP catch and update tool counts - ([dd251f7](https://github.com/codefuturist/email-mcp/commit/dd251f7cbbfa46b74033fbcf9be39500d18cc7d3)) - Kithrian, Claude Fable 5
- add Mistral Vibe MCP client installation instructions - ([643fb18](https://github.com/codefuturist/email-mcp/commit/643fb18b9e0c3c241143991db6825d7ca174921a)) - Colin
- add scheduler daemon setup instructions and delivery requirements - ([cbc3042](https://github.com/codefuturist/email-mcp/commit/cbc3042bcc4ae8c33e7586519b7065ba2b0f264d)) - Colin
- expand VS Code Copilot setup (all 3 methods) and add Zed client - ([9e1f785](https://github.com/codefuturist/email-mcp/commit/9e1f78518833048c9fd56a37110d0dc54da538ce)) - Colin
#### Tests
- (**verification**) add GreenMail integration coverage - ([fdf8b7d](https://github.com/codefuturist/email-mcp/commit/fdf8b7d127b412cd57a555fdab32a126ad6086a9)) - Kithrian, Claude Fable 5
#### ♻️ Refactoring
- (**cli**) move cancel helpers into guard - ([060702d](https://github.com/codefuturist/email-mcp/commit/060702d613f7d261ab09a5efc9446e7a264d6fcf)) - Kithrian, Claude Fable 5
- (**config**) route config writes through validated save - ([c45c7bf](https://github.com/codefuturist/email-mcp/commit/c45c7bfa01769b3a3c0d19a95e9fab75639f95b4)) - Kithrian, Claude Fable 5
- (**utils**) extract glob matching and reply-chain stripping - ([d7ae7ca](https://github.com/codefuturist/email-mcp/commit/d7ae7cac8464aed0db12fcafde6a94e81d718ca8)) - Kithrian, Claude Fable 5
#### Chores
- normalize server.json formatting - ([4034b78](https://github.com/codefuturist/email-mcp/commit/4034b78715f1ab20306f969ec963b9f0df0aae4d)) - Colin, Copilot
- fix cog post_bump_hooks to sync package.json and server.json versions - ([03b3b02](https://github.com/codefuturist/email-mcp/commit/03b3b0233e5e65b1fa30324f3859860e061b364d)) - Colin

- - -

## [v0.2.1](https://github.com/codefuturist/email-mcp/compare/bd6f94d6f0d1f7f4beca5aa8061f2892a40f0ce0..v0.2.1) - 2026-02-20
#### 🐛 Bug Fixes
- (**labels**) fix critical parameter swap and multiple label bugs - ([bd6f94d](https://github.com/codefuturist/email-mcp/commit/bd6f94d6f0d1f7f4beca5aa8061f2892a40f0ce0)) - Colin
- defer post-connect work until MCP handshake completes - ([7847da0](https://github.com/codefuturist/email-mcp/commit/7847da07b4241e73282b2a36a9dd1a362dfb8656)) - Colin
#### Tests
- (**integration**) expand plain connection tests to match STARTTLS and SSL coverage - ([8bd3d77](https://github.com/codefuturist/email-mcp/commit/8bd3d7752ca18037ca899899a1e14688b961c0b1)) - Colin
- (**integration**) add connection mode tests for plain, STARTTLS, and implicit SSL - ([ccbefb7](https://github.com/codefuturist/email-mcp/commit/ccbefb78248f0f08d31c5b227347f286f350c9f9)) - Colin
- (**integration**) add integration test suite with GreenMail and Testcontainers - ([1cc72fe](https://github.com/codefuturist/email-mcp/commit/1cc72fec8166842fa92ad8c7957c2ec28df327ac)) - Colin
#### Build
- (**docker**) add OCI manifest annotations for GHCR multi-arch images - ([2aeb938](https://github.com/codefuturist/email-mcp/commit/2aeb93857e95d99b2cf4435e4eee7cd7a47aecdc)) - Colin
- (**docker**) add docker and goreleaser scripts, fix build for dockers_v2 context - ([56102f4](https://github.com/codefuturist/email-mcp/commit/56102f42ce81bba8c9ab8f442926d1b9704d2ab4)) - Colin
- (**docker**) add GoReleaser dockers_v2 for GHCR and Docker Hub publishing - ([83483a8](https://github.com/codefuturist/email-mcp/commit/83483a8879228b3ec213414f2f7c53e9cce3f497)) - Colin
- (**docker**) add Dockerfile, docker-compose, and CI docker build - ([e9f0a9f](https://github.com/codefuturist/email-mcp/commit/e9f0a9f2179a59de064879456204c8c3b4f3945b)) - Colin
- add lefthook git hooks, report output, upgrade actions and node to v24 - ([8665419](https://github.com/codefuturist/email-mcp/commit/86654197b1a1f252d6c67d8a5fd67f09100f4fd4)) - Colin
#### CI
- (**docker**) enable docker hub publishing - ([f2a8d44](https://github.com/codefuturist/email-mcp/commit/f2a8d44fb8e503a0ef053a716e00b5814625daf8)) - Colin
- refactor workflows to use codefuturist/shared-workflows@v1 - ([815292c](https://github.com/codefuturist/email-mcp/commit/815292c91e6215592cd3172a91600cf42b2224e0)) - Colin
- add docker-sha workflow, workflow_dispatch, action upgrades and lint fixes - ([ddfbcdc](https://github.com/codefuturist/email-mcp/commit/ddfbcdc27af83175c3fec3c666ebd1f23d0631f4)) - Colin
- improve Docker tag strategy - ([99785a0](https://github.com/codefuturist/email-mcp/commit/99785a0ea5c01579046783c3fdf7347932e77fdb)) - Colin
- add weekly Docker rebuild workflow for base image updates - ([08f77f9](https://github.com/codefuturist/email-mcp/commit/08f77f9d06c8fd5b6de65a08c9ff89b556e7f2c0)) - Colin
#### Chores
- (**eslint**) exclude integration tests from eslint - ([e3bcc12](https://github.com/codefuturist/email-mcp/commit/e3bcc122bb9d71bfdfd77040d4419b96296a162d)) - Colin
- (**gitignore**) update .gitignore to include comprehensive rules for various environments and tools - ([4c55dea](https://github.com/codefuturist/email-mcp/commit/4c55dea709e592f3e9f8b01d449846742774c07f)) - Colin
- fix changelog separator for cocogitto - ([55510c3](https://github.com/codefuturist/email-mcp/commit/55510c34bb44ac377e91e1c628d7a810ed2e6d6e)) - Colin

- - -


## [v0.1.0](https://github.com/codefuturist/email-mcp/releases/tag/v0.1.0) — Initial Release

First public release of email-mcp.

#### ✨ Features

- Full IMAP + SMTP email server for MCP clients
- 42 tools, 7 prompts, 6 resources
- Multi-account support with XDG-compliant TOML config
- Guided interactive setup wizard with provider auto-detection
- Gmail, Outlook, Yahoo, iCloud, Fastmail, ProtonMail, Zoho, GMX support
- OAuth2 XOAUTH2 for Gmail and Microsoft 365 _(experimental)_
- Email scheduling with OS-level scheduler integration
- Real-time IMAP IDLE watcher with AI-powered triage
- Urgency-based desktop / webhook alerts
- Provider-aware label management
- ICS/iCalendar extraction from emails
- Email analytics (volume, top senders, daily trends)
- Token-bucket rate limiter and audit trail
- MCP client auto-installer (Claude Desktop, VS Code, Cursor, Windsurf)
