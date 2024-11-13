import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import Anthropic from "npm:@anthropic-ai/sdk";
import OpenAI from "npm:openai";

const router = new Router();
const app = new Application();

// Initialize API clients
const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  defaultHeaders: {
    "anthropic-beta": "prompt-caching-2024-07-31",
  },
});

const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
});

// Initialize Deno KV
const kv = await Deno.openKv();

// API Configuration
const API_CONFIG = {
  anthropic: {
    model: "claude-3-5-haiku-latest",
    maxRequests: 78,
  },
  openai: {
    model: "chatgpt-4o-latest", // Fallback model
    maxRequests: 150, // Adjust based on your OpenAI rate limits
  },
};

// Rate limit error templates
const getRateLimitError = (provider: string, maxRequests: number) => ({
  error: {
    message: `Message quota exceeded for ${provider}. Maximum ${maxRequests} requests allowed per user.`,
    type: "MessageQuotaExceeded",
  },
});

// CORS middleware
app.use((ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "OPTIONS,POST");
  ctx.response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization"
  );
  return next();
});

interface RequestBody {
  email: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  system: string;
  max_tokens?: number;
  temperature?: number;
}

// Helper function to check and increment rate limit for specific provider
async function checkRateLimit(
  email: string,
  provider: "anthropic" | "openai"
): Promise<boolean> {
  const key = ["rate_limit", provider, email];
  const atomic = kv.atomic();
  const currentCount = await kv.get(key);
  const maxRequests = API_CONFIG[provider].maxRequests;

  if (!currentCount.value) {
    await atomic.set(key, 1).commit();
    return true;
  }

  if (currentCount.value >= maxRequests) {
    return false;
  }

  await atomic.set(key, (currentCount.value as number) + 1).commit();
  return true;
}

// Helper function to transform messages for OpenAI format
function transformMessagesForOpenAI(messages: any[], system: string) {
  return [
    { role: "system", content: system },
    ...messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
  ];
}

// Helper function to handle API calls with fallback
async function handleAPIRequest(body: RequestBody) {
  const { messages, system, max_tokens = 2048, temperature = 0.0 } = body;

  // Try Anthropic first
  const withinAnthropicLimit = await checkRateLimit(body.email, "anthropic");
  if (withinAnthropicLimit) {
    try {
      const transformedSystem = [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral" },
        },
      ];

      const response = await anthropic.messages.create(
        {
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          model: API_CONFIG.anthropic.model,
          max_tokens,
          temperature,
          system: transformedSystem,
        },
        {
          "anthropic-beta": "prompt-caching-2024-07-31",
        }
      );

      return {
        provider: "anthropic",
        response,
      };
    } catch (error) {
      if (error.status === 429) {
        // Fall through to OpenAI
      } else {
        throw error;
      }
    }
  }

  // Try OpenAI as fallback
  const withinOpenAILimit = await checkRateLimit(body.email, "openai");
  if (!withinOpenAILimit) {
    throw new Error("Rate limit exceeded for both Anthropic and OpenAI");
  }

  const openAIResponse = await openai.chat.completions.create({
    model: API_CONFIG.openai.model,
    messages: transformMessagesForOpenAI(messages, system),
    max_tokens,
    temperature,
  });

  return {
    provider: "openai",
    response: openAIResponse,
  };
}

router
  .options("/", (ctx) => {
    ctx.response.status = 200;
    ctx.response.statusText = "OK";
  })
  .post("/", async (ctx) => {
    try {
      const body: RequestBody = await ctx.request.body.json();

      if (!body.email) {
        ctx.response.status = 400;
        ctx.response.body = {
          error: {
            message: "Email is required",
            type: "ValidationError",
          },
        };
        return;
      }

      ctx.response.headers.set("Content-Type", "application/json");

      const result = await handleAPIRequest(body);
      ctx.response.body = {
        ...result.response,
        provider: result.provider,
      };
    } catch (error) {
      console.error("Error:", error);
      ctx.response.status = error.status || 500;
      ctx.response.body = {
        error: {
          message: error.message || "Internal server error",
          type: error.name || "UnknownError",
        },
      };
    }
  });

app.use(router.routes());
await app.listen({ port: 8000 });
