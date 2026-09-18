// T-209: base64 → UTF-8. Zwilling von src/lib/githubSync.ts:b64ToUtf8 (T-208) — kein
// Shared-Import, weil das Worker-Bundle eigenständig ist (kein Zugriff auf src/lib/*).
// atob() allein liefert eine Latin-1-Bytefolge ("Qualität" → "QualitÃ¤t"); wer mit
// btoa(unescape(encodeURIComponent(x))) schreibt, MUSS mit TextDecoder('utf-8') lesen,
// sonst kippt ein Read-Modify-Write-Zyklus (z.B. readMutationsFile) deutschen Freitext
// in Mojibake und schreibt ihn dauerhaft zurück.
export function b64ToUtf8(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}
