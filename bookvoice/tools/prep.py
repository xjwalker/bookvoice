#!/usr/bin/env python3
"""
BookVoice PDF Preprocessor

Analyzes scanned PDF books (including two-page spreads) and extracts
text in correct reading order with metadata. Outputs a .bookvoice
directory that the app can import directly.

Usage:
    python3 prep.py /path/to/book.pdf
    python3 prep.py /path/to/book.pdf -o /custom/output/
    python3 prep.py /path/to/book.pdf --verbose
"""

import argparse
import json
import os
import re
import sys
import statistics
from collections import Counter
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF
from langdetect import detect as detect_language


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class LogicalPage:
    logical_page: int
    pdf_page: int          # 0-indexed
    side: str              # "left", "right", or "full"
    text: str
    page_number: Optional[int] = None   # printed page number if detected
    is_chapter_start: bool = False
    chapter_title: Optional[str] = None

@dataclass
class Chapter:
    number: Optional[int]
    title: str
    logical_page: int

@dataclass
class Metadata:
    version: int = 1
    source: str = ""
    title: str = ""
    author: str = ""
    language: str = ""
    total_logical_pages: int = 0
    total_pdf_pages: int = 0
    chapters: list = field(default_factory=list)
    spread_info: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# PDF Analysis
# ---------------------------------------------------------------------------

def analyze_page_sizes(doc: fitz.Document) -> dict:
    """Classify pages as single or spread based on width clustering."""
    widths = []
    for i in range(doc.page_count):
        widths.append(round(doc[i].rect.width))

    if not widths:
        return {"single_pages": [], "spread_pages": [], "threshold": 0}

    width_counts = Counter(widths)
    unique_widths = sorted(width_counts.keys())

    if len(unique_widths) == 1:
        # All same width — assume all single or all spread based on aspect ratio
        page = doc[0]
        ratio = page.rect.width / page.rect.height
        if ratio > 1.3:
            return {
                "single_pages": [],
                "spread_pages": list(range(doc.page_count)),
                "threshold": unique_widths[0] - 1,
            }
        else:
            return {
                "single_pages": list(range(doc.page_count)),
                "spread_pages": [],
                "threshold": unique_widths[0] + 1,
            }

    # Find the natural split between narrow (single) and wide (spread) pages
    # Use the midpoint between the two most common widths
    sorted_by_freq = sorted(width_counts.items(), key=lambda x: -x[1])
    if len(sorted_by_freq) >= 2:
        w1, w2 = sorted(w for w, _ in sorted_by_freq[:2])
        threshold = (w1 + w2) / 2
    else:
        threshold = unique_widths[0] + 50

    single_pages = [i for i in range(doc.page_count) if widths[i] < threshold]
    spread_pages = [i for i in range(doc.page_count) if widths[i] >= threshold]

    return {
        "single_pages": single_pages,
        "spread_pages": spread_pages,
        "threshold": threshold,
    }


def detect_gutter(doc: fitz.Document, spread_pages: list[int]) -> float:
    """
    Find the x-coordinate of the gutter (gap between left and right pages)
    by analyzing text span positions across spread pages.
    """
    if not spread_pages:
        return 0.0

    # Sample up to 20 evenly-spaced spread pages
    sample_size = min(20, len(spread_pages))
    step = max(1, len(spread_pages) // sample_size)
    sample = spread_pages[::step][:sample_size]

    all_x0 = []
    page_width = doc[spread_pages[0]].rect.width

    for pg_idx in sample:
        page = doc[pg_idx]
        blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]
        for block in blocks:
            if "lines" not in block:
                continue
            for line in block["lines"]:
                x0 = line["bbox"][0]
                all_x0.append(x0)

    if not all_x0:
        return page_width / 2

    # Build histogram of x0 positions (10px buckets)
    bucket_size = 10
    buckets = Counter()
    for x in all_x0:
        buckets[int(x / bucket_size)] += 1

    # Look for the largest gap in the center 40% of the page
    center_start = int(page_width * 0.3 / bucket_size)
    center_end = int(page_width * 0.7 / bucket_size)

    # Find the bucket range in the center with the lowest density
    min_bucket = center_start
    min_count = float("inf")
    for b in range(center_start, center_end + 1):
        count = buckets.get(b, 0)
        if count < min_count:
            min_count = count
            min_bucket = b

    # Expand outward to find the full gap
    gap_start = min_bucket
    gap_end = min_bucket
    while gap_start > center_start and buckets.get(gap_start - 1, 0) <= min_count + 1:
        gap_start -= 1
    while gap_end < center_end and buckets.get(gap_end + 1, 0) <= min_count + 1:
        gap_end += 1

    gutter_x = (gap_start + gap_end) / 2 * bucket_size + bucket_size / 2
    return gutter_x


