// POST /api/chat
// body: { messages: [{ role: "user" | "model", text }], context?: { stage, affectedArea, recommendation, riskLevel }, lang }
// returns: { reply }
//
// The fall armyworm assistant. Logged-in users only, with a per-user daily limit
// (Admin > Settings), so the public cannot spend the Gemini quota.
import { api } from "../lib/http.js";
import { getUser } from "../lib/auth.js";
import { chatReply } from "../lib/gemini.js";
import { getSettings, rateLimit } from "../lib/system.js";

export default api(
  {
    "POST ": {
      auth: "any",
      fn: async ({ body, user }) => {
        const settings = await getSettings();
        await rateLimit(`chat:${user.id}`, settings.chat.daily_limit, 86400, "You have asked many questions today. Please try again tomorrow, or request help from an advisor.");
        const reply = await chatReply({ messages: body.messages, context: body.context, lang: body.lang });
        return { reply };
      },
    },
  },
  { getUser }
);
