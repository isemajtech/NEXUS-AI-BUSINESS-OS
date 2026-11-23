import { Product } from '../types';
import {
  FACTORY_STORAGE_BUCKETS,
  uploadOwnerStorageAsset,
  createSignedFactoryUrl,
  getCurrentSupabaseUser,
  authorizedApiFetch,
} from './supabase';

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export function triggerBlobDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export interface BuildPdfResult {
  success: boolean;
  filename?: string;
  pageCount?: number;
  byteLength?: number;
  blob?: Blob;
  storagePath?: string;
  signedUrl?: string;
  storageError?: string;
  error?: string;
}

export async function buildProductPdfAsset(
  product: Product,
  businessName?: string
): Promise<BuildPdfResult> {
  try {
    const resp = await authorizedApiFetch('/api/factory/build-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: product.name,
        description: product.description,
        businessName: businessName || 'Personal AI Business OS',
        deliverableFormat: product.deliverableFormat || 'pdf_guide',
        price: product.price,
        billingType: product.billingType,
        deliverableContent:
          product.deliverableContent ||
          `# ${product.name}\n\n${product.description || 'Digital Deliverable Package'}`,
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data?.pdfBase64) {
      return { success: false, error: data?.error || 'PDF build failed.' };
    }

    const pdfBlob = base64ToBlob(data.pdfBase64, 'application/pdf');
    const filename = data.filename || `${product.slug || 'digital-product'}.pdf`;

    let storagePath: string | undefined;
    let signedUrl: string | undefined;
    let storageError: string | undefined;

    const supaUser = await getCurrentSupabaseUser();
    if (supaUser) {
      const uploadRes = await uploadOwnerStorageAsset(
        FACTORY_STORAGE_BUCKETS.DELIVERABLES,
        product.businessId,
        product.id,
        filename,
        pdfBlob,
        'application/pdf'
      );

      if (uploadRes.success && uploadRes.path) {
        storagePath = uploadRes.path;
        const signed = await createSignedFactoryUrl(
          FACTORY_STORAGE_BUCKETS.DELIVERABLES,
          uploadRes.path,
          3600
        );
        if (signed.success && signed.url) {
          signedUrl = signed.url;
        }
      } else {
        storageError = uploadRes.error;
      }
    }

    return {
      success: true,
      filename,
      pageCount: data.pageCount,
      byteLength: data.byteLength,
      blob: pdfBlob,
      storagePath,
      signedUrl,
      storageError,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Network error while building PDF deliverable.',
    };
  }
}

export interface GenerateCoverResult {
  success: boolean;
  coverDataUrl?: string;
  storagePath?: string;
  signedUrl?: string;
  modelUsed?: string;
  storageError?: string;
  error?: string;
}

export async function generateProductCoverAsset(
  product: Product,
  businessName?: string
): Promise<GenerateCoverResult> {
  try {
    const resp = await authorizedApiFetch('/api/factory/generate-cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: product.name,
        description: product.description,
        businessName: businessName || 'Personal AI Business OS',
        productType: product.type,
        price: product.price,
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data?.svgContent || !data?.coverDataUrl) {
      return { success: false, error: data?.error || 'Cover generation failed.' };
    }

    let storagePath: string | undefined;
    let signedUrl: string | undefined;
    let storageError: string | undefined;

    const supaUser = await getCurrentSupabaseUser();
    if (supaUser) {
      const svgBlob = new Blob([data.svgContent], { type: 'image/svg+xml' });
      const uploadRes = await uploadOwnerStorageAsset(
        FACTORY_STORAGE_BUCKETS.ASSETS,
        product.businessId,
        product.id,
        'cover.svg',
        svgBlob,
        'image/svg+xml'
      );

      if (uploadRes.success && uploadRes.path) {
        storagePath = uploadRes.path;
        const signed = await createSignedFactoryUrl(
          FACTORY_STORAGE_BUCKETS.ASSETS,
          uploadRes.path,
          3600
        );
        if (signed.success && signed.url) {
          signedUrl = signed.url;
        }
      } else {
        storageError = uploadRes.error;
      }
    }

    return {
      success: true,
      coverDataUrl: data.coverDataUrl,
      storagePath,
      signedUrl,
      modelUsed: data.modelUsed,
      storageError,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Network error generating cover art.',
    };
  }
}

export interface FactoryResearchResult {
  positioningHook: string;
  buyerPainPoints: string[];
  outlineSections: string[];
  recommendedSummary: string;
  modelUsed: string;
}

