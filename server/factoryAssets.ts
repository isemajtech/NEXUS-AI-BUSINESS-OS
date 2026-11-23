import PDFDocument from 'pdfkit';
import { GoogleGenAI, Type } from '@google/genai';

export interface BuildPdfInput {
  title: string;
  description?: string;
  businessName?: string;
  deliverableFormat?: string;
  price?: number;
  billingType?: string;
  deliverableContent: string;
}

export interface BuildPdfOutput {
  buffer: Buffer;
  pageCount: number;
  filename: string;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .trim();
}

function slugifyFilename(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `${base || 'digital-product'}.pdf`;
}

export async function buildProductPdfBuffer(input: BuildPdfInput): Promise<BuildPdfOutput> {
  const title = (input.title || 'Digital Product Deliverable').trim();
  const description = (input.description || '').trim();
  const businessName = (input.businessName || 'Personal AI Business OS').trim();
  const formatLabel = (input.deliverableFormat || 'pdf_guide').replace(/_/g, ' ').toUpperCase();
  const priceText =
    typeof input.price === 'number' && !Number.isNaN(input.price)
      ? `$${input.price.toFixed(2)} ${(input.billingType || 'one_time').replace(/_/g, ' ')}`
      : 'Digital Edition';

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    bufferPages: true,
    info: {
      Title: title,
      Author: businessName,
      Subject: description || `${title} — Digital Deliverable`,
      Creator: 'Digital Product Factory',
    },
  });

  let totalPages = 1;
  const chunks: Buffer[] = [];
  const bufferPromise = new Promise<BuildPdfOutput>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => {
      resolve({
        buffer: Buffer.concat(chunks),
        pageCount: totalPages,
        filename: slugifyFilename(title),
      });
    });
  });

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const contentWidth = pageWidth - doc.page.margins.left - doc.page.margins.right;

  // --- COVER PAGE ---
  doc.rect(0, 0, pageWidth, pageHeight).fill('#0b1120');
  doc.rect(0, 0, 14, pageHeight).fill('#06b6d4');
  doc.rect(56, 86, 120, 4).fill('#3b82f6');

  doc
    .fillColor('#38bdf8')
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(`${businessName.toUpperCase()}  ·  ${formatLabel}`, 56, 108, {
      width: contentWidth,
      characterSpacing: 1.2,
    });

  doc
    .fillColor('#f8fafc')
    .font('Helvetica-Bold')
    .fontSize(30)
    .text(title, 56, 148, {
      width: contentWidth,
      lineGap: 6,
    });

  if (description) {
    doc.moveDown(0.8);
    doc
      .fillColor('#cbd5e1')
      .font('Helvetica')
      .fontSize(13)
      .text(description, 56, doc.y, {
        width: contentWidth,
        lineGap: 4,
      });
  }

  // Cover metadata card
  const cardTop = Math.max(doc.y + 36, pageHeight - 190);
  doc.roundedRect(56, cardTop, contentWidth, 92, 8).fillAndStroke('#111b2e', '#1e293b');
  doc
    .fillColor('#94a3b8')
    .font('Helvetica-Bold')
    .fontSize(9)
    .text('DIGITAL DELIVERABLE PACKAGE', 74, cardTop + 18, { characterSpacing: 0.8 });
  doc
    .fillColor('#f8fafc')
    .font('Helvetica-Bold')
    .fontSize(13)
    .text(`${formatLabel}  ·  ${priceText}`, 74, cardTop + 36);
  doc
    .fillColor('#64748b')
    .font('Helvetica')
    .fontSize(9.5)
    .text(
      `Prepared by ${businessName} · Licensed Digital Asset (${new Date().toISOString().split('T')[0]})`,
      74,
      cardTop + 60,
      { width: contentWidth - 36 }
    );

  // --- BODY CONTENT ---
  doc.addPage();
  doc.fillColor('#0f172a');

  const ensureSpace = (minHeight: number) => {
    if (doc.y + minHeight > pageHeight - doc.page.margins.bottom - 20) {
      doc.addPage();
    }
  };

  const lines = (input.deliverableContent || '').replace(/\r\n/g, '\n').split('\n');
  let tableRows: string[][] = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const cols = Math.max(...tableRows.map((r) => r.length));
    const colWidth = contentWidth / Math.max(cols, 1);

    doc.moveDown(0.3);
    for (let rIdx = 0; rIdx < tableRows.length; rIdx++) {
      const row = tableRows[rIdx];
      const isHeader = rIdx === 0;
      const cellHeights = row.map((cell) =>
        doc
          .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(9)
          .heightOfString(stripInlineMarkdown(cell), { width: colWidth - 10 })
      );
      const rowHeight = Math.max(20, ...cellHeights) + 10;
      ensureSpace(rowHeight + 6);

      const startY = doc.y;
      const startX = doc.page.margins.left;

      for (let cIdx = 0; cIdx < cols; cIdx++) {
        const cellX = startX + cIdx * colWidth;
        doc
          .rect(cellX, startY, colWidth, rowHeight)
          .fillAndStroke(isHeader ? '#e2e8f0' : rIdx % 2 === 1 ? '#ffffff' : '#f8fafc', '#cbd5e1');
        doc
          .fillColor('#0f172a')
          .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(9)
          .text(stripInlineMarkdown(row[cIdx] || ''), cellX + 5, startY + 5, {
            width: colWidth - 10,
          });
      }
      doc.y = startY + rowHeight;
    }
    doc.moveDown(0.5);
    tableRows = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (/^\|[\s|:-]+\|$/.test(trimmed)) {
        continue;
      }
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      tableRows.push(cells);
      continue;
    } else if (tableRows.length > 0) {
      flushTable();
    }

    if (trimmed === '') {
      doc.moveDown(0.35);
      continue;
    }

    if (trimmed === '---' || trimmed === '***') {
      ensureSpace(16);
      const y = doc.y + 4;
      doc
        .strokeColor('#cbd5e1')
        .lineWidth(1)
        .moveTo(doc.page.margins.left, y)
        .lineTo(pageWidth - doc.page.margins.right, y)
        .stroke();
      doc.y = y + 10;
      continue;
    }

    if (trimmed.startsWith('# ')) {
      ensureSpace(44);
      doc.moveDown(0.3);
      doc
        .fillColor('#0f172a')
        .font('Helvetica-Bold')
        .fontSize(19)
        .text(stripInlineMarkdown(trimmed.slice(2)), { width: contentWidth });
      const ruleY = doc.y + 3;
      doc
        .strokeColor('#0f172a')
        .lineWidth(1.5)
        .moveTo(doc.page.margins.left, ruleY)
        .lineTo(pageWidth - doc.page.margins.right, ruleY)
        .stroke();
      doc.y = ruleY + 8;
      continue;
    }

    if (trimmed.startsWith('## ')) {
      ensureSpace(36);
      doc.moveDown(0.45);
      doc
        .fillColor('#1e293b')
        .font('Helvetica-Bold')
        .fontSize(14)
        .text(stripInlineMarkdown(trimmed.slice(3)), { width: contentWidth });
      const ruleY = doc.y + 2;
      doc
        .strokeColor('#e2e8f0')
        .lineWidth(1)
        .moveTo(doc.page.margins.left, ruleY)
        .lineTo(pageWidth - doc.page.margins.right, ruleY)
        .stroke();
      doc.y = ruleY + 6;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      ensureSpace(26);
      doc.moveDown(0.25);
      doc
        .fillColor('#334155')
        .font('Helvetica-Bold')
        .fontSize(11.5)
        .text(stripInlineMarkdown(trimmed.slice(4)), { width: contentWidth });
      doc.moveDown(0.15);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const isNumbered = /^\d+\.\s+/.test(trimmed);
      const marker = isNumbered ? trimmed.match(/^\d+\./)?.[0] || '•' : '•';
      const itemBody = stripInlineMarkdown(trimmed.replace(/^([-*]|\d+\.)\s+/, ''));
      const itemHeight = doc.font('Helvetica').fontSize(10.5).heightOfString(itemBody, {
        width: contentWidth - 18,
      });
      ensureSpace(itemHeight + 6);
      const rowY = doc.y;
      doc
        .fillColor('#0284c7')
        .font('Helvetica-Bold')
        .fontSize(10.5)
        .text(marker, doc.page.margins.left + 2, rowY, { width: 16 });
      doc
        .fillColor('#1e293b')
        .font('Helvetica')
        .fontSize(10.5)
        .text(itemBody, doc.page.margins.left + 18, rowY, {
          width: contentWidth - 18,
          lineGap: 2.5,
        });
      doc.moveDown(0.15);
      continue;
    }

    const cleanParagraph = stripInlineMarkdown(trimmed);
    const paraHeight = doc.font('Helvetica').fontSize(10.5).heightOfString(cleanParagraph, {
      width: contentWidth,
    });
    ensureSpace(paraHeight + 6);
    doc
      .fillColor('#1e293b')
      .font('Helvetica')
      .fontSize(10.5)
      .text(cleanParagraph, doc.page.margins.left, doc.y, {
        width: contentWidth,
        lineGap: 3,
      });
    doc.moveDown(0.2);
  }

  if (tableRows.length > 0) {
    flushTable();
  }

  // Running header & footer on body pages (skip cover page 0)
  const range = doc.bufferedPageRange();
  totalPages = Math.max(1, range.count);
  for (let i = 1; i < range.count; i++) {
    doc.switchToPage(i);
    doc
      .fillColor('#64748b')
      .font('Helvetica')
      .fontSize(8)
      .text(title, doc.page.margins.left, 26, { width: contentWidth * 0.7, ellipsis: true })
      .text(
        `Page ${i} of ${range.count - 1}`,
        doc.page.margins.left,
        pageHeight - 36,
        { width: contentWidth, align: 'right' }
      );
  }

  doc.end();
  return bufferPromise;
}

