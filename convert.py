#!/usr/bin/env python3
"""
convert.py — PDF conversion helper
Usage:
  python3 convert.py word            input.pdf output.docx
  python3 convert.py excel           input.pdf output.xlsx
  python3 convert.py encrypt         input.pdf output.pdf user_pwd [owner_pwd]
  python3 convert.py decrypt         input.pdf output.pdf current_pwd
  python3 convert.py extract-text    input.pdf output.json
  python3 convert.py apply-text-edits input.pdf output.pdf edits.json
  python3 convert.py redact          input.pdf output.pdf redactions.json
"""
import sys
import os
import json


def to_word(input_pdf, output_docx):
    from pdf2docx import Converter

    cv = Converter(input_pdf)
    try:
        # start=0, end=None converts every page.
        # multi_processing=True speeds up longer documents on multi-core hosts.
        cv.convert(output_docx, start=0, end=None)
    finally:
        cv.close()
    print(f"OK: {output_docx}")


def to_excel(input_pdf, output_xlsx):
    # Use pdfplumber to extract tables, write to xlsx with openpyxl
    import pdfplumber
    import openpyxl
    wb = openpyxl.Workbook()
    wb.remove(wb.active)  # remove default sheet
    with pdfplumber.open(input_pdf) as pdf:
        for i, page in enumerate(pdf.pages):
            tables = page.extract_tables()
            ws = wb.create_sheet(title=f"Page {i+1}")
            if tables:
                for table in tables:
                    for row in table:
                        ws.append([cell or '' for cell in row])
                    ws.append([])  # blank row between tables
            else:
                # No tables — extract raw text into column A
                text = page.extract_text() or ''
                for line in text.split('\n'):
                    ws.append([line])
    if not wb.sheetnames:
        wb.create_sheet("Sheet1")
    wb.save(output_xlsx)
    print(f"OK: {output_xlsx}")


def encrypt_pdf(input_pdf, output_pdf, user_pwd, owner_pwd):
    import pikepdf
    with pikepdf.open(input_pdf) as pdf:
        pdf.save(output_pdf, encryption=pikepdf.Encryption(
            user=user_pwd, owner=owner_pwd, R=6
        ))
    print(f"OK: {output_pdf}")


def decrypt_pdf(input_pdf, output_pdf, current_pwd):
    import pikepdf
    try:
        # password="" also works here if the PDF only has owner-level
        # restrictions with no open password set.
        with pikepdf.open(input_pdf, password=current_pwd) as pdf:
            # Saving without an `encryption=` argument strips protection entirely.
            pdf.save(output_pdf)
    except pikepdf.PasswordError:
        print("Error: Incorrect password.", file=sys.stderr)
        sys.exit(1)
    print(f"OK: {output_pdf}")


# ══════════════════════════════════════════════════════════════
# EDIT TEXT + REDACT — both built on PyMuPDF (fitz), because its
# redaction API (add_redact_annot + apply_redactions) genuinely strips
# content from the page's data. This is the fix for the old client-side
# Redact tool, which only ever painted a box over content — the text
# was still there underneath, extractable by anyone who knew to look.
# ══════════════════════════════════════════════════════════════

def extract_text_spans(input_pdf, output_json):
    """Flatten every text span on every page into a simple list the
    frontend can turn into clickable overlay boxes. Span-level (not
    block/paragraph-level) granularity matches "click a line to edit it"
    better than a whole paragraph at once."""
    import fitz
    doc = fitz.open(input_pdf)
    pages_out = []
    for pno in range(len(doc)):
        page = doc[pno]
        raw = page.get_text("dict")
        spans_out = []
        for block in raw.get("blocks", []):
            if block.get("type") != 0:  # skip image blocks
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span.get("text", "")
                    if not text.strip():
                        continue
                    spans_out.append({
                        "bbox":  list(span["bbox"]),  # [x0, y0, x1, y1], top-down, same convention pdf.js uses
                        "text":  text,
                        "font":  span.get("font", ""),
                        "size":  span.get("size", 12),
                        "color": span.get("color", 0),  # packed int RGB
                    })
        pages_out.append({
            "pageIndex": pno,
            "width":  page.rect.width,
            "height": page.rect.height,
            "spans":  spans_out,
        })
    doc.close()
    with open(output_json, "w", encoding="utf-8") as f:
        json.dump({"pages": pages_out}, f)
    print(f"OK: {output_json}")