export async function runFactoryResearch(input: {
  topic: string;
  targetAudience: string;
  businessName: string;
  productType: string;
  price: number;
}): Promise<FactoryResearchResult> {
  try {
    const resp = await authorizedApiFetch('/api/factory/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await resp.json();
    if (resp.ok && data?.research) {
      return data.research;
    }
  } catch {
    // Fall through to deterministic fallback below
  }

  return {
    positioningHook: `Turnkey ${input.topic} system engineered for ${input.targetAudience}.`,
    buyerPainPoints: [
      `Time lost manually assembling ${input.topic} processes`,
      'Need for clean templates and repeatable SOPs',
    ],
    outlineSections: [
      '1. Quick-Start Blueprint',
      '2. Core Templates & Workflows',
      '3. Step-by-Step Execution Checklist',
      '4. Commercial Use Terms',
    ],
    recommendedSummary: `Deliver a practical toolkit at $${input.price.toFixed(2)}.`,
    modelUsed: 'local_fallback',
  };
}

export async function generateFactoryProductPackage(input: {
  topic: string;
  targetAudience: string;
  productType: Product['type'];
  price: number;
  billingType: Product['billingType'];
  businessName: string;
  research?: FactoryResearchResult;
}): Promise<{
  name: string;
  description: string;
  deliverableFormat: NonNullable<Product['deliverableFormat']>;
  deliverableContent: string;
  modelUsed: string;
}> {
  const enrichedTopic = input.research
    ? `${input.topic}\nPositioning Hook: ${input.research.positioningHook}\nRequired Sections: ${input.research.outlineSections.join('; ')}`
    : input.topic;

  try {
    const resp = await authorizedApiFetch('/api/ai/generate-product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: enrichedTopic,
        targetAudience: input.targetAudience,
        productType: input.productType,
        price: input.price,
        billingType: input.billingType,
        businessName: input.businessName,
      }),
    });
    const data = await resp.json();
    if (resp.ok && data?.product) {
      return {
        name: String(data.product.name || input.topic),
        description: String(data.product.description || input.research?.positioningHook || input.topic),
        deliverableFormat: data.product.deliverableFormat || 'pdf_guide',
        deliverableContent: String(data.product.deliverableContent || ''),
        modelUsed: String(data.model || 'gemini-3.1-flash-lite'),
      };
    }
  } catch {
    // Fallback to clean structured package if server Gemini key is absent
  }

  const sectionsMd = (input.research?.outlineSections || [
    '1. Executive Quick-Start Guide',
    '2. Core Templates & Action Plan',
    '3. Implementation Checklists',
    '4. Commercial License & Delivery',
  ])
    .map(
      (sec, idx) =>
        `## ${sec}\n\n- **Objective ${idx + 1}:** Implement the ${input.topic} workflow step by step for ${input.targetAudience}.\n- **Action Item:** Customize the template fields below to match your active business operations.\n`
    )
    .join('\n');

  return {
    name: input.topic,
    description:
      input.research?.positioningHook ||
      `Complete ${input.productType.replace(/_/g, ' ')} package for ${input.targetAudience}.`,
    deliverableFormat:
      input.productType === 'template'
        ? 'template_pack'
        : input.productType === 'saas' || input.productType === 'api_service'
        ? 'saas_license'
        : 'pdf_guide',
    deliverableContent: `# ${input.topic}\n\n**Published by:** ${input.businessName}\n**Designed for:** ${input.targetAudience}\n\n---\n\n## Key Challenges Addressed\n${(input.research?.buyerPainPoints || ['Eliminate manual setup friction', 'Standardize repeatable execution']).map((p) => `- ${p}`).join('\n')}\n\n---\n\n${sectionsMd}\n## Commercial Use Rights\nIncludes single-operator commercial rights for ${input.businessName} customers.`,
    modelUsed: 'structured_factory_template',
  };
}

export interface FactoryLaunchKitResult {
  campaignName: string;
  channel: 'email' | 'social_media' | 'content';
  conversionGoal: string;
  emailSubject: string;
  emailBody: string;
  socialPosts: string[];
  seoKeywords: string[];
  modelUsed: string;
}

export async function runFactoryLaunchKit(input: {
  title: string;
  description: string;
  price: number;
  billingType: string;
  businessName: string;
  targetAudience: string;
  researchHook?: string;
}): Promise<FactoryLaunchKitResult> {
  try {
    const resp = await authorizedApiFetch('/api/factory/launch-kit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await resp.json();
    if (resp.ok && data?.launchKit) {
      return data.launchKit;
    }
  } catch {
    // Fallback below
  }

  return {
    campaignName: `Launch Broadcast: ${input.title}`,
    channel: 'email',
    conversionGoal: `Convert qualified leads on ${input.title} ($${input.price.toFixed(2)})`,
    emailSubject: `New Release: ${input.title}`,
    emailBody: `${input.title} is now packaged and ready for ${input.targetAudience}.\n\n${input.description}`,
    socialPosts: [`Now available from ${input.businessName}: ${input.title}.`],
    seoKeywords: [input.title.toLowerCase(), 'digital playbook'],
    modelUsed: 'local_fallback',
  };
}

