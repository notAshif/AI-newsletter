import { google } from "@ai-sdk/google";
import { streamObject } from "ai";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getUserSettingsByUserId } from "@/actions/user-settings";
import { getCurrentUser } from "@/lib/auth/helpers";
import { buildArticleSummaries, buildNewsletterPrompt } from "@/lib/newsletter/prompt-builder";
import { prepareFeedsAndArticles } from "@/lib/rss/feed-refresh";

export const maxDuration = 300;

const NewsletterSchema = z.object({
  suggestedTitles: z.array(z.string()).length(5),
  suggestedSubjectLines: z.array(z.string()).length(5),
  body: z.string(),
  topAnnouncements: z.array(z.string()).length(5),
  additionalInfo: z.string().optional(),
});

const MAX_PROMPT_BYTES = 24000;
const MAX_SUMMARY_CHARS = 1200;
const MAX_ARTICLES_INITIAL = 100;
const MAX_ARTICLES_FALLBACK = 40;

function approxByteLength(s: string) {
  return Buffer.byteLength(s || "", "utf8");
}

function ensurePromptFits({ startDate, endDate, articleSummaries, userInput, settings }) {
  const truncated = articleSummaries.map((s) =>
    s.length > MAX_SUMMARY_CHARS ? s.slice(0, MAX_SUMMARY_CHARS) + "…" : s
  );

  let prompt = buildNewsletterPrompt({
    startDate,
    endDate,
    articleSummaries: truncated,
    articleCount: truncated.length,
    userInput,
    settings,
  });

  let bytes = approxByteLength(prompt);

  if (bytes > MAX_PROMPT_BYTES) {
    let allowed = Math.min(truncated.length, MAX_ARTICLES_FALLBACK);
    while (bytes > MAX_PROMPT_BYTES && allowed > 0) {
      const reduced = truncated.slice(0, allowed);
      prompt = buildNewsletterPrompt({
        startDate,
        endDate,
        articleSummaries: reduced,
        articleCount: reduced.length,
        userInput,
        settings,
      });
      bytes = approxByteLength(prompt);
      if (bytes > MAX_PROMPT_BYTES) allowed = Math.max(1, Math.floor(allowed * 0.6));
    }
  }

  return { prompt, bytes };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { feedIds, startDate, endDate, userInput } = body;

    if (!feedIds || !Array.isArray(feedIds) || feedIds.length === 0) {
      return Response.json({ error: "feedIds is required" }, { status: 400 });
    }

    if (!startDate || !endDate) {
      return Response.json({ error: "startDate and endDate are required" }, { status: 400 });
    }

    const user = await getCurrentUser();
    const settings = await getUserSettingsByUserId(user.id);

    const articles = await prepareFeedsAndArticles({
      feedIds,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      limit: MAX_ARTICLES_INITIAL,
    });

    let articleSummaries = buildArticleSummaries(articles);

    try {
      if (typeof articleSummaries === "string") {
        articleSummaries = [articleSummaries];
      } else if (Array.isArray(articleSummaries)) {
        articleSummaries = articleSummaries.map((s) => String(s ?? ""));
      } else if (articleSummaries && typeof articleSummaries === "object") {
        const vals = Object.values(articleSummaries);
        articleSummaries = vals.map((v) => String(v ?? ""));
      } else {
        articleSummaries = [];
      }
    } catch {
      articleSummaries = [];
    }

    const { prompt, bytes } = ensurePromptFits({
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      articleSummaries,
      userInput,
      settings,
    });

    console.info(
      `Newsletter generation: feeds=${feedIds.length}, articles=${articles.length}, summaries=${articleSummaries.length}, promptBytes=${bytes}`
    );

    try {
      const result = await streamObject({
        model: google("gemini-2.5-flash"),
        schema: NewsletterSchema,
        prompt,
      });

      return result.toTextStreamResponse();
    } catch (streamErr) {
      const details = String(streamErr ?? "");
      const isQuota =
        details.toLowerCase().includes("insufficient_quota") ||
        details.toLowerCase().includes("quota") ||
        details.toLowerCase().includes("billing") ||
        (streamErr && (streamErr as any).type === "insufficient_quota");

      if (isQuota) {
        return Response.json({ error: "insufficient_quota", message: "AI quota exhausted. Check billing or API key." }, { status: 402 });
      }

      return Response.json({ error: "AI generation failed", details }, { status: 500 });
    }
  } catch (error) {
    return Response.json(
      { error: "Failed to generate newsletter", details: String(error) },
      { status: 500 }
    );
  }
}
