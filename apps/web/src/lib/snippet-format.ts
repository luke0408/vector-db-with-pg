const EMPTY_SNIPPET_FALLBACK = 'No summary available.'

export function formatSnippet(raw: string): string {
  const normalized = raw
    .replace(/\[\[분류:[^\]]+\]\]/g, ' ')
    .replace(/\[include\([^\]]*\)\]/g, ' ')
    .replace(/\{\{[^{}]*\}\}/g, ' ')
    .replace(/\{\{|\}\}/g, ' ')
    .replace(/\[\[파일:[^\]]+\]\]/g, ' ')
    .replace(/\[\[https?:[^\]|]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, (_match, token: string) => {
      if (token.startsWith('분류:') || token.startsWith('파일:')) {
        return ' '
      }

      return token
    })
    .replace(/={2,}\s*([^=]+?)\s*={2,}/g, '$1')
    .replace(/\[목차\]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\|\|+/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized.length > 0 ? normalized : EMPTY_SNIPPET_FALLBACK
}

export { EMPTY_SNIPPET_FALLBACK }