# ---------------------------------------------------------------------------
# Text Extraction
# ---------------------------------------------------------------------------

@dataclass
class TextLine:
    x0: float
    y0: float
    y1: float
    text: str
    font_size: float = 0.0
    is_bold: bool = False


def extract_lines(page: fitz.Page) -> list[TextLine]:
    """Extract all text lines with position info from a page."""
    lines = []
    blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]
    for block in blocks:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            spans = line["spans"]
            if not spans:
                continue
            text = "".join(s["text"] for s in spans).strip()
            if not text:
                continue
            avg_size = sum(s["size"] for s in spans) / len(spans)
            is_bold = any("Bold" in (s.get("font", "") or "") or
                         "bold" in (s.get("font", "") or "").lower()
                         for s in spans)
            lines.append(TextLine(
                x0=line["bbox"][0],
                y0=line["bbox"][1],
                y1=line["bbox"][3],
                text=text,
                font_size=avg_size,
                is_bold=is_bold,
            ))
    return lines


def detect_header_footer(lines: list[TextLine], page_height: float) -> tuple[list[TextLine], list[TextLine]]:
    """
    Separate header/footer lines from body lines.
    Returns (body_lines, hf_lines).
    """
    header_zone = page_height * 0.10
    footer_zone = page_height * 0.93
    body = []
    hf = []
    for line in lines:
        if line.y0 < header_zone or line.y0 > footer_zone:
            hf.append(line)
        else:
            body.append(line)
    return body, hf


def extract_page_number(hf_lines: list[TextLine]) -> Optional[int]:
    """Try to extract a printed page number from header/footer lines."""
    for line in hf_lines:
        text = line.text.strip()
        if text.isdigit() and len(text) <= 4:
            return int(text)
    return None


def lines_to_paragraphs(lines: list[TextLine]) -> str:
    """Join lines into paragraphs, detecting paragraph breaks by y-gaps."""
    if not lines:
        return ""

    sorted_lines = sorted(lines, key=lambda l: l.y0)

    # Estimate typical line spacing
    gaps = []
    for i in range(1, len(sorted_lines)):
        gap = sorted_lines[i].y0 - sorted_lines[i - 1].y1
        gaps.append(gap)

    if gaps:
        median_gap = statistics.median(gaps)
        para_threshold = median_gap + max(median_gap * 0.8, 4.0)
    else:
        para_threshold = 999

    paragraphs = []
    current = [sorted_lines[0].text]

    for i in range(1, len(sorted_lines)):
        gap = sorted_lines[i].y0 - sorted_lines[i - 1].y1
        if gap > para_threshold:
            paragraphs.append(" ".join(current))
            current = [sorted_lines[i].text]
        else:
            current.append(sorted_lines[i].text)

    if current:
        paragraphs.append(" ".join(current))

    return "\n\n".join(paragraphs)


