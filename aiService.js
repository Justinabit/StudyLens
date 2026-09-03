/*
  aiService.js
  ------------
  All AI-related logic lives here, separate from the UI (popup) and the
  webpage logic (content.js). This is intentional: to add a new AI
  provider later, you should only need to change this file.

  Loaded by background.js (via importScripts) where the actual network
  requests happen. Also loaded by popup.js for the two functions that
  build plain-text prompts and need no network access at all
  (buildQuizPrompt / buildFlashcardPrompt).

  SECURITY NOTE (see README > API Key Security):
  The API key is read from chrome.storage.local, set by the student on the
  Settings page. It is never hard-coded here. For a prototype like this,
  the key lives in the browser and is only ever sent directly to the AI
  provider - that is normal for a personal local extension, but it is NOT
  the same as a secure secret on a server. Do not publish a build of
  StudyLens with a key already filled in.
*/

const AI_MODELS = {
  openai: "gpt-4o-mini",
  // Google retires Gemini model names periodically - gemini-3.1-flash-lite
  // is the current fast, low-cost model as of this build. If Gemini starts
  // returning 404s for the model, check https://ai.google.dev/gemini-api/docs/models
  // and update this one line.
  gemini: "gemini-3.1-flash-lite"
};

/* ---------------------------------------------------------------------- *
 *  Low-level provider calls
 * ---------------------------------------------------------------------- */

// Every provider implements the same shape: callModel(apiKey, messages)
// and resolves to a plain string (the model's reply text).
const PROVIDERS = {
  async openai(apiKey, messages) {
    if (!apiKey) {
      throw new Error("No API key is set. Add one on the StudyLens Settings page.");
    }

    let response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey
        },
        body: JSON.stringify({
          model: AI_MODELS.openai,
          messages,
          temperature: 0.2
        })
      });
    } catch (networkErr) {
      throw new Error("Could not reach the AI service. Check your internet connection.");
    }

    if (!response.ok) {
      throw new Error(await describeOpenAIError(response));
    }

    const data = await response.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;

    if (!text) {
      throw new Error("The AI service returned an unexpected response.");
    }
    return text.trim();
  },

  async gemini(apiKey, messages) {
    if (!apiKey) {
      throw new Error("No API key is set. Add one on the StudyLens Settings page.");
    }

    // Gemini keeps the system instruction separate from the conversation,
    // rather than mixing it into the messages list like OpenAI does.
    const systemMessage = messages.find((m) => m.role === "system");
    const userMessages = messages.filter((m) => m.role !== "system");

    const body = {
      contents: userMessages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      })),
      generationConfig: { temperature: 0.2 }
    };
    if (systemMessage) {
      body.systemInstruction = { parts: [{ text: systemMessage.content }] };
    }

    const model = AI_MODELS.gemini;
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(body)
      });
    } catch (networkErr) {
      throw new Error("Could not reach the AI service. Check your internet connection.");
    }

    if (!response.ok) {
      throw new Error(await describeGeminiError(response));
    }

    const data = await response.json();
    const candidate = data && data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map((p) => p.text || "").join("")
      : null;

    if (!text) {
      const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
      if (blockReason) {
        throw new Error("Gemini did not generate a result for this page's content (reason: " + blockReason + ").");
      }
      throw new Error("The AI service returned an unexpected response.");
    }
    return text.trim();
  },

  // Placeholder so the provider list in Settings can be extended later
  // without restructuring the extension (see README > Future Improvements).
  async anthropic() {
    throw new Error("Anthropic support is not implemented yet. Please use OpenAI or Gemini in Settings.");
  }
};

// OpenAI returns HTTP 429 for both true rate limiting AND for an account
// that is simply out of quota/billing - those need very different advice,
// so this reads the response body to tell them apart instead of showing
// one generic "try again shortly" message for both.
async function describeOpenAIError(response) {
  if (response.status === 401) {
    return "The AI service rejected your API key. Check it on the Settings page.";
  }

  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    // Body wasn't JSON - fall through to a generic message below.
  }
  const errorType = body && body.error && (body.error.code || body.error.type);
  const errorMessage = body && body.error && body.error.message;

  if (response.status === 429) {
    if (errorType === "insufficient_quota") {
      return "Your OpenAI account has no available quota. Check your plan and billing at platform.openai.com, or switch to Gemini in Settings.";
    }
    return "The AI service is rate-limited right now - you're sending requests faster than your plan allows. Wait a moment and try again, or check your usage limits at platform.openai.com.";
  }

  if (response.status >= 500) {
    return "The AI service is temporarily unavailable. Please try again shortly.";
  }

  return errorMessage
    ? "The AI service returned an error: " + errorMessage
    : "The AI service returned an error (status " + response.status + ").";
}

