#!/usr/bin/env python3
"""
convert.py — PDF conversion helper
Usage:
  python3 convert.py word  input.pdf output.docx
  python3 convert.py excel input.pdf output.xlsx
"""
import sys
import os

def to_word(input_pdf, output_docx):
    from pdf2docx import Converter
    cv = Converter(input_pdf)
    cv.convert(output_docx, start=0, end=None)
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

if __name__ == '__main__':
    if len(sys.argv) != 4:
        print("Usage: convert.py <word|excel> <input.pdf> <output>", file=sys.stderr)
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
        else:
            print(f"Unknown mode: {mode}", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
