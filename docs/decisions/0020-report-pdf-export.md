# 0020. PDF export of the hours report (client-side)

Status: Accepted (added after Phase 10 at the owner's request; awaiting review).

## Context
The hours report could only be read on screen. The owner asked for a **Download PDF** button on the report page.

## Decision
- **The PDF is drawn in the browser** from the report the screen already shows (`src/lib/report-pdf.ts`), not by a new backend endpoint. The backend has already scoped those rows by role (a contributor's file holds only their own hours, a manager's only their reporting line), so no new authorization surface exists and the file always matches the table, including filters and the 5000-row `truncated` note.
- **New dependencies:** `jspdf` (PDF drawing) and `jspdf-autotable` (table layout, page breaks, repeated header and a total row). Both are stable releases; writing a PDF layout engine by hand would be far more code and risk. `npm audit --omit=dev` reports 0 vulnerabilities. They are **loaded on demand** (`import()` when the button is pressed), so the initial bundle did not grow (main chunk ≈ 409 kB, unchanged); the PDF chunks (~600 kB, ≈ 190 kB gzipped) are fetched only when someone exports.
- The file is handed to the browser as a Blob download (`<a download>` on an object URL): nothing is uploaded and the page does not navigate. Name: `hours-report_<from>_to_<to>.pdf`.
- Failures (the PDF cannot be created) show a fixed message, never the exception text.

## Trade-offs
- The PDF uses the built-in Helvetica font, which covers Western European text. Names or project titles in other scripts (for example CJK or Cyrillic) would render incorrectly until a Unicode font is embedded (adds a large font file). Not done.
- A server-side PDF (for example scheduled emails or very large reports) would need a backend library and its own tests; the 5000-row cap keeps the browser approach comfortable.
- Only the hours report is exported. The budget report (admin-only) has no export yet.

## Verification
Unit tests for the table builder, a real PDF built in jsdom (header, title, rows, totals, truncation note, page breaks), the button (saves a `%PDF-` Blob named after the period, hidden for empty or failed reports, error message instead of a crash); a Playwright test downloads the file in Chrome and checks its name and contents; the output was rendered to an image and inspected.