// Gemini's free tier returns 429 for both per-minute rate limits and daily
// quota exhaustion; the response body's error message usually says which.
async function describeGeminiError(response) {
  if (response.status === 400) {
    return "The AI service rejected this request. Check that your Gemini API key is correct on the Settings page.";
  }
  if (response.status === 403) {
    return "The AI service rejected your API key. Check it on the Settings page.";
  }

  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    // Body wasn't JSON - fall through to a generic message below.
  }
  const errorMessage = (body && body.error && body.error.message) || "";

  if (response.status === 429) {
    if (/quota/i.test(errorMessage)) {
      return "Your Gemini account has run out of free quota for now. Check your usage at aistudio.google.com, or try again after it resets.";
    }
    return "The AI service is rate-limited right now - you're sending requests faster than your plan allows. Wait a moment and try again.";
  }

  if (response.status >= 500) {
    return "The AI service is temporarily unavailable. Please try again shortly.";
  }

  return errorMessage
    ? "The AI service returned an error: " + errorMessage
    : "The AI service returned an error (status " + response.status + ").";
}

async function callModel(provider, apiKey, messages) {
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error("Unknown AI provider: " + provider);
  return fn(apiKey, messages);
}

/* ---------------------------------------------------------------------- *
 *  Content chunking for long documents (see README > Long Documents)
 * ---------------------------------------------------------------------- */

function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length > maxChars && current) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = current ? current + "\n\n" + paragraph : paragraph;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

const RULES = [
  "Use ONLY the supplied source content below.",
  "Do not invent facts, definitions, examples, or citations.",
  "If the content does not contain enough information for something, say so plainly instead of guessing."
].join(" ");

// Runs a task across every chunk of a long page, then combines the
// per-chunk notes into one final answer. For short pages, this simply
// skips straight to a single call.
async function generateWithChunking(provider, apiKey, text, { chunkInstruction, finalInstruction }) {
  const chunks = chunkText(text, MAX_CHARS_PER_CHUNK);

  if (chunks.length === 1) {
    const reply = await callModel(provider, apiKey, [
      { role: "system", content: RULES },
      { role: "user", content: finalInstruction + "\n\nWEBPAGE CONTENT:\n" + chunks[0] }
    ]);
    return { text: reply, chunked: false, chunkCount: 1 };
  }

  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    const reply = await callModel(provider, apiKey, [
      { role: "system", content: RULES },
      {
        role: "user",
        content:
          chunkInstruction +
          "\n\nThis is section " + (i + 1) + " of " + chunks.length + " of one source document.\n\nSECTION CONTENT:\n" +
          chunks[i]
      }
    ]);
    notes.push("Section " + (i + 1) + " notes:\n" + reply);
  }

  const combined = await callModel(provider, apiKey, [
    { role: "system", content: RULES },
    {
      role: "user",
      content:
        finalInstruction +
        "\n\nThe source was long, so it was read in " + chunks.length +
        " sections. Combine these section notes into ONE cohesive, complete result covering every topic mentioned " +
        "below, removing any duplicate or repeated information that appears in more than one section's notes:\n\n" +
        notes.join("\n\n")
    }
  ]);

  return { text: combined, chunked: true, chunkCount: chunks.length };
}

/* ---------------------------------------------------------------------- *
 *  High-level study features
 * ---------------------------------------------------------------------- */

async function generateSummary(provider, apiKey, text) {
  const instruction =
    "Write a study summary of this source content in this exact format:\n\n" +
    "SUMMARY\n\nTopic:\n[topic]\n\nOverview:\n[2-3 sentence explanation]\n\n" +
    "Main Ideas:\n• [idea]\n• [idea]\n• [idea]\n• [idea]\n\nConclusion:\n[1-2 sentence conclusion]";

  return generateWithChunking(provider, apiKey, text, {
    chunkInstruction: "Take brief notes on the main ideas and important facts in this section, in your own words.",
    finalInstruction: instruction
  });
}

async function generateKeyPoints(provider, apiKey, text, count) {
  const n = count || 6;
  const instruction =
    "List the " + n + " most important things a student should remember from this source. " +
    "Prioritize definitions, rules, facts, processes, and comparisons. " +
    'Format the response as a numbered list titled "KEY POINTS TO REMEMBER", one clear sentence per point, nothing else.';

  return generateWithChunking(provider, apiKey, text, {
    chunkInstruction: "List the most important facts, definitions, and rules found in this section only.",
    finalInstruction: instruction
  });
}

