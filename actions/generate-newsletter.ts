"use server";

import { google } from "@ai-sdk/google";
import { streamObject } from "ai";
import { z } from "zod";
import { checkIsProUser, getCurrentUser } from "@/lib/auth/helpers";
import { buildArticleSummaries, buildNewsletterPrompt } from "@/lib/newsletter/prompt-builder";
import { prepareFeedsAndArticles } from "@/lib/rss/feed-refresh";
import { createNewsletter } from "./newsletter";
import { getUserSettingsByUserId } from "./user-settings";

const NewsletterSchema = z.object({
  suggestedTitles: z.array(z.string()).length(5),
  suggestedSubjectLines: z.array(z.string()).length(5),
  body: z.string(),
  topAnnouncements: z.array(z.string()).length(5),
  additionalInfo: z.string().optional(),
});

type GeneratedNewsletter = z.infer<typeof NewsletterSchema>;

const MAX_PROMPT_BYTES = 24000;
const MAX_SUMMARY_CHARS = 1200;
const MAX_ARTICLES_INITIAL = 100;
const MAX_ARTICLES_FALLBACK = 40;

function approxByteLength(s: string) {
  return Buffer.byteLength(s || "", "utf8");
}

function ensurePromptFits({ startDate, endDate, articleSummaries, userInput, settings }: {
  startDate: Date;
  endDate: Date;
  articleSummaries: string[];
  userInput?: string;
  settings: any;
}) {
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

export async function generateNewsletterStream(params: {
  feedIds: string[];
  startDate: Date;
  endDate: Date;
  userInput?: string;
}) {
  const user = await getCurrentUser();
  const settings = await getUserSettingsByUserId(user.id);

  const articles = await prepareFeedsAndArticles({
    feedIds: params.feedIds,
    startDate: params.startDate,
    endDate: params.endDate,
    limit: MAX_ARTICLES_INITIAL,
  });

  let articleSummaries: unknown = buildArticleSummaries(articles);

  try {
    if (typeof articleSummaries === "string") {
      articleSummaries = [articleSummaries];
    } else if (Array.isArray(articleSummaries)) {
      articleSummaries = articleSummaries.map((s) => String(s ?? ""));
    } else if (articleSummaries && typeof articleSummaries === "object") {
      const vals = Object.values(articleSummaries as Record<string, unknown>);
      articleSummaries = vals.map((v) => String(v ?? ""));
    } else {
      articleSummaries = [];
    }
  } catch {
    articleSummaries = [];
  }

  const summariesArray = (articleSummaries as string[]).slice(0, Math.max(0, articleSummaries ? (articleSummaries as string[]).length : 0));
  const { prompt, bytes } = ensurePromptFits({
    startDate: params.startDate,
    endDate: params.endDate,
    articleSummaries: summariesArray,
    userInput: params.userInput,
    settings,
  });

  const { partialObjectStream } = await streamObject({
    model: google("gemini-2.5-flash"),
    schema: NewsletterSchema,
    prompt,
  });

  return {
    stream: partialObjectStream,
    articlesAnalyzed: articles.length,
  };
}

export async function saveGeneratedNewsletter(params: {
  newsletter: GeneratedNewsletter;
  feedIds: string[];
  startDate: Date;
  endDate: Date;
  userInput?: string;
}) {
  const isPro = await checkIsProUser();
  if (!isPro) throw new Error("Pro plan required to save newsletters");
  const user = await getCurrentUser();
  const savedNewsletter = await createNewsletter({
    userId: user.id,
    suggestedTitles: params.newsletter.suggestedTitles,
    suggestedSubjectLines: params.newsletter.suggestedSubjectLines,
    body: params.newsletter.body,
    topAnnouncements: params.newsletter.topAnnouncements,
    additionalInfo: params.newsletter.additionalInfo,
    startDate: params.startDate,
    endDate: params.endDate,
    userInput: params.userInput,
    feedsUsed: params.feedIds,
  });
  return savedNewsletter;
}