def _map_font(font_name):
    """PyMuPDF's built-in fonts only cover Helvetica/Times/Courier
    families (keywords: helv/hebo/heit/hebi, tiro/tibo/tiit/tibi,
    cour/cobo/coit/cobi). Anything else (embedded/subset fonts, Calibri,
    Verdana, etc.) maps to its closest match by weight/style — same
    honest limitation as the client-side vector engine's font handling."""
    fn = (font_name or "").lower()
    bold   = "bold" in fn
    italic = "italic" in fn or "oblique" in fn

    if "courier" in fn or "mono" in fn:
        if bold and italic: return "cobi"
        if bold:             return "cobo"
        if italic:           return "coit"
        return "cour"
    if "times" in fn or "georgia" in fn or "serif" in fn or "roman" in fn:
        if bold and italic: return "tibi"
        if bold:             return "tibo"
        if italic:           return "tiit"
        return "tiro"
    # Default: Helvetica family — closest match for Arial/Calibri/Verdana/unknown
    if bold and italic: return "hebi"
    if bold:             return "hebo"
    if italic:           return "heit"
    return "helv"


def _color_int_to_rgb01(c):
    c = int(c or 0)
    return ((c >> 16 & 255) / 255.0, (c >> 8 & 255) / 255.0, (c & 255) / 255.0)


def _hex_to_rgb01(hex_str):
    hex_str = (hex_str or "#000000").lstrip("#")
    if len(hex_str) == 3:
        hex_str = "".join(ch * 2 for ch in hex_str)
    return _color_int_to_rgb01(int(hex_str, 16))


