/**
 * Content fetched from the web or a browser page may contain text aimed at the model
 * ("ignore previous instructions..."). It is always delivered inside an explicit data envelope,
 * and the system prompt tells the model to treat the envelope as data only.
 */
export function wrapUntrusted(source: string, text: string): string {
  // Defang any attempt to close the envelope early.
  const body = text.replaceAll('</untrusted_content', '<​/untrusted_content');
  return `<untrusted_content source=${JSON.stringify(source)}>\n${body}\n</untrusted_content>`;
}
