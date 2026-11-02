# Synthetic notebook validation

Persistent notebook writes remain experimental and disabled in the installed plugin until physical tablet validation passes. Unit tests and cloud read-back alone are insufficient.

## Disposable test, 2026-11-01

The tablet initialized a two-entry PDF and added handwriting to both entries. Inserting a native blank page between the entries converted the document to `cPages` format 2. The experimental writer then refreshed the first entry, grew it to two pages, and appended a third entry under the same document ID.

Cloud verification confirmed:

- The intended five-page logical order, including the native blank page.
- Byte-identical unrelated handwriting and archive members.
- Exact uploaded PDF/content bytes and an idempotent retry.
- Six physical PDF backgrounds, including retained older backgrounds; all had 702 x 936 page boxes and rendered with Poppler.

**Physical tablet validation failed:** the user reported that most pages were blank and stuck at 5.0x zoom. A subsequent download retained the new PDF and redirects. The tablet sorted the new page-order keys and added native scrolling metadata. Stored document zoom still read `bestFit`, scale `1`.

This does not establish a root cause. A stale tablet PDF cache is a hypothesis, not a confirmed diagnosis. No guessed zoom, metadata, or size-field changes should be treated as a repair. Original annotated archives and the failed state are backed up locally outside the repository.

Further physical checks:

- Restarting the tablet did not resolve the mostly blank pages.
- A separate fresh upload of the **exact same six-page PDF bytes** displayed all pages with text. This isolates the failure to the existing-document update path rather than the PDF's basic rendering compatibility.
- Renaming the original document through the normal cloud operation refreshed its document metadata. All non-metadata archive members stayed byte-identical. The tablet still showed the 5.0x problem, including blank printed pages 2 and 5; page 3 was the intentionally blank page.

The next diagnostic is a read-only USB export of the original disposable document. Compare its actual tablet PDF bytes with the original and updated cloud PDFs. A cloud read-back alone cannot distinguish a stale local PDF from a local rendering-cache or page-metadata problem. No production compatibility evidence has been issued.

## Remaining acceptance checks

1. Resolve the blank-page/zoom failure and confirm updated pages display correctly on the tablet.
2. Confirm same-document refresh, append, growth, and shrink, preserving unrelated handwriting and native blank pages.
3. Write on an updated page and verify the subsequent download, OCR, and save into the correct Obsidian note.
4. Verify another update after that save, including retry without duplicated pages or repeated handwriting imports.
5. Verify initialized legacy metadata and migration to tablet-generated `cPages` metadata.

Keep the production compatibility gate closed until these checks pass. Do not manufacture a compatibility-evidence file from automated or cloud-only results.