def extract_spread_page(page: fitz.Page, gutter_x: float, page_height: float) -> tuple[str, Optional[int], str, Optional[int]]:
    """
    Extract text from a spread page, returning (left_text, left_pagenum, right_text, right_pagenum).
    """
    all_lines = extract_lines(page)
    body_lines, hf_lines = detect_header_footer(all_lines, page_height)

    left_body = [l for l in body_lines if l.x0 < gutter_x]
    right_body = [l for l in body_lines if l.x0 >= gutter_x]

    left_hf = [l for l in hf_lines if l.x0 < gutter_x]
    right_hf = [l for l in hf_lines if l.x0 >= gutter_x]

    left_text = lines_to_paragraphs(left_body)
    right_text = lines_to_paragraphs(right_body)

    left_pagenum = extract_page_number(left_hf)
    right_pagenum = extract_page_number(right_hf)

    return left_text, left_pagenum, right_text, right_pagenum


def extract_single_page(page: fitz.Page, page_height: float) -> tuple[str, Optional[int]]:
    """Extract text from a single (non-spread) page."""
    all_lines = extract_lines(page)
    body_lines, hf_lines = detect_header_footer(all_lines, page_height)
    text = lines_to_paragraphs(body_lines)
    pagenum = extract_page_number(hf_lines)
    return text, pagenum


# ---------------------------------------------------------------------------
# Chapter Detection
# ---------------------------------------------------------------------------

def filter_front_matter(pages: list[LogicalPage]) -> list[LogicalPage]:
    """
    Remove noisy front-matter pages (cover, copyright, TOC) that appear
    before the first real chapter. Pages with low alpha ratio or high
    noise character counts are dropped.
    """
    # Find the first chapter start
    first_chapter_idx = None
    for i, lp in enumerate(pages):
        text = lp.text.strip()[:300]
        for pattern in CHAPTER_PATTERNS:
            if pattern.search(text):
                first_chapter_idx = i
                break
        if first_chapter_idx is not None:
            break

    if first_chapter_idx is None:
        return pages  # no chapters found, keep everything

    # Keep all pages from the first chapter onward.
    # For pages before the first chapter, only keep those with clean text
    # (e.g. a preface or foreword), skip garbage pages.
    clean_front = []
    for lp in pages[:first_chapter_idx]:
        text = lp.text.strip()
        if not text or len(text) < 50:
            continue
        alpha_ratio = sum(1 for c in text if c.isalpha()) / max(len(text), 1)
        # Skip pages with lots of noise (OCR artifacts, dot leaders in TOC)
        noise_chars = sum(1 for c in text if c in '•·○°~<>[]{}|\\')
        noise_ratio = noise_chars / max(len(text), 1)
        has_ocr_noise = any(c in text for c in '~<>[]{}|')
        # Count isolated "o" which are misrecognized dots
        isolated_o = text.count(' o ') + text.count(' o\n')
        if alpha_ratio < 0.7 or noise_ratio > 0.03 or isolated_o > 5 or has_ocr_noise:
            continue
        clean_front.append(lp)

    return clean_front + pages[first_chapter_idx:]


CHAPTER_PATTERNS = [
    # Spanish
    re.compile(r"^CAP[ÍI]TULO\s+(\d+)", re.IGNORECASE | re.MULTILINE),
    # English
    re.compile(r"^CHAPTER\s+(\d+)", re.IGNORECASE | re.MULTILINE),
]

PART_PATTERNS = [
    re.compile(r"(PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA)\s+PARTE", re.IGNORECASE),
    re.compile(r"(FIRST|SECOND|THIRD|FOURTH|FIFTH)\s+PART", re.IGNORECASE),
    re.compile(r"PART\s+(I{1,3}|IV|V|VI{0,3})\b", re.IGNORECASE),
]


def detect_chapters(pages: list[LogicalPage]) -> list[Chapter]:
    """Scan all logical pages for chapter headings."""
    chapters = []

    for lp in pages:
        text = lp.text.strip()
        if not text:
            continue

        # Check for chapter patterns — only match if near the start of the page
        # (real chapter headings appear at the top, not mid-paragraph)
        first_300 = text[:300]
        for pattern in CHAPTER_PATTERNS:
            match = pattern.search(first_300)
            if match:
                num = int(match.group(1))
                # Grab the title: lines immediately after "CAPITULO N" until a paragraph break
                after_match = text[match.end():].strip()
                # Split on double-newline to get just the title block
                title_block = after_match.split("\n\n")[0].strip()
                # Take first 1-2 short lines as the title
                title_lines = [l.strip() for l in title_block.split("\n") if l.strip()]
                title = " ".join(title_lines[:2]) if title_lines else ""
                if len(title) > 80:
                    title = title[:80]

                chapters.append(Chapter(
                    number=num,
                    title=title,
                    logical_page=lp.logical_page,
                ))
                lp.is_chapter_start = True
                lp.chapter_title = f"Capítulo {num}: {title}" if title else f"Capítulo {num}"
                break

    return chapters