export interface CoverArtDirection {
  primaryColor: string;
  accentColor: string;
  surfaceColor: string;
  tagline: string;
  editionBadge: string;
  highlights: string[];
  motif: 'grid' | 'waves' | 'orbits' | 'Prism';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapTextLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= maxCharsPerLine) {
      current += ` ${w}`;
    } else {
      lines.push(current);
      current = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines;
}

function sanitizeHexColor(color: string | undefined, fallback: string): string {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color.trim())) {
    return color.trim();
  }
  return fallback;
}

export interface GenerateCoverInput {
  title: string;
  description?: string;
  businessName?: string;
  productType?: string;
  price?: number;
  geminiKey?: string | null;
}

export interface GenerateCoverOutput {
  svgContent: string;
  coverDataUrl: string;
  mimeType: 'image/svg+xml';
  artDirection: CoverArtDirection;
  modelUsed: string;
}

export async function generateProductCoverSvg(input: GenerateCoverInput): Promise<GenerateCoverOutput> {
  const title = (input.title || 'Digital Product Edition').trim();
  const description = (input.description || 'Actionable systems, templates, and execution playbook.').trim();
  const businessName = (input.businessName || 'Nexus Cloud Technologies').trim();
  const productType = (input.productType || 'digital_download').replace(/_/g, ' ').toUpperCase();

  let art: CoverArtDirection = {
    primaryColor: '#06b6d4',
    accentColor: '#6366f1',
    surfaceColor: '#0b1120',
    tagline: description.slice(0, 110),
    editionBadge: productType,
    highlights: ['Plug-and-Play Framework', 'Verified Workflows', 'Commercial Use Included'],
    motif: 'grid',
  };
  let modelUsed = 'deterministic_editorial_svg';

  if (input.geminiKey) {
    try {
      const ai = new GoogleGenAI({
        apiKey: input.geminiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });
      const prompt = `Design dark-mode editorial cover art direction for a digital product:
Title: "${title}"
Description: "${description}"
Brand: "${businessName}"
Type: "${productType}"

Return crisp dark-surface hex colors (#08101e to #14182b surfaceColor, vivid #primaryColor and #accentColor with high contrast against white text), a 6-10 word editorial tagline, a short 2-word editionBadge, and 3 concise 2-4 word highlight chips.`;

      const models = ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'];
      for (const m of models) {
        try {
          const resp = await ai.models.generateContent({
            model: m,
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  primaryColor: { type: Type.STRING },
                  accentColor: { type: Type.STRING },
                  surfaceColor: { type: Type.STRING },
                  tagline: { type: Type.STRING },
                  editionBadge: { type: Type.STRING },
                  highlights: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  motif: { type: Type.STRING },
                },
              },
            },
          });
          if (resp.text) {
            const parsed = JSON.parse(resp.text);
            art = {
              primaryColor: sanitizeHexColor(parsed.primaryColor, art.primaryColor),
              accentColor: sanitizeHexColor(parsed.accentColor, art.accentColor),
              surfaceColor: sanitizeHexColor(parsed.surfaceColor, art.surfaceColor),
              tagline: String(parsed.tagline || art.tagline).slice(0, 120),
              editionBadge: String(parsed.editionBadge || art.editionBadge).slice(0, 26).toUpperCase(),
              highlights: Array.isArray(parsed.highlights) && parsed.highlights.length > 0
                ? parsed.highlights.slice(0, 3).map((h: any) => String(h).slice(0, 34))
                : art.highlights,
              motif: parsed.motif === 'waves' || parsed.motif === 'orbits' ? parsed.motif : 'grid',
            };
            modelUsed = `${m}_editorial_svg`;
            break;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Fall back cleanly to deterministic editorial direction
    }
  }

  const titleLines = wrapTextLines(title, 20, 4);
  const taglineLines = wrapTextLines(art.tagline, 42, 3);
  const priceBadge = typeof input.price === 'number' ? `$${input.price.toFixed(0)} EDITION` : 'DIGITAL EDITION';

  const motifLayer =
    art.motif === 'waves'
      ? `<path d="M0 980 Q 300 840 600 960 T 1200 920 L 1200 1500 L 0 1500 Z" fill="${art.primaryColor}" opacity="0.14"/>
         <path d="M0 1080 Q 360 950 720 1060 T 1200 1020 L 1200 1500 L 0 1500 Z" fill="${art.accentColor}" opacity="0.18"/>`
      : art.motif === 'orbits'
      ? `<circle cx="960" cy="340" r="290" fill="none" stroke="${art.primaryColor}" stroke-width="2" opacity="0.28"/>
         <circle cx="960" cy="340" r="200" fill="none" stroke="${art.accentColor}" stroke-width="2" stroke-dasharray="10 10" opacity="0.35"/>
         <circle cx="960" cy="340" r="110" fill="${art.primaryColor}" opacity="0.14"/>`
      : `<g opacity="0.16" stroke="${art.primaryColor}" stroke-width="1">
           ${Array.from({ length: 10 })
             .map((_, i) => `<line x1="${i * 120 + 60}" y1="0" x2="${i * 120 + 60}" y2="1500" />`)
             .join('')}
           ${Array.from({ length: 12 })
             .map((_, i) => `<line x1="0" y1="${i * 120 + 80}" x2="1200" y2="${i * 120 + 80}" />`)
             .join('')}
         </g>`;

  const titleSvg = titleLines
    .map(
      (line, idx) =>
        `<text x="96" y="${390 + idx * 88}" fill="#f8fafc" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="72" font-weight="800" letter-spacing="-1.5">${escapeXml(
          line
        )}</text>`
    )
    .join('\n  ');

  const taglineYBase = 390 + titleLines.length * 88 + 36;
  const taglineSvg = taglineLines
    .map(
      (line, idx) =>
        `<text x="96" y="${taglineYBase + idx * 42}" fill="#cbd5e1" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="28" font-weight="400">${escapeXml(
          line
        )}</text>`
    )
    .join('\n  ');

  const chipsSvg = art.highlights
    .slice(0, 3)
    .map((chip, idx) => {
      const y = 1040 + idx * 72;
      return `<g transform="translate(96, ${y})">
        <rect x="0" y="0" width="1008" height="54" rx="12" fill="#131c31" stroke="${art.primaryColor}" stroke-opacity="0.35" stroke-width="1.5"/>
        <circle cx="28" cy="27" r="6" fill="${art.primaryColor}"/>
        <text x="52" y="34" fill="#e2e8f0" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="22" font-weight="600">${escapeXml(
          chip
        )}</text>
      </g>`;
    })
    .join('\n  ');

  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1500" width="1200" height="1500">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${art.surfaceColor}"/>
      <stop offset="100%" stop-color="#060913"/>
    </linearGradient>
    <linearGradient id="accentBar" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${art.primaryColor}"/>
      <stop offset="100%" stop-color="${art.accentColor}"/>
    </linearGradient>
    <radialGradient id="glow" cx="78%" cy="22%" r="55%">
      <stop offset="0%" stop-color="${art.accentColor}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${art.surfaceColor}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="1500" fill="url(#bgGrad)"/>
  <rect width="1200" height="1500" fill="url(#glow)"/>
  ${motifLayer}
  <rect x="0" y="0" width="22" height="1500" fill="url(#accentBar)"/>

  <rect x="96" y="128" width="140" height="6" rx="3" fill="url(#accentBar)"/>
  <text x="96" y="182" fill="${art.primaryColor}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="700" letter-spacing="3">${escapeXml(
    businessName.toUpperCase()
  )}</text>

  <rect x="96" y="218" width="320" height="44" rx="8" fill="${art.primaryColor}" fill-opacity="0.14" stroke="${art.primaryColor}" stroke-opacity="0.45"/>
  <text x="116" y="247" fill="#f8fafc" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="18" font-weight="700" letter-spacing="1.5">${escapeXml(
    art.editionBadge
  )}</text>

  ${titleSvg}
  ${taglineSvg}

  ${chipsSvg}

  <line x1="96" y1="1335" x2="1104" y2="1335" stroke="#1e293b" stroke-width="2"/>
  <text x="96" y="1396" fill="#94a3b8" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="600">READY FOR INSTANT DIGITAL DELIVERY</text>
  <text x="1104" y="1396" text-anchor="end" fill="${art.primaryColor}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="700">${escapeXml(
    priceBadge
  )}</text>
</svg>`;

  const base64Svg = Buffer.from(svgContent, 'utf-8').toString('base64');
  return {
    svgContent,
    coverDataUrl: `data:image/svg+xml;base64,${base64Svg}`,
    mimeType: 'image/svg+xml',
    artDirection: art,
    modelUsed,
  };
}
