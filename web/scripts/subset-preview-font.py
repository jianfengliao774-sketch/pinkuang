"""Subset the local preview's CJK typeface. Supply an upstream NotoSansSC variable TTF.
Usage: python scripts/subset-preview-font.py /path/to/NotoSansSC.ttf
Requires fonttools and brotli. Regenerate after adding Chinese UI text.
"""
from pathlib import Path
from fontTools import subset
import sys
root=Path(__file__).resolve().parents[1]
text=''.join(p.read_text() for folder in ['app','components','lib'] for p in (root/folder).rglob('*') if p.suffix in ['.jsx','.js','.css'])
options=subset.Options()
options.flavor='woff2'
font=subset.load_font(sys.argv[1],options)
subsetter=subset.Subsetter(options=options)
subsetter.populate(text=''.join(sorted(set(text)))+'0123456789')
subsetter.subset(font)
subset.save_font(font,str(root/'public/fonts/noto-sans-sc-preview.woff2'),options)