# ---------------------------------------------------------------------------
# Metadata Extraction
# ---------------------------------------------------------------------------

def parse_title_author_from_filename(filename: str) -> tuple[str, str]:
    """Try to extract author and title from 'Author - Title.pdf' pattern."""
    stem = Path(filename).stem
    if " - " in stem:
        parts = stem.split(" - ", 1)
        return parts[1].strip(), parts[0].strip()
    return stem, ""


def detect_book_language(pages: list[LogicalPage]) -> str:
    """Detect language from a sample of page text."""
    sample = ""
    for lp in pages:
        if lp.text.strip():
            sample += lp.text + " "
        if len(sample) > 3000:
            break

    if len(sample) < 50:
        return "en"

    try:
        return detect_language(sample)
    except Exception:
        return "en"


# ---------------------------------------------------------------------------
# Main Pipeline
# ---------------------------------------------------------------------------

def process_pdf(pdf_path: str, verbose: bool = False) -> tuple[Metadata, list[LogicalPage]]:
    """Full preprocessing pipeline for a PDF file."""
    doc = fitz.open(pdf_path)
    filename = os.path.basename(pdf_path)

    if verbose:
        print(f"Opened: {filename} ({doc.page_count} pages)")

    # 1. Analyze page sizes
    size_info = analyze_page_sizes(doc)
    single_pages = size_info["single_pages"]
    spread_pages = size_info["spread_pages"]

    if verbose:
        print(f"Single pages: {len(single_pages)}, Spread pages: {len(spread_pages)}")

    # 2. Detect gutter
    gutter_x = detect_gutter(doc, spread_pages)
    if verbose:
        print(f"Gutter detected at x={gutter_x:.1f}")

    # 3. Extract text in reading order
    logical_pages: list[LogicalPage] = []
    lp_idx = 0

    for pdf_pg in range(doc.page_count):
        page = doc[pdf_pg]
        page_height = page.rect.height

        if pdf_pg in spread_pages:
            left_text, left_pn, right_text, right_pn = extract_spread_page(page, gutter_x, page_height)

            if left_text.strip():
                logical_pages.append(LogicalPage(
                    logical_page=lp_idx,
                    pdf_page=pdf_pg,
                    side="left",
                    text=left_text,
                    page_number=left_pn,
                ))
                lp_idx += 1

            if right_text.strip():
                logical_pages.append(LogicalPage(
                    logical_page=lp_idx,
                    pdf_page=pdf_pg,
                    side="right",
                    text=right_text,
                    page_number=right_pn,
                ))
                lp_idx += 1
        else:
            text, pn = extract_single_page(page, page_height)
            if text.strip():
                logical_pages.append(LogicalPage(
                    logical_page=lp_idx,
                    pdf_page=pdf_pg,
                    side="full",
                    text=text,
                    page_number=pn,
                ))
                lp_idx += 1

    if verbose:
        print(f"Extracted {len(logical_pages)} logical pages")

    # 3b. Filter out noisy front-matter pages (cover, copyright, TOC)
    #     These appear before the first chapter and often have OCR garbage.
    logical_pages = filter_front_matter(logical_pages)
    # Re-index logical pages
    for i, lp in enumerate(logical_pages):
        lp.logical_page = i

    # 4. Detect chapters
    chapters = detect_chapters(logical_pages)
    if verbose:
        print(f"Found {len(chapters)} chapters")
        for ch in chapters:
            print(f"  Ch {ch.number}: {ch.title} (page {ch.logical_page})")

    # 5. Detect language
    language = detect_book_language(logical_pages)
    if verbose:
        print(f"Language: {language}")

    # 6. Build metadata
    title, author = parse_title_author_from_filename(filename)

    # Try to refine title from the first few pages — look for short, clean text
    for lp in logical_pages[:10]:
        text = lp.text.strip()
        if not text or len(text) > 200:
            continue
        alpha_ratio = sum(1 for c in text if c.isalpha()) / max(len(text), 1)
        if alpha_ratio < 0.85:
            continue
        # Must be purely clean text with no OCR noise characters
        if any(c in text for c in '~<>[]{}|\\'):
            continue
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        if lines and len(lines[0]) < 80:
            title = lines[0]
            break

    metadata = Metadata(
        source=filename,
        title=title,
        author=author,
        language=language,
        total_logical_pages=len(logical_pages),
        total_pdf_pages=doc.page_count,
        chapters=[asdict(ch) for ch in chapters],
        spread_info={
            "single_pages": len(single_pages),
            "spread_pages": len(spread_pages),
            "gutter_x": round(gutter_x, 1),
        },
    )

    doc.close()
    return metadata, logical_pages


