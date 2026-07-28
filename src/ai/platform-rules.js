/**
 * Platform-specific formatting rules and hook templates
 * Injected into AI prompts based on target platform
 */

// ============================================
// Digest/style formatting rules (appended to STYLES system prompt)
// ============================================

export const PLATFORM_RULES = {
  telegram: `FORMAT RULES:
- Dùng Telegram formatting: *bold*, _italic_
- KHÔNG dùng ## markdown headers
- Tối đa 4000 ký tự
- Giữ nhịp viết tự nhiên; đừng biến mỗi mục thành cùng một template`,

  x: `FORMAT RULES:
- Plain text only — no markdown, no HTML, no *bold* or _italic_
- Each tweet max 280 characters
- Thread format: number as 1/n, 2/n... separated by blank lines
- Add 2-3 relevant hashtags to the first tweet only
- Punchy, direct tone, but avoid generic hype
- Max 10 tweets per thread`,

  threads: `FORMAT RULES:
- Plain text only — no markdown, no HTML
- Max 500 characters total
- Casual, conversational tone
- Emoji OK but max 3
- No hashtags required
- Sound like a useful share, not a press blurb`,

  facebook: `FORMAT RULES:
- Plain text only — no markdown, no HTML
- Optimal length: under 500 characters for engagement
- Friendly, slightly more formal than X
- End with a real question only when it fits the article
- Put link on its own line at the end`,
};

// ============================================
// Hook rules (drip mode single-article posts per platform)
// ============================================

export const HOOK_RULES = {
  telegram: {
    format: `QUY TẮC:
- Vietnglish tự nhiên, xen tiếng Anh như người làm IT Việt chat hàng ngày
- Dòng đầu là tiêu đề bài viết, dùng *bold*
- Sau tiêu đề là đúng 2-3 câu ngắn chỉ tóm tắt thông tin chính; không viết phân tích dài hoặc hot take
- Tổng nội dung không quá 700 ký tự để vừa một Telegram photo caption
- Link gốc ở cuối, paste thẳng URL
- Emoji: tối đa 1 cái hoặc không
- Ngoài tiêu đề, không lạm dụng *bold*
- KHÔNG bắt đầu bằng emoji, KHÔNG dùng ## headers
- Tránh mở bài kiểu template: "Trong bối cảnh...", "Điều này quan trọng vì...", "Đây có thể là bước ngoặt..."`,
    examples: `VÍ DỤ TONE ĐÚNG (học cách viết, KHÔNG copy):

---
*Cloudflare giới thiệu Agent Lee cho AI agents trên edge*

Agent Lee gom Workers, KV, D1 và R2 vào cùng một flow triển khai AI agents. Cách tiếp cận này giúp team giảm phần glue code khi xây dựng trên Cloudflare stack.

https://blog.cloudflare.com/introducing-agent-lee/
---`,
  },

  x: {
    format: `RULES:
- Plain text only — NO markdown, NO *bold*, NO _italic_
- Max 280 characters total (including URL)
- Vietnglish natural tone, mix English tech terms
- Include article URL
- End with 2-3 relevant hashtags
- Punchy, one key insight only
- End with "— Dan Tech Daily News"
- Avoid performative controversy or one-sided framing unless the article strongly supports it`,
    examples: `EXAMPLE TONE (learn style, DON'T copy):

---
Cloudflare kéo AI agents về Workers stack với Agent Lee: KV/D1/R2 chung flow, ít glue code hơn. Team IT nên nhìn vào cost, ops và lock-in. blog.cloudflare.com/agent-lee/ — Dan Tech Daily News #cloudflare #ai
---`,
  },

  threads: {
    format: `RULES:
- Plain text only — NO markdown, NO *bold*
- Max 500 characters
- Vietnglish casual, like sharing with IT peers
- Include article URL on its own line
- End with "— Dan Tech Daily News"
- Emoji: 0-2, natural placement only
- Avoid sounding like a launch announcement`,
    examples: `EXAMPLE TONE (learn style, DON'T copy):

---
Cloudflare vừa ra Agent Lee. Cái đáng để ý là họ đang gom runtime, storage và edge vào một flow cho AI agents, thay vì để team tự wire từng mảnh. Với IT teams, đây là bài toán tradeoff giữa tốc độ triển khai, vận hành và lock-in.

blog.cloudflare.com/agent-lee/
— Dan Tech Daily News
---`,
  },

  facebook: {
    format: `RULES:
- Plain text only — NO markdown
- 300-500 characters optimal
- Vietnglish friendly tone, slightly more formal than X
- Summarize the key insight with one concrete implication
- End with a question only if it is specific and useful
- Link on its own line
- End with "— Dan Tech Daily News"`,
    examples: `EXAMPLE TONE (learn style, DON'T copy):

---
Cloudflare vừa ra mắt Agent Lee, một flow mới để build AI agents trên Workers stack. Điểm đáng chú ý là KV, D1, R2 được kéo vào cùng runtime, nên phần glue code và vận hành có thể giảm khá nhiều.

Với team IT, tradeoff giữa tốc độ triển khai, chi phí vận hành và lock-in nên được cân nhắc thế nào?

blog.cloudflare.com/agent-lee/
— Dan Tech Daily News
---`,
  },
};