def _sample_background_color(page, rect, margin=2):
    """Best-effort background color for a text box, sampled BEFORE that
    box is redacted (once redacted, the pixels are already blank, so this
    has to run first). Renders a small region around the box and picks
    the most common pixel color rather than a single point sample, since
    the background dominates the box and a single sampled pixel could
    easily land on a stray bit of ink. Falls back to white on any
    failure — a wrong-but-plausible guess beats a crash."""
    import fitz  # local import — this file scopes fitz per-function so CLI
                 # modes that don't need it (word/excel/encrypt/decrypt) stay light
    try:
        clip = fitz.Rect(rect.x0 - margin, rect.y0 - margin, rect.x1 + margin, rect.y1 + margin) & page.rect
        if clip.is_empty:
            return (1, 1, 1)
        pix = page.get_pixmap(clip=clip, dpi=72)
        samples, n = pix.samples, pix.n
        total_px = pix.width * pix.height
        if total_px == 0:
            return (1, 1, 1)
        step = max(1, total_px // 400)  # cap sampling cost on larger boxes
        from collections import Counter
        counts = Counter()
        for i in range(0, len(samples) - n + 1, n * step):
            counts[(samples[i], samples[i + 1], samples[i + 2])] += 1
        if not counts:
            return (1, 1, 1)
        (r, g, b), _ = counts.most_common(1)[0]
        return (r / 255.0, g / 255.0, b / 255.0)
    except Exception:
        return (1, 1, 1)


def _font_descender_fraction(fontname):
    """Real per-font descender (fraction of 1 em, e.g. Helvetica ≈ -0.207)
    for accurate baseline placement, instead of one guessed constant that
    doesn't account for how fonts actually differ."""
    import fitz
    try:
        return abs(fitz.Font(fontname).descender)
    except Exception:
        return 0.2  # reasonable generic fallback if metrics aren't available


def apply_text_edits(input_pdf, output_pdf, edits_json_path):
    """Each edit genuinely removes the old text (via real redaction, not
    a box painted on top) and draws the replacement in its place. No
    reflow: if the new text is wider than the original box, font size
    auto-shrinks down to a floor of 60% of the original size, then clips
    — the same documented behavior as every other "quick edit" PDF tool.
    The redacted area is filled with the page's own sampled background
    color (not hardcoded white), and the replacement's baseline uses the
    actual font's descender metric rather than a flat approximation."""
    import fitz
    with open(edits_json_path, "r", encoding="utf-8") as f:
        edits = json.load(f)

    doc = fitz.open(input_pdf)
    by_page = {}
    for e in edits:
        by_page.setdefault(int(e["page"]), []).append(e)

    for pno, page_edits in by_page.items():
        page = doc[pno]

        # Sample every edit's background BEFORE any redaction touches this
        # page — order matters, once apply_redactions() runs, the "before"
        # pixels are gone for every box on the page, not just the one that
        # triggered it.
        bg_fills = []
        for e in page_edits:
            rect = fitz.Rect(*e["bbox"])
            bg_fills.append(_sample_background_color(page, rect))
            page.add_redact_annot(rect, fill=bg_fills[-1])
        page.apply_redactions()

        for e, bg in zip(page_edits, bg_fills):
            new_text = (e.get("newText") or "").strip()
            if not new_text:
                continue
            rect     = fitz.Rect(*e["bbox"])
            fontname = _map_font(e.get("font", ""))
            color    = _color_int_to_rgb01(e.get("color", 0))
            size     = float(e.get("size", 12)) or 12.0
            min_size = max(4.0, size * 0.6)

            fit_size = size
            while fit_size > min_size:
                tw = fitz.get_text_length(new_text, fontname=fontname, fontsize=fit_size)
                if tw <= rect.width:
                    break
                fit_size -= 0.5

            # insert_text() draws at an exact baseline point rather than
            # trying to "fit" into a box — insert_textbox() was used here
            # originally, but it silently draws NOTHING when it judges the
            # text won't cleanly fit, which is exactly what was happening:
            # PyMuPDF's span bboxes are cropped tight to the glyph ink with
            # no line-height padding, so insert_textbox kept rejecting
            # perfectly reasonable single-line replacements.
            baseline_y = rect.y1 - _font_descender_fraction(fontname) * fit_size
            page.insert_text((rect.x0, baseline_y), new_text, fontsize=fit_size, fontname=fontname, color=color)

    doc.save(output_pdf)
    doc.close()
    print(f"OK: {output_pdf}")


def redact_apply(input_pdf, output_pdf, redactions_json_path):
    """TRUE redaction — genuinely strips content in each box, then fills
    it with the requested solid color. This replaces the old client-side
    Redact tool, which only ever painted a box over content on a canvas;
    the original text was still present in the exported PDF underneath
    it, extractable by anyone who selected it. This does not have that
    problem — apply_redactions() removes the underlying content stream
    data in the box, not just its visual appearance."""
    import fitz
    with open(redactions_json_path, "r", encoding="utf-8") as f:
        redactions = json.load(f)

    doc = fitz.open(input_pdf)
    by_page = {}
    for r in redactions:
        by_page.setdefault(int(r["page"]), []).append(r)

    for pno, page_reds in by_page.items():
        page = doc[pno]
        for r in page_reds:
            fill = _hex_to_rgb01(r.get("color", "#000000"))
            page.add_redact_annot(fitz.Rect(*r["bbox"]), fill=fill)
        page.apply_redactions()

    doc.save(output_pdf)
    doc.close()
    print(f"OK: {output_pdf}")


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: convert.py <mode> <input.pdf> <out> [extra args]", file=sys.stderr)
        sys.exit(1)
    mode, inp, out = sys.argv[1], sys.argv[2], sys.argv[3]
    if not os.path.exists(inp):
        print(f"Input file not found: {inp}", file=sys.stderr)
        sys.exit(1)
    try:
        if mode == 'word':
            to_word(inp, out)
        elif mode == 'excel':
            to_excel(inp, out)
        elif mode == 'encrypt':
            u = sys.argv[4] if len(sys.argv) > 4 else ''
            o = sys.argv[5] if len(sys.argv) > 5 else u
            encrypt_pdf(inp, out, u, o)
        elif mode == 'decrypt':
            pwd = sys.argv[4] if len(sys.argv) > 4 else ''
            decrypt_pdf(inp, out, pwd)
        elif mode == 'extract-text':
            extract_text_spans(inp, out)
        elif mode == 'apply-text-edits':
            edits_path = sys.argv[4]
            apply_text_edits(inp, out, edits_path)
        elif mode == 'redact':
            redactions_path = sys.argv[4]
            redact_apply(inp, out, redactions_path)
        else:
            print(f"Unknown mode: {mode}", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