def write_output(metadata: Metadata, pages: list[LogicalPage], output_dir: str):
    """Write the preprocessed output to disk."""
    os.makedirs(output_dir, exist_ok=True)

    pages_data = []
    for lp in pages:
        pages_data.append({
            "logical_page": lp.logical_page,
            "pdf_page": lp.pdf_page,
            "side": lp.side,
            "text": lp.text,
            "page_number": lp.page_number,
            "is_chapter_start": lp.is_chapter_start,
            "chapter_title": lp.chapter_title,
        })

    # metadata.json
    with open(os.path.join(output_dir, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(asdict(metadata), f, ensure_ascii=False, indent=2)

    # text.json
    with open(os.path.join(output_dir, "text.json"), "w", encoding="utf-8") as f:
        json.dump(pages_data, f, ensure_ascii=False, indent=2)

    # Single bundled .bookvoice.json — importable directly by the app via file picker
    bundle = {**asdict(metadata), "pages": pages_data}
    bundle_path = output_dir.rstrip("/") + ".json"
    with open(bundle_path, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False)

    # full_text.txt — concatenated for easy review
    with open(os.path.join(output_dir, "full_text.txt"), "w", encoding="utf-8") as f:
        for lp in pages:
            if lp.page_number:
                f.write(f"\n--- Page {lp.page_number} (pdf:{lp.pdf_page+1} {lp.side}) ---\n\n")
            else:
                f.write(f"\n--- Logical page {lp.logical_page} (pdf:{lp.pdf_page+1} {lp.side}) ---\n\n")
            f.write(lp.text)
            f.write("\n")


def main():
    parser = argparse.ArgumentParser(
        description="BookVoice PDF Preprocessor — extract text and metadata from scanned book PDFs"
    )
    parser.add_argument("pdf", help="Path to PDF file")
    parser.add_argument("-o", "--output", help="Output directory (default: <pdf_name>.bookvoice/)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Print progress info")

    args = parser.parse_args()

    pdf_path = os.path.abspath(args.pdf)
    if not os.path.isfile(pdf_path):
        print(f"Error: file not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    if args.output:
        output_dir = os.path.abspath(args.output)
    else:
        stem = Path(pdf_path).stem
        output_dir = os.path.join(os.path.dirname(pdf_path), f"{stem}.bookvoice")

    if args.verbose:
        print(f"Output: {output_dir}")

    metadata, pages = process_pdf(pdf_path, verbose=args.verbose)
    write_output(metadata, pages, output_dir)

    print(f"\nDone! {metadata.total_logical_pages} pages extracted.")
    print(f"  Title:    {metadata.title}")
    print(f"  Author:   {metadata.author}")
    print(f"  Language:  {metadata.language}")
    print(f"  Chapters: {len(metadata.chapters)}")
    print(f"  Output:   {output_dir}")


if __name__ == "__main__":
    main()
