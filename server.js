require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5500;

const MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-1.5-flash',
  'gemini-3-flash-preview'
];

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1500, 3000, 5000];

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isOverloaded(status, message) {
  if (status === 429 || status === 503) return true;
  const msg = (message || '').toLowerCase();
  return msg.includes('high demand')
    || msg.includes('overloaded')
    || msg.includes('resource exhausted')
    || msg.includes('try again');
}

function isModelUnavailable(status, message) {
  if (status === 404) return true;
  const msg = (message || '').toLowerCase();
  return msg.includes('not found') || msg.includes('not supported');
}

async function generateWithModel(apiKey, model, parts, config) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: config
    })
  });

  const data = await response.json().catch(() => ({}));
  const message = data?.error?.message || `HTTP ${response.status}`;

  if (!response.ok) {
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || 'unknown';
    throw new Error(`Empty response from model (reason: ${reason})`);
  }

  return { text, model };
}

app.post('/api/gemini', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in .env file' });
  }

  const { parts, generationConfig = {} } = req.body;
  if (!parts || !Array.isArray(parts) || parts.length === 0) {
    return res.status(400).json({ error: 'Missing parts in request body' });
  }

  const config = {
    temperature: 0.7,
    maxOutputTokens: 8192,
    ...generationConfig
  };

  let lastError = null;

  for (const model of MODELS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await generateWithModel(apiKey, model, parts, config);
        return res.json({ text: result.text, model: result.model });
      } catch (err) {
        lastError = err;
        const overloaded = isOverloaded(err.status, err.message);
        const unavailable = isModelUnavailable(err.status, err.message);

        if (unavailable) break;

        if (overloaded && attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAYS_MS[attempt] || 3000);
          continue;
        }

        if (overloaded) break;
        return res.status(err.status || 500).json({ error: err.message });
      }
    }
  }

  res.status(503).json({
    error: lastError?.message || 'All models are busy. Please wait a moment and try again.',
    retryable: true
  });
});

app.listen(PORT, () => {
  console.log(`Quiz app running at http://localhost:${PORT}`);
});
