import { GoogleGenerativeAI } from "@google/generative-ai";

export async function runGemini(promptText) {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY env var is not set on Vercel.");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const result = await model.generateContent(promptText);
  const text = result?.response?.text() || "";

  return text.trim();
}