async function generateReviewer(provider, apiKey, text, mode) {
  const depth =
    mode === "quick"
      ? "Keep this brief: for each topic, cover only the single most essential idea and the most important terms."
      : mode === "standard"
      ? "Cover the important concepts and terms for each topic without excessive secondary detail - the standard, recommended depth."
      : // "comprehensive" (default) - coverage first, brevity second.
        "Prioritize coverage over brevity. Include every major topic and subtopic found in the source, with full " +
        "definitions, important details, and examples for each. A student should be able to study from this reviewer " +
        "without needing to go back to the original material. Do not omit information just to keep the reviewer short.";

  const instruction =
    "Create a study reviewer from this source content. " + depth + " " +
    "If something is unclear or not covered in the source, write \"Not clearly specified in the source material\" " +
    "instead of guessing. Use this structure, repeating the topic section (## I., ## II., ## III. ...) for every " +
    "major topic you find in the source - do not stop after one topic:\n\n" +
    "# FULL REVIEWER\n\n" +
    "## I. [Topic Name]\n\n" +
    "### Definition\n[if this topic has a core definition]\n\n" +
    "### Important Concepts\n• ...\n\n" +
    "### Key Terms\n**Term** — Definition\n\n" +
    "### Important Details\n• ...\n\n" +
    "### Examples\n[if the source gives any]\n\n" +
    "(repeat ## II., ## III., etc. for each additional topic actually found in the source)\n\n" +
    "## KEY POINTS TO REMEMBER\n1. ...\n\n" +
    "## QUICK REVIEW\n• ...";

  return generateWithChunking(provider, apiKey, text, {
    chunkInstruction:
      "Identify the topic(s) covered in this excerpt and take detailed, organized notes on each: definitions, " +
      "concepts, terminology, examples, processes, lists, dates, names, formulas, and other important details. " +
      "Label which topic each note belongs to.",
    finalInstruction: instruction
  });
}

// Returns short, EXACT quotes from the source so they can be found and
// highlighted on the actual webpage (see content.js).
async function generateHighlightPhrases(provider, apiKey, text, count) {
  const n = count || 10;
  const instruction =
    "Find the " + n + " most important passages in this webpage content (definitions, rules, key facts, " +
    "conclusions, formulas). Copy each one EXACTLY as it appears in the source - word for word, do not " +
    "paraphrase or shorten with '...'. Respond with ONLY a JSON array of strings, no other text, like:\n" +
    '["exact phrase one", "exact phrase two"]';

  // Highlighting works best on the original wording, so this is never
  // chunk-combined - it runs once per chunk and merges the raw phrase lists.
  const chunks = chunkText(text, MAX_CHARS_PER_CHUNK);
  let allPhrases = [];

  for (const chunk of chunks) {
    const reply = await callModel(provider, apiKey, [
      { role: "system", content: RULES },
      { role: "user", content: instruction + "\n\nWEBPAGE CONTENT:\n" + chunk }
    ]);

    const cleaned = reply.replace(/```json|```/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        allPhrases = allPhrases.concat(parsed.filter((p) => typeof p === "string"));
      }
    } catch (err) {
      // If the model didn't return valid JSON, skip this chunk's phrases
      // rather than failing the whole feature.
    }
  }

  return { phrases: allPhrases.slice(0, Math.max(n, 20)), chunked: chunks.length > 1, chunkCount: chunks.length };
}

/* ---------------------------------------------------------------------- *
 *  Plain-text prompt builders (no AI call - see README > Quiz/Flashcard)
 * ---------------------------------------------------------------------- */

function buildQuizPrompt(studyMaterial) {
  return (
    "You are a study quiz generator.\n\n" +
    "Using ONLY the study material provided below, create a quiz that tests the student's understanding.\n\n" +
    "Requirements:\n" +
    "- Use only the provided study material.\n" +
    "- Focus on important concepts.\n" +
    "- Include multiple-choice questions.\n" +
    "- Provide plausible distractors.\n" +
    "- Include an answer key.\n" +
    "- Explain why each answer is correct.\n" +
    "- Do not introduce information that is not present in the study material.\n\n" +
    "STUDY MATERIAL:\n\n" +
    studyMaterial
  );
}

function buildFlashcardPrompt(studyMaterial) {
  return (
    "Using ONLY the study material below, create useful study flashcards.\n\n" +
    "Each flashcard should contain:\n\n" +
    "Front:\nQuestion or term\n\n" +
    "Back:\nAnswer or definition\n\n" +
    "Focus on the most important concepts.\n\n" +
    "STUDY MATERIAL:\n\n" +
    studyMaterial
  );
}
