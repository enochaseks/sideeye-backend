const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function testGemini() {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent(["Say hello!"]);
    console.log("Gemini response:", result.response.text());
  } catch (err) {
    console.error("Gemini test error:", err);
  }
}
testGemini();
