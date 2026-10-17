/*! @license MIT
 * Snippet matching adapted from OpenWhispr v1.10.3 src/utils/snippets.ts.
 * MIT License
 * Copyright (c) 2024 OpenWhispr Team
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

interface Snippet {
  readonly trigger: string;
  readonly replacement: string;
}

export interface OpenWhisprLibrary {
  readonly words: readonly string[];
  readonly snippets: readonly Snippet[];
}

function foldCapitalIDot(value: string): string {
  return value.replace(/İ/g, "i");
}

function replaceEntries(text: string, entries: readonly Snippet[]): string {
  const replacements = new Map<string, string>();
  for (const { trigger, replacement } of entries) {
    const folded = foldCapitalIDot(trigger.trim().normalize("NFC"));
    const key = folded.toLowerCase();
    if (!key) continue;
    replacements.set(key, replacement);
    const dotlessKey = folded.replace(/I/g, "ı").toLowerCase();
    if (!replacements.has(dotlessKey)) replacements.set(dotlessKey, replacement);
  }
  if (replacements.size === 0 || !text) return text;
  const escaped = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .map((term) => term.replace(/i/g, "[iİ]").replace(/ı/g, "[ıI]"));
  const pattern = new RegExp(
    `(?<=^|[\\s\\p{P}\\p{S}])(?:${escaped.join("|")})(?=$|[\\s\\p{P}\\p{S}])`,
    "giu",
  );
  return text.normalize("NFC").replace(pattern, (match) => {
    const folded = foldCapitalIDot(match);
    return (
      replacements.get(folded.toLowerCase()) ??
      replacements.get(folded.replace(/I/g, "ı").toLowerCase()) ??
      match
    );
  });
}

/** Saved spellings first, then one pass of snippet expansion so saved text stays literal. */
export function applyOpenWhisprLibrary(text: string, library: OpenWhisprLibrary): string {
  const spelled = replaceEntries(
    text,
    library.words.map((word) => ({
      trigger: word,
      replacement: word.trim().normalize("NFC"),
    })),
  );
  return replaceEntries(spelled, library.snippets);
}

/** Whisper's context is limited; never split a saved word or include snippet replacement text. */
export function openWhisprDictionaryPrompt(library: OpenWhisprLibrary): string | undefined {
  const words = [...library.words, ...library.snippets.map((snippet) => snippet.trigger)];
  const seen = new Set<string>();
  let prompt = "";
  for (const word of words) {
    const term = word.trim().replace(/\s+/g, " ").normalize("NFC");
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    const next = prompt ? `${prompt}, ${term}` : term;
    if (next.length <= 900) prompt = next;
  }
  return prompt || undefined;
}

/** Re-decode a full hint-list echo without the hint, rather than inserting the user's dictionary. */
export function isOpenWhisprDictionaryEcho(text: string, prompt: string): boolean {
  if (prompt.split(",").filter((term) => term.trim()).length < 2) return false;
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return normalize(text).length > 0 && normalize(text) === normalize(prompt);
}
