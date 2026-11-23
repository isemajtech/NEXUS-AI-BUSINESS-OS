import { GoogleGenAI } from '@google/genai';

export interface ResearchInput {
  topic: string;
  targetAudience: string;
  businessName: string;
  productType: string;
  price: number;
  geminiKey?: string | null;
}

export interface ResearchOutput {
  positioningHook: string;
  buyerPainPoints: string[];
  outlineSections: string[];
  recommendedSummary: string;
  modelUsed: string;
}

export interface LaunchKitInput {
  title: string;
  description: string;
  price: number;
  billingType: string;
  businessName: string;
  targetAudience: string;
  researchHook?: string;
  geminiKey?: string | null;
}

export interface LaunchKitOutput {
  campaignName: string;
  channel: 'email' | 'social_media' | 'content';
  conversionGoal: string;
  emailSubject: string;
  emailBody: string;
  socialPosts: string[];
  seoKeywords: string[];
  modelUsed: string;
}

const FREE_TIER_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash'];

async function generateJsonWithFreeTierGemini(
  geminiKey: string,
  prompt: string
): Promise<{ parsed: any; model: string } | null> {
  const client = new GoogleGenAI({
    apiKey: geminiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  for (const modelName of FREE_TIER_MODELS) {
    try {
      const result = await client.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: 'application/json',
        },
      });
      const raw = result?.text?.trim();
      if (!raw) continue;
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      return { parsed, model: modelName };
    } catch {
      continue;
    }
  }
  return null;
}

export async function researchMarketOpportunity(input: ResearchInput): Promise<ResearchOutput> {
  const topic = input.topic.trim();
  const audience = input.targetAudience.trim() || 'Small business owners and solo founders';

  if (input.geminiKey) {
    const prompt = `You are the Product Strategy & Market Research lead for "${input.businessName}".
Conduct concise commercial research for this new digital product:
- Topic: ${topic}
- Target Audience: ${audience}
- Format: ${input.productType}
- Target Price: $${Number(input.price || 19).toFixed(2)}

Return ONLY valid JSON:
{
  "positioningHook": "One crisp 1-sentence value proposition highlighting immediate ROI",
  "buyerPainPoints": ["Pain point 1", "Pain point 2", "Pain point 3"],
  "outlineSections": ["Section 1 title", "Section 2 title", "Section 3 title", "Section 4 title", "Section 5 title"],
  "recommendedSummary": "2-sentence positioning brief for the product writer"
}`;

    const aiRes = await generateJsonWithFreeTierGemini(input.geminiKey, prompt);
    if (aiRes?.parsed) {
      const p = aiRes.parsed;
      return {
        positioningHook:
          typeof p.positioningHook === 'string' && p.positioningHook.trim()
            ? p.positioningHook.trim()
            : `Actionable ${topic} system built for ${audience}.`,
        buyerPainPoints: Array.isArray(p.buyerPainPoints) && p.buyerPainPoints.length > 0
          ? p.buyerPainPoints.slice(0, 5).map(String)
          : [
              `Hours wasted rebuilding ${topic} workflows from scratch`,
              'Inconsistent execution and lack of standardized templates',
              'Need for practical SOPs that work out of the box',
            ],
        outlineSections: Array.isArray(p.outlineSections) && p.outlineSections.length > 0
          ? p.outlineSections.slice(0, 7).map(String)
          : [
              '1. Executive Quick-Start Framework',
              '2. Core Templates & Execution Checklists',
              '3. Step-by-Step Implementation Sprint',
              '4. KPI Tracking & Optimization Playbook',
              '5. Commercial License & Deployment Rights',
            ],
        recommendedSummary:
          typeof p.recommendedSummary === 'string' && p.recommendedSummary.trim()
            ? p.recommendedSummary.trim()
            : `Package ${topic} as a ready-to-deploy digital toolkit priced at $${Number(input.price || 19).toFixed(2)}.`,
        modelUsed: aiRes.model,
      };
    }
  }

  return {
    positioningHook: `A turnkey ${topic} blueprint helping ${audience} execute faster with zero trial-and-error.`,
    buyerPainPoints: [
      `Disconnected documentation and slow manual workflows around ${topic}`,
      'Unclear step-by-step execution standards for lean teams',
      'Desire for copy-paste scripts, checklists, and measurable ROI metrics',
    ],
    outlineSections: [
      '01. Quick-Start Implementation Guide',
      '02. Ready-to-Use Templates & Checklists',
      '03. 30-Day Execution Roadmap',
      '04. Common Pitfalls & Troubleshooting',
      '05. Commercial Usage & Delivery Notes',
    ],
    recommendedSummary: `Positioned for ${audience} as a high-clarity, immediately usable ${input.productType.replace(/_/g, ' ')} at $${Number(input.price || 19).toFixed(2)}.`,
    modelUsed: 'deterministic_strategist',
  };
}

