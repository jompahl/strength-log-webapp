// api/_ai.js — decides WHICH model to call for a request.
//
// Bring-your-own-key: if the caller passes the user's OpenRouter key (loaded from Vault),
// we call OpenRouter (OpenAI-compatible) with their chosen model and THEIR credit.
// Otherwise we fall back to the app's own Anthropic key (ANTHROPIC_API_KEY).
//
// This module no longer stores keys — secret storage lives in Vault (see _supabase.js).

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';

// Convert Anthropic-style content blocks into OpenAI/OpenRouter chat content.
function toOpenAiContent(content) {
  return content.map(block => {
    if (block.type === 'image') {
      const src = block.source || {};
      return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/jpeg'};base64,${src.data}` } };
    }
    return { type: 'text', text: block.text || '' };
  });
}

async function callOpenRouter({ apiKey, model, system, content, maxTokens }) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-Title': process.env.OPENROUTER_APP_NAME || 'Strength Log',
  };
  if (process.env.OPENROUTER_APP_URL) headers['HTTP-Referer'] = process.env.OPENROUTER_APP_URL;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: toOpenAiContent(content) },
  ];
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
  });
  const data = await response.json();
  if (data.error) { const err = new Error(data.error.message || 'OpenRouter API error'); err.provider = 'openrouter'; throw err; }
  const choice = (data.choices && data.choices[0]) || {};
  return {
    text: String(choice.message?.content || '').trim(),
    provider: 'openrouter',
    model,
    stopReason: choice.finish_reason || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

async function callAnthropic({ system, content, maxTokens }) {
  if (!ANTHROPIC_KEY) { const err = new Error('Server missing ANTHROPIC_API_KEY.'); err.provider = 'anthropic'; throw err; }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
  });
  const data = await response.json();
  if (data.error) { const err = new Error(data.error.message || 'Claude API error'); err.provider = 'anthropic'; throw err; }
  return {
    text: (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim(),
    provider: 'anthropic',
    model: ANTHROPIC_MODEL,
    stopReason: data.stop_reason || '',
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

// Routes to the user's OpenRouter key when provided, else the app's Anthropic key.
// `content` is an array of Anthropic-style blocks: { type:'text', text } / { type:'image', source }.
async function generate({ system, content, maxTokens, userKey, userModel }) {
  if (userKey) {
    return callOpenRouter({ apiKey: userKey, model: userModel || DEFAULT_OPENROUTER_MODEL, system, content, maxTokens });
  }
  return callAnthropic({ system, content, maxTokens });
}

module.exports = { DEFAULT_OPENROUTER_MODEL, generate };
