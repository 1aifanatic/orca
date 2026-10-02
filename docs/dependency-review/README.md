# Dependency update review

Reviewed October 1, 2026 PDT / October 2 UTC. Four agents reviewed every direct dependency in the desktop, mobile, cloud and documentation projects, plus native packages, package managers, Ruby tooling, runtime pins, Terraform providers, container bases and GitHub Action families. Decisions use committed lock versions, primary release notes, publish dates, engines, peers, security advisories and bounded upstream issue searches.

Updates were selected for fixes or capabilities Orca uses. The review preserves native patches, matched React/React DOM 19.2 versions, the Linux glibc 2.31 floor, and existing SSH and mixed-version protocol behavior. Every workspace retains a 72-hour release-age gate with no new exceptions; stale desktop exemptions were removed.

## Decisions and evidence

- [Desktop application dependencies](desktop.md): complete 144-entry inventory, selected fixes, security resolution and final validation.
- [Desktop platform and toolchain](desktop-platform.md): Electron/native/tooling matrices, measured Sherpa incompatibility, packaging deferrals, package-manager behavior, Fastlane and auxiliary pins.
- [Mobile](mobile.md): complete inventory, compatible Expo SDK 55 backports, tool updates, unchanged native patches and native migration limits.
- [Cloud and documentation](cloud-docs.md): complete inventory, Hono/Node adapter compatibility, Next security updates, standalone install policy, real PostgreSQL checks and frozen old-parser wire tests.

Selected changes include the Claude SDK, Linear SDK, i18next, DOMPurify, WebSocket and state-management fixes; corrected Tailwind class merging and UI primitives; compatible Expo backports; docs Next/React maintenance releases; and compiler, linter, test-DOM, package-manager and Fastlane maintenance. Test adjustments preserve behavior checks while accommodating public CSS APIs, optional CLI metadata and stricter workspace fixture validation.

Important holds include Electron, electron-builder/Squirrel, the Vite/Electron-Vite major migration, Sherpa, the patched xterm suite, Expo/React Native majors, Mermaid 12, Monaco, React 19.3 and Sonner 2.0.8. The reports distinguish current packages, useful candidates needing qualification, fresh releases below the age gate and updates with no relevant benefit.

## Security audits

| Project       |           Initial findings | Final findings |
| ------------- | -------------------------: | -------------: |
| Desktop       |                         28 |              0 |
| Cloud         |                          0 |              0 |
| Documentation | 25, including one critical |              0 |
| Mobile        |                          8 |              1 |

Mobile's remaining finding is [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) in node-forge, reached through Expo CLI tooling. No fixed version is published. Audit counts describe each project's dependency graph, not distinct vulnerabilities across projects. The issue reviews also record reports absent from registry audits, including SSH2's receive-window report and fresh Hono static-file advisories affecting middleware Orca does not import.

## Verification

Frozen installs and typechecks pass across the four projects. Desktop validation includes 42,214 passing tests in the broad run, successful rechecks of all ten initially failing files, 430 updater tests, eight real Claude CLI tests, production builds and hidden Electron checks for Markdown editing, emoji selection and Select keyboard typeahead. Mobile passes 9,746 tests across 902 files. Documentation builds 119 pages and passes its tests and lint/type checks. The cloud report records real PostgreSQL integration and 13 frozen-parser compatibility tests, including the exact final full-run result.

Rendered validation uses hidden windows and isolated profiles; screenshots were inspected. Linux/Windows/macOS release packaging, signing, native iOS/Android builds and on-device testing were not performed locally. Broader native and installer migrations remain deferred for that qualification. The Docker package-manager bootstrap was aligned, but its image was not rebuilt locally. Detailed reports state initial failures, retries and existing skipped or grandfathered checks explicitly.
