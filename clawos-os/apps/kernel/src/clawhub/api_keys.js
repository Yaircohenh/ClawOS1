/**
 * Maps known API key env vars to their sign-up / management URLs.
 * getKeyLinks(skillMd) → [{ envVar, label, url }]
 */

export const KEY_LINKS = {
  ANTHROPIC_API_KEY:    { label: "Anthropic API Key",              url: "https://console.anthropic.com/settings/keys" },
  OPENAI_API_KEY:       { label: "OpenAI API Key",                 url: "https://platform.openai.com/api-keys" },
  GEMINI_API_KEY:       { label: "Google Gemini API Key",          url: "https://aistudio.google.com/app/apikey" },
  GOOGLE_GEMINI_API_KEY:{ label: "Google Gemini API Key",          url: "https://aistudio.google.com/app/apikey" },
  BRAVE_API_KEY:        { label: "Brave Search API Key",           url: "https://brave.com/search/api/" },
  GITHUB_TOKEN:         { label: "GitHub Personal Access Token",   url: "https://github.com/settings/tokens" },
  NOTION_API_KEY:       { label: "Notion Integration Token",       url: "https://www.notion.so/my-integrations" },
  DISCORD_WEBHOOK_URL:  { label: "Discord Webhook URL",            url: "https://support.discord.com/hc/en-us/articles/228383668" },
  SLACK_BOT_TOKEN:      { label: "Slack Bot Token",                url: "https://api.slack.com/apps" },
  STRIPE_API_KEY:       { label: "Stripe API Key",                 url: "https://dashboard.stripe.com/apikeys" },
  SENDGRID_API_KEY:     { label: "SendGrid API Key",               url: "https://app.sendgrid.com/settings/api_keys" },
  AWS_ACCESS_KEY_ID:    { label: "AWS Access Key",                 url: "https://console.aws.amazon.com/iam/home#/security_credentials" },
  AWS_SECRET_ACCESS_KEY:{ label: "AWS Secret Key",                 url: "https://console.aws.amazon.com/iam/home#/security_credentials" },
  GOOGLE_API_KEY:       { label: "Google Cloud API Key",           url: "https://console.cloud.google.com/apis/credentials" },
  TWITTER_BEARER_TOKEN: { label: "Twitter/X Bearer Token",         url: "https://developer.twitter.com/en/portal/dashboard" },
  LINEAR_API_KEY:       { label: "Linear API Key",                 url: "https://linear.app/settings/api" },
  JIRA_API_TOKEN:       { label: "Jira API Token",                 url: "https://id.atlassian.com/manage-profile/security/api-tokens" },
  CONFLUENCE_API_TOKEN: { label: "Confluence API Token",           url: "https://id.atlassian.com/manage-profile/security/api-tokens" },
};

/**
 * Scans a SKILL.md string for known env var references and returns
 * matching { envVar, label, url } entries (deduplicated).
 *
 * @param {string} skillMd
 * @returns {{ envVar: string; label: string; url: string }[]}
 */
export function getKeyLinks(skillMd) {
  const matches = skillMd.match(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g) ?? [];
  const found = new Set();
  const links = [];
  for (const m of matches) {
    const varName = m.replace(/^\$\{?/, "").replace(/\}$/, "");
    if (found.has(varName)) {continue;}
    found.add(varName);
    if (KEY_LINKS[varName]) {
      links.push({ envVar: varName, ...KEY_LINKS[varName] });
    } else if (/(?:_API_KEY|_TOKEN|_SECRET|_KEY)$/.test(varName)) {
      // Unknown sensitive var — surface it so the user knows it's needed
      links.push({ envVar: varName, label: "API key required by this skill", url: "" });
    }
  }
  return links;
}
