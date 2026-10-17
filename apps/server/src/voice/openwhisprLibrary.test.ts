import { describe, expect, it } from "vite-plus/test";
import {
  applyOpenWhisprLibrary,
  isOpenWhisprDictionaryEcho,
  openWhisprDictionaryPrompt,
} from "./openwhisprLibrary.ts";

describe("OpenWhispr library", () => {
  it("preserves saved spellings on whole words and phrases", () => {
    expect(
      applyOpenWhisprLibrary("ask arcwright about tailscale and new york. notarcwright", {
        words: ["Arcwright", "Tailscale", "New York"],
        snippets: [],
      }),
    ).toBe("ask Arcwright about Tailscale and New York. notarcwright");
  });
  it("expands the longest literal snippet, including punctuation and regular-expression characters", () => {
    expect(
      applyOpenWhisprLibrary("signature please! signature; use c++", {
        words: [],
        snippets: [
          { trigger: "signature", replacement: "SHORT" },
          { trigger: "signature please", replacement: "$&\nThanks, Alex" },
          { trigger: "c++", replacement: "C++ language" },
        ],
      }),
    ).toBe("$&\nThanks, Alex! SHORT; use C++ language");
  });
  it("keeps replacement text literal without recursively expanding snippets or changing saved spelling", () => {
    expect(
      applyOpenWhisprLibrary("my signature", {
        words: ["Arcwright"],
        snippets: [
          { trigger: "my signature", replacement: "arcwright signature" },
          { trigger: "signature", replacement: "EXPANDED" },
        ],
      }),
    ).toBe("arcwright signature");
  });
  it("matches Unicode boundaries and Turkish dotted and dotless I like OpenWhispr", () => {
    expect(
      applyOpenWhisprLibrary("ÖZEL İMZA! imzalar imza ıslak", {
        words: [],
        snippets: [
          { trigger: "özel imza", replacement: "özel metin" },
          { trigger: "İmza", replacement: "SIGNED" },
          { trigger: "Islak", replacement: "WET" },
        ],
      }),
    ).toBe("özel metin! imzalar SIGNED WET");
  });
  it("normalizes decomposed Unicode and leaves an empty library untouched", () => {
    expect(applyOpenWhisprLibrary("use cafe\u0301", { words: ["Café"], snippets: [] })).toBe(
      "use Café",
    );
    expect(applyOpenWhisprLibrary(" untouched  ", { words: [], snippets: [] })).toBe(
      " untouched  ",
    );
  });
  it("builds Whisper hints from words and triggers, excluding replacement text and duplicate terms", () => {
    expect(
      openWhisprDictionaryPrompt({
        words: [" Arcwright ", "arcwright", "  "],
        snippets: [
          { trigger: "my signature", replacement: "Private saved text, not a vocabulary hint" },
        ],
      }),
    ).toBe("Arcwright, my signature");
  });
  it("bounds Whisper hints at complete entries and still applies the whole spelling dictionary", () => {
    const words = ["x".repeat(901), "Arcwright", "y".repeat(890), "Tailscale"];
    const library = { words, snippets: [] };
    expect(openWhisprDictionaryPrompt(library)).toBe("Arcwright, Tailscale");
    expect(applyOpenWhisprLibrary(words[0]!.toUpperCase(), library)).toBe(words[0]);
    expect(openWhisprDictionaryPrompt({ words: [], snippets: [] })).toBeUndefined();
  });
  it("recognizes full hint-list echoes without classifying ordinary dictionary words as echoes", () => {
    expect(isOpenWhisprDictionaryEcho("arcwright, tailscale.", "Arcwright, Tailscale")).toBe(true);
    expect(isOpenWhisprDictionaryEcho("Use Arcwright with Tailscale", "Arcwright, Tailscale")).toBe(
      false,
    );
    expect(isOpenWhisprDictionaryEcho("Arcwright", "Arcwright")).toBe(false);
  });
});
