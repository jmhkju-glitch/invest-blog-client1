import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { invokeLLM } from "./_core/llm";
import {
  getAllCategories,
  getAllTags,
  getPostList,
  getPostBySlug,
  getPostById,
  createPost,
  updatePost,
  deletePost,
  incrementViewCount,
  getCommentsByPostId,
  createComment,
  deleteComment,
} from "./db";
import { ENV } from "./_core/env";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9가-힣-]/g, "")
      .substring(0, 100) +
    "-" +
    Date.now().toString(36)
  );
}

function isOwner(openId: string): boolean {
  return openId === ENV.ownerOpenId;
}

// ─── Owner-only procedure ─────────────────────────────────────────────────────
const ownerProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!isOwner(ctx.user.openId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "소유자만 접근할 수 있습니다." });
  }
  return next({ ctx });
});

// ─── Routers ──────────────────────────────────────────────────────────────────
export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ─── Categories ─────────────────────────────────────────────────────────────
  categories: router({
    list: publicProcedure.query(() => getAllCategories()),
  }),

  // ─── Tags ───────────────────────────────────────────────────────────────────
  tags: router({
    list: publicProcedure.query(() => getAllTags()),
  }),

  // ─── Posts ──────────────────────────────────────────────────────────────────
  posts: router({
    list: publicProcedure
      .input(
        z.object({
          page: z.number().int().min(1).default(1),
          pageSize: z.number().int().min(1).max(50).default(9),
          categorySlug: z.string().optional(),
          tagSlug: z.string().optional(),
          search: z.string().optional(),
          showDrafts: z.boolean().default(false),
        })
      )
      .query(async ({ input, ctx }) => {
        const showDrafts = input.showDrafts && ctx.user && isOwner(ctx.user.openId);
        return getPostList({
          page: input.page,
          pageSize: input.pageSize,
          categorySlug: input.categorySlug,
          tagSlug: input.tagSlug,
          search: input.search,
          published: showDrafts ? undefined : true,
        });
      }),

    bySlug: publicProcedure
      .input(z.object({ slug: z.string() }))
      .query(async ({ input, ctx }) => {
        const post = await getPostBySlug(input.slug);
        if (!post) throw new TRPCError({ code: "NOT_FOUND", message: "글을 찾을 수 없습니다." });
        if (!post.published) {
          if (!ctx.user || !isOwner(ctx.user.openId)) {
            throw new TRPCError({ code: "NOT_FOUND", message: "글을 찾을 수 없습니다." });
          }
        }
        await incrementViewCount(post.id);
        return post;
      }),

    create: ownerProcedure
      .input(
        z.object({
          title: z.string().min(1).max(255),
          content: z.string().min(1),
          summary: z.string().optional(),
          aiInsight: z.string().optional(),
          categoryId: z.number().int().optional(),
          tags: z.array(z.string()).default([]),
          published: z.boolean().default(false),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const slug = generateSlug(input.title);
        const post = await createPost(
          {
            title: input.title,
            slug,
            content: input.content,
            summary: input.summary ?? null,
            aiInsight: input.aiInsight ?? null,
            categoryId: input.categoryId ?? null,
            published: input.published,
            authorId: ctx.user.id,
          },
          input.tags
        );
        return post;
      }),

    update: ownerProcedure
      .input(
        z.object({
          id: z.number().int(),
          title: z.string().min(1).max(255).optional(),
          content: z.string().min(1).optional(),
          summary: z.string().optional(),
          aiInsight: z.string().optional(),
          categoryId: z.number().int().nullable().optional(),
          tags: z.array(z.string()).optional(),
          published: z.boolean().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, tags: tagNames, ...data } = input;
        await updatePost(id, data, tagNames);
        return { success: true };
      }),

    byId: ownerProcedure
      .input(z.object({ id: z.number().int() }))
      .query(async ({ input }) => {
        const post = await getPostById(input.id);
        if (!post) throw new TRPCError({ code: "NOT_FOUND", message: "글을 찾을 수 없습니다." });
        return post;
      }),

    delete: ownerProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ input }) => {
        await deletePost(input.id);
        return { success: true };
      }),
  }),

  // ─── Comments ────────────────────────────────────────────────────────────────
  comments: router({
    list: publicProcedure
      .input(z.object({ postId: z.number().int() }))
      .query(({ input }) => getCommentsByPostId(input.postId)),

    create: publicProcedure
      .input(
        z.object({
          postId: z.number().int(),
          authorName: z.string().min(1).max(64),
          content: z.string().min(1).max(2000),
        })
      )
      .mutation(({ input }) => createComment(input)),

    delete: ownerProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(({ input }) => deleteComment(input.id).then(() => ({ success: true }))),
  }),

  // ─── AI ──────────────────────────────────────────────────────────────────────
  ai: router({
    generateInsight: ownerProcedure
      .input(
        z.object({
          title: z.string(),
          content: z.string(),
        })
      )
      .mutation(async ({ input }) => {
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `당신은 투자 전문 AI 어시스턴트입니다. 블로그 글의 내용을 분석하여 다음을 제공하세요:
1. 핵심 요약 (3-4문장)
2. 투자 인사이트 및 시사점 (2-3개 bullet point)
3. 주의해야 할 리스크 요인 (1-2개)

응답은 마크다운 형식으로 작성하세요.`,
            },
            {
              role: "user",
              content: `제목: ${input.title}\n\n내용:\n${input.content.substring(0, 3000)}`,
            },
          ],
        });
        const content = response.choices?.[0]?.message?.content ?? "";
        return { insight: content };
      }),

    summarize: ownerProcedure
      .input(z.object({ title: z.string(), content: z.string() }))
      .mutation(async ({ input }) => {
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content:
                "투자 블로그 글의 핵심 내용을 2-3문장으로 간결하게 요약하세요. 투자자들이 빠르게 내용을 파악할 수 있도록 핵심 정보를 포함하세요.",
            },
            {
              role: "user",
              content: `제목: ${input.title}\n\n내용:\n${input.content.substring(0, 2000)}`,
            },
          ],
        });
        const summary = response.choices?.[0]?.message?.content ?? "";
        return { summary };
      }),
  }),
});

export type AppRouter = typeof appRouter;