export async function generateProductLaunchKit(input: LaunchKitInput): Promise<LaunchKitOutput> {
  const title = input.title.trim();

  if (input.geminiKey) {
    const prompt = `You are the Marketing & Growth Director for "${input.businessName}".
Draft a launch marketing kit for a newly packaged digital product:
- Product Title: ${title}
- Description: ${input.description}
- Price: $${Number(input.price || 19).toFixed(2)} (${input.billingType})
- Target Audience: ${input.targetAudience}
- Positioning Hook: ${input.researchHook || input.description}

Return ONLY valid JSON:
{
  "campaignName": "Short campaign title",
  "channel": "email",
  "conversionGoal": "Direct digital product sales",
  "emailSubject": "Compelling launch email subject line",
  "emailBody": "Concise 3-paragraph plain-text launch email with clear CTA",
  "socialPosts": ["LinkedIn launch post", "X/Twitter thread hook post", "Instagram caption post"],
  "seoKeywords": ["keyword 1", "keyword 2", "keyword 3", "keyword 4"]
}`;

    const aiRes = await generateJsonWithFreeTierGemini(input.geminiKey, prompt);
    if (aiRes?.parsed) {
      const p = aiRes.parsed;
      return {
        campaignName:
          typeof p.campaignName === 'string' && p.campaignName.trim()
            ? p.campaignName.trim()
            : `Launch Kit: ${title}`,
        channel:
          p.channel === 'social_media' || p.channel === 'content' ? p.channel : 'email',
        conversionGoal:
          typeof p.conversionGoal === 'string' && p.conversionGoal.trim()
            ? p.conversionGoal.trim()
            : `Drive checkout conversions for ${title} ($${Number(input.price || 19).toFixed(2)})`,
        emailSubject:
          typeof p.emailSubject === 'string' && p.emailSubject.trim()
            ? p.emailSubject.trim()
            : `Now Live: ${title}`,
        emailBody:
          typeof p.emailBody === 'string' && p.emailBody.trim()
            ? p.emailBody.trim()
            : `${title} is ready for immediate download.\n\n${input.description}`,
        socialPosts:
          Array.isArray(p.socialPosts) && p.socialPosts.length > 0
            ? p.socialPosts.slice(0, 4).map(String)
            : [`Introducing ${title} — built for ${input.targetAudience}.`],
        seoKeywords:
          Array.isArray(p.seoKeywords) && p.seoKeywords.length > 0
            ? p.seoKeywords.slice(0, 6).map(String)
            : [title.toLowerCase(), 'digital playbook', 'business templates'],
        modelUsed: aiRes.model,
      };
    }
  }

  return {
    campaignName: `Launch Broadcast: ${title}`,
    channel: 'email',
    conversionGoal: `First 25 verified orders for ${title} ($${Number(input.price || 19).toFixed(2)})`,
    emailSubject: `Just Released: ${title} (${input.businessName})`,
    emailBody: `We just packaged "${title}" for ${input.targetAudience}.\n\nInside the PDF deliverable, you get an actionable quick-start framework, copy-paste templates, and an execution checklist built to save hours from day one.\n\nUnlock instant access for $${Number(input.price || 19).toFixed(2)} via checkout.`,
    socialPosts: [
      `[LinkedIn] We built "${title}" after seeing ${input.targetAudience} struggle with inconsistent execution. Download the full PDF playbook & templates today.`,
      `[X / Twitter] Stop reinventing workflows from scratch. "${title}" gives you every checklist and script in one clean PDF package ($${Number(input.price || 19).toFixed(2)}).`,
      `[Instagram] New release from ${input.businessName}: ${title}. Built for practical execution.`,
    ],
    seoKeywords: [
      title.toLowerCase(),
      `${input.businessName.toLowerCase()} digital product`,
      'turnkey playbook pdf',
      'small business templates',
    ],
    modelUsed: 'deterministic_marketer',
  };
}
