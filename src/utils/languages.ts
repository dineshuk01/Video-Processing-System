// Languages seen in audio and subtitle tracks. Files carry ISO 639-2 codes ("hin", "eng"); players and
// HLS want short codes ("hi", "en"). Anything not listed keeps its own code and is shown as-is.
const LANGUAGES: Array<[string, string, string]> = [
  // [639-2, 639-1, name]
  ['hin', 'hi', 'Hindi'], ['eng', 'en', 'English'], ['tam', 'ta', 'Tamil'], ['tel', 'te', 'Telugu'],
  ['kan', 'kn', 'Kannada'], ['mal', 'ml', 'Malayalam'], ['ben', 'bn', 'Bengali'], ['mar', 'mr', 'Marathi'],
  ['pan', 'pa', 'Punjabi'], ['guj', 'gu', 'Gujarati'], ['urd', 'ur', 'Urdu'], ['ori', 'or', 'Odia'],
  ['spa', 'es', 'Spanish'], ['fre', 'fr', 'French'], ['fra', 'fr', 'French'], ['ger', 'de', 'German'],
  ['deu', 'de', 'German'], ['ita', 'it', 'Italian'], ['por', 'pt', 'Portuguese'], ['rus', 'ru', 'Russian'],
  ['jpn', 'ja', 'Japanese'], ['kor', 'ko', 'Korean'], ['chi', 'zh', 'Chinese'], ['zho', 'zh', 'Chinese'],
  ['ara', 'ar', 'Arabic'], ['tha', 'th', 'Thai'], ['tur', 'tr', 'Turkish'], ['ind', 'id', 'Indonesian'],
  ['vie', 'vi', 'Vietnamese'], ['dut', 'nl', 'Dutch'], ['nld', 'nl', 'Dutch'], ['pol', 'pl', 'Polish'],
];

export interface Language { code: string; name: string }

// "hin", "hi" or "Hindi" -> { code: "hi", name: "Hindi" }; unknown values are kept as they are
export function resolveLanguage(value?: string): Language {
  const v = (value || '').trim().toLowerCase();
  if (!v || v === 'und' || v === 'unk') return { code: 'und', name: '' };
  const hit = LANGUAGES.find(([c3, c2, name]) => v === c3 || v === c2 || v === name.toLowerCase());
  return hit ? { code: hit[1], name: hit[2] } : { code: v.slice(0, 8), name: '' };
}

// The label shown in the player's menu: the file's own title when it says something useful, else the language
export function trackLabel(title: string | undefined, language: string | undefined, fallback: string): string {
  const t = (title || '').trim();
  if (t && t.length <= 40 && !/^(audio|stereo|mono|surround|track|und)\b\s*\d*$/i.test(t)) return t;
  const lang = resolveLanguage(language);
  return lang.name || (lang.code !== 'und' ? lang.code.toUpperCase() : fallback);
}
